"""提示词「障眼法」编码 —— 与 `src/lib/promptCloak.ts` 同算法、同 KEY、同 MARK。

派生脚本 `derive-trial-templates.py` 用 `cloak()` 把试用版提示词编码成 `ENC1::` 串
存进模板定义;客户端 `promptCloak.ts::uncloakPrompt` 在生成出口解码。

⚠️ 改 KEY / 算法 / MARK 必须**两端同步**,否则客户端解不开 → 试用卡发乱码上游。
这是障眼法不是加密(KEY 编在客户端可被扒),只为不让 casual 一眼看见明文。
见 `docs/平面模板试用版-提示词封装-施工图.md`。

算法:utf8(s) → 逐字节 XOR 循环 KEY → base64 → 前缀 "ENC1::"。
"""
import base64

KEY = b"ac-trial-cloak-2026"
MARK = "ENC1::"


def _xor_cycle(data: bytes) -> bytes:
    """逐字节 XOR 循环 KEY(自反:同一函数既加也解)。"""
    return bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(data))


def is_cloaked(s) -> bool:
    return isinstance(s, str) and s.startswith(MARK)


def cloak(s):
    """明文 → ENC1:: 串。空 / 已编码 / 非字符串原样返回(幂等)。"""
    if not isinstance(s, str) or s == "" or s.startswith(MARK):
        return s
    return MARK + base64.b64encode(_xor_cycle(s.encode("utf-8"))).decode("ascii")


def uncloak(s):
    """ENC1:: 串 → 明文。仅供对拍 / 校验。"""
    if not isinstance(s, str) or not s.startswith(MARK):
        return s
    return _xor_cycle(base64.b64decode(s[len(MARK):])).decode("utf-8")


# ---------------------------------------------------------------------------
# Card-level cloaking (shared by derive-trial-templates.py / cloak-templates.py)
# ---------------------------------------------------------------------------

AI_CARD_TYPES = {"ai_image", "ai_chat", "ai_video", "ai_tryon", "ai_multiangle"}
PROMPT_FIELDS = ("content", "_systemPrompt", "_promptTemplate")
DEFAULT_LOCK_DESC = "提示词已封装"


def cloak_card_prompts(card, *, lock_description=DEFAULT_LOCK_DESC) -> int:
    """对一张 AI 卡的提示词字段就地 cloak + 上锁。返回封装的字段数(0=该卡无提示词,不动)。"""
    if card.get("type") not in AI_CARD_TYPES:
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
            data["_description"] = lock_description
    return n


def uncloak_card_prompts(card) -> int:
    """对一张 AI 卡的提示词字段就地 uncloak + 解锁。返回解封的字段数。"""
    if card.get("type") not in AI_CARD_TYPES:
        return 0
    data = card.get("data")
    if not isinstance(data, dict):
        return 0
    n = 0
    for field in PROMPT_FIELDS:
        v = data.get(field)
        if is_cloaked(v):
            data[field] = uncloak(v)
            n += 1
    if n:
        data.pop("_locked", None)
    return n


def cloak_template(tpl, **kwargs) -> int:
    """对一个模板的所有卡就地封装提示词。返回封装字段总数。"""
    return sum(cloak_card_prompts(c, **kwargs) for c in tpl.get("cards", []))


def uncloak_template(tpl) -> int:
    """对一个模板的所有卡就地解封提示词。返回解封字段总数。"""
    return sum(uncloak_card_prompts(c) for c in tpl.get("cards", []))


def _downstream_targets(tpl, src_idx):
    """返回 [(target_idx, target_card), ...](按 connections sourceIndex/targetIndex 解析)。"""
    cards = tpl.get("cards", [])
    out = []
    for conn in tpl.get("connections", []) or []:
        if conn.get("sourceIndex") == src_idx:
            ti = conn.get("targetIndex")
            if isinstance(ti, int) and 0 <= ti < len(cards):
                out.append((ti, cards[ti]))
    return out


def handle_chat_result(tpl) -> tuple:
    """处理 ai_chat 卡的 result 字段(试用版语义清场)。**必须在 cloak_template 之前调用**。

    - BOTH(content+result 都非空):清空 result(content 走 cloak 钩子封装)。
    - RESULT_ONLY(content 空、result 非空):
        * 下游含 ai_chat → 把 result 明文前置拼到下游 ai_chat 的 content,
          然后清空本卡 result(下游 content 后续 cloak 会一并封装)。
        * 下游不含 ai_chat(空 / 仅 ai_image):保留 result 原样。

    返回 (cleared_count, injected_count, preserved_count)。
    """
    cleared = injected = preserved = 0
    cards = tpl.get("cards", [])
    for idx, card in enumerate(cards):
        if card.get("type") != "ai_chat":
            continue
        data = card.get("data")
        if not isinstance(data, dict):
            continue
        content_v = data.get("content")
        result_v = data.get("result")
        content_s = content_v.strip() if isinstance(content_v, str) else ""
        result_s = result_v.strip() if isinstance(result_v, str) else ""
        if not result_s:
            continue
        if content_s:
            data["result"] = ""
            cleared += 1
            continue
        targets = _downstream_targets(tpl, idx)
        chat_targets = [(ti, tc) for ti, tc in targets if tc.get("type") == "ai_chat"]
        if not chat_targets:
            preserved += 1
            continue
        for _, tc in chat_targets:
            tdata = tc.get("data")
            if not isinstance(tdata, dict):
                tdata = {}
                tc["data"] = tdata
            existing = tdata.get("content")
            existing_s = existing if isinstance(existing, str) else ""
            if is_cloaked(existing_s):
                continue
            merged = (result_v + "\n\n" + existing_s) if existing_s else result_v
            tdata["content"] = merged
            injected += 1
        data["result"] = ""
    return cleared, injected, preserved


if __name__ == "__main__":
    # 跨语言对拍:打印固定样例的编码串,粘进 buildRequests.test.ts 做 TS 解码断言。
    for sample in ["a poster", "红裙", "模特服装多模态融合：把图1的人物换成图2的服装"]:
        enc = cloak(sample)
        assert uncloak(enc) == sample, "round-trip 不一致"
        print(f"{sample!r}\n  -> {enc}\n  <- {uncloak(enc)!r}\n")
