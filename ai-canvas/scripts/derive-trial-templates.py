"""派生试用版(trial)模板 —— 从 templates-seed.json 的 flat 模板自动克隆 `-trial` 双胞胎,
锁定 + `ENC1::` 编码提示词,**复用平面模板封面/参考图(零图片上传)**。

见 docs/平面模板试用版-提示词封装-施工图.md §3.2。

管线位置:import-aicat-templates.py → **本脚本** → seed-templates-db.py

跑法(PowerShell):
  python scripts/derive-trial-templates.py                          # dry-run:只报告,不写盘
  python scripts/derive-trial-templates.py --write --min-app-version 1.3.8

⚠ `--min-app-version` 是老客户端版本闸:没有解码钩子的旧版本会被 `GET /api/templates`
  版本守卫过滤掉(拿不到 ENC1:: 乱码就不会发上游)。**上 PROD 前必须设成发布解码钩子
  的那个版本**;dry-run/本地可不传。
"""
import argparse
import copy
import json
import os

from promptcloak import cloak, is_cloaked

_HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(_HERE, "templates-seed.json")
FALLBACK = os.path.join(_HERE, "..", "src", "config", "templatesFallback.json")

TRIAL_SUFFIX = "-trial"
# 提示词在 data.content 的 AI 生成卡(与客户端 build*Request 解码钩子覆盖范围一致)。
TRIAL_CARD_TYPES = {"ai_image", "ai_chat", "ai_video", "ai_tryon", "ai_multiangle"}
# 可能藏提示词的字段(逐一 cloak)。
PROMPT_FIELDS = ("content", "_systemPrompt", "_promptTemplate")
TRIAL_TPL_DESC = "试用版：提示词已封装，升级正式版后可查看与编辑"
CARD_LOCK_DESC = "试用模板：提示词已封装，升级正式版后可查看与编辑"

# 已有专门手作 trial 双胞胎(不同 id、含特殊处理)的 flat,不自动派生,避免重复:
#   wf-face-swap(换脸) → 手作 wf-face-merge-trial(带 gender 选项锁),保留手作版。
EXCLUDE_FLAT = {"wf-face-swap"}


def cloak_card_prompts(card) -> int:
    """对一张 AI 卡的提示词字段就地 cloak + 上锁。返回封装的字段数(0=该卡无提示词,不动)。"""
    if card.get("type") not in TRIAL_CARD_TYPES:
        return 0
    data = card.get("data")
    if not isinstance(data, dict):
        return 0
    n = 0
    for field in PROMPT_FIELDS:
        v = data.get(field)
        if isinstance(v, str) and v.strip() and not is_cloaked(v):
            data[field] = cloak(v)
            n += 1
    if n:
        data["_locked"] = True
        if not data.get("_label"):
            data["_label"] = card.get("title") or "模板节点"
        if not data.get("_description"):
            data["_description"] = CARD_LOCK_DESC
    return n


def cloak_template(tpl) -> int:
    """对一个模板的所有卡就地封装提示词。返回封装字段总数。"""
    return sum(cloak_card_prompts(c) for c in tpl.get("cards", []))


def make_trial_twin(flat, min_app_version):
    """flat 模板 → trial 双胞胎(深拷贝改 id/category/name + 封装提示词 + 复用封面)。"""
    twin = copy.deepcopy(flat)
    twin["id"] = flat["id"] + TRIAL_SUFFIX
    twin["category"] = "trial"
    name = flat.get("name") or flat["id"]
    if "试用" not in name:
        twin["name"] = f"{name}（试用）"
    twin["description"] = TRIAL_TPL_DESC
    if min_app_version:
        twin["min_app_version"] = min_app_version
    locked = cloak_template(twin)
    return twin, locked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="写回 seed + fallback(默认 dry-run 不写盘)")
    ap.add_argument(
        "--min-app-version",
        default=None,
        help="试用版 min_app_version 版本闸(老客户端无解码=被 API 版本守卫过滤)。"
        "不传则不设;⚠ 上 PROD 前必须设成发布解码钩子的版本",
    )
    args = ap.parse_args()

    templates = json.load(open(SEED, encoding="utf-8"))
    existing_ids = {t["id"] for t in templates}
    all_flat = [t for t in templates if t.get("category") == "flat"]
    flats = [t for t in all_flat if t["id"] not in EXCLUDE_FLAT]

    print(
        f"[derive] flat {len(all_flat)} 个,排除 {sorted(EXCLUDE_FLAT)} → 派生 {len(flats)} 个 trial 双胞胎"
        + ("" if args.min_app_version else "  (⚠ 未设 --min-app-version)")
    )

    twins = []
    total_locked = 0
    for f in flats:
        twin, locked = make_trial_twin(f, args.min_app_version)
        twins.append(twin)
        total_locked += locked
        tag = "↻覆盖手作" if twin["id"] in existing_ids else "+新增"
        cover = "复用封面" if twin.get("coverImage") else "无封面"
        print(f"  {tag:<8} {twin['id']:<34} 封装 {locked:>2} 条  {cover}")

    # 合并:替换同 id 的旧 trial(手作 outfit-fusion-trial/model-bag-trial → 封装版),
    # 保留其余(含手作 face-merge-trial / detail-cn-trial,且对它们也补封装)。
    twin_ids = {t["id"] for t in twins}
    merged = [t for t in templates if t["id"] not in twin_ids]
    kept_cloaked = 0
    for t in merged:
        if t.get("category") == "trial":
            c = cloak_template(t)
            kept_cloaked += c
            if c and args.min_app_version and not t.get("min_app_version"):
                t["min_app_version"] = args.min_app_version
            if c:
                print(f"  ~补封装   {t['id']:<34} 封装 {c:>2} 条  (保留的手作 trial)")
    merged.extend(twins)

    trial_total = sum(1 for t in merged if t.get("category") == "trial")
    print(
        f"[derive] 完成:派生 {len(twins)} + 保留手作补封装 {kept_cloaked} 条 → "
        f"trial 共 {trial_total} 个 / 模板总 {len(merged)} 个;新派生封装 {total_locked} 条提示词"
    )

    if not args.write:
        print("[derive] dry-run(未写盘)。确认无误后加 --write --min-app-version <发布版本> 落盘。")
        # dry-run 也产出 trial id 列表预览(给 tier_def 白名单用)
        print("[derive] trial id 列表(白名单用):")
        print("  " + json.dumps(sorted(t["id"] for t in merged if t.get("category") == "trial"), ensure_ascii=False))
        return

    for path in (SEED, FALLBACK):
        with open(path, "w", encoding="utf-8") as fp:
            json.dump(merged, fp, ensure_ascii=False, indent=2)
        print(f"[derive] 写回 {os.path.relpath(path, _HERE)} ({len(merged)} 个模板)")

    ids_path = os.path.join(_HERE, "trial-template-ids.json")
    trial_ids = sorted(t["id"] for t in merged if t.get("category") == "trial")
    with open(ids_path, "w", encoding="utf-8") as fp:
        json.dump(trial_ids, fp, ensure_ascii=False, indent=2)
    print(f"[derive] 写出 trial 白名单 id → {os.path.relpath(ids_path, _HERE)} ({len(trial_ids)} 个)")
    print("[derive] 下一步:python scripts/seed-templates-db.py 推库;再用 trial-template-ids.json 更新 tier_def 白名单。")


if __name__ == "__main__":
    main()
