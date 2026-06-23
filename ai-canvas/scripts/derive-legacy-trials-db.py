# -*- coding: utf-8 -*-
"""DB 直连版:给「不在 templates-seed.json、由 SQL 直接上架」的 legacy flat 模板派生 -trial 双胞胎。

背景:derive-trial-templates.py 只覆盖 seed 内的 flat(import 管线产物);PROD 库里还有
~10 个 legacy 手写 flat(wf-tryon / wf-white-bg / wf-mirror-selfie …)不在 seed 里。
本脚本直接从库读这些 flat 的 definition → 复用 derive 的 make_trial_twin 派生封装版
→ upsert 回库(min_app_version 直接写列,不依赖后续 UPDATE)。

与 seed 管线互不重叠:只处理「库里 category=flat 且 id 不在 seed」的模板;产出的 trial
不写进 seed/fallback(离线 fallback 不含 legacy trial,可接受)。legacy flat 在库里被
admin 改动后,需重跑本脚本刷新对应 trial。

跑法(PowerShell):
  $env:AICAT_SSH_PASSWORD="..."; python scripts/derive-legacy-trials-db.py            # dry-run:只分析
  $env:AICAT_SSH_PASSWORD="..."; python scripts/derive-legacy-trials-db.py --write --min-app-version 1.3.8
"""
import argparse
import base64
import importlib.util
import json
import os
import sys

import paramiko

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)  # derive 内部 `from promptcloak import …`

_spec = importlib.util.spec_from_file_location(
    "derive_trial_templates", os.path.join(_HERE, "derive-trial-templates.py"))
derive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(derive)

SERVER = os.environ.get("AICAT_SSH_HOST", "101.37.80.236")
USER = os.environ.get("AICAT_SSH_USER", "root")
PWD = os.environ.get("AICAT_SSH_PASSWORD")
DBPWD = os.environ.get("AICAT_DB_PASSWORD") or PWD
SEED = os.path.join(_HERE, "templates-seed.json")
REMOTE_SQL = "/tmp/legacy-trials.sql"
LEGACY_SORT_BASE = 100  # 排在 seed 派生 trial 之后


def esc(s):
    if s is None:
        return "NULL"
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def b64col(col):
    """TO_BASE64 会按 76 字符插换行,剥掉;NULL 安全。"""
    return f"IFNULL(REPLACE(TO_BASE64({col}), '\\n', ''), '')"


def fetch_legacy_flats(ssh):
    seed_ids = {t["id"] for t in json.load(open(SEED, encoding="utf-8"))}
    cols = ", ".join([
        "id", "category", "sort",
        b64col("name"), b64col("description"), b64col("icon"),
        b64col("cover_url"), b64col("definition"),
    ])
    sql = f"SELECT {cols} FROM aicat.template WHERE category='flat' ORDER BY sort, id"
    cmd = (f"mysql -u root -p'{DBPWD}' --default-character-set=utf8mb4 -N -e \"{sql}\" 2>&1 "
           "| grep -v 'Using a password'")
    _, out, _ = ssh.exec_command(cmd)
    raw = out.read().decode("utf-8", "replace").strip()

    def deb64(s):
        return base64.b64decode(s).decode("utf-8") if s else None

    flats = []
    for line in raw.splitlines():
        f = line.split("\t")
        if len(f) != 8:
            sys.exit(f"[FAIL] 行解析异常: {line[:120]}")
        tpl_id = f[0]
        if tpl_id in seed_ids or tpl_id in derive.EXCLUDE_FLAT:
            continue
        flats.append({
            "id": tpl_id, "sort": int(f[2]),
            "name": deb64(f[3]), "description": deb64(f[4]), "icon": deb64(f[5]),
            "cover_url": deb64(f[6]), "definition": json.loads(deb64(f[7])),
        })
    return flats


def cloak_tryon_instruction(twin):
    """ai_tryon 的提示词在 data.instruction(客户端 buildTryonRequest 解码),derive 的
    PROMPT_FIELDS 不含它 → 这里补封装,锁卡逻辑与 derive.cloak_card_prompts 一致。"""
    n = 0
    for card in twin.get("cards", []):
        if card.get("type") != "ai_tryon":
            continue
        data = card.get("data")
        if not isinstance(data, dict):
            continue
        v = data.get("instruction")
        if isinstance(v, str) and v.strip() and not derive.is_cloaked(v):
            data["instruction"] = derive.cloak(v)
            data["_locked"] = True
            if not data.get("_label"):
                data["_label"] = card.get("title") or "模板节点"
            if not data.get("_description"):
                data["_description"] = derive.CARD_LOCK_DESC
            n += 1
    return n


def analyze(flat, twin, locked):
    """dry-run 体检:报卡型分布 + 没封装到任何字段的 AI 卡(可能提示词藏在别的字段)。"""
    d = flat["definition"]
    cards = d.get("cards")
    if not isinstance(cards, list):
        print(f"  !! {flat['id']}: definition 无 cards 数组,跳过派生会失败")
        return
    types = {}
    for c in cards:
        types[c.get("type", "?")] = types.get(c.get("type", "?"), 0) + 1
    unlocked_ai = []
    for c in twin.get("cards", []):
        if c.get("type") in derive.TRIAL_CARD_TYPES:
            data = c.get("data") or {}
            if not data.get("_locked"):
                keys = [k for k, v in data.items()
                        if isinstance(v, str) and len(v.strip()) > 20]
                unlocked_ai.append(f"{c.get('type')}({c.get('title')}) 长文本字段={keys}")
    print(f"  {flat['id']:<28} 卡 {len(cards):>2} {types}  封装 {locked:>2} 条"
          + (f"  ⚠ 未锁AI卡: {unlocked_ai}" if unlocked_ai else ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="推库(默认 dry-run 只分析)")
    ap.add_argument("--min-app-version", default=None)
    args = ap.parse_args()
    if not PWD:
        sys.exit("[FAIL] 请设环境变量 AICAT_SSH_PASSWORD")
    if args.write and not args.min_app_version:
        sys.exit("[FAIL] --write 必须带 --min-app-version(老客户端无解码钩子,必须上版本闸)")

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(SERVER, port=22, username=USER, password=PWD, timeout=15)
    try:
        flats = fetch_legacy_flats(c)
        print(f"[legacy-derive] 库中 legacy flat(不在 seed): {len(flats)} 个")
        rows = []
        for i, f in enumerate(flats):
            twin, locked = derive.make_trial_twin(f["definition"], args.min_app_version)
            locked += cloak_tryon_instruction(twin)
            # definition 内的 id/name/category 也要对齐(make_trial_twin 已改),库列单独给
            analyze(f, twin, locked)
            rows.append("(" + ",".join([
                esc(twin["id"]),
                esc(twin.get("name") or (f["name"] or f["id"]) + "（试用）"),
                esc(derive.TRIAL_TPL_DESC),
                esc(f["icon"]),
                esc("trial"),
                esc(f["cover_url"]),
                esc(json.dumps(twin, ensure_ascii=False)),
                esc(args.min_app_version),
                str(LEGACY_SORT_BASE + i),
                "1",
            ]) + ")")

        if not args.write:
            print("[legacy-derive] dry-run(未推库)。trial id 列表:")
            print("  " + json.dumps([f["id"] + "-trial" for f in flats], ensure_ascii=False))
            return

        sql = ("SET NAMES utf8mb4;\n"
               "INSERT INTO `template` "
               "(`id`,`name`,`description`,`icon`,`category`,`cover_url`,`definition`,"
               "`min_app_version`,`sort`,`is_active`) VALUES\n"
               + ",\n".join(rows)
               + "\nON DUPLICATE KEY UPDATE cover_url=VALUES(cover_url),"
                 "definition=VALUES(definition),min_app_version=VALUES(min_app_version);\n")
        local_sql = os.path.join(_HERE, "legacy-trials.sql")
        with open(local_sql, "w", encoding="utf-8") as fp:
            fp.write(sql)
        sftp = c.open_sftp()
        sftp.put(local_sql, REMOTE_SQL)
        sftp.close()
        cmd = (f"mysql -u root -p'{DBPWD}' --default-character-set=utf8mb4 aicat < {REMOTE_SQL}"
               f" && rm -f {REMOTE_SQL}")
        _, out, err = c.exec_command(cmd)
        code = out.channel.recv_exit_status()
        if code != 0:
            sys.exit(f"[FAIL] 导入失败 exit {code}: {err.read().decode(errors='replace')}")
        print(f"[legacy-derive] 推库完成 {len(rows)} 个 trial(min_app_version={args.min_app_version})")
    finally:
        c.close()


if __name__ == "__main__":
    main()
