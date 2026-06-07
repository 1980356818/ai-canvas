# -*- coding: utf-8 -*-
"""按「真实角色」规范化模板里图片卡的标签:参考图N / 效果图N。

只动 IMG 卡的**通用标签**(效果图N/参考图N/图片N);描述性名字(模特图/服装图/人脸合成/
人物1/详情页/帧…)一律保留。不动连线/坐标/data 其它字段/提示词/视频/文本卡。

角色判定(已逐字段实库核实,无歧义):
  - 效果图(effect = AI 生成图):卡片**有生成提示词 content**,或**有入边**(被上游生成/喂入)。
    包含「由文字从零生成、不接收输入图、却作为流程起点」的生成卡(它们带 gpt-image-2/gemini
    等真实模型,确属生成图)。
  - 参考图(reference = 静态上传图):**无 content 且无入边**的叶子上传图。

编号(最小改动):每个模板内,通用标签的卡按角色分组重排成 参考图1/2/3… 与 效果图1/2/3…
(描述性名字不参与编号、不占号)。**保留原有顺序** —— 已是正确角色前缀的卡按其原编号排序在前,
被纠正角色的卡(图片N、或角色标错的 参考图/效果图)按原编号排在其后;再统一赋 1..k 闭合空缺。
故角色正确且本就连续的模板零改动,只动真正错的(角色错/图片N/编号有洞)。

标签纯展示(连线用下标、提示词用「图N」按连线序在实例化时重建),改名零功能影响。
试用版锁定卡的展示名在 data._label,必须与 title 同步更新。

跑法:
  python scripts/relabel-templates.py            # 干跑:打印 改前→改后 映射,不写文件
  python scripts/relabel-templates.py --write     # 落地:覆盖 templates-seed.json + templatesFallback.json
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED = os.path.join(ROOT, "scripts", "templates-seed.json")
FALLBACK = os.path.join(ROOT, "src", "config", "templatesFallback.json")

IMG_TYPES = {"ai_image", "ai_multiangle", "ai_tryon"}
# 通用标签 = 效果图/参考图/图片 + 可选数字(整串匹配)。描述性名字不匹配 → 保留。
GENERIC_RE = re.compile(r"^(效果图|参考图|图片)(\d*)$")


def _disp_label(card):
    d = card.get("data") or {}
    return (card.get("title") or "").strip() or (d.get("_label") or "").strip()


def relabel(t):
    """就地规范化一个模板的图片卡标签。返回 [(idx, old, new), …](仅实际变动)。"""
    cards = t.get("cards") or []
    n = len(cards)
    indeg = [0] * n
    for cn in (t.get("connections") or []):
        s, d = cn.get("sourceIndex"), cn.get("targetIndex")
        if isinstance(s, int) and isinstance(d, int) and 0 <= s < n and 0 <= d < n:
            indeg[d] += 1

    # 分四桶:角色已正确(保留原编号序)/ 角色被纠正(排在后面)。
    eff_keep, eff_fix, ref_keep, ref_fix = [], [], [], []
    for i, c in enumerate(cards):
        if c.get("type") not in IMG_TYPES:
            continue
        m = GENERIC_RE.match(_disp_label(c))
        if not m:
            continue  # 描述性名字 → 不动
        prefix, num = m.group(1), int(m.group(2)) if m.group(2) else 0
        d = c.get("data") or {}
        has_content = bool((d.get("content") or "").strip())
        role = "effect" if (has_content or indeg[i] > 0) else "reference"
        if role == "effect":
            (eff_keep if prefix == "效果图" else eff_fix).append((num, i))
        else:
            (ref_keep if prefix == "参考图" else ref_fix).append((num, i))

    # 已正确的按原编号序在前,被纠正的按原编号序在后 → 统一 1..k(闭合空缺/收编纠正卡)。
    eff_order = [i for _, i in sorted(eff_keep)] + [i for _, i in sorted(eff_fix)]
    ref_order = [i for _, i in sorted(ref_keep)] + [i for _, i in sorted(ref_fix)]
    newlabel = {}
    for k, i in enumerate(eff_order, 1):
        newlabel[i] = f"效果图{k}"
    for k, i in enumerate(ref_order, 1):
        newlabel[i] = f"参考图{k}"

    changes = []
    for i, lab in newlabel.items():
        c = cards[i]
        d = c.setdefault("data", {}) if isinstance(c.get("data"), dict) or c.get("data") is None else c["data"]
        old = _disp_label(c)
        if old != lab:
            changes.append((i, old, lab))
        c["title"] = lab
        # 锁定卡(试用版)展示名在 _label;有则同步,保持画布显示一致。
        if isinstance(d, dict) and (d.get("_locked") or d.get("_label")):
            d["_label"] = lab
    return changes


def main():
    write = "--write" in sys.argv
    data = json.load(open(SEED, encoding="utf-8"))
    total = 0
    for t in data:
        ch = relabel(t)
        if ch:
            total += len(ch)
            print(f"### {t['id']} [{t.get('category')}] — {len(ch)} 改名")
            for i, old, new in sorted(ch):
                print(f"    [{i:>2}] {old!r:<18} → {new}")
    print(f"\n共 {total} 张图片卡改名(描述性名字与非图片卡未动)。")

    if write:
        txt = json.dumps(data, ensure_ascii=False, indent=2)
        with open(SEED, "w", encoding="utf-8") as f:
            f.write(txt)
        with open(FALLBACK, "w", encoding="utf-8") as f:
            f.write(txt)
        print(f"[write] 已覆盖 {SEED}")
        print(f"[write] 已覆盖 {FALLBACK}")
    else:
        print("[dry] 未写文件。确认映射后加 --write 落地。")


if __name__ == "__main__":
    main()
