"""
把 ai-canvas 智能关键帧需要的 ffmpeg 二进制部署到 JiJing 服务器
(192.168.31.244 → NAS /mnt/nas/ec_system/aicanvas-static/),
让客户端 `frame_extract.rs::download_from_server` 走
`https://ai.snoworangekeji.cn/aicanvas-static/ffmpeg-<ver>-<triple>[ext]` 拉。

服务器侧已配 nginx `^~ /aicanvas-static/` location 反代到 NAS 目录,
本脚本只管「文件部署 + SHA 校验」,不动 nginx。

幂等 + 跳过未变化 + 本地缺文件就 warn 不强制:
  - 远端 SHA-256 跟脚本里的 EXPECTED 对得上 → 跳过(已部署最新版)
  - 远端 SHA 不对 / 不存在 → 看本地路径
      - 本地有且 SHA 对 → 上传(走 .partial → mv)
      - 本地没有 → warn 跳过,提示"本地暂缺,先在另一台机器跑或手工上传"
  - 全程不删旧文件、不动 nginx

升新版 ffmpeg 流程:
  1. 同步改 `ai-canvas/src-tauri/src/commands/frame_extract.rs` 的 FfmpegBundle 常量
  2. 在对应平台上准备新 binary 放到 LOCAL_PATHS 指向的路径
  3. 跑 `python deploy-ffmpeg-static.py` 全部三 triple 重新部署
  4. 改 `scripts/fetch-ffmpeg.mjs` 里的版本号(dev 本地 binaries 用)

环境变量:
  AICAT_SSH_PASSWORD   — root@192.168.31.244 的 SSH 密码 (必需)
  AICAT_SSH_HOST       — 默认 192.168.31.244
  AICAT_SSH_USER       — 默认 root

CLI 选项:
  --triple <triple>    — 只部署这一个 triple,可重复 (默认全部三个)
  --skip-local-check   — 跳过本地 SHA 校验,直接信任本地文件
"""
import argparse
import hashlib
import os
import sys
from dataclasses import dataclass

import paramiko


# ── 配置 ───────────────────────────────────────────────────────────────
SERVER = os.environ.get("AICAT_SSH_HOST", "192.168.31.244")
USER = os.environ.get("AICAT_SSH_USER", "root")
PASSWORD = os.environ.get("AICAT_SSH_PASSWORD")

REMOTE_STATIC_DIR = "/mnt/nas/ec_system/aicanvas-static"
REMOTE_OWNER = "www:www"


@dataclass(frozen=True)
class Bundle:
    """跟 frame_extract.rs::FFMPEG_BUNDLE 一一对应。"""
    triple: str
    version: str
    ext: str           # "" or ".exe"
    sha256: str
    size: int
    local_path: str    # 本地源文件路径; 不存在则跳过上传

    @property
    def remote_name(self) -> str:
        return f"ffmpeg-{self.version}-{self.triple}{self.ext}"

    @property
    def remote_path(self) -> str:
        return f"{REMOTE_STATIC_DIR}/{self.remote_name}"


# 本仓库内 fetch-ffmpeg.mjs 拉到的 binaries/ 目录
_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_BIN_DIR = os.path.join(_BASE, "src-tauri", "binaries")


BUNDLES = {
    "x86_64-pc-windows-msvc": Bundle(
        triple="x86_64-pc-windows-msvc",
        version="8.1.1",
        ext=".exe",
        sha256="228d7a8556258de907fdb55f36850078ebc7680b84ec30d84ea02e99bec1d1eb",
        size=101_457_920,
        # gyan.dev essentials build, fetch-ffmpeg.mjs 自动拉
        local_path=os.path.join(_BIN_DIR, "ffmpeg-x86_64-pc-windows-msvc.exe"),
    ),
    "aarch64-apple-darwin": Bundle(
        triple="aarch64-apple-darwin",
        version="8.1",
        ext="",
        sha256="9a08d61f9328e8164ba560ee7a79958e357307fcfeea6fe626b7d66cdc287028",
        size=51_860_280,
        # osxexperts.net ffmpeg81arm.zip 解出来的 ffmpeg (mac arm64, 8.1)
        # 服务器侧用 mihomo 代理 wget 然后解压;本地路径仅在升级时用
        local_path=os.path.join(_BIN_DIR, "ffmpeg-aarch64-apple-darwin"),
    ),
    "x86_64-apple-darwin": Bundle(
        triple="x86_64-apple-darwin",
        version="8.1.1",
        ext="",
        sha256="3a0ea97adddecfbf87b865da3bcbb321edfce4bab18a98ae1ba4ba9f0bd1f93a",
        size=80_126_240,
        # evermeet.cx ffmpeg-8.1.1.zip 解出来的 ffmpeg (mac intel, 8.1.1)
        local_path=os.path.join(_BIN_DIR, "ffmpeg-x86_64-apple-darwin"),
    ),
}


# ── 辅助 ───────────────────────────────────────────────────────────────
def fail(msg, code=1):
    print(f"[FAIL] {msg}", file=sys.stderr)
    sys.exit(code)


def info(msg):
    print(f"[deploy-ffmpeg] {msg}")


def warn(msg):
    print(f"[WARN] {msg}", file=sys.stderr)


def sha256_local(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(ssh, cmd, check=True):
    _, stdout, stderr = ssh.exec_command(cmd)
    exit_code = stdout.channel.recv_exit_status()
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    if check and exit_code != 0:
        print(f"  cmd: {cmd}")
        print(f"  stdout: {out.rstrip()}")
        print(f"  stderr: {err.rstrip()}")
        fail(f"exit code {exit_code}")
    return exit_code, out, err


# ── 主流程 ─────────────────────────────────────────────────────────────
def deploy_one(ssh, bundle: Bundle, skip_local_check: bool) -> str:
    """返回 'uploaded' / 'skipped' / 'warn'"""
    info(f"--- {bundle.triple} ---")
    info(f"  remote: {bundle.remote_path}")

    # 1) 远端先查 SHA
    _, out, _ = run(
        ssh,
        f"sha256sum {bundle.remote_path} 2>/dev/null || echo MISSING",
        check=False,
    )
    remote_sha = (
        out.split()[0]
        if out and not out.startswith("MISSING")
        else None
    )
    if remote_sha == bundle.sha256:
        info("  ✓ 远端 SHA 已对,跳过")
        return "skipped"
    if remote_sha:
        info(f"  远端现有 SHA={remote_sha[:16]}... 不对,需覆盖")
    else:
        info("  远端无此文件,需上传")

    # 2) 看本地有无
    if not os.path.isfile(bundle.local_path):
        warn(
            f"  本地路径 {bundle.local_path} 不存在,跳过上传 — "
            f"请在对应平台准备好二进制(或在已部署的服务器上 wget 解压)再跑一次"
        )
        return "warn"

    # 3) 本地 SHA 校验
    if not skip_local_check:
        size = os.path.getsize(bundle.local_path)
        if size != bundle.size:
            fail(
                f"  本地 {bundle.local_path} size={size} 跟代码常量 {bundle.size} 对不上"
            )
        info(f"  算本地 SHA-256 ({size/1048576:.1f} MB)...")
        sha = sha256_local(bundle.local_path)
        if sha != bundle.sha256:
            fail(
                f"  本地 SHA={sha} 跟代码常量 {bundle.sha256} 对不上"
            )
        info("  ✓ 本地 SHA 已校验")

    # 4) 上传 (走 .partial → mv,避免半截 binary 被 nginx serve)
    info(f"  上传 → {bundle.remote_path}")
    sftp = ssh.open_sftp()
    tmp = bundle.remote_path + ".partial"
    sftp.put(bundle.local_path, tmp)
    sftp.close()
    run(ssh, f"chmod 644 {tmp} && mv {tmp} {bundle.remote_path}")
    run(ssh, f"chown {REMOTE_OWNER} {bundle.remote_path} 2>/dev/null || true", check=False)

    # 5) 服务端再 SHA 校验
    _, out, _ = run(ssh, f"sha256sum {bundle.remote_path}")
    uploaded_sha = out.split()[0]
    if uploaded_sha != bundle.sha256:
        fail(
            f"  传完了但服务端算的 SHA={uploaded_sha} 跟常量 {bundle.sha256} 对不上!"
        )
    info("  ✓ 上传 + 服务端 SHA 校验 OK")
    return "uploaded"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--triple",
        action="append",
        choices=list(BUNDLES.keys()),
        help="只部署这一个 triple,可重复 (默认全部三个)",
    )
    parser.add_argument(
        "--skip-local-check",
        action="store_true",
        help="跳过本地 SHA-256 校验,直接信任本地文件",
    )
    args = parser.parse_args()

    if not PASSWORD:
        fail("请设环境变量 AICAT_SSH_PASSWORD")

    targets = args.triple or list(BUNDLES.keys())
    info(f"目标服务器: {USER}@{SERVER}")
    info(f"远端目录:   {REMOTE_STATIC_DIR}")
    info(f"部署 triple: {', '.join(targets)}")

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(SERVER, port=22, username=USER, password=PASSWORD, timeout=15)
    info("SSH connected")

    try:
        # 远端目录在
        run(c, f"mkdir -p {REMOTE_STATIC_DIR} && chmod 755 {REMOTE_STATIC_DIR}")

        results = {}
        for triple in targets:
            results[triple] = deploy_one(c, BUNDLES[triple], args.skip_local_check)

        # 服务器内 HEAD 校验(Host header 走真域名,验证 nginx location 通)
        info("")
        info("=== 服务器内 HEAD 校验 ===")
        for triple in targets:
            b = BUNDLES[triple]
            code, out, _ = run(
                c,
                f'curl -ksI -H "Host: ai.snoworangekeji.cn" '
                f'https://127.0.0.1/aicanvas-static/{b.remote_name} '
                f'| head -1',
                check=False,
            )
            status = out.strip().split()[1] if len(out.strip().split()) > 1 else "?"
            ok = status == "200"
            mark = "✓" if ok else "✗"
            info(f"  {mark} HTTP {status}  /aicanvas-static/{b.remote_name}")
            if not ok:
                warn(f"    nginx HEAD 没返 200 — 检查 location 配置")

        info("")
        info("=== DONE ===")
        for triple, r in results.items():
            info(f"  {triple}: {r}")
        info("")
        info(f"客户端 URL 模板: https://ai.snoworangekeji.cn/aicanvas-static/ffmpeg-<ver>-<triple>[ext]")

    finally:
        c.close()


if __name__ == "__main__":
    main()
