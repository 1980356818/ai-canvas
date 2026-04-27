"""
Real API test: verify that the gpt-image-2 size map produces images at the
requested pixel dimensions through Comfly's /v1/images/generations endpoint.

Mirrors the size map in `src/providers/openai-compat/base.ts`.
"""
import json
import struct
import sys
import time
import urllib.request
import urllib.error
from io import BytesIO

API_URL = "https://ai.comfly.chat/v1/images/generations"
API_KEY = "sk-PcGW28MxA0vyShZTKaYjtbr7Za8LxO94xRYxtgJeLpLS8oSt"
MODEL = "gpt-image-2"

SIZE_MAP = {
    "2K": {
        "1:1":  "2048x2048",
        "3:2":  "1920x1280",
        "2:3":  "1280x1920",
        "16:9": "2560x1440",
        "9:16": "1440x2560",
    },
    "4K": {
        "1:1":  "2880x2880",
        "3:2":  "3072x2048",
        "2:3":  "2048x3072",
        "16:9": "3840x2160",
        "9:16": "2160x3840",
    },
}

PROMPT = "A simple red apple on a white wooden table, soft natural daylight"


def parse_image_size(data: bytes):
    """Return (w, h) by sniffing the file header. Supports PNG/JPEG/WebP."""
    if len(data) < 24:
        return None

    # PNG: 89 50 4E 47 ... IHDR @ 16: width(4), height(4)
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack(">II", data[16:24])
        return w, h

    # JPEG: scan for SOF marker
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            i += 2
            if marker in (0xD8, 0xD9):
                continue
            if 0xD0 <= marker <= 0xD7:
                continue
            seg_len = struct.unpack(">H", data[i:i + 2])[0]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", data[i + 3:i + 7])
                return w, h
            i += seg_len
        return None

    # WebP
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        if data[12:16] == b"VP8 ":
            w = struct.unpack("<H", data[26:28])[0] & 0x3FFF
            h = struct.unpack("<H", data[28:30])[0] & 0x3FFF
            return w, h
        if data[12:16] == b"VP8L":
            b0, b1, b2, b3 = data[21], data[22], data[23], data[24]
            w = 1 + (((b1 & 0x3F) << 8) | b0)
            h = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
            return w, h
        if data[12:16] == b"VP8X":
            w = 1 + (data[24] | (data[25] << 8) | (data[26] << 16))
            h = 1 + (data[27] | (data[28] << 8) | (data[29] << 16))
            return w, h
    return None


def call_api(size_str: str, timeout: int = 180):
    body = {
        "model": MODEL,
        "prompt": PROMPT,
        "size": size_str,
        "n": 1,
        "response_format": "b64_json",
        "quality": "standard",
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            txt = resp.read().decode("utf-8", errors="replace")
            elapsed = time.time() - t0
            return resp.status, txt, elapsed
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace"), time.time() - t0
    except Exception as e:
        return 0, f"ERR:{e}", time.time() - t0


def fetch_dims(url: str):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            data = r.read(64 * 1024)
            return parse_image_size(data)
    except Exception as e:
        return f"fetch_err:{e}"


def run_test(ratio: str, resolution: str):
    expected_size = SIZE_MAP[resolution][ratio]
    ew, eh = map(int, expected_size.split("x"))
    print(f"\n[{resolution} {ratio}] requesting size={expected_size}")

    status, body, elapsed = call_api(expected_size)
    if status != 200:
        print(f"  HTTP {status} ({elapsed:.1f}s) body={body[:200]}")
        return False

    try:
        data = json.loads(body)
        item = data["data"][0]
        b64 = item.get("b64_json")
        url = item.get("url")
    except Exception as e:
        print(f"  parse err: {e}; body={body[:200]}")
        return False

    raw = None
    if b64:
        import base64
        # Comfly returns data URLs like "data:image/png;base64,iVBOR..."
        if "," in b64[:64]:
            b64 = b64.split(",", 1)[1]
        b64_clean = "".join(b64.split())
        pad = (-len(b64_clean)) % 4
        try:
            raw = base64.b64decode(b64_clean + "=" * pad, validate=False)
        except Exception as e:
            print(f"  b64 decode err: {e}; len={len(b64_clean)}")
            return False
        print(f"  HTTP 200 ({elapsed:.1f}s) b64 bytes={len(raw)}")
    elif url:
        print(f"  HTTP 200 ({elapsed:.1f}s) url={url[:80]}...")
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                raw = r.read()
        except Exception as e:
            print(f"  url fetch err: {e}")
            return False
    else:
        print(f"  no image data in response: {body[:200]}")
        return False

    dims = parse_image_size(raw)
    if dims is None:
        print(f"  could not parse image header (first bytes: {raw[:16].hex()})")
        return False

    aw, ah = dims
    ok = (aw == ew and ah == eh)
    mark = "PASS" if ok else "FAIL"
    print(f"  expected={ew}x{eh}  actual={aw}x{ah}  -> {mark}")
    return ok


def main():
    cases = [
        ("1:1",  "2K"),
        ("16:9", "4K"),
        ("9:16", "2K"),
    ]
    if "--full" in sys.argv:
        cases = [(r, res) for res in SIZE_MAP for r in SIZE_MAP[res]]

    print(f"Running {len(cases)} test(s) against {API_URL}")
    print(f"Model: {MODEL}")

    results = {}
    for ratio, res in cases:
        results[(res, ratio)] = run_test(ratio, res)

    print("\n=== Summary ===")
    passed = sum(1 for v in results.values() if v)
    for (res, ratio), ok in results.items():
        print(f"  {res} {ratio}: {'PASS' if ok else 'FAIL'}")
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
