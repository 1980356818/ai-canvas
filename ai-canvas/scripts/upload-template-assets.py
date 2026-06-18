"""
按 seed-templates.mts 产的 manifest,把模板图(内容哈希命名)上传到**极境 NAS**,
nginx 静态 serve(`www.jjowo.com/aicanvas-static/`,跟 ffmpeg 同套),**不走腾讯 COS**。

源:src/assets/templates/<localRel>
标:111.170.157.39:/www/aicanvas-static/templates/<remoteRel>(带 sha16)
公网:https://www.jjowo.com/aicanvas-static/templates/<remoteRel>

幂等:哈希命名 → 远端同名即同内容 → 存在就跳过。
prune:删 templates/ 下不在 manifest 里的旧文件(旧哈希/已删模板),保持整洁。

凭据只从环境变量读:AICAT_SSH_PASSWORD(极境 NAS root 密码,必需)。
跑法:$env:AICAT_SSH_PASSWORD="..."; python scripts/upload-template-assets.py
"""
import json
import os
import sys
import posixpath

import paramiko

SERVER = os.environ.get("AICAT_SSH_HOST", "111.170.157.39")
USER = os.environ.get("AICAT_SSH_USER", "root")
PWD = os.environ.get("AICAT_SSH_PASSWORD")

_HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(_HERE, "templates-assets-manifest.json")
LOCAL_DIR = os.path.join(_HERE, "..", "src", "assets", "templates")
REMOTE_DIR = "/www/aicanvas-static/templates"
REMOTE_OWNER = "www-data:www-data"
PUBLIC_HOST = "www.jjowo.com"


def run(ssh, cmd, check=True):
    _, out, err = ssh.exec_command(cmd)
    code = out.channel.recv_exit_status()
    o = out.read().decode(errors="replace")
    e = err.read().decode(errors="replace")
    if check and code != 0:
        print(f"  cmd: {cmd}\n  {e}")
        sys.exit(f"[FAIL] exit {code}")
    return o, e


def main():
    if not PWD:
        sys.exit("[FAIL] 请设环境变量 AICAT_SSH_PASSWORD(极境 NAS root 密码)")
    if not os.path.isfile(MANIFEST):
        sys.exit(f"[FAIL] 找不到 {MANIFEST},先跑 seed-templates.mts")

    manifest = json.load(open(MANIFEST, encoding="utf-8"))  # [{localRel, remoteRel}]
    keep = {m["remoteRel"] for m in manifest}
    total = 0
    for m in manifest:
        p = os.path.join(LOCAL_DIR, m["localRel"].replace("/", os.sep))
        if os.path.isfile(p):
            total += os.path.getsize(p)
    print(f"[upload] {len(manifest)} 张图(哈希命名), 合计 {total/1048576:.1f} MB → {USER}@{SERVER}:{REMOTE_DIR}")

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(SERVER, port=22, username=USER, password=PWD, timeout=15)
    print("[upload] SSH connected (极境 NAS)")
    try:
        # 远端已有文件清单(prune + 跳过用)
        run(c, f"mkdir -p {REMOTE_DIR}")
        out, _ = run(c, f"cd {REMOTE_DIR} && find . -type f 2>/dev/null | sed 's|^\\./||' || true", check=False)
        remote_existing = {ln.strip() for ln in out.splitlines() if ln.strip()}

        # 预建子目录
        dirs = sorted({posixpath.dirname(posixpath.join(REMOTE_DIR, m["remoteRel"])) for m in manifest})
        run(c, "mkdir -p " + " ".join(f"'{d}'" for d in dirs))

        sftp = c.open_sftp()
        up, skip = 0, 0
        for m in manifest:
            remote_rel = m["remoteRel"]
            if remote_rel in remote_existing:
                skip += 1  # 哈希命名 → 同名即同内容
                continue
            local = os.path.join(LOCAL_DIR, m["localRel"].replace("/", os.sep))
            if not os.path.isfile(local):
                print(f"  [WARN] 本地缺 {m['localRel']}, 跳过")
                continue
            remote = posixpath.join(REMOTE_DIR, remote_rel)
            sftp.put(local, remote + ".partial")
            run(c, f"chmod 644 '{remote}.partial' && mv '{remote}.partial' '{remote}'")
            up += 1
        sftp.close()
        run(c, f"chown -R {REMOTE_OWNER} {REMOTE_DIR} 2>/dev/null || true", check=False)

        # prune 远端孤儿(旧哈希 / 已删模板的图)
        pruned = 0
        for r in sorted(remote_existing - keep):
            run(c, f"rm -f '{posixpath.join(REMOTE_DIR, r)}'", check=False)
            pruned += 1

        # nginx HEAD 抽查
        sample = manifest[0]["remoteRel"] if manifest else None
        head = ""
        if sample:
            head, _ = run(c, f'curl -ksI -H "Host: {PUBLIC_HOST}" https://127.0.0.1/aicanvas-static/templates/{sample} | head -1', check=False)
        print(f"[upload] DONE — 上传 {up}, 跳过(已最新) {skip}, prune 旧文件 {pruned}")
        if sample:
            print(f"[upload] nginx HEAD /{sample}: {head.strip()}")
    finally:
        c.close()


if __name__ == "__main__":
    main()
