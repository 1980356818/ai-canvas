"""
模板审计:交叉对照 *源 .aicat*(导入管线的输入)与 templatesFallback.json(坏输出),
把"标题缺失 / 参考图绑定与顺序"的全量数据钉死,供硬化 import-aicat-templates.py 用。

只读、纯本地、无网络。输出:
  - 控制台逐模板报告
  - scripts/audit-templates-report.json (结构化全量数据)
跑法: cd ai-canvas && python scripts/audit-templates.py
"""
import os, sys, json, zipfile, collections, re

try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = r"C:\Users\Administrator\Desktop\模板修改\6.6号模板"
FALLBACK = os.path.join(REPO, "src", "config", "templatesFallback.json")

# id -> (分类文件夹, 模板文件夹)  —— 抄自 import-aicat-templates.py REGISTRY
REG = {
    "wf-white-bg-2": ("平面模板", "一键白底图模板2"),
    "wf-three-view": ("平面模板", "人物三视图模板"),
    "wf-face-swap": ("平面模板", "人物换脸模板"),
    "wf-outfit-fusion": ("平面模板", "人物服装多模态融合"),
    "wf-digital-model-1": ("平面模板", "数字模特融合1"),
    "wf-digital-model-2": ("平面模板", "数字模特融合2"),
    "wf-phone-shoot": ("平面模板", "服装手机风拍摄模板"),
    "wf-model-bag": ("平面模板", "模特箱包模板"),
    "wf-model-pants": ("平面模板", "模特裤子模板"),
    "wf-skirt-flat": ("平面模板", "裙子平面模板"),
    "wf-sport-duo-solo": ("平面模板", "运动风服饰双人-单人"),
    "wf-product-seeding-video": ("视频模板", "产品带货种草视频模板"),
    "wf-clothing-talk-video": ("视频模板", "口播服装讲解视频模板"),
    "wf-solo-replica-video": ("视频模板", "视频单人复刻模板"),
    "wf-live-selling-video": ("视频模板", "视频口播带货模板"),
    "wf-drive-transform-video": ("视频模板", "视频开车变装模板"),
    "wf-clothing-fixed-video": ("视频模板", "视频服装固定展示模板"),
    "wf-clothing-show-video": ("视频模板", "视频服装展示模板"),
    "wf-content-replace-video": ("视频模板", "视频画面内容替换模板"),
    "wf-kv-poster": ("详情页模板", "kv海报模板"),
    "wf-detail-cn": ("详情页模板", "国内电商详情页模板"),
    "wf-detail-overseas": ("详情页模板", "海外电商详情页模板"),
    "wf-hot-replica-main": ("详情页模板", "爆款复刻主图模板"),
    "wf-outfit-fusion-trial": ("试用版模板", "人物服装多模态融合"),
    "wf-face-merge-trial": ("试用版模板", "人脸合成"),
    "wf-detail-cn-trial": ("试用版模板", "国内电商详情页模板"),
    "wf-model-bag-trial": ("试用版模板", "模特箱包模板"),
}

IMG_TYPES = {"ai_image", "ai_multiangle", "ai_tryon"}
RUNTIME_FIELDS = ["results", "revisedPrompt", "selectedIndex", "upstreamCardId",
                  "model", "provider", "resolution", "quality"]
SLOTS = [f"refImage{i}" for i in range(14)]
REF_TOKEN_RE = re.compile(r"\{\{ref:([^}]+)\}\}")
LITERAL_TU = re.compile(r"图\s*([0-9一二三四五六七八九十])")


def find_aicat(cat, tpl):
    d = os.path.join(BASE, cat, tpl)
    if not os.path.isdir(d): return None
    for f in os.listdir(d):
        if f.lower().endswith(".aicat"):
            return os.path.join(d, f)
    return None


def load_canvas(p):
    z = zipfile.ZipFile(p)
    cv = json.loads(z.read("canvas.json"))
    for c in cv.get("cards", []):
        d = c.get("data")
        if isinstance(d, str):
            c["data"] = json.loads(d) if d.strip() else {}
        elif not isinstance(d, dict):
            c["data"] = {}
    return cv


def card_image_id(c):
    """该卡是否产出图片(可作参考源)。返回其 id 或 None。"""
    return c.get("id") if c.get("type") in IMG_TYPES else None


def occupied_slot_sources(d):
    """生成卡 refImages 槽位:返回 [(slotKey, sourceCardId, url), ...] 按 refImage0,1,2 顺序(仅占用)。"""
    ri = d.get("refImages") or {}
    out = []
    for s in SLOTS:
        e = ri.get(s)
        if isinstance(e, dict) and e.get("url"):
            out.append((s, e.get("sourceCardId"), e.get("url")))
    return out


def audit_source(tid, cat, tpl):
    p = find_aicat(cat, tpl)
    rep = {"id": tid, "folder": f"{cat}/{tpl}", "found": bool(p)}
    if not p:
        return rep
    cv = load_canvas(p)
    cards = cv.get("cards", [])
    conns = cv.get("connections", [])
    id2idx = {c.get("id"): i for i, c in enumerate(cards)}
    id2card = {c.get("id"): c for c in cards}

    rep["nCards"] = len(cards)
    rep["nConns"] = len(conns)
    rep["nGroups"] = len(cv.get("groups", []) or [])
    rep["titled"] = sum(1 for c in cards if (c.get("title") or "").strip())

    # 每生成卡的参考三序对照
    gen = []
    for i, c in enumerate(cards):
        d = c.get("data") or {}
        content = (d.get("content") or "")
        ptpl = (d.get("_promptTemplate") or "")
        if not (content.strip() or ptpl.strip()):
            continue
        # 1) 槽序
        slot = occupied_slot_sources(d)              # [(key, srcId, url)]
        slot_src = [s[1] for s in slot]
        # 2) 连线序(指向本卡、源为图片卡)
        conn_src = []
        for cn in conns:
            if id2idx.get(cn.get("target_card_id")) == i:
                sid = cn.get("source_card_id")
                if sid in id2card and card_image_id(id2card[sid]):
                    conn_src.append(sid)
        # 3) 空间序(连线源按 y,x)
        spat_src = sorted(set(conn_src),
                          key=lambda sid: (id2card[sid].get("y", 0), id2card[sid].get("x", 0)))
        # inlineRefs 分类
        irs = d.get("inlineRefs") or []
        ir_rows = []
        for r in irs:
            src = r.get("source") or {}
            if src.get("type") == "refSlot":
                key = src.get("slotKey", "")
                # 占用序标签
                panel = None
                for n, (k, _s, _u) in enumerate(slot, 1):
                    if k == key: panel = f"图{n}"
                ir_rows.append({"kind": "refSlot", "slotKey": key,
                                "stored": r.get("displayLabel"), "panel": panel,
                                "mismatch": panel != r.get("displayLabel")})
            elif src.get("type") == "upstream":
                ir_rows.append({"kind": "upstream", "sourceCardId": src.get("sourceCardId"),
                                "stored": r.get("displayLabel"), "dangling": True})
            else:
                ir_rows.append({"kind": src.get("type"), "stored": r.get("displayLabel")})
        # prompt 里字面/令牌引用的不同编号
        toks = REF_TOKEN_RE.findall(content)
        literal = sorted(set(LITERAL_TU.findall(content)))
        gen.append({
            "idx": i, "title": c.get("title") or "", "type": c.get("type"),
            "promptKind": "tokens" if toks else ("template" if "{{" in content else "plain"),
            "nSlots": len(slot), "slotKeys": [s[0] for s in slot],
            "slotGap": [s[0] for s in slot] != SLOTS[:len(slot)],
            "order_slot": slot_src, "order_conn": conn_src, "order_spatial": spat_src,
            "slot_eq_conn": slot_src == conn_src,
            "slot_eq_spatial": slot_src == spat_src,
            "conn_eq_spatial": conn_src == spat_src,
            "inlineRefs": ir_rows,
            "literalNums": literal,
            "runtime": [f for f in RUNTIME_FIELDS if f in d],
        })
    rep["genCards"] = gen
    # 纯输入图卡(无 prompt、产图)= 候选"参考图N"
    rep["inputImageCards"] = [
        {"idx": i, "title": c.get("title") or "", "y": c.get("y"), "x": c.get("x")}
        for i, c in enumerate(cards)
        if card_image_id(c) and not ((c.get("data") or {}).get("content") or "").strip()
        and not ((c.get("data") or {}).get("_promptTemplate") or "").strip()
    ]
    return rep


def main():
    reports = []
    for tid, (cat, tpl) in REG.items():
        reports.append(audit_source(tid, cat, tpl))

    # ── 控制台报告 ──
    tot_cards = tot_titled = 0
    flag_dangle = flag_mismatch = flag_slotgap = flag_orderdiv = 0
    for r in reports:
        if not r.get("found"):
            print(f"!! {r['id']:<26} 源未找到 {r['folder']}")
            continue
        tot_cards += r["nCards"]; tot_titled += r["titled"]
        print(f"\n■ {r['id']:<26} cards={r['nCards']:>2} titled={r['titled']:>2} "
              f"conn={r['nConns']:>2} groups={r['nGroups']} ← {r['folder']}")
        for g in r["genCards"]:
            tags = []
            if not g["slot_eq_conn"]: tags.append("槽≠连")
            if not g["slot_eq_spatial"]: tags.append("槽≠空间")
            if g["slotGap"]: tags.append("槽空洞");
            dangles = [x for x in g["inlineRefs"] if x.get("dangling")]
            mismatches = [x for x in g["inlineRefs"] if x.get("mismatch")]
            if dangles: tags.append(f"悬空upstream×{len(dangles)}")
            if mismatches: tags.append(f"标签错位×{len(mismatches)}")
            if g["runtime"]: tags.append("含运行态")
            if g["slotGap"]: flag_slotgap += 1
            if dangles: flag_dangle += len(dangles)
            if mismatches: flag_mismatch += len(mismatches)
            if not g["slot_eq_conn"] or not g["slot_eq_spatial"]: flag_orderdiv += 1
            flag = ("  ⚠ " + " ".join(tags)) if tags else "  ok"
            print(f"    gen[{g['idx']:>2}] {g['type']:<11} prompt={g['promptKind']:<8} "
                  f"slots={g['nSlots']} 字面图号={g['literalNums']}{flag}")
            if not g["slot_eq_conn"]:
                print(f"          槽序   {[s[:6] for s in g['order_slot']]}")
                print(f"          连线序 {[s[:6] for s in g['order_conn']]}")
            if not g["slot_eq_spatial"] and g["order_spatial"] != g["order_conn"]:
                print(f"          空间序 {[s[:6] for s in g['order_spatial']]}")
            for ir in g["inlineRefs"]:
                if ir.get("dangling"):
                    print(f"          inlineRef upstream→{(ir['sourceCardId'] or '')[:8]} 悬空(实例化后丢图)")
                elif ir.get("mismatch"):
                    print(f"          inlineRef {ir['slotKey']} 存={ir['stored']} 面板={ir['panel']} 错位")

    print("\n" + "=" * 70)
    print(f"汇总: {len(reports)} 模板  源卡 {tot_cards} 张  有标题 {tot_titled} "
          f"({100*tot_titled//max(tot_cards,1)}%)")
    print(f"  悬空 upstream 引用(丢图): {flag_dangle}")
    print(f"  inlineRef 标签错位:       {flag_mismatch}")
    print(f"  槽位空洞(未 compact):     {flag_slotgap}")
    print(f"  槽序/连线序/空间序不一致的生成卡: {flag_orderdiv}")

    out = os.path.join(REPO, "scripts", "audit-templates-report.json")
    json.dump(reports, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"\n结构化全量 → {out}")


if __name__ == "__main__":
    main()
