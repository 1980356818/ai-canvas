"""
部署 ai-canvas-server 的「模板服务端化」特性到生产 101.37.80.236(全加性、可回滚):
  1. 备份现网 JAR → .bak
  2. apply schema.sql(幂等,IF NOT EXISTS/INSERT IGNORE)→ 建 template 表
  3. scp 新 JAR
  4. systemctl restart + 验活 + journalctl
  5. curl 本地 /api/templates 确认端点起来(此时可能空表,只验证端点活)
失败时新 JAR 还原:手动 `mv .bak 回 jar 再 restart`(脚本会打印回滚命令)。

凭据只从环境变量读:
  AICAT_SSH_PASSWORD  root@101.37.80.236 SSH 密码(也用作 MySQL root 密码,除非另设 AICAT_DB_PASSWORD)

跑法:$env:AICAT_SSH_PASSWORD="..."; python deploy-template-feature.py
"""
import os
import sys
import time

import paramiko

SERVER = os.environ.get("AICAT_SSH_HOST", "101.37.80.236")
USER = os.environ.get("AICAT_SSH_USER", "root")
PWD = os.environ.get("AICAT_SSH_PASSWORD")
DBPWD = os.environ.get("AICAT_DB_PASSWORD") or PWD

_HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_JAR = os.path.join(_HERE, "ai-canvas-server", "target", "ai-canvas-server-0.1.0.jar")
LOCAL_SCHEMA = os.path.join(_HERE, "ai-canvas-server", "src", "main", "resources", "db", "schema.sql")
REMOTE_JAR = "/opt/ai-canvas/ai-canvas-server.jar"
REMOTE_SCHEMA = "/tmp/aicat-schema.sql"


def run(ssh, cmd, check=True):
    _, out, err = ssh.exec_command(cmd)
    code = out.channel.recv_exit_status()
    o = out.read().decode(errors="replace")
    e = err.read().decode(errors="replace")
    if check and code != 0:
        print(f"  cmd: {cmd}\n  stdout: {o}\n  stderr: {e}")
        sys.exit(f"[FAIL] exit {code}")
    return o, e


def main():
    if not PWD:
        sys.exit("[FAIL] 请设环境变量 AICAT_SSH_PASSWORD")
    for p in (LOCAL_JAR, LOCAL_SCHEMA):
        if not os.path.isfile(p):
            sys.exit(f"[FAIL] 找不到 {p}")

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(SERVER, port=22, username=USER, password=PWD, timeout=15)
    print(f"[deploy] SSH connected {USER}@{SERVER}")
    try:
        # 1. 备份现网 JAR
        run(c, f"cp -f {REMOTE_JAR} {REMOTE_JAR}.bak", check=False)
        print(f"[deploy] 已备份 → {REMOTE_JAR}.bak")

        # 2. apply schema(幂等)
        sftp = c.open_sftp()
        sftp.put(LOCAL_SCHEMA, REMOTE_SCHEMA)
        print("[deploy] schema.sql 已上传, apply 中...")
        run(c, f"mysql -u root -p'{DBPWD}' --default-character-set=utf8mb4 < {REMOTE_SCHEMA}")
        o, _ = run(c, "mysql -u root -p'%s' -N -e \"SELECT COUNT(*) FROM information_schema.tables "
                      "WHERE table_schema='aicat' AND table_name='template'\"" % DBPWD)
        if o.strip() != "1":
            sys.exit("[FAIL] template 表未创建")
        print("[deploy] ✓ aicat.template 表就绪")

        # 3. 上传新 JAR
        sftp.put(LOCAL_JAR, REMOTE_JAR)
        sftp.close()
        sz, _ = run(c, f"stat -c %s {REMOTE_JAR}")
        print(f"[deploy] ✓ 新 JAR 已上传 ({int(sz.strip()) // 1048576} MB)")

        # 4. 重启 + 验活
        run(c, "systemctl daemon-reload && systemctl restart ai-canvas", check=False)
        print("[deploy] 重启中, 等 9s...")
        time.sleep(9)
        status, _ = run(c, "systemctl is-active ai-canvas", check=False)
        status = status.strip()
        print(f"[deploy] 服务状态: {status}")
        if status != "active":
            jo, _ = run(c, "journalctl -u ai-canvas --no-pager -n 30", check=False)
            print(jo)
            print("\n[ROLLBACK] 新 JAR 起不来,回滚:")
            print(f"  ssh {USER}@{SERVER} 'mv {REMOTE_JAR}.bak {REMOTE_JAR} && systemctl restart ai-canvas'")
            sys.exit("[FAIL] 服务未 active")

        # 5. 验证端点活(空表也应 200 + data:[])
        body, _ = run(c, "curl -s --max-time 10 http://127.0.0.1:8090/api/templates", check=False)
        print(f"[deploy] GET /api/templates → {body[:200]}")
        if '"code":0' not in body:
            print("[WARN] 端点未返 code:0,检查日志:")
            jo, _ = run(c, "journalctl -u ai-canvas --no-pager -n 20", check=False)
            print(jo)
        else:
            print("[deploy] ✓ /api/templates 端点已活")

        print("\n[deploy] === 后端部署完成 ===")
        print("[deploy] 下一步: python ai-canvas/scripts/seed-templates-db.py 写入 16 模板")
    finally:
        c.close()


if __name__ == "__main__":
    main()
