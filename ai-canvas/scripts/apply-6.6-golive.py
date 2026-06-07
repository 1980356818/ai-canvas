"""
6.6 号模板「正式切换上线」一把梭(生产 aicat @ 101.37.80.236),原子事务:

  1. mysqldump 备份 template + tier_def → 远端 /tmp(可回滚)
  2. INSERT 新 27 个模板(ON DUPLICATE 只刷 cover_url+definition;新 id → is_active=1)
  3. UPDATE template SET is_active=0 WHERE id NOT IN(新 27)  —— 旧模板整体下架(保留可回滚)
  4. UPDATE tier_def 试用 tier 的 features.templates = 4 个 trial 模板 id(JSON_SET,保留其它 features)
  5. 校验:active 模板数/分类分布、试用白名单

凭据从环境变量读:AICAT_SSH_PASSWORD(=DB root 密码)。
跑法:$env:AICAT_SSH_PASSWORD="..."; python scripts/apply-6.6-golive.py
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
REMOTE_SQL = "/tmp/aicat-6.6-golive.sql"


def esc(s):
    if s is None:
        return "NULL"
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def run(ssh, cmd, check=True):
    _, out, err = ssh.exec_command(cmd)
    code = out.channel.recv_exit_status()
    o = out.read().decode(errors="replace")
    e = err.read().decode(errors="replace")
    if check and code != 0:
        print(f"  cmd: {cmd}\n  stdout: {o}\n  stderr: {e}")
        sys.exit(f"[FAIL] exit {code}")
    return o, e


def build_sql(templates):
    rows = []
    for i, t in enumerate(templates):
        definition = json.dumps(t, ensure_ascii=False)
        rows.append("(" + ",".join([
            esc(t["id"]), esc(t.get("name")), esc(t.get("description")), esc(t.get("icon")),
            esc(t.get("category")), esc(t.get("coverImage")), esc(definition),
            "NULL", str(i), "1",
        ]) + ")")
    all_ids = ",".join(esc(t["id"]) for t in templates)
    trial_ids = ",".join(esc(t["id"]) for t in templates if t.get("category") == "trial")
    return (
        "SET NAMES utf8mb4;\n"
        "START TRANSACTION;\n"
        "INSERT INTO `template` "
        "(`id`,`name`,`description`,`icon`,`category`,`cover_url`,`definition`,`min_app_version`,`sort`,`is_active`) VALUES\n"
        + ",\n".join(rows)
        + "\nON DUPLICATE KEY UPDATE cover_url=VALUES(cover_url),definition=VALUES(definition),"
        "category=VALUES(category),name=VALUES(name),description=VALUES(description),"
        "icon=VALUES(icon),sort=VALUES(sort),is_active=1;\n"
        # ↑ 新 id 是首次 INSERT;万一某 id 撞上旧行,这里把它当成新内容刷新并重新上架。
        f"UPDATE `template` SET is_active=0 WHERE id NOT IN ({all_ids});\n"
        f"UPDATE `tier_def` SET features=JSON_SET(features,'$.templates',JSON_ARRAY({trial_ids})) "
        "WHERE tier_key='trial';\n"
        "COMMIT;\n"
    )


def main():
    if not PWD:
        sys.exit("[FAIL] 请设环境变量 AICAT_SSH_PASSWORD")
    if not os.path.isfile(SEED):
        sys.exit(f"[FAIL] 找不到 {SEED},先跑 import-aicat-templates.py")

    templates = json.load(open(SEED, encoding="utf-8"))
    trial = [t["id"] for t in templates if t.get("category") == "trial"]
    print(f"[golive] {len(templates)} 个新模板;试用白名单({len(trial)}): {trial}")
    sql = build_sql(templates)
    local_sql = os.path.join(_HERE, "apply-6.6-golive.sql")
    with open(local_sql, "w", encoding="utf-8") as f:
        f.write(sql)
    print(f"[golive] 生成 SQL → {local_sql} ({len(sql)} 字节)")

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(SERVER, 22, USER, PWD, timeout=15)
    print(f"[golive] SSH connected {USER}@{SERVER}")
    try:
        # 表在?
        o, _ = run(c, "mysql -u root -p'%s' -N -e \"SELECT COUNT(*) FROM information_schema.tables "
                      "WHERE table_schema='aicat' AND table_name IN('template','tier_def')\"" % DBPWD)
        if o.strip() != "2":
            sys.exit("[FAIL] template/tier_def 表不齐")

        # 1) 备份
        ts, _ = run(c, "date +%Y%m%d_%H%M%S")
        ts = ts.strip()
        bak = f"/tmp/aicat_backup_template_tierdef_{ts}.sql"
        run(c, f"mysqldump -u root -p'{DBPWD}' --default-character-set=utf8mb4 aicat template tier_def > {bak}")
        sz, _ = run(c, f"wc -c < {bak}", check=False)
        print(f"[golive] 备份 → {bak} ({sz.strip()} 字节)")

        # 2-4) 导入(事务)
        sftp = c.open_sftp()
        sftp.put(local_sql, REMOTE_SQL)
        sftp.close()
        run(c, f"mysql -u root -p'{DBPWD}' --default-character-set=utf8mb4 aicat < {REMOTE_SQL}")

        # 5) 校验
        print("\n[golive] === active 模板(id | category | sort) ===")
        o, _ = run(c, "mysql -u root -p'%s' -N -e \"SELECT id,category,sort FROM aicat.template "
                      "WHERE is_active=1 ORDER BY sort\" aicat" % DBPWD)
        print(o.rstrip())
        o2, _ = run(c, "mysql -u root -p'%s' -N -e \"SELECT category,COUNT(*) FROM aicat.template "
                       "WHERE is_active=1 GROUP BY category\" aicat" % DBPWD)
        print("[golive] active 分类分布:\n" + o2.rstrip())
        o3, _ = run(c, "mysql -u root -p'%s' -N -e \"SELECT COUNT(*) FROM aicat.template WHERE is_active=0\" aicat" % DBPWD)
        print(f"[golive] 已下架(旧)模板数: {o3.strip()}")
        o4, _ = run(c, "mysql -u root -p'%s' -E -e \"SELECT tier_key,JSON_EXTRACT(features,'$.templates') t "
                       "FROM aicat.tier_def WHERE tier_key='trial'\" aicat" % DBPWD)
        print("[golive] 试用白名单:\n" + o4.rstrip())
        run(c, f"rm -f {REMOTE_SQL}", check=False)
        print("\n[golive] DONE — 切换完成(回滚: 把上面备份文件导回 aicat)")
    finally:
        c.close()


if __name__ == "__main__":
    main()
