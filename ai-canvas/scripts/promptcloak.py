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


if __name__ == "__main__":
    # 跨语言对拍:打印固定样例的编码串,粘进 buildRequests.test.ts 做 TS 解码断言。
    for sample in ["a poster", "红裙", "模特服装多模态融合：把图1的人物换成图2的服装"]:
        enc = cloak(sample)
        assert uncloak(enc) == sample, "round-trip 不一致"
        print(f"{sample!r}\n  -> {enc}\n  <- {uncloak(enc)!r}\n")
