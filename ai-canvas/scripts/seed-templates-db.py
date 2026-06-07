"""
把 scripts/templates-seed.json 的模板写入生产 aicat.template 表(幂等 upsert)。

前置:template 表已存在(部署时 apply schema.sql)。
凭据只从环境变量读,不写进文件:
  AICAT_SSH_PASSWORD   root@101.37.80.236 SSH 密码 (必需)
  AICAT_DB_PASSWORD    MySQL root 密码 (默认同 SSH 密码)
  AICAT_SSH_HOST/USER  默认 101.37.80.236 / root

跑法(PowerShell):
  $env:AICAT_SSH_PASSWORD="..."; python scripts/seed-templates-db.py
"""
import json
import os
import sys

import paramiko

SERVER = os.environ.get("AICAT_SSH_HOST", "101.37.80.236")
USER = os.environ.get("AICAT_SSH_USER", "root")
PWD = os.environ.get("AICAT_SSH_PASSWORD")
DBPWD = os.environ.get("AICAT_DB_PASSWORD") or PWD

_HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(_HERE, "templates-seed.json")
REMOTE_SQL = "/tmp/templates-seed.sql"


def esc(s):
    """MySQL 单引号字符串字面量转义(默认非 NO_BACKSLASH_ESCAPES 模式)。"""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def build_sql(templates):
    rows = []
    for i, t in enumerate(templates):
        definition = json.dumps(t, ensure_ascii=False)  # 紧凑 JSON,换行已转义为 \n
        rows.append("(" + ",".join([
            esc(t["id"]),
            esc(t.get("name")),
            esc(t.get("description")),
            esc(t.get("icon")),
            esc(t.get("category")),
            esc(t.get("coverImage")),   # 可能没有封面 → NULL
            esc(definition),
            "NULL",                      # min_app_version:现有模板全版本可用
            str(i),                      # sort:保留 WORKFLOW_TEMPLATES 顺序
            "1",                         # is_active
        ]) + ")")
    return (
        "SET NAMES utf8mb4;\n"
        "INSERT INTO `template` "
        "(`id`,`name`,`description`,`icon`,`category`,`cover_url`,`definition`,`min_app_version`,`sort`,`is_active`) VALUES\n"
        + ",\n".join(rows)
        # 重跑只刷新「图相关」字段(种子拥有);name/description/category/sort/is_active/min_app_version
        # 是 admin 可管理的「运营状态」,保留不覆盖 —— 否则重跑会把下架的模板又激活、把改过的名/排序冲掉。
        # 首次 INSERT 时这些字段照常从种子建立(默认 is_active=1)。
        + "\nON DUPLICATE KEY UPDATE "
        "cover_url=VALUES(cover_url),definition=VALUES(definition);\n"
    )


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
    if not os.path.isfile(SEED):
        sys.exit(f"[FAIL] 找不到种子文件 {SEED},先跑 seed-templates.mts")

    templates = json.load(open(SEED, encoding="utf-8"))
    print(f"[seed-db] 读到 {len(templates)} 个模板")
    sql = build_sql(templates)
    local_sql = os.path.join(_HERE, "templates-seed.sql")
    with open(local_sql, "w", encoding="utf-8") as f:
        f.write(sql)
    print(f"[seed-db] 生成 SQL → {local_sql} ({len(sql)} 字节)")

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(SERVER, port=22, username=USER, password=PWD, timeout=15)
    print(f"[seed-db] SSH connected {USER}@{SERVER}")
    try:
        sftp = c.open_sftp()
        sftp.put(local_sql, REMOTE_SQL)
        sftp.close()
        # 先确认表在
        o, _ = run(c, "mysql -u root -p'%s' -N -e \"SELECT COUNT(*) FROM information_schema.tables "
                      "WHERE table_schema='aicat' AND table_name='template'\"" % DBPWD)
        if o.strip() != "1":
            sys.exit("[FAIL] aicat.template 表不存在 — 先 apply schema.sql(部署脚本)")
        # 导入
        run(c, f"mysql -u root -p'{DBPWD}' --default-character-set=utf8mb4 aicat < {REMOTE_SQL}")
        # 校验(ORDER BY id 走主键索引,不触发 filesort;ORDER BY sort 会把大 definition
        # 整行塞进 sort buffer 导致 ERROR 1038 Out of sort memory——那只是校验查询炸,导入已成功)
        o, _ = run(c, "mysql -u root -p'%s' -N -e \"SELECT id,is_active,CHAR_LENGTH(definition) "
                      "FROM aicat.template ORDER BY id\" aicat" % DBPWD)
        print("[seed-db] 入库结果 (id / is_active / definition 长度):")
        print(o.rstrip())
        o2, _ = run(c, "mysql -u root -p'%s' -N -e \"SELECT COUNT(*) FROM aicat.template WHERE is_active=1\" aicat" % DBPWD)
        print(f"[seed-db] DONE — active 模板数: {o2.strip()}")
        run(c, f"rm -f {REMOTE_SQL}", check=False)
    finally:
        c.close()


if __name__ == "__main__":
    main()
