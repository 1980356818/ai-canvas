# -*- coding: utf-8 -*-
"""
重排所有模板的卡片坐标(relativeX/relativeY),让画布打开后整洁清晰。

只动坐标:width/height/data/connections/图 URL 全部原样保留,连线拓扑不变。

布局思路(每个模板):
  1. 按连线拆成独立"流"(连通分量);孤立卡单独处理。
  2. 每个流用「分层有向图布局」:longest-path 分层 → 列(从左到右按依赖深度)。
     - 输入卡在最左,提示词/中间卡居中,产出卡在最右,符合连线 右出→左入 的方向。
     - 叶子产出层卡数多时(≥5)自动折成网格块,避免一列拉得很长。
     - 每列竖直居中,fan-in/fan-out 形成对称的"沙漏",观感整洁。
     - barycenter 排序减少连线交叉(用原始 y 初始化,尽量尊重原意)。
  3. 多个流竖直堆叠成"泳道",孤立卡在底部排成一行/网格。

跑法:
  python scripts/relayout-templates.py            # 干跑:写 *.relayout.json + 预览 HTML,不动正式文件
  python scripts/relayout-templates.py --write     # 落地:覆盖 templates-seed.json + templatesFallback.json
"""
import json
import math
import os
import sys
import copy
from collections import defaultdict, deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED = os.path.join(ROOT, "scripts", "templates-seed.json")
FALLBACK = os.path.join(ROOT, "src", "config", "templatesFallback.json")
PREVIEW = os.path.join(ROOT, "scripts", "relayout-preview.html")
DRY_SEED = os.path.join(ROOT, "scripts", "templates-seed.relayout.json")

# ── 布局参数(世界像素) ────────────────────────────────
H_GAP = 150         # 列与列之间(水平)
SUBGAP_X = 44       # 折网格时,子列之间
V_GAP = 56          # 同列卡片之间(竖直)
COMP_GAP = 170      # 流与流之间(竖直泳道间距)
COMP_GAP_X = 230    # 流与流之间(同一行并排时的水平间距)
LEAF_WRAP_MIN = 5   # 叶子产出层 ≥ 此数量时折成网格
FANIN_WRAP_MIN = 7  # 非叶子层(输入/中间)≥ 此数量才折网格:中小扇入保持单列,连线更顺
SHELF_ROW_W = 2400  # 流数量多(>4)时按此宽度折行排布,控制总高
MANY_COMPS = 4      # 流数量 > 此值时改用折行排布(否则竖直堆叠成泳道)

TYPE_COLOR = {
    "ai_chat": "#3B82F6",
    "ai_image": "#8B5CF6",
    "ai_video": "#EF4444",
    "ai_tryon": "#EC4899",
    "ai_multiangle": "#14B8A6",
    "text": "#6B7280",
    "sticky_note": "#F59E0B",
    "audio": "#F97316",
    "frame_extractor": "#10B981",
}


def build_edges(t):
    n = len(t["cards"])
    edges = []
    for c in (t.get("connections") or []):
        s, d = c["sourceIndex"], c["targetIndex"]
        if 0 <= s < n and 0 <= d < n and s != d:
            edges.append((s, d))
    return n, edges


def components(n, edges):
    und = defaultdict(set)
    for s, d in edges:
        und[s].add(d)
        und[d].add(s)
    seen = [False] * n
    comps = []
    for i in range(n):
        if seen[i]:
            continue
        q = deque([i])
        seen[i] = True
        comp = [i]
        while q:
            u = q.popleft()
            for v in und[u]:
                if not seen[v]:
                    seen[v] = True
                    comp.append(v)
                    q.append(v)
        comps.append(comp)
    return comps


def layering(nodes, edges):
    """longest-path 分层(限定在 nodes 内)。返回 layer / 有向 adj / radj。"""
    nodeset = set(nodes)
    adj = defaultdict(list)
    radj = defaultdict(list)
    indeg = {i: 0 for i in nodes}
    for s, d in edges:
        if s in nodeset and d in nodeset:
            adj[s].append(d)
            radj[d].append(s)
            indeg[d] += 1
    layer = {i: 0 for i in nodes}
    tindeg = dict(indeg)
    q = deque([i for i in nodes if tindeg[i] == 0])
    done = 0
    while q:
        u = q.popleft()
        done += 1
        for v in adj[u]:
            if layer[u] + 1 > layer[v]:
                layer[v] = layer[u] + 1
            tindeg[v] -= 1
            if tindeg[v] == 0:
                q.append(v)
    # 有环兜底(本项目模板实测无环):剩余节点保持 layer 0
    return layer, adj, radj


def order_layers(nodes, layer, adj, radj, orig_y):
    """barycenter 排序减少交叉,原始 y 初始化。返回 {layer: [有序节点]}。"""
    bylayer = defaultdict(list)
    for v in nodes:
        bylayer[layer[v]].append(v)
    maxL = max(layer[v] for v in nodes)
    for L in bylayer:
        bylayer[L].sort(key=lambda v: (orig_y.get(v, 0), v))
    pos = {}

    def recompute():
        for L in bylayer:
            for i, v in enumerate(bylayer[L]):
                pos[v] = i

    recompute()
    neigh = {v: list(adj[v]) + list(radj[v]) for v in nodes}
    for _ in range(6):
        for L in range(maxL + 1):
            arr = bylayer.get(L)
            if not arr:
                continue
            def key(v):
                ns = neigh[v]
                return (sum(pos[u] for u in ns) / len(ns)) if ns else pos[v]
            arr.sort(key=lambda v: (key(v), pos[v]))
        recompute()
    return bylayer, maxL


def layout_component(comp, cards, edges, orig_y):
    layer, adj, radj = layering(comp, edges)
    bylayer, maxL = order_layers(comp, layer, adj, radj, orig_y)
    outdeg = {v: len(adj[v]) for v in comp}

    # 先算每层的块尺寸(用于竖直居中)
    blocks = {}
    for L in range(maxL + 1):
        arr = bylayer.get(L)
        if not arr:
            continue
        colW = max(cards[v]["width"] for v in arr)
        rowH = max(cards[v]["height"] for v in arr)
        m = len(arr)
        is_leaf = L > 0 and all(outdeg[v] == 0 for v in arr)
        wrap_min = LEAF_WRAP_MIN if is_leaf else FANIN_WRAP_MIN
        if m >= wrap_min:
            rows = math.ceil(math.sqrt(m))
            subcols = math.ceil(m / rows)
        else:
            rows, subcols = m, 1
        blockW = subcols * colW + (subcols - 1) * SUBGAP_X
        blockH = rows * rowH + (rows - 1) * V_GAP
        blocks[L] = dict(arr=arr, colW=colW, rowH=rowH, rows=rows, subcols=subcols,
                         blockW=blockW, blockH=blockH)

    contentH = max(b["blockH"] for b in blocks.values())
    placements = {}
    curX = 0.0
    for L in range(maxL + 1):
        b = blocks.get(L)
        if not b:
            continue
        startY = (contentH - b["blockH"]) / 2.0
        colW, rowH, rows = b["colW"], b["rowH"], b["rows"]
        for idx, v in enumerate(b["arr"]):
            subcol = idx // rows
            row = idx % rows
            cx = curX + subcol * (colW + SUBGAP_X) + (colW - cards[v]["width"]) / 2.0
            cy = startY + row * (rowH + V_GAP) + (rowH - cards[v]["height"]) / 2.0
            placements[v] = (cx, cy)
        curX += b["subcols"] * (colW + SUBGAP_X) - SUBGAP_X + H_GAP
    compW = curX - H_GAP
    return placements, compW, contentH


def relayout(t):
    cards = t["cards"]
    n, edges = build_edges(t)
    if n == 0:
        return
    orig_y = {i: cards[i].get("relativeY", 0) for i in range(n)}
    orig_x = {i: cards[i].get("relativeX", 0) for i in range(n)}

    comps = components(n, edges)
    multi = [c for c in comps if len(c) > 1]
    singles = [c[0] for c in comps if len(c) == 1]
    multi.sort(key=lambda c: (min(orig_y[v] for v in c), min(orig_x[v] for v in c)))

    # 先各自布局,拿到每个流的尺寸
    laidout = [(comp, *layout_component(comp, cards, edges, orig_y)) for comp in multi]

    newpos = {}
    if len(laidout) > MANY_COMPS:
        # 流很多:按行折叠("货架"装箱),控制总高度;同一行内的流上沿对齐。
        row_cap = max(SHELF_ROW_W, max((w for _, _, w, _ in laidout), default=0))
        laidout.sort(key=lambda e: -e[3])  # 高的先放,行更整齐
        xC = yC = shelfH = 0.0
        for comp, placements, compW, compH in laidout:
            if xC > 0 and xC + compW > row_cap:
                yC += shelfH + COMP_GAP
                xC = shelfH = 0.0
            for v, (x, y) in placements.items():
                newpos[v] = (xC + x, yC + y)
            xC += compW + COMP_GAP_X
            shelfH = max(shelfH, compH)
        yOff = yC + shelfH + COMP_GAP
    else:
        # 常见情形:竖直堆叠成清晰的泳道。
        yOff = 0.0
        for comp, placements, compW, compH in laidout:
            for v, (x, y) in placements.items():
                newpos[v] = (x, y + yOff)
            yOff += compH + COMP_GAP

    if singles:
        singles.sort(key=lambda v: (orig_x[v], orig_y[v]))
        maxW = max(cards[v]["width"] for v in singles)
        maxH = max(cards[v]["height"] for v in singles)
        per_row = min(6, len(singles))
        for i, v in enumerate(singles):
            col = i % per_row
            rr = i // per_row
            cx = col * (maxW + SUBGAP_X) + (maxW - cards[v]["width"]) / 2.0
            cy = yOff + rr * (maxH + V_GAP) + (maxH - cards[v]["height"]) / 2.0
            newpos[v] = (cx, cy)

    minx = min(p[0] for p in newpos.values())
    miny = min(p[1] for p in newpos.values())
    for i in range(n):
        x, y = newpos[i]
        cards[i]["relativeX"] = round(x - minx)
        cards[i]["relativeY"] = round(y - miny)


# ── 预览(SVG 盒子 + 连线),对比 前/后 ────────────────────
def svg_for(t, panel_w=620):
    cards = t["cards"]
    n = len(cards)
    xs = [c["relativeX"] for c in cards]
    ys = [c["relativeY"] for c in cards]
    x2 = [c["relativeX"] + c["width"] for c in cards]
    y2 = [c["relativeY"] + c["height"] for c in cards]
    minx, miny = min(xs), min(ys)
    w = max(x2) - minx or 1
    h = max(y2) - miny or 1
    scale = panel_w / w
    H = h * scale
    parts = [f'<svg width="{panel_w}" height="{H:.0f}" viewBox="0 0 {panel_w} {H:.0f}" '
             f'style="background:#0f1116;border:1px solid #222">']
    # 连线
    for c in (t.get("connections") or []):
        s, d = c["sourceIndex"], c["targetIndex"]
        if not (0 <= s < n and 0 <= d < n):
            continue
        sx = (cards[s]["relativeX"] + cards[s]["width"] - minx) * scale
        sy = (cards[s]["relativeY"] + cards[s]["height"] / 2 - miny) * scale
        tx = (cards[d]["relativeX"] - minx) * scale
        ty = (cards[d]["relativeY"] + cards[d]["height"] / 2 - miny) * scale
        mx = (sx + tx) / 2
        parts.append(f'<path d="M{sx:.0f},{sy:.0f} C{mx:.0f},{sy:.0f} {mx:.0f},{ty:.0f} {tx:.0f},{ty:.0f}" '
                     f'fill="none" stroke="#a855f7" stroke-width="1" opacity="0.55"/>')
    # 卡片
    for i, c in enumerate(cards):
        x = (c["relativeX"] - minx) * scale
        y = (c["relativeY"] - miny) * scale
        cw = c["width"] * scale
        ch = c["height"] * scale
        col = TYPE_COLOR.get(c["type"], "#888")
        parts.append(f'<rect x="{x:.0f}" y="{y:.0f}" width="{cw:.0f}" height="{ch:.0f}" rx="4" '
                     f'fill="{col}22" stroke="{col}" stroke-width="1.5"/>')
        parts.append(f'<text x="{x+4:.0f}" y="{y+13:.0f}" font-size="11" fill="#ddd" '
                     f'font-family="monospace">{i}</text>')
    parts.append("</svg>")
    return "".join(parts)


def write_preview(before, after):
    rows = []
    for b, a in zip(before, after):
        rows.append(
            f'<div class="row"><h3>{b["id"]} — {b.get("name","")} '
            f'<span class="cat">[{b.get("category")}] {len(b["cards"])} 卡</span></h3>'
            f'<div class="pair"><div><div class="lbl">改前</div>{svg_for(b)}</div>'
            f'<div><div class="lbl">改后</div>{svg_for(a)}</div></div></div>'
        )
    html = (
        '<!doctype html><meta charset="utf-8"><title>模板布局 改前/改后</title>'
        '<style>body{background:#16181d;color:#ccc;font-family:system-ui;margin:24px}'
        'h3{margin:28px 0 8px;font-size:15px;border-bottom:1px solid #333;padding-bottom:6px}'
        '.cat{color:#888;font-weight:400;font-size:12px;margin-left:8px}'
        '.pair{display:flex;gap:24px;align-items:flex-start}'
        '.lbl{font-size:12px;color:#999;margin-bottom:4px}'
        '.row{margin-bottom:8px}</style>'
        '<h1 style="font-size:18px">模板布局优化 — 改前 / 改后</h1>'
        + "".join(rows)
    )
    with open(PREVIEW, "w", encoding="utf-8") as f:
        f.write(html)


def main():
    write = "--write" in sys.argv
    data = json.load(open(SEED, encoding="utf-8"))
    before = copy.deepcopy(data)
    for t in data:
        relayout(t)
    after = data

    write_preview(before, after)
    print(f"[preview] {PREVIEW}")

    if write:
        txt = json.dumps(after, ensure_ascii=False, indent=2)
        with open(SEED, "w", encoding="utf-8") as f:
            f.write(txt)
        with open(FALLBACK, "w", encoding="utf-8") as f:
            f.write(txt)
        print(f"[write] 已覆盖 {SEED}")
        print(f"[write] 已覆盖 {FALLBACK}")
    else:
        with open(DRY_SEED, "w", encoding="utf-8") as f:
            f.write(json.dumps(after, ensure_ascii=False, indent=2))
        print(f"[dry] 结果写到 {DRY_SEED}(未动正式文件)。确认预览后加 --write 落地。")


if __name__ == "__main__":
    main()
