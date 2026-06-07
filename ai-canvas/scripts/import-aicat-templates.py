"""
6.6 号模板导入管线:把桌面端导出的 `.aicat`(ZIP=manifest.json+canvas.json+内嵌 media/)
转成服务端模板定义 `WorkflowTemplate`,内嵌媒体抽出按内容哈希命名,产出三份文件:

  scripts/templates-seed.json             给 seed-templates-db.py 写 aicat.template(含 category)
  src/config/templatesFallback.json       桌面端离线兜底
  scripts/templates-imported-manifest.json 给 upload-imported-assets.py(localAbs → remoteRel)

媒体抽到仓库外的暂存目录 `D:\\tmp\\aicat\\assets\\<sha16>.<ext>`(图不进仓库/不进包),
公网 = https://ai.snoworangekeji.cn/aicanvas-static/templates/imported/<sha16>.<ext>(极境 NAS, 非 COS)。

分类(category slug):flat 平面 / video 视频 / detail 详情页 / trial 试用版。
试用版(trial):对带提示词的卡设 `_locked:true` 隐藏提示词(只 UI 隐藏,见会员门禁说明)。
平面/产品带货种草 与 视频/产品带货种草 内容相同 → 只保留视频那份(平面那份 drop,封面借用)。

跑法:python scripts/import-aicat-templates.py   (纯本地转换 + 算哈希,无网络/无 key)
下一步:① upload-imported-assets.py 传 NAS  ② seed-templates-db.py 写库(新 id→is_active=1)
"""
import os
import re
import sys
import json
import zipfile
import hashlib
import collections
import subprocess
import tempfile
from io import BytesIO

try:
    from PIL import Image
    HAS_PIL = True
except Exception:
    HAS_PIL = False

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# 模板只是示例预览,不追质量,压到够看即可。
# 图片:最长边像素上限 + JPEG 质量。
COVER_MAX = 600
IMG_MAX = 1024
IMG_QUALITY = 72
# 视频:ffmpeg 转码,长边上限 + CRF(越大越小越糊,28~32 为"示例级")。
VIDEO_MAX = 900
VIDEO_CRF = "31"
FFMPEG = "ffmpeg"

BASE = r"C:\Users\Administrator\Desktop\模板修改\6.6号模板"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_TPL = os.path.join(REPO, "src", "assets", "templates")  # /assets 内建图解析源
STAGE = r"D:\tmp\aicat\assets"
NAS_BASE = "https://ai.snoworangekeji.cn/aicanvas-static/templates/"
REMOTE_SUBDIR = "imported"

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v"}

TRIAL_DESC = "试用模板：提示词已封装，升级正式版后可查看与编辑"

# (分类文件夹, 模板文件夹) -> 配置。drop=True 跳过;lock=True 锁试用提示词;
# cover_from 借用另一个文件夹的封面(本身无封面时)。
REGISTRY = collections.OrderedDict([
    # ── 平面 flat ──
    (("平面模板", "一键白底图模板2"), {"id": "wf-white-bg-2", "category": "flat", "desc": "上传商品图，一键生成白底精修与多角度图"}),
    (("平面模板", "产品带货种草视频模板"), {"drop": True}),  # = 视频/产品带货种草,归视频
    (("平面模板", "人物三视图模板"), {"id": "wf-three-view", "category": "flat", "desc": "上传人物图，生成正/侧/背三视图"}),
    (("平面模板", "人物换脸模板"), {"id": "wf-face-swap", "category": "flat", "desc": "上传人物与目标脸，一键换脸"}),
    (("平面模板", "人物服装多模态融合"), {"id": "wf-outfit-fusion", "category": "flat", "desc": "模特+服装+场景多模态融合，生成商业大片"}),
    (("平面模板", "双人服装多模态"), {"id": "wf-duo-outfit-fusion", "category": "flat", "name": "双人服装多模态",
        "desc": "上传双人模特、双套服装与场景图，AI 生成一组连续一致的双人服装场景大片",
        "titles": {3: "模特图", 4: "服装图", 5: "场景图", 6: "融合提示词"}}),
    (("平面模板", "数字模特融合1"), {"id": "wf-digital-model-1", "category": "flat", "desc": "真人服装上身到数字模特，自然换装"}),
    (("平面模板", "数字模特融合2"), {"id": "wf-digital-model-2", "category": "flat", "desc": "数字模特服装融合，多角度成片"}),
    (("平面模板", "服装手机风拍摄模板"), {"id": "wf-phone-shoot", "category": "flat", "desc": "服装手机随手拍风格，真实生活感成片"}),
    (("平面模板", "模特箱包模板"), {"id": "wf-model-bag", "category": "flat", "desc": "箱包+模特融合，生成商业展示图"}),
    (("平面模板", "模特裤子模板"), {"id": "wf-model-pants", "category": "flat", "desc": "裤装上身，模特多姿态展示成片"}),
    (("平面模板", "裙子平面模板"), {"id": "wf-skirt-flat", "category": "flat", "desc": "裙装平面图融合，生成模特上身效果"}),
    (("平面模板", "运动风服饰双人-单人"), {"id": "wf-sport-duo-solo", "category": "flat", "desc": "运动风服饰，单人/双人场景成片"}),
    # ── 视频 video ──
    (("视频模板", "产品带货种草视频模板"), {"id": "wf-product-seeding-video", "category": "video", "desc": "产品图一键生成带货种草短视频", "cover_from": ("平面模板", "产品带货种草视频模板")}),
    (("视频模板", "口播服装讲解视频模板"), {"id": "wf-clothing-talk-video", "category": "video", "desc": "服装口播讲解视频，模特出镜解说"}),
    (("视频模板", "视频单人复刻模板"), {"id": "wf-solo-replica-video", "category": "video", "desc": "上传参考视频，单人动作复刻成片"}),
    (("视频模板", "视频口播带货模板"), {"id": "wf-live-selling-video", "category": "video", "desc": "口播带货视频，模特讲解上身效果"}),
    (("视频模板", "视频开车变装模板"), {"id": "wf-drive-transform-video", "category": "video", "desc": "开车变装创意短视频一键生成"}),
    (("视频模板", "视频服装固定展示模板"), {"id": "wf-clothing-fixed-video", "category": "video", "desc": "服装固定机位展示视频"}),
    (("视频模板", "视频服装展示模板"), {"id": "wf-clothing-show-video", "category": "video", "desc": "服装动态展示视频成片"}),
    (("视频模板", "视频画面内容替换模板"), {"id": "wf-content-replace-video", "category": "video", "desc": "替换视频画面内容/主体"}),
    # ── 详情页 detail ──
    (("详情页模板", "kv海报模板"), {"id": "wf-kv-poster", "category": "detail", "desc": "一键生成 KV 主视觉海报"}),
    (("详情页模板", "国内电商详情页模板"), {"id": "wf-detail-cn", "category": "detail", "desc": "一键生成国内电商详情页长图"}),
    (("详情页模板", "海外电商详情页模板"), {"id": "wf-detail-overseas", "category": "detail", "desc": "一键生成海外电商详情页长图"}),
    (("详情页模板", "爆款复刻主图模板"), {"id": "wf-hot-replica-main", "category": "detail", "desc": "复刻爆款主图风格，生成商品主图"}),
    # ── 试用版 trial(锁提示词) ──
    (("试用版模板", "人物服装多模态融合"), {"id": "wf-outfit-fusion-trial", "category": "trial", "lock": True, "desc": "试用：模特服装多模态融合（提示词已封装）", "cover_from": ("平面模板", "人物服装多模态融合")}),
    (("试用版模板", "人脸合成"), {"id": "wf-face-merge-trial", "category": "trial", "lock": True, "desc": "试用：两张人像融合生成新面孔（可选性别）", "cover_from": ("平面模板", "人物换脸模板")}),
    (("试用版模板", "国内电商详情页模板"), {"id": "wf-detail-cn-trial", "category": "trial", "lock": True, "desc": "试用：一键生成国内电商详情页（提示词已封装）"}),
    (("试用版模板", "模特箱包模板"), {"id": "wf-model-bag-trial", "category": "trial", "lock": True, "desc": "试用：箱包模特融合展示（提示词已封装）", "cover_from": ("平面模板", "模特箱包模板")}),
])

CATEGORY_ORDER = {"flat": 0, "video": 1, "detail": 2, "trial": 3}

# /assets/<name>-<vitehash>.<ext> 的显式覆盖(基名歧义时):指向 src/assets/templates 下的源图。
ASSETS_OVERRIDE = {
    "person-CmkXG1eh.jpg": "face-merge/person-1.jpg",
    "person-2-DrfuET6q.jpg": "face-merge/person-2.jpg",
    "result-CtxlYpG8.jpg": "face-merge/result.jpg",
}

# ── 暂存 / 哈希 ──
os.makedirs(STAGE, exist_ok=True)
manifest = {}          # remoteRel -> localAbs(去重)
staged_bytes = [0]     # 累计新写字节
unresolved = []        # (ctx, ref) 未解析的 /assets
missing_embedded = []  # (ctx, ref) zip 里找不到的 media


def downscale(b, ext, max_edge):
    """图片下采样 + 重压(有 alpha 留 PNG,否则转 JPEG q85)。失败/无 PIL → 原样。"""
    if not HAS_PIL:
        return b, ext
    try:
        im = Image.open(BytesIO(b))
        has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        w, h = im.size
        scale = min(1.0, max_edge / max(w, h)) if max(w, h) else 1.0
        if scale < 1.0:
            im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        out = BytesIO()
        if has_alpha:
            im.convert("RGBA").save(out, "PNG", optimize=True)
            return out.getvalue(), ".png"
        im.convert("RGB").save(out, "JPEG", quality=IMG_QUALITY, optimize=True)
        return out.getvalue(), ".jpg"
    except Exception:
        return b, ext


def transcode_video(b, ext):
    """ffmpeg 转码:长边 ≤ VIDEO_MAX、H.264 CRF、音频 48k 单声道、faststart。
    失败 / 反而更大 → 用原始字节。"""
    try:
        with tempfile.TemporaryDirectory() as td:
            ip = os.path.join(td, "in" + (ext or ".mp4"))
            op = os.path.join(td, "out.mp4")
            with open(ip, "wb") as f:
                f.write(b)
            cmd = [
                FFMPEG, "-y", "-loglevel", "error", "-i", ip,
                "-vf", f"scale={VIDEO_MAX}:{VIDEO_MAX}:force_original_aspect_ratio=decrease,"
                       "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:v", "libx264", "-crf", VIDEO_CRF, "-preset", "medium", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-movflags", "+faststart", op,
            ]
            r = subprocess.run(cmd, capture_output=True)
            if r.returncode == 0 and os.path.isfile(op) and os.path.getsize(op) > 0:
                with open(op, "rb") as f:
                    out = f.read()
                if len(out) < len(b):
                    return out, ".mp4"
    except Exception:
        pass
    return b, ext


def stage_bytes(b, ext, kind="image"):
    if kind == "video":
        b, ext = transcode_video(b, ext)
    elif ext.lower() in IMG_EXT:
        b, ext = downscale(b, ext, COVER_MAX if kind == "cover" else IMG_MAX)
    sha = hashlib.sha256(b).hexdigest()[:16]
    fname = f"{sha}{ext.lower()}"
    dest = os.path.join(STAGE, fname)
    if not os.path.isfile(dest):
        with open(dest, "wb") as f:
            f.write(b)
        staged_bytes[0] += len(b)
    remote_rel = f"{REMOTE_SUBDIR}/{fname}"
    manifest[remote_rel] = dest
    return NAS_BASE + remote_rel


# src/assets/templates 基名索引(去 vite hash 后)
_src_index = collections.defaultdict(list)
for root, _dirs, files in os.walk(SRC_TPL):
    for fn in files:
        base, ext = os.path.splitext(fn)
        if ext.lower() in IMG_EXT or ext.lower() in VIDEO_EXT:
            _src_index[base].append(os.path.join(root, fn))


def _strip_vite_hash(fname):
    # person-2-DrfuET6q.jpg -> person-2 ; result-CtxlYpG8.jpg -> result
    base, _ext = os.path.splitext(fname)
    parts = base.rsplit("-", 1)
    if len(parts) == 2 and 6 <= len(parts[1]) <= 12 and parts[1].isalnum():
        return parts[0]
    return base


def resolve_builtin(ref, ctx):
    """ /assets/<name> -> 暂存 url 或 None(未解析,保留原 ref)。 """
    fname = os.path.basename(ref)
    src = None
    if fname in ASSETS_OVERRIDE:
        cand = os.path.join(SRC_TPL, ASSETS_OVERRIDE[fname].replace("/", os.sep))
        if os.path.isfile(cand):
            src = cand
    if src is None:
        base = _strip_vite_hash(fname)
        cands = _src_index.get(base, [])
        if len(cands) == 1:
            src = cands[0]
    if src is None:
        unresolved.append((ctx, ref))
        return None
    ext = os.path.splitext(src)[1]
    with open(src, "rb") as f:
        return stage_bytes(f.read(), ext, "image")


def rewrite_refs(node, z, ctx, cache):
    if isinstance(node, str):
        if node.startswith("media/"):
            if node in cache:
                return cache[node]
            try:
                b = z.read(node)
            except KeyError:
                missing_embedded.append((ctx, node))
                return node
            ext = os.path.splitext(node)[1]
            kind = "video" if ext.lower() in VIDEO_EXT else "image"
            url = stage_bytes(b, ext, kind)
            cache[node] = url
            return url
        if node.startswith("/assets/"):
            if node in cache:
                return cache[node]
            url = resolve_builtin(node, ctx)
            cache[node] = url if url else node
            return cache[node]
        return node
    if isinstance(node, list):
        return [rewrite_refs(x, z, ctx, cache) for x in node]
    if isinstance(node, dict):
        return {k: rewrite_refs(v, z, ctx, cache) for k, v in node.items()}
    return node


def lock_prompts(cards):
    n = 0
    for c in cards:
        d = c["data"]
        content = (d.get("content") or "").strip()
        ptpl = (d.get("_promptTemplate") or "").strip()
        if content or ptpl:
            d["_locked"] = True
            if not d.get("_label"):
                d["_label"] = c.get("title") or "模板节点"
            if not d.get("_description"):
                d["_description"] = TRIAL_DESC
            n += 1
    return n


# ── 参考态清洗 / 自动命名(根治"参考图顺序乱"+"标签全未命名")────────────────
#
# 导出的 .aicat 把**运行态参考绑定**(refImages 槽位/inlineRefs/upstream* )原样带出。
# 这些绑定按"原项目卡片 UUID + 槽位顺序"冻结,模板被重新实例化时(新 UUID)会失配:
#   · refImages 槽位顺序 ≠ 连线顺序 → 面板/送模型的图序乱(buildImage/ChatRequest 都按槽序)
#   · inlineRefs 的 upstream 指向旧 UUID → 实例化后丢图
# 但**所有 317 个 refImages 都是连线产生的**(无文件上传/无孤儿,已审计),
# 所以最稳的做法是:**删掉所有运行态参考绑定**,让桌面端实例化时由 dataFlow
# 的 onConnectionsAdded → injectOnConnections 按**连线顺序**重新注入(填 refImage0,1,2…),
# 槽序 = 连线顺序 = 正确图序。内联令牌 {{ref:…}} 先按连线顺序转成纯文本「图N」再删。
# 连线顺序已验证为作者本意(outfit-fusion/skirt-flat 标注吻合;face-swap 还原原始 revisedPrompt)。

IMG_TYPES = {"ai_image", "ai_multiangle", "ai_tryon"}
REF_TOKEN_RE = re.compile(r"\{\{ref:([^}]+)\}\}")
# 实例化时由连线重新注入的运行态字段,模板里一律不带(带了会挡注入/顺序乱)。
RUNTIME_REF_FIELDS = [
    "refImages", "refVideos", "refAudios", "refFrames", "directMedia", "inlineRefs",
    "upstreamCardId", "upstreamText", "upstreamTexts", "upstreamImageUrl",
    "upstreamChatResult", "upstreamChatCardId", "personImageUrl", "garmentImageUrl",
    "sourceVideoUrl", "sourceVideoCardId",
]


def build_image_conn_order(raw_cards, canvas_conns):
    """target_card_id -> [source_card_id, …] —— 仅图片源,按 canvas 连线数组顺序。
    这与桌面端实例化时的注入顺序一致(connections 数组序 = addConnection 序 = 填槽序)。"""
    id2card = {c.get("id"): c for c in raw_cards}
    order = collections.defaultdict(list)
    for cn in canvas_conns:
        s, t = cn.get("source_card_id"), cn.get("target_card_id")
        if s in id2card and t in id2card and id2card[s].get("type") in IMG_TYPES:
            order[t].append(s)
    return order


def convert_tokens_to_plain(data, card_id, img_order):
    """把 {{ref:…}} 内联令牌转成纯文本「图N」(N=该图在连线顺序里的 1-based 位次)。
    优先用 inlineRef 解析源卡;inlineRef 缺失时(源项目可能漏存)直接按令牌 id
    `slot:refImageN` 查 refImages[slotKey].sourceCardId,或 `upstream:<id>` 直接取 id。
    必须在删 refImages/inlineRefs **之前**调。"""
    content = data.get("content")
    if not content or "{{ref:" not in content:
        return
    pos = {sid: i + 1 for i, sid in enumerate(img_order.get(card_id, []))}
    ref_images = data.get("refImages") or {}
    irs = {r.get("id"): r for r in (data.get("inlineRefs") or [])}

    def label_for(tid):
        sid = None
        r = irs.get(tid)
        if r:
            src = r.get("source") or {}
            if src.get("type") == "refSlot":
                e = ref_images.get(src.get("slotKey"))
                sid = e.get("sourceCardId") if isinstance(e, dict) else None
            elif src.get("type") == "upstream":
                sid = src.get("sourceCardId")
        elif tid.startswith("slot:"):
            e = ref_images.get(tid.split(":", 1)[1])
            sid = e.get("sourceCardId") if isinstance(e, dict) else None
        elif tid.startswith("upstream:"):
            sid = tid.split(":", 1)[1]
        p = pos.get(sid)
        if p:
            return f"图{p}"
        return (r.get("displayLabel") if r else None) or "图"

    data["content"] = REF_TOKEN_RE.sub(lambda m: label_for(m.group(1)), content)


def sanitize_card_data(data, card_id, img_order):
    """令牌转纯文本 → 删运行态参考绑定。保留 imageUrl/results/content/size/model 等预览与配置。"""
    convert_tokens_to_plain(data, card_id, img_order)
    for k in RUNTIME_REF_FIELDS:
        data.pop(k, None)


def assign_titles(raw_cards, img_order, overrides=None):
    """给无标题卡片自动起**模板内唯一**的通用名:输入图=参考图N、出图=效果图N、对话=提示词、
    视频=视频、文本=文本(均按出现顺序递增编号,首个省略 1)。已有标题(如手工「模特图(图1)」)保留。
    `overrides`={卡片下标: 标题} 可给特定卡指定有意义名(REGISTRY 的 titles),优先级高于自动名、
    不占用自动编号计数器。注:卡片标签只为画布可读;实际参考图序由连线顺序在实例化时重建,与标签无关。"""
    overrides = overrides or {}
    sources = set()  # 被连到生成卡的图片源(配 参考图N)
    for sids in img_order.values():
        sources.update(sids)

    cnt = collections.Counter()

    def numbered(prefix):
        cnt[prefix] += 1
        return prefix if cnt[prefix] == 1 else f"{prefix}{cnt[prefix]}"

    for idx, c in enumerate(raw_cards):
        if (c.get("title") or "").strip():
            continue
        if idx in overrides:
            c["title"] = overrides[idx]
            continue
        t = c.get("type")
        d = c.get("data") or {}
        has_prompt = bool((d.get("content") or "").strip() or (d.get("_promptTemplate") or "").strip())
        if t == "ai_chat":
            c["title"] = numbered("提示词")
        elif t == "ai_video":
            c["title"] = numbered("视频")
        elif t in ("text", "sticky_note"):
            c["title"] = numbered("文本")
        elif t == "frame_extractor":
            c["title"] = numbered("关键帧")
        elif t in IMG_TYPES:
            if has_prompt:
                cnt["out"] += 1
                c["title"] = f"效果图{cnt['out']}"
            elif c.get("id") in sources:
                cnt["ref"] += 1
                c["title"] = f"参考图{cnt['ref']}"
            else:
                cnt["img"] += 1
                c["title"] = f"图片{cnt['img']}"
        else:
            c["title"] = numbered("卡片")


def find_cover(cat_folder, tpl_folder):
    folder = os.path.join(BASE, cat_folder, tpl_folder)
    if not os.path.isdir(folder):
        return None
    for fn in sorted(os.listdir(folder)):
        if os.path.splitext(fn)[1].lower() in IMG_EXT:
            with open(os.path.join(folder, fn), "rb") as f:
                return stage_bytes(f.read(), os.path.splitext(fn)[1], "cover")
    return None


def process(cat_folder, tpl_folder, reg):
    ctx = f"{cat_folder}/{tpl_folder}"
    tdir = os.path.join(BASE, cat_folder, tpl_folder)
    aicats = [f for f in os.listdir(tdir) if f.lower().endswith(".aicat")]
    if not aicats:
        print(f"  [WARN] {ctx} 无 .aicat,跳过")
        return None
    z = zipfile.ZipFile(os.path.join(tdir, aicats[0]))
    manifest_json = json.loads(z.read("manifest.json").decode("utf-8")) if "manifest.json" in z.namelist() else {}
    canvas = json.loads(z.read("canvas.json").decode("utf-8"))
    raw_cards = canvas.get("cards", [])
    if canvas.get("groups"):
        print(f"  [WARN] {ctx} 含 {len(canvas['groups'])} 个分组,WorkflowTemplate 不支持,已忽略")

    # 解析 data(字符串 JSON)+ 改写媒体引用
    cache = {}
    for c in raw_cards:
        d = c.get("data")
        if isinstance(d, str):
            d = json.loads(d) if d.strip() else {}
        c["data"] = rewrite_refs(d if isinstance(d, dict) else {}, z, ctx, cache)

    # 自动命名(无标题卡)+ 清洗运行态参考绑定(令牌转「图N」后删 refImages/inlineRefs/upstream*)。
    # 顺序:先按连线算图序 → 起名(参考图N 与图序对齐)→ 用图序把令牌转纯文本再删绑定。
    img_order = build_image_conn_order(raw_cards, canvas.get("connections", []))
    assign_titles(raw_cards, img_order, reg.get("titles"))
    for c in raw_cards:
        sanitize_card_data(c["data"], c.get("id"), img_order)

    # 试用版锁提示词(此时标题已就位,_label 用得到)
    locked = lock_prompts(raw_cards) if reg.get("lock") else 0

    # 坐标归一(最小点 → 原点)
    xs = [c.get("x", 0.0) for c in raw_cards] or [0.0]
    ys = [c.get("y", 0.0) for c in raw_cards] or [0.0]
    minx, miny = min(xs), min(ys)

    presets = []
    for c in raw_cards:
        presets.append({
            "type": c.get("type"),
            "title": c.get("title") or "",
            "relativeX": int(round(c.get("x", 0.0) - minx)),
            "relativeY": int(round(c.get("y", 0.0) - miny)),
            "width": c.get("width"),
            "height": c.get("height"),
            "data": c["data"],
        })

    idmap = {c.get("id"): i for i, c in enumerate(raw_cards)}
    conns = []
    for cn in canvas.get("connections", []):
        s = idmap.get(cn.get("source_card_id"))
        t = idmap.get(cn.get("target_card_id"))
        if s is not None and t is not None:
            conns.append({"sourceIndex": s, "targetIndex": t})

    cover_src = reg.get("cover_from", (cat_folder, tpl_folder))
    cover_url = find_cover(*cover_src)

    name = reg.get("name") or (manifest_json.get("project") or {}).get("title") or tpl_folder
    if reg["category"] == "trial" and "试用" not in name:
        name = f"{name}（试用）"
    has_video = any(c.get("type") == "ai_video" for c in raw_cards)

    tpl = {
        "id": reg["id"],
        "name": name,
        "description": reg.get("desc", ""),
        "icon": "Video" if has_video else "ImageIcon",
        "category": reg["category"],
        "coverImage": cover_url,
        "cards": presets,
        "connections": conns,
    }
    media_n = (manifest_json.get("counts") or {}).get("media", 0)
    print(f"  [{reg['category']}] {reg['id']:<26} cards={len(presets):>2} conn={len(conns):>2} "
          f"media={media_n:>2} locked={locked} cover={'Y' if cover_url else 'N'} ← {ctx}")
    return tpl


def _apply_relayout(templates):
    """复用 relayout-templates.py 的分层布局算法,就地重排每个模板卡片坐标(只动 relativeX/Y)。
    并进 import 末尾是**根治**:此前 relayout 是独立手动步,重跑 import 会静默把整洁布局冲回
    .aicat 原始散乱坐标(踩过坑)。现在 import 自带 relayout → 重跑也永远输出整洁布局,
    无需再单独 `relayout-templates.py --write`。失败不致命(回退原始坐标 + 警告)。"""
    try:
        import importlib.util
        path = os.path.join(REPO, "scripts", "relayout-templates.py")
        spec = importlib.util.spec_from_file_location("relayout_templates", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        for t in templates:
            mod.relayout(t)
        print("[import] 已就地 relayout(整洁布局)")
    except Exception as e:
        print(f"[import] ⚠ relayout 失败,保留原始坐标:{e}")


def _apply_relabel(templates):
    """复用 relabel-templates.py 按真实角色规范化图片卡标签(参考图N/效果图N)。
    并进 import 末尾是**根治**:assign_titles 的 has_prompt 启发式 + 保留 .aicat 原标题,
    会把生成图(effect)误标成 参考图/图片(踩过坑,用户反馈"参考图标签是效果图")。
    relabel 用「有 content 或有入边 = 效果图」的可靠规则纠正,描述性名字保留。失败不致命。"""
    try:
        import importlib.util
        path = os.path.join(REPO, "scripts", "relabel-templates.py")
        spec = importlib.util.spec_from_file_location("relabel_templates", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        nch = sum(len(mod.relabel(t)) for t in templates)
        print(f"[import] 已就地 relabel(图片卡标签按角色规范化,{nch} 改名)")
    except Exception as e:
        print(f"[import] ⚠ relabel 失败,保留原标签:{e}")


def main():
    print(f"[import] 源={BASE}\n[import] 暂存={STAGE}\n")
    templates = []
    seq = 0
    for (cat_folder, tpl_folder), reg in REGISTRY.items():
        if reg.get("drop"):
            print(f"  [drop] {cat_folder}/{tpl_folder}（重复，归其它分类）")
            continue
        reg = dict(reg, _seq=seq)
        seq += 1
        tpl = process(cat_folder, tpl_folder, reg)
        if tpl:
            tpl["_seq"] = reg["_seq"]
            templates.append(tpl)

    # 排序:分类顺序 → 注册顺序;清掉 _seq
    templates.sort(key=lambda t: (CATEGORY_ORDER.get(t["category"], 9), t["_seq"]))
    for t in templates:
        t.pop("_seq", None)

    # 写盘前就地重排布局(根治"重跑 import 冲掉整洁布局")。
    _apply_relayout(templates)
    # 再按真实角色规范化图片卡标签(根治"生成图被误标成参考图/图片")。
    _apply_relabel(templates)

    seed_path = os.path.join(REPO, "scripts", "templates-seed.json")
    fallback_path = os.path.join(REPO, "src", "config", "templatesFallback.json")
    man_path = os.path.join(REPO, "scripts", "templates-imported-manifest.json")
    json.dump(templates, open(seed_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    json.dump(templates, open(fallback_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    man_list = [{"localAbs": v, "remoteRel": k} for k, v in sorted(manifest.items())]
    json.dump(man_list, open(man_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    by_cat = collections.Counter(t["category"] for t in templates)
    print(f"\n[import] DONE — {len(templates)} 模板 {dict(by_cat)}")
    print(f"[import] 媒体:{len(manifest)} 个唯一文件(含封面),本次新写 {staged_bytes[0]/1048576:.1f} MB → {STAGE}")
    print(f"[import] → {seed_path}")
    print(f"[import] → {fallback_path}")
    print(f"[import] → {man_path}")
    if missing_embedded:
        print(f"\n[import] ⚠ zip 内缺失 media({len(missing_embedded)}):")
        for ctx, ref in missing_embedded[:20]:
            print(f"   {ctx}  {ref}")
    if unresolved:
        uniq = sorted(set(r for _c, r in unresolved))
        print(f"\n[import] ⚠ 未解析 /assets 引用({len(unresolved)} 处, {len(uniq)} 个唯一) — 这些卡预览图会空,功能不受影响:")
        for r in uniq:
            ctxs = sorted(set(c for c, rr in unresolved if rr == r))
            print(f"   {r}  ← {', '.join(ctxs)}")
    print("\n下一步:① python scripts/upload-imported-assets.py  ② python scripts/seed-templates-db.py")
    print("       (布局已在 import 内自动 relayout,无需再单独跑 relayout-templates.py)")


if __name__ == "__main__":
    main()
