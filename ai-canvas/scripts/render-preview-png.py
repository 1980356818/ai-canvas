# -*- coding: utf-8 -*-
"""把 改前(templates-seed.json) 与 改后(templates-seed.relayout.json) 渲染成 PNG 便于肉眼检查。
用法: python scripts/render-preview-png.py
产出: scripts/preview/_overview_after.png(全部改后总览) + scripts/preview/<id>.png(逐个 改前|改后)
"""
import json
import os
import math
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BEFORE = json.load(open(os.path.join(ROOT, "scripts", "templates-seed.json"), encoding="utf-8"))
AFTER = json.load(open(os.path.join(ROOT, "scripts", "templates-seed.relayout.json"), encoding="utf-8"))
OUT = os.path.join(ROOT, "scripts", "preview")
os.makedirs(OUT, exist_ok=True)

COL = {"ai_chat": (59, 130, 246), "ai_image": (139, 92, 246), "ai_video": (239, 68, 68),
       "ai_tryon": (236, 72, 153), "ai_multiangle": (20, 184, 166), "text": (107, 114, 128),
       "sticky_note": (245, 158, 11), "audio": (249, 115, 22), "frame_extractor": (16, 185, 129)}
BG = (15, 17, 22)

try:
    FONT = ImageFont.truetype("arial.ttf", 13)
    FONTS = ImageFont.truetype("arial.ttf", 11)
except Exception:
    FONT = ImageFont.load_default()
    FONTS = FONT


def bbox(cards):
    minx = min(c["relativeX"] for c in cards)
    miny = min(c["relativeY"] for c in cards)
    maxx = max(c["relativeX"] + c["width"] for c in cards)
    maxy = max(c["relativeY"] + c["height"] for c in cards)
    return minx, miny, maxx - minx, maxy - miny


def draw_template(t, panel_w=640, pad=14):
    cards = t["cards"]
    minx, miny, w, h = bbox(cards)
    w = w or 1
    h = h or 1
    scale = panel_w / w
    H = int(h * scale) + pad * 2
    img = Image.new("RGB", (panel_w + pad * 2, H), BG)
    d = ImageDraw.Draw(img, "RGBA")

    def P(x, y):
        return (pad + (x - minx) * scale, pad + (y - miny) * scale)

    # 连线(采样三次贝塞尔)
    n = len(cards)
    for c in (t.get("connections") or []):
        s, dd = c["sourceIndex"], c["targetIndex"]
        if not (0 <= s < n and 0 <= dd < n):
            continue
        x0, y0 = P(cards[s]["relativeX"] + cards[s]["width"], cards[s]["relativeY"] + cards[s]["height"] / 2)
        x1, y1 = P(cards[dd]["relativeX"], cards[dd]["relativeY"] + cards[dd]["height"] / 2)
        cxm = (x0 + x1) / 2
        pts = []
        for i in range(13):
            tt = i / 12
            mt = 1 - tt
            bx = mt**3 * x0 + 3 * mt**2 * tt * cxm + 3 * mt * tt**2 * cxm + tt**3 * x1
            by = mt**3 * y0 + 3 * mt**2 * tt * y0 + 3 * mt * tt**2 * y1 + tt**3 * y1
            pts.append((bx, by))
        d.line(pts, fill=(168, 85, 247, 150), width=2)

    for i, c in enumerate(cards):
        x, y = P(c["relativeX"], c["relativeY"])
        cw, ch = c["width"] * scale, c["height"] * scale
        col = COL.get(c["type"], (136, 136, 136))
        d.rectangle([x, y, x + cw, y + ch], fill=col + (40,), outline=col + (255,), width=2)
        d.text((x + 4, y + 3), str(i), fill=(230, 230, 230), font=FONTS)
    return img


def label_bar(text, width, h=26):
    img = Image.new("RGB", (width, h), (28, 30, 36))
    ImageDraw.Draw(img).text((8, 5), text, fill=(210, 210, 210), font=FONT)
    return img


def side_by_side(tb, ta):
    bimg = draw_template(tb)
    aimg = draw_template(ta)
    H = max(bimg.height, aimg.height)
    gap = 18
    title = label_bar(f'{tb["id"]}  —  {tb.get("name","")}   [{tb.get("category")}]  {len(tb["cards"])} cards   (左=改前  右=改后)',
                      bimg.width + aimg.width + gap, 28)
    canvas = Image.new("RGB", (bimg.width + aimg.width + gap, H + 28), (20, 22, 27))
    canvas.paste(title, (0, 0))
    canvas.paste(bimg, (0, 28))
    canvas.paste(aimg, (bimg.width + gap, 28))
    return canvas


# 逐个
for tb, ta in zip(BEFORE, AFTER):
    side_by_side(tb, ta).save(os.path.join(OUT, f'{tb["id"]}.png'))

# 总览(全部改后,小图网格)
thumbs = [draw_template(t, panel_w=300) for t in AFTER]
cols = 4
cw = 300 + 28
rown = math.ceil(len(thumbs) / cols)
rowhs = []
for r in range(rown):
    rowhs.append(max(thumbs[r * cols + i].height for i in range(cols) if r * cols + i < len(thumbs)) + 30)
W = cols * cw
Htot = sum(rowhs)
ov = Image.new("RGB", (W, Htot), (20, 22, 27))
dd = ImageDraw.Draw(ov)
yy = 0
for r in range(rown):
    xx = 0
    for cidx in range(cols):
        k = r * cols + cidx
        if k >= len(thumbs):
            break
        dd.text((xx + 6, yy + 4), AFTER[k]["id"], fill=(200, 200, 200), font=FONTS)
        ov.paste(thumbs[k], (xx, yy + 22))
        xx += cw
    yy += rowhs[r]
ov.save(os.path.join(OUT, "_overview_after.png"))
print("done ->", OUT)
