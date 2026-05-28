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
import getpass
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
    return ap.parse_args()


def main() -> None:
    args = parse_args()

    new_ver = args.version.strip()
    if not SEMVER_RE.match(new_ver):
        fail(f"非法版本号: {new_ver} (需形如 1.2.0)")

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

    # 6. 逐个上传
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
        log(f"  → release id={data.get('id')} size={data.get('fileSize')}")

    log("=== 发版完成 ===")
    log(f"v{new_ver} 已上传 ({target}/{arch})。客户端最长 ~3 秒后台轮询会发现新版本。")


if __name__ == "__main__":
    main()
