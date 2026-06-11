"""审计模板卡片的「标签/名称/顺序」问题,给人工逐个纠正用。

只读 scripts/templates-seed.json(= app 加载的那份),不改任何东西。
规则(沿用 memory project_ai_canvas_template_labels):
  - 有 content 或有入边 = 效果图(结果卡);无 content 且无入边 = 输入/参考图。
  - 标题应反映角色;编号(效果图N/参考图N)应连续且与空间顺序一致。

跑法:
  python scripts/audit-template-labels.py            # 审所有非 trial 模板
  python scripts/audit-template-labels.py --all      # 含 trial
  python scripts/audit-template-labels.py wf-model-bag  # 只看某个
"""
import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(_HERE, "templates-seed.json")

TYPE_CN = {"ai_image": "图", "ai_chat": "文", "ai_video": "视频", "ai_tryon": "换装",
           "ai_multiangle": "多角度", "text": "文本", "image": "图素材"}

# 明显的占位/通用名(标题=这些之一→大概率没起好名)
GENERIC = {"", "模板节点", "模板分析节点", "节点", "未命名", "未命名节点", "新建节点",
           "新建", "AI图片", "AI对话", "AI 图片", "AI 对话", "图片", "图片节点",
           "文本", "文本节点", "对话", "图片生成", "无标题"}

# 输入/参考类标题词根(这类卡应当无 content、无入边)
INPUT_WORDS = ("参考图", "上传", "原图", "素材", "底图", "商品图", "人物图", "服装图", "脸")
# 结果/效果类标题词根(这类卡应当有 content 或有入边)
RESULT_WORDS = ("效果图", "成品", "生成", "结果", "方案", "三视图", "详情页", "主图", "海报")


def num_suffix(title):
    """提取 '效果图3' → ('效果图', 3);无数字 → (title, None)。"""
    m = re.match(r"^(.*?)(\d+)\s*$", title or "")
    if m:
        return m.group(1), int(m.group(2))
    return (title or ""), None


def audit_template(t):
    cards = t.get("cards", [])
    conns = t.get("connections", []) or []
    n = len(cards)
    indeg = [0] * n
    outdeg = [0] * n
    for c in conns:
        s, d = c.get("sourceIndex"), c.get("targetIndex")
        if isinstance(s, int) and 0 <= s < n:
            outdeg[s] += 1
        if isinstance(d, int) and 0 <= d < n:
            indeg[d] += 1

    issues = []  # (卡idx, 标题, 问题描述)
    titles = {}
    for i, c in enumerate(cards):
        title = (c.get("title") or "").strip()
        titles.setdefault(title, []).append(i)

    for i, c in enumerate(cards):
        ty = c.get("type", "?")
        title = (c.get("title") or "").strip()
        data = c.get("data") or {}
        content = data.get("content")
        has_content = isinstance(content, str) and content.strip() != ""
        has_in = indeg[i] > 0
        is_result = has_content or has_in  # 效果图判定

        flags = []
        # 1. 空名 / 通用名
        if title in GENERIC:
            flags.append("空名/通用名")
        # 2. 类型-角色-标题不符
        if ty == "ai_image":
            named_input = any(w in title for w in INPUT_WORDS)
            named_result = any(w in title for w in RESULT_WORDS)
            if is_result and named_input:
                flags.append(f"名像输入('{title}')但实为结果(有{'内容' if has_content else ''}{'入边' if has_in else ''})")
            if (not is_result) and named_result:
                flags.append(f"名像结果('{title}')但实为输入(无内容无入边)")
        if ty == "ai_chat" and any(w in title for w in ("效果图", "参考图")) and "提示" not in title:
            flags.append(f"对话卡却叫'{title}'(应是提示词/反推/脚本类名)")
        if flags:
            issues.append((i, title or "(空)", "; ".join(flags)))

    # 3. 重名
    for title, idxs in titles.items():
        if title and len(idxs) > 1:
            issues.append(("dup", title, f"重名 ×{len(idxs)} → 卡 {idxs}"))

    # 4. 编号连续性 + 空间顺序
    groups = {}
    for i, c in enumerate(cards):
        base, num = num_suffix((c.get("title") or "").strip())
        if num is not None and base:
            groups.setdefault(base, []).append((num, i, c.get("relativeX", 0), c.get("relativeY", 0)))
    for base, items in groups.items():
        if len(items) < 2:
            continue
        nums = sorted(x[0] for x in items)
        # 缺号 / 重号
        expect = list(range(nums[0], nums[0] + len(nums)))
        if nums != expect or len(set(nums)) != len(nums):
            issues.append(("num", base, f"编号不连续/重号: {nums}"))
        # 空间顺序 vs 编号:按位置(先列X后行Y)排,看编号是否随之递增
        by_pos = sorted(items, key=lambda x: (round(x[2] / 200), x[3]))
        pos_order = [x[0] for x in by_pos]
        if pos_order != sorted(pos_order):
            issues.append(("order", base, f"编号与画面顺序错乱: 按位置看到的编号序 = {pos_order}"))

    return issues


def reading_dump(t):
    """按阅读顺序(列X→行Y)列出卡片,给人对照。"""
    cards = t.get("cards", [])
    conns = t.get("connections", []) or []
    n = len(cards)
    indeg = [0] * n
    for c in conns:
        d = c.get("targetIndex")
        if isinstance(d, int) and 0 <= d < n:
            indeg[d] += 1
    order = sorted(range(n), key=lambda i: (round(cards[i].get("relativeX", 0) / 200), cards[i].get("relativeY", 0)))
    lines = []
    for i in order:
        c = cards[i]
        ty = TYPE_CN.get(c.get("type"), c.get("type"))
        title = (c.get("title") or "").strip() or "(空)"
        data = c.get("data") or {}
        has_c = isinstance(data.get("content"), str) and data["content"].strip() != ""
        role = "效果图" if (has_c or indeg[i] > 0) else "输入图"
        lines.append(f"    #{i:<2} [{ty}] {title:<16} {role}{' ·有提示词' if has_c else ''}")
    return lines


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    include_trial = "--all" in sys.argv
    templates = json.load(open(SEED, encoding="utf-8"))
    if args:
        templates = [t for t in templates if t["id"] in args]
    elif not include_trial:
        templates = [t for t in templates if t.get("category") != "trial"]

    total_issues = 0
    clean = []
    for t in templates:
        issues = audit_template(t)
        if not issues:
            clean.append(f"{t['id']} ({t.get('name')})")
            continue
        total_issues += len(issues)
        print(f"\n═══ {t['id']}  「{t.get('name')}」 [{t.get('category')}, {len(t.get('cards',[]))}卡] ═══")
        for idx, title, desc in issues:
            tag = {"dup": "重名", "num": "编号", "order": "顺序"}.get(idx, f"卡#{idx}")
            print(f"  ⚠ [{tag}] {title}: {desc}")
        if args:  # 单模板时附完整阅读顺序对照
            print("  ── 阅读顺序(列→行) ──")
            print("\n".join(reading_dump(t)))

    print(f"\n{'='*50}")
    print(f"扫 {len(templates)} 个模板,{total_issues} 处疑似问题。")
    if clean:
        print(f"无自动标记: {', '.join(clean)}")
    print("注:trial 试用版标题继承自同名 flat 模板,改 flat 重跑 derive 即同步。")


if __name__ == "__main__":
    main()
