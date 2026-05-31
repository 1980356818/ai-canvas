"""
把 ffmpeg.exe 上传到 101.37.80.236 的 /opt/ai-canvas/static/,
并在 nginx sites-enabled/ai-canvas 里加 `location /static/`。

幂等 + 备份 + 自动回滚:
  - 已存在的 location /static/ 不再重复加
  - 改 nginx 前先 .bak 一份
  - nginx -t 失败立刻 mv .bak 回去
  - 已存在同 SHA 的 ffmpeg.exe 跳过上传(本地算 SHA 跟服务端比)

环境变量 (必需):
  AICAT_SSH_PASSWORD   — root@101.37.80.236 的 SSH 密码
可选:
  AICAT_SSH_HOST       — 默认 101.37.80.236
  AICAT_SSH_USER       — 默认 root
"""
import hashlib
import os
import sys
import paramiko

SERVER = os.environ.get("AICAT_SSH_HOST", "101.37.80.236")
USER = os.environ.get("AICAT_SSH_USER", "root")
PASSWORD = os.environ.get("AICAT_SSH_PASSWORD")
if not PASSWORD:
    print("[FAIL] 请设环境变量 AICAT_SSH_PASSWORD", file=sys.stderr)
    sys.exit(1)

# 本地源:src-tauri/binaries/(fetch-ffmpeg.mjs 拉到这);兜底用装机版 D:\AICat\ffmpeg.exe
import os as _os, sys as _sys
_BASE = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
_CANDIDATES = [
    _os.path.join(_BASE, "src-tauri", "binaries", "ffmpeg-x86_64-pc-windows-msvc.exe"),
    r"D:\AICat\ffmpeg.exe",
]
LOCAL_FFMPEG = next((p for p in _CANDIDATES if _os.path.isfile(p)), _CANDIDATES[0])
FFMPEG_VERSION = "8.1.1"
FFMPEG_TRIPLE = "x86_64-pc-windows-msvc"
EXPECTED_SHA = "228d7a8556258de907fdb55f36850078ebc7680b84ec30d84ea02e99bec1d1eb"
EXPECTED_SIZE = 101_457_920
REMOTE_NAME = f"ffmpeg-{FFMPEG_VERSION}-{FFMPEG_TRIPLE}.exe"

REMOTE_STATIC_DIR = "/opt/ai-canvas/static"
REMOTE_PATH = f"{REMOTE_STATIC_DIR}/{REMOTE_NAME}"
NGINX_CONF = "/etc/nginx/sites-enabled/ai-canvas"

LOCATION_BLOCK = """    # ffmpeg.exe(客户端首次抽帧时按需下载);跟 Java app proxy 解耦,
    # nginx 直接 sendfile,~100MB 大文件不占 backend。详见
    # ai-canvas/src-tauri/src/commands/frame_extract.rs `download_from_server`。
    location /static/ {
        alias /opt/ai-canvas/static/;
        autoindex off;
        sendfile on;
        tcp_nopush on;
        # SHA 锁死内容,客户端验完才信任,所以这里放心 cache
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

"""


def fail(msg, code=1):
    print(f"[FAIL] {msg}", file=sys.stderr)
    sys.exit(code)


def info(msg):
    print(f"[deploy-ffmpeg] {msg}")


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


def main():
    # 1) 本地文件校验
    if not os.path.isfile(LOCAL_FFMPEG):
        fail(f"本地找不到 {LOCAL_FFMPEG}")
    size = os.path.getsize(LOCAL_FFMPEG)
    if size != EXPECTED_SIZE:
        fail(f"本地 {LOCAL_FFMPEG} size={size} 跟代码常量 {EXPECTED_SIZE} 对不上")
    info(f"算本地 SHA-256 ({size} bytes,~30s)...")
    sha = sha256_local(LOCAL_FFMPEG)
    if sha != EXPECTED_SHA:
        fail(f"本地 SHA={sha} 跟代码常量 {EXPECTED_SHA} 对不上")
    info(f"  ✓ 本地 {LOCAL_FFMPEG} 已校验")

    # 2) SSH
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(SERVER, port=22, username=USER, password=PASSWORD, timeout=15)
    info("SSH connected")

    try:
        # 3) mkdir
        run(c, f"mkdir -p {REMOTE_STATIC_DIR} && chmod 755 {REMOTE_STATIC_DIR}")
        info(f"  ✓ {REMOTE_STATIC_DIR} ready")

        # 4) 远端 SHA 检查 → 决定要不要重传
        _, out, _ = run(c, f"sha256sum {REMOTE_PATH} 2>/dev/null || echo MISSING", check=False)
        remote_sha = out.split()[0] if out and not out.startswith("MISSING") else None
        if remote_sha == EXPECTED_SHA:
            info(f"  ✓ 服务器上 {REMOTE_PATH} SHA 已对,跳过上传")
        else:
            if remote_sha:
                info(f"  服务器现有 SHA={remote_sha[:16]}... 不对,覆盖上传")
            info(f"  上传 {LOCAL_FFMPEG} → {REMOTE_PATH} ({size/1048576:.1f} MB)...")
            sftp = c.open_sftp()
            # 走 .partial → mv,避免半截文件被 nginx 提前 serve
            tmp = REMOTE_PATH + ".partial"
            sftp.put(LOCAL_FFMPEG, tmp)
            sftp.close()
            run(c, f"chmod 644 {tmp} && mv {tmp} {REMOTE_PATH}")
            _, out, _ = run(c, f"sha256sum {REMOTE_PATH}")
            uploaded_sha = out.split()[0]
            if uploaded_sha != EXPECTED_SHA:
                fail(f"传完了但服务端算的 SHA={uploaded_sha} 不对!")
            info("  ✓ 上传 + 服务端 SHA 校验 OK")

        # 5) nginx config:幂等加 location /static/
        _, conf, _ = run(c, f"cat {NGINX_CONF}")
        if "location /static/" in conf:
            info(f"  ✓ {NGINX_CONF} 已有 /static/ location,跳过 nginx 改动")
        else:
            info(f"  改 {NGINX_CONF}:加 location /static/")
            ts = run(c, "date +%Y%m%d-%H%M%S")[1].strip()
            backup = f"{NGINX_CONF}.bak-{ts}"
            run(c, f"cp -p {NGINX_CONF} {backup}")
            info(f"  备份 → {backup}")

            # 在 "# Admin SPA -" 之前插入
            marker = "    # Admin SPA -"
            if marker not in conf:
                fail(f"在 {NGINX_CONF} 里没找到 marker '{marker}',不敢自动改,人工介入")
            new_conf = conf.replace(marker, LOCATION_BLOCK + marker, 1)

            # 写入临时文件 → mv,避免 nginx 半行
            sftp = c.open_sftp()
            with sftp.file(f"{NGINX_CONF}.new", "w") as f:
                f.write(new_conf)
            sftp.close()
            run(c, f"mv {NGINX_CONF}.new {NGINX_CONF}")

            # 6) nginx -t,挂了立刻回滚
            code, out, err = run(c, "nginx -t 2>&1", check=False)
            if code != 0:
                info(f"  ✗ nginx -t 失败,回滚:\n{out}\n{err}")
                run(c, f"cp -p {backup} {NGINX_CONF}")
                fail("回滚已完成,人工排查后再来")
            info(f"  ✓ nginx -t OK")
            run(c, "nginx -s reload")
            info(f"  ✓ nginx -s reload OK")

        # 7) 服务器内 curl 验证 URL 可达
        url_path = f"/static/{REMOTE_NAME}"
        info(f"服务器自检 GET http://127.0.0.1{url_path} (HEAD only)...")
        _, out, _ = run(c, f"curl -sI http://127.0.0.1{url_path}")
        print("    ", out.replace("\n", "\n     ").rstrip())
        if "200 OK" not in out and "200" not in out.split()[1]:
            fail("服务器自检 HEAD 没返 200")
        if str(EXPECTED_SIZE) not in out:
            fail(f"Content-Length 不是 {EXPECTED_SIZE}")
        info("  ✓ 服务器自检 OK")

        info("")
        info("=== DONE ===")
        info(f"客户端会去拉:  http://{SERVER}{url_path}")
        info(f"SHA-256:        {EXPECTED_SHA}")
        info(f"Size:           {EXPECTED_SIZE} bytes")

    finally:
        c.close()


if __name__ == "__main__":
    main()
