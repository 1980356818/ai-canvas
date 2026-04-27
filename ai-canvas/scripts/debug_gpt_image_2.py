import json
import urllib.request
import time

API_URL = "https://ai.comfly.chat/v1/images/generations"
API_KEY = "sk-PcGW28MxA0vyShZTKaYjtbr7Za8LxO94xRYxtgJeLpLS8oSt"

body = {
    "model": "gpt-image-2",
    "prompt": "A simple red apple on a white wooden table",
    "size": "1024x1024",
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
with urllib.request.urlopen(req, timeout=180) as resp:
    txt = resp.read().decode("utf-8", errors="replace")

print(f"HTTP {resp.status} ({time.time() - t0:.1f}s)")
print(f"body length: {len(txt)}")

data = json.loads(txt)
print(f"top-level keys: {list(data.keys())}")
if "data" in data and len(data["data"]) > 0:
    item = data["data"][0]
    print(f"data[0] keys: {list(item.keys())}")
    for k, v in item.items():
        if isinstance(v, str) and len(v) > 100:
            print(f"  {k} (len={len(v)}): {v[:80]}...")
        else:
            print(f"  {k}: {v}")
