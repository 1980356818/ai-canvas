"""
ai-canvas 发版脚本（Win/Mac 通用）。

用法
----
  python scripts/release.py 1.2.0
  python scripts/release.py 1.2.0 --notes "修复 X / 优化 Y"
  python scripts/release.py 1.2.0 --no-upload     # 只构建,不上传
  python scripts/release.py 1.2.0 --skip-build    # 用现有产物上传

环境变量（必需）
  TAURI_SIGNING_PRIVATE_KEY           — 私钥文件**内容**
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD  — 私钥密码

  AICAT_ADMIN_USER  / AICAT_ADMIN_PASSWORD  — 上传时管理员账号 (可用 --user/--password 覆盖)
  AICAT_SERVER      — 服务端地址,默认 http://101.37.80.236

流程
----
  1. 校验 semver、确认 > 当前 package.json 版本
  2. npm run version:sync         (写 Cargo.toml / tauri.conf.json)
  3. npm install （省心一手）+ cargo tauri build
  4. 扫 src-tauri/target/release/bundle/ 下所有 *.sig
  5. 登录服务端 → 拿 admin token
  6. 对每个 (artifact, .sig) → POST /api/admin/release/upload

发版完毕后服务端 (version, target, arch) 唯一约束保证同版本不会重复落库,
如果重跑同一个版本号会被 409 RELEASE_DUPLICATE 拒绝 —— 这是想要的行为。
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG_JSON = ROOT / "package.json"
TAURI_BUNDLE_DIR = ROOT / "src-tauri" / "target" / "release" / "bundle"

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+([-+].+)?$")


def log(msg: str) -> None:
    print(f"[release] {msg}", flush=True)


def fail(msg: str, code: int = 1) -> None:
    print(f"[release] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def encode_version(v: str) -> int:
    """与服务端 / 客户端的 encodeVersion 一致;只比较 major.minor.patch,忽略 pre-release。"""
    clean = re.split(r"[-+]", v, 1)[0]
    parts = clean.split(".")
    try:
        major = int(parts[0]) if len(parts) > 0 else 0
        minor = int(parts[1]) if len(parts) > 1 else 0
        patch = int(parts[2]) if len(parts) > 2 else 0
    except ValueError:
        return 0
    return major * 1_000_000 + minor * 1_000 + patch


def host_target_arch() -> tuple[str, str]:
    """根据当前操作系统/架构推断 Tauri 标记。"""
    system = platform.system().lower()
    if system.startswith("win"):
        target = "windows"
    elif system == "darwin":
        target = "darwin"
    else:
        target = "linux"

    machine = platform.machine().lower()
    if machine in ("amd64", "x86_64"):
        arch = "x86_64"
    elif machine in ("arm64", "aarch64"):
        arch = "aarch64"
    else:
        arch = machine
    return target, arch


def read_current_version() -> str:
    pkg = json.loads(PKG_JSON.read_text(encoding="utf-8"))
    return pkg["version"]


def write_version_to_pkg(new_version: str) -> None:
    pkg = json.loads(PKG_JSON.read_text(encoding="utf-8"))
    pkg["version"] = new_version
    PKG_JSON.write_text(
        json.dumps(pkg, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def run(cmd: list[str] | str, *, cwd: Path = ROOT, check: bool = True) -> None:
    """统一打印 + 失败终止。Win 上 npm 是 .cmd,得 shell=True。"""
    is_str = isinstance(cmd, str)
    shown = cmd if is_str else " ".join(cmd)
    log(f"$ {shown}")
    result = subprocess.run(
        cmd,
        cwd=str(cwd),
        shell=is_str or platform.system().lower().startswith("win"),
    )
    if check and result.returncode != 0:
        fail(f"command failed (exit {result.returncode}): {shown}")


def find_signed_artifacts() -> list[tuple[Path, Path]]:
    """
    扫 bundle 目录里所有 *.sig,返回 [(artifact_path, sig_path), ...]。
    Tauri 2 createUpdaterArtifacts=true 时:
      Win:   bundle/nsis/<n>_<ver>_<arch>-setup.nsis.zip(+.sig)
      macOS: bundle/macos/<n>.app.tar.gz(+.sig)
    """
    if not TAURI_BUNDLE_DIR.exists():
        return []
    pairs: list[tuple[Path, Path]] = []
    for sig in TAURI_BUNDLE_DIR.rglob("*.sig"):
        artifact = sig.with_suffix("")  # 砍掉 .sig 后缀
        if not artifact.exists():
            log(f"WARN: sig {sig.name} 缺对应安装包,跳过")
            continue
        pairs.append((artifact, sig))
    return pairs


# ── 上传到服务端 ────────────────────────────────────────────────────────


def admin_login(server: str, user: str, password: str) -> str:
    url = f"{server.rstrip('/')}/api/admin/login"
    body = json.dumps({"username": user, "password": password}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        fail(f"admin login HTTP {e.code}: {e.read().decode('utf-8', 'ignore')}")
    except urllib.error.URLError as e:
        fail(f"admin login failed: {e.reason}")
    if payload.get("code") != 0:
        fail(f"admin login rejected: {payload}")
    return payload["data"]["token"]


def _multipart_encode(
    fields: dict[str, str], files: dict[str, tuple[str, bytes]]
) -> tuple[bytes, str]:
    """
    手写 multipart 避免引入 requests 依赖。

    格式严格按 RFC 7578:每段以 `--boundary\r\n` 开头,header 行各自 \r\n 结尾,
    header 与 body 之间额外一个空行 \r\n,body 之后 \r\n,最后 `--boundary--\r\n`。
    早期实现误用 \r\n.join 把多余 \r\n 渗进了字段值,踩过坑。
    """
    boundary = "----aicat-release-" + os.urandom(8).hex()
    sep = ("--" + boundary + "\r\n").encode()
    end = ("--" + boundary + "--\r\n").encode()
    body = bytearray()
    for name, value in fields.items():
        body += sep
        body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        body += value.encode("utf-8")
        body += b"\r\n"
    for name, (filename, content) in files.items():
        body += sep
        body += (
            f'Content-Disposition: form-data; name="{name}"; '
            f'filename="{filename}"\r\n'
            f'Content-Type: application/octet-stream\r\n\r\n'
        ).encode()
        body += content
        body += b"\r\n"
    body += end
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def upload_release(
    server: str,
    token: str,
    version: str,
    target: str,
    arch: str,
    notes: str | None,
    min_version: str | None,
    artifact: Path,
    sig: Path,
) -> dict:
    fields: dict[str, str] = {
        "version": version,
        "target": target,
        "arch": arch,
    }
    if notes:
        fields["releaseNotes"] = notes
    if min_version:
        fields["minVersion"] = min_version
    files = {
        "file": (artifact.name, artifact.read_bytes()),
        "signature": (sig.name, sig.read_bytes()),
    }
    body, content_type = _multipart_encode(fields, files)
    url = f"{server.rstrip('/')}/api/admin/release/upload"
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": content_type,
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_str = e.read().decode("utf-8", "ignore")
        fail(f"upload HTTP {e.code}: {body_str}")
    except urllib.error.URLError as e:
        fail(f"upload failed: {e.reason}")
    if payload.get("code") != 0:
        fail(f"upload rejected: {payload}")
    return payload["data"]


# ── 发布前签名校验(完整性闸) ────────────────────────────────────────────


def _embedded_pubkey_b64() -> str:
    """从 src-tauri/tauri.conf.json 读 updater.pubkey —— 单一真相源。"""
    conf = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    return conf["plugins"]["updater"]["pubkey"]


def verify_signature(artifact: Path, sig: Path) -> None:
    """用 app 内嵌 pubkey 密码学校验 artifact 的 .sig。
    不匹配直接 fail —— 防止把签错/损坏的包传上线(客户端会拒装,表现为静默更新失败)。"""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        log("WARN: 缺 cryptography 库,跳过签名校验 (pip install cryptography 可启用)")
        return
    pubfile = base64.b64decode(_embedded_pubkey_b64()).decode()
    pub_raw = base64.b64decode(pubfile.strip().splitlines()[1])
    pub_keyid, pub_key = pub_raw[2:10], pub_raw[10:42]
    # .sig 文件内容本身是 base64,解一层得到 minisign 签名文件
    sigfile = base64.b64decode(sig.read_bytes().strip()).decode()
    sraw = base64.b64decode(sigfile.strip().splitlines()[1])
    alg, sig_keyid, sig_bytes = sraw[0:2], sraw[2:10], sraw[10:74]
    if sig_keyid != pub_keyid:
        fail(f"{sig.name}: 签名 keyid {sig_keyid.hex()} != pubkey {pub_keyid.hex()} (用错密钥?)")
    data = artifact.read_bytes()
    msg = hashlib.blake2b(data, digest_size=64).digest() if alg == b"ED" else data
    try:
        Ed25519PublicKey.from_public_bytes(pub_key).verify(sig_bytes, msg)
    except Exception as e:
        fail(f"{artifact.name}: 签名校验失败(包被改 / 密钥不符): {e}")
    log(f"  ✓ 签名校验通过: {artifact.name}")


# ── 管理端动作: promote / block / rollback ────────────────────────────────


def admin_list_releases(server: str, token: str) -> list[dict]:
    url = f"{server.rstrip('/')}/api/admin/release/list?page=1&size=500"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        fail(f"list releases HTTP {e.code}: {e.read().decode('utf-8', 'ignore')}")
    if payload.get("code") != 0:
        fail(f"list releases failed: {payload}")
    return payload["data"]["records"]


def admin_action(server: str, token: str, rid: int, action: str) -> None:
    """action ∈ promote / block / activate / deactivate"""
    url = f"{server.rstrip('/')}/api/admin/release/{rid}/{action}"
    req = urllib.request.Request(url, data=b"",
                                 headers={"Authorization": f"Bearer {token}"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        fail(f"{action} id={rid} HTTP {e.code}: {e.read().decode('utf-8', 'ignore')}")
    if payload.get("code") != 0:
        fail(f"{action} id={rid} failed: {payload}")
    log(f"  → id={rid} {action} ok")


def do_admin_action(args, action: str, version: str) -> None:
    """对已存在版本(全平台)做 promote/block/rollback,不构建。"""
    user = args.user or input("管理员账号: ").strip()
    password = args.password or getpass.getpass("管理员密码: ")
    token = admin_login(args.server, user, password)
    rows = admin_list_releases(args.server, token)
    targets = [r for r in rows if r.get("version") == version]
    if not targets:
        fail(f"服务端找不到版本 {version} 的任何记录")

    if action == "promote":
        log(f"promote {version} ({len(targets)} 个平台)→ stable 全量:")
        for r in targets:
            admin_action(args.server, token, r["id"], "promote")
    elif action == "block":
        log(f"block(召回) {version} ({len(targets)} 个平台):")
        for r in targets:
            admin_action(args.server, token, r["id"], "block")
    elif action == "rollback":
        log(f"rollback: 召回 {version} + 把每个平台的次高版本提为 stable")
        for r in targets:
            admin_action(args.server, token, r["id"], "block")
        bad_code = encode_version(version)
        by_platform: dict[tuple[str, str], dict] = {}
        for r in rows:
            if encode_version(r["version"]) >= bad_code:
                continue
            key = (r["target"], r["arch"])
            cur = by_platform.get(key)
            if cur is None or r["versionCode"] > cur["versionCode"]:
                by_platform[key] = r
        if not by_platform:
            fail("找不到可回滚到的更早版本(没有比它低的版本)")
        for (t, a), r in by_platform.items():
            log(f"  回滚 {t}/{a} → {r['version']}")
            admin_action(args.server, token, r["id"], "promote")
    log("=== 动作完成 ===")


# ── 主流程 ──────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="ai-canvas 发版脚本")
    ap.add_argument("version", help="新版本号 (语义版本, 如 1.2.0)")
    ap.add_argument("--notes", help="更新说明 (release notes)")
    ap.add_argument("--min-version", help="强更阈值 (低于此版本的客户端必须升级)")
    ap.add_argument(
        "--server",
        default=os.environ.get("AICAT_SERVER", "http://101.37.80.236"),
        help="服务端地址 (默认 http://101.37.80.236 或 $AICAT_SERVER)",
    )
    ap.add_argument("--user", default=os.environ.get("AICAT_ADMIN_USER"))
    ap.add_argument("--password", default=os.environ.get("AICAT_ADMIN_PASSWORD"))
    ap.add_argument(
        "--no-upload",
        action="store_true",
        help="只构建,不上传 (用于本地验证产物)",
    )
    ap.add_argument(
        "--skip-build",
        action="store_true",
        help="跳过构建,用现有 bundle/ 下的产物直接上传",
    )
    ap.add_argument(
        "--skip-sync",
        action="store_true",
        help="跳过 version:sync (用于排错;一般不用)",
    )
    ap.add_argument(
        "--action",
        choices=["release", "promote", "block", "rollback"],
        default="release",
        help="release=构建并上传(默认,落 draft); "
             "promote/block/rollback=对已存在版本操作,不构建",
    )
    ap.add_argument(
        "--promote",
        action="store_true",
        help="构建上传后立即 promote 到 stable(全量)。不加=只落 draft,需手动再 promote",
    )
    ap.add_argument(
        "--no-verify",
        action="store_true",
        help="跳过上传前的签名校验(强烈不建议)",
    )
    return ap.parse_args()


def main() -> None:
    args = parse_args()

    new_ver = args.version.strip()
    if not SEMVER_RE.match(new_ver):
        fail(f"非法版本号: {new_ver} (需形如 1.2.0)")

    # 非 release 动作:对已存在版本 promote/block/rollback,不构建不上传。
    if args.action != "release":
        do_admin_action(args, args.action, new_ver)
        return

    cur = read_current_version()
    if not args.skip_build and encode_version(new_ver) < encode_version(cur):
        fail(
            f"新版本号 {new_ver} 低于当前 {cur} (拒绝降级)。"
            f"如确需用现有产物重传同一版本,可加 --skip-build (服务端唯一约束兜底)"
        )
    # 同版本号(retry)允许通过 —— 服务端 uk_ver_target_arch 会拒绝重复落库

    target, arch = host_target_arch()
    log(f"target={target}, arch={arch}; new version={new_ver}; current={cur}")

    if not args.skip_build:
        # 1. 写新版本号到 package.json,version:sync 会接力同步 Cargo.toml + tauri.conf.json
        if not args.skip_sync:
            log(f"writing package.json version → {new_ver}")
            write_version_to_pkg(new_ver)
            run(["npm", "run", "version:sync"])

        # 2. 签名密钥必须就位,否则 tauri build 不会生成 .sig
        if not os.environ.get("TAURI_SIGNING_PRIVATE_KEY"):
            fail(
                "TAURI_SIGNING_PRIVATE_KEY 未设置, 无法签名。\n"
                "  先跑过 `npm run signing:generate`, 然后按提示导出 env vars。"
            )

        # 3. 构建
        log("running cargo tauri build")
        run(["npm", "run", "tauri", "--", "build"])

    # 4. 找产物
    pairs = find_signed_artifacts()
    if not pairs:
        fail(
            f"在 {TAURI_BUNDLE_DIR} 下没找到任何 *.sig\n"
            "  检查: tauri.conf.json.bundle.createUpdaterArtifacts 是否为 true ?"
        )
    log(f"found {len(pairs)} signed artifact(s):")
    for art, sig in pairs:
        log(f"  · {art.relative_to(ROOT)}  +  {sig.name}")

    # 发布前完整性闸:校验每个包的签名匹配 app 内嵌 pubkey。
    if not args.no_verify:
        log("校验签名(发布前完整性闸)...")
        for art, sig in pairs:
            verify_signature(art, sig)

    if args.no_upload:
        log("--no-upload set, skipping upload. 完成。")
        return

    # 5. 登录
    user = args.user
    password = args.password
    if not user:
        user = input("管理员账号: ").strip()
    if not password:
        password = getpass.getpass("管理员密码: ")
    log(f"logging in to {args.server} as {user}")
    token = admin_login(args.server, user, password)
    log("admin login ok")

    # 6. 逐个上传(落 draft,不直接下发)
    uploaded_ids: list = []
    for art, sig in pairs:
        log(f"uploading {art.name} ...")
        data = upload_release(
            server=args.server,
            token=token,
            version=new_ver,
            target=target,
            arch=arch,
            notes=args.notes,
            min_version=args.min_version,
            artifact=art,
            sig=sig,
        )
        uploaded_ids.append(data.get("id"))
        log(f"  → release id={data.get('id')} size={data.get('fileSize')} [draft]")

    if args.promote:
        log("promote 到 stable(--promote)...")
        for rid in uploaded_ids:
            if rid is not None:
                admin_action(args.server, token, rid, "promote")
        log("=== 发版完成(已全量 stable) ===")
        log(f"v{new_ver} 已全量 ({target}/{arch})。客户端最长 ~3 秒后台轮询会发现。")
    else:
        log("=== 上传完成(draft,未下发) ===")
        log(f"v{new_ver} 已作为 draft 上传 ({target}/{arch})。确认无误后全量发布:")
        log(f"    python scripts/release.py {new_ver} --action promote")


if __name__ == "__main__":
    main()
