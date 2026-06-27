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

from promptcloak import cloak_template, handle_chat_result

_HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(_HERE, "templates-seed.json")
FALLBACK = os.path.join(_HERE, "..", "src", "config", "templatesFallback.json")

TRIAL_SUFFIX = "-trial"
TRIAL_TPL_DESC = "试用版：提示词已封装，升级正式版后可查看与编辑"
CARD_LOCK_DESC = "试用模板：提示词已封装，升级正式版后可查看与编辑"

# 已有专门手作 trial 双胞胎(不同 id、含特殊处理)的 flat,不自动派生,避免重复:
#   wf-face-swap(换脸) → 手作 wf-face-merge-trial(带 gender 选项锁),保留手作版。
EXCLUDE_SRC = {"wf-face-swap"}
EXCLUDE_FLAT = EXCLUDE_SRC  # 向后兼容(legacy 脚本仍 import 此名)

# 允许派生 trial 的源类别。detail(详情页)与 flat 共享同一套客户端解码钩子,可一并派生。
ALLOWED_SOURCE_CATEGORIES = {"flat", "detail", "video"}


# 源分类 → trial 双胞胎的独立分组。video/detail 各自落进专属 trial 分组,正式版/付费档
# 按分类整组隐藏(服务端 tier_def.templateCategories 过滤,见 TemplateService.listForClient),
# 试用档按分类授予;其余源(flat 等)归通用 trial 组。
TRIAL_CATEGORY_MAP = {"video": "trial-video", "detail": "trial-detail"}

def make_trial_twin(src, min_app_version):
    """源模板(flat/detail/video)→ trial 双胞胎(深拷贝改 id/category/name + result 处理 + 封装提示词 + 复用封面)。"""
    twin = copy.deepcopy(src)
    twin["id"] = src["id"] + TRIAL_SUFFIX
    twin["category"] = TRIAL_CATEGORY_MAP.get(src.get("category"), "trial")
    name = src.get("name") or src["id"]
    if "试用" not in name:
        twin["name"] = f"{name}（试用）"
    twin["description"] = TRIAL_TPL_DESC
    if min_app_version:
        twin["min_app_version"] = min_app_version
    # 顺序固定:先 result 处理(可能改下游 content),再 cloak(把新 content 一并封装)
    handle_chat_result(twin)
    locked = cloak_template(twin, lock_description=CARD_LOCK_DESC)
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
    all_src = [t for t in templates if t.get("category") in ALLOWED_SOURCE_CATEGORIES and not t["id"].endswith(TRIAL_SUFFIX)]
    srcs = [t for t in all_src if t["id"] not in EXCLUDE_SRC]
    by_cat = {}
    for t in srcs:
        by_cat[t.get("category")] = by_cat.get(t.get("category"), 0) + 1

    print(
        f"[derive] 源 {len(all_src)} 个 {dict(by_cat)},排除 {sorted(EXCLUDE_SRC)} → 派生 {len(srcs)} 个 trial 双胞胎"
        + ("" if args.min_app_version else "  (⚠ 未设 --min-app-version)")
    )

    twins = []
    total_locked = 0
    total_stats = [0, 0, 0]  # cleared, injected, preserved
    for f in srcs:
        # 复算 stats(make_trial_twin 内部已跑过 handle_chat_result,这里独立干跑一次拿计数)
        preview = copy.deepcopy(f)
        c, inj, kept = handle_chat_result(preview)
        total_stats[0] += c
        total_stats[1] += inj
        total_stats[2] += kept

        twin, locked = make_trial_twin(f, args.min_app_version)
        twins.append(twin)
        total_locked += locked
        tag = "↻覆盖手作" if twin["id"] in existing_ids else "+新增"
        cover = "复用封面" if twin.get("coverImage") else "无封面"
        extra = []
        if c: extra.append(f"清result {c}")
        if inj: extra.append(f"拼下游 {inj}")
        if kept: extra.append(f"留result {kept}")
        extras = " ".join(extra)
        print(f"  {tag:<8} {twin['id']:<34} 封装 {locked:>2} 条  {cover}  {f.get('category'):<6} {extras}")

    # 合并:替换同 id 的旧 trial(手作 outfit-fusion-trial/model-bag-trial → 封装版),
    # 保留其余(含手作 face-merge-trial / detail-cn-trial,且对它们也补封装)。
    twin_ids = {t["id"] for t in twins}
    merged = [t for t in templates if t["id"] not in twin_ids]
    kept_cloaked = 0
    for t in merged:
        if t.get("category") == "trial":
            c = cloak_template(t, lock_description=CARD_LOCK_DESC)
            kept_cloaked += c
            if c and args.min_app_version and not t.get("min_app_version"):
                t["min_app_version"] = args.min_app_version
            if c:
                print(f"  ~补封装   {t['id']:<34} 封装 {c:>2} 条  (保留的手作 trial)")
    merged.extend(twins)

    trial_total = sum(1 for t in merged if t.get("category") == "trial" or t["id"].endswith(TRIAL_SUFFIX))
    print(
        f"[derive] 完成:派生 {len(twins)} + 保留手作补封装 {kept_cloaked} 条 → "
        f"trial 共 {trial_total} 个 / 模板总 {len(merged)} 个;新派生封装 {total_locked} 条提示词"
    )
    print(
        f"[derive] result 字段处理:Case1 清空 {total_stats[0]} 个 / "
        f"Case2 拼下游 {total_stats[1]} 个 / 保留(下游非chat) {total_stats[2]} 个"
    )

    if not args.write:
        print("[derive] dry-run(未写盘)。确认无误后加 --write --min-app-version <发布版本> 落盘。")
        # dry-run 也产出 trial id 列表预览(给 tier_def 白名单用)
        print("[derive] trial id 列表(白名单用):")
        print("  " + json.dumps(sorted(t["id"] for t in merged if t.get("category") == "trial" or t["id"].endswith(TRIAL_SUFFIX)), ensure_ascii=False))
        return

    for path in (SEED, FALLBACK):
        with open(path, "w", encoding="utf-8") as fp:
            json.dump(merged, fp, ensure_ascii=False, indent=2)
        print(f"[derive] 写回 {os.path.relpath(path, _HERE)} ({len(merged)} 个模板)")

    ids_path = os.path.join(_HERE, "trial-template-ids.json")
    trial_ids = sorted(t["id"] for t in merged if t.get("category") == "trial" or t["id"].endswith(TRIAL_SUFFIX))
    with open(ids_path, "w", encoding="utf-8") as fp:
        json.dump(trial_ids, fp, ensure_ascii=False, indent=2)
    print(f"[derive] 写出 trial 白名单 id → {os.path.relpath(ids_path, _HERE)} ({len(trial_ids)} 个)")
    print("[derive] 下一步:python scripts/seed-templates-db.py 推库;再用 trial-template-ids.json 更新 tier_def 白名单。")


if __name__ == "__main__":
    main()
