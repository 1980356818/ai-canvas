"""就地封装/解封指定分类模板的提示词(直接操作生产 DB,不改种子文件)。

用途:为 trial-video-detail 等级封装 video+detail 分类的提示词。
不同于 derive-trial-templates.py(派生 trial 副本到种子文件),本脚本**原地修改** DB 中
已有模板的 definition JSON。幂等:遇 ENC1:: 跳过。

凭据只从环境变量读,不写进文件(同 seed-templates-db.py):
  AICAT_SSH_PASSWORD   root@101.37.80.236 SSH 密码 (必需)
  AICAT_DB_PASSWORD    MySQL root 密码 (默认同 SSH 密码)

跑法(PowerShell):
  # dry-run(只报告不写库):
  $env:AICAT_SSH_PASSWORD="..."; python scripts/cloak-templates.py --categories video,detail

  # 执行封装 + 设版本闸:
  $env:AICAT_SSH_PASSWORD="..."; python scripts/cloak-templates.py --categories video,detail --write --min-app-version 1.3.8

  # 回滚(解封 + 去版本闸):
  $env:AICAT_SSH_PASSWORD="..."; python scripts/cloak-templates.py --categories video,detail --uncloak --write
"""
import argparse
import json
import os
import sys

import paramiko

from promptcloak import cloak_template, uncloak_template

SERVER = os.environ.get("AICAT_SSH_HOST", "101.37.80.236")
USER = os.environ.get("AICAT_SSH_USER", "root")
PWD = os.environ.get("AICAT_SSH_PASSWORD")
DBPWD = os.environ.get("AICAT_DB_PASSWORD") or PWD

_HERE = os.path.dirname(os.path.abspath(__file__))
LOCK_DESC = "提示词已封装，升级后可查看与编辑"


def run(ssh, cmd, check=True):
    _, out, err = ssh.exec_command(cmd)
    code = out.channel.recv_exit_status()
    o = out.read().decode(errors="replace")
    e = err.read().decode(errors="replace")
    if check and code != 0:
        print(f"  cmd: {cmd}\n  stdout: {o}\n  stderr: {e}")
        sys.exit(f"[FAIL] exit {code}")
    return o, e


def esc(s):
    """MySQL 单引号字面量转义。"""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def main():
    ap = argparse.ArgumentParser(description="就地封装/解封指定分类模板的提示词")
    ap.add_argument("--categories", required=True,
                    help="逗号分隔分类(如 video,detail)")
    ap.add_argument("--write", action="store_true",
                    help="执行写入(默认 dry-run)")
    ap.add_argument("--uncloak", action="store_true",
                    help="解封模式(回滚)")
    ap.add_argument("--min-app-version", default=None,
                    help="封装模板的 min_app_version 版本闸(解封时自动清除)")
    args = ap.parse_args()

    cats = [c.strip() for c in args.categories.split(",") if c.strip()]
    if not cats:
        sys.exit("[FAIL] --categories 不能为空")
    if not PWD:
        sys.exit("[FAIL] 请设环境变量 AICAT_SSH_PASSWORD")

    action = "解封" if args.uncloak else "封装"
    cat_sql = ",".join(esc(c) for c in cats)

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(SERVER, port=22, username=USER, password=PWD, timeout=15)
    print(f"[cloak] SSH connected {USER}@{SERVER}")

    try:
        # 读取目标模板(definition 用 HEX 编码避免 tab/换行解析问题)
        query = (
            f"SELECT id, category, HEX(definition), IFNULL(min_app_version,'') "
            f"FROM aicat.template "
            f"WHERE category IN ({cat_sql}) AND is_active=1 ORDER BY sort"
        )
        o, _ = run(ssh, f"mysql -u root -p'{DBPWD}' -N -B -e \"{query}\" aicat")

        templates = []
        for line in o.strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split("\t", 3)
            if len(parts) < 3:
                print(f"  ⚠ 跳过异常行: {line[:80]}...")
                continue
            tid, cat = parts[0], parts[1]
            hex_defn = parts[2] if len(parts) == 3 else parts[2]
            mav = parts[3] if len(parts) > 3 else ""
            try:
                defn = bytes.fromhex(hex_defn).decode("utf-8")
                tpl = json.loads(defn)
            except (ValueError, json.JSONDecodeError) as e:
                print(f"  ⚠ {tid}: definition 解析失败 ({e}), 跳过")
                continue
            templates.append({
                "id": tid, "category": cat, "tpl": tpl,
                "mav": mav if mav else None,
            })

        print(f"[cloak] 读取 {len(templates)} 个活跃模板 (分类: {','.join(cats)})")
        if not templates:
            print("[cloak] 无目标模板")
            return

        # 封装/解封
        updates = []
        for item in templates:
            tpl = item["tpl"]
            if args.uncloak:
                n = uncloak_template(tpl)
            else:
                n = cloak_template(tpl, lock_description=LOCK_DESC)
            if n > 0:
                new_defn = json.dumps(tpl, ensure_ascii=False)
                if args.uncloak:
                    new_mav = None
                else:
                    new_mav = args.min_app_version or item["mav"]
                updates.append({
                    "id": item["id"], "definition": new_defn,
                    "mav": new_mav, "count": n, "category": item["category"],
                })
                print(f"  {action} {item['id']:<34} {n:>2} 条  [{item['category']}]")
            else:
                status = "已封装" if not args.uncloak else "未封装"
                print(f"  跳过 {item['id']:<34} ({status})  [{item['category']}]")

        print(f"\n[cloak] {action}合计: {len(updates)}/{len(templates)} 个模板有变化")
        if not updates:
            print("[cloak] 无需更新")
            return

        if not args.write:
            print(f"[cloak] dry-run(未写库)。确认无误后加 --write 执行。")
            if not args.uncloak and not args.min_app_version:
                print("  ⚠ 未设 --min-app-version，上 PROD 前必须设(老客户端无解码会发乱码)")
            return

        # 备份
        backup = "/tmp/aicat_template_cloak_backup.sql"
        print(f"[cloak] 备份 → {backup}")
        run(ssh, f"mysqldump -u root -p'{DBPWD}' --no-create-info "
            f"--where=\"category IN ({cat_sql})\" aicat template > {backup}")

        # 生成 UPDATE SQL(definition 用 HEX 编码,彻底回避转义问题)
        stmts = ["SET NAMES utf8mb4;\n"]
        for u in updates:
            hex_defn = u["definition"].encode("utf-8").hex().upper()
            if u["mav"]:
                mav_clause = f", min_app_version={esc(u['mav'])}"
            else:
                mav_clause = ", min_app_version=NULL"
            stmts.append(
                f"UPDATE `template` SET definition=CONVERT(UNHEX('{hex_defn}') USING utf8mb4){mav_clause} "
                f"WHERE id={esc(u['id'])};\n"
            )
        sql = "".join(stmts)

        # SFTP 上传 → 执行
        remote_sql = "/tmp/cloak-templates-update.sql"
        sftp = ssh.open_sftp()
        with sftp.open(remote_sql, "w") as f:
            f.write(sql)
        sftp.close()
        print(f"[cloak] 上传 SQL ({len(sql)} 字节)")

        run(ssh, f"mysql -u root -p'{DBPWD}' --default-character-set=utf8mb4 "
            f"aicat < {remote_sql}")

        # 校验
        o, _ = run(ssh,
            f"mysql -u root -p'{DBPWD}' -N -e "
            f"\"SELECT id, min_app_version, CHAR_LENGTH(definition) "
            f"FROM aicat.template WHERE category IN ({cat_sql}) ORDER BY sort\" aicat")
        print(f"[cloak] 入库结果 (id / mav / defn长度):")
        print(o.rstrip())

        run(ssh, f"rm -f {remote_sql}", check=False)
        print(f"\n[cloak] DONE — {len(updates)} 个模板已{action}")
        print(f"[cloak] 回滚: mysql -u root -p'...' aicat < {backup}")

    finally:
        ssh.close()


if __name__ == "__main__":
    main()
