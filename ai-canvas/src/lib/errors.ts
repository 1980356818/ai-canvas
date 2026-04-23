const ERROR_CODE_MAP: Record<string, string> = {
  "10004": "模型不可用或分组不支持，请检查模型名称和令牌分组",
  "10001": "API Key 无效或已过期",
  "10002": "余额不足",
  "10003": "请求频率过高，请稍后重试",
  insufficient_quota: "余额不足，请充值后重试",
  model_not_found: "模型不存在，请检查模型名称",
  invalid_api_key: "API Key 无效",
  rate_limit_exceeded: "请求频率过高，请稍后重试",
  context_length_exceeded: "输入内容过长，请缩短提示词",
};

export function friendlyError(raw: string): string {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const err = obj.error ?? obj;
      const code = err.code ?? err.type ?? "";
      const msg = err.message ?? obj.message ?? "";

      const mapped = ERROR_CODE_MAP[String(code)];
      if (mapped) return mapped;

      if (msg) return msg;
    } catch { /* fall through */ }
  }

  if (raw.includes("timeout") || raw.includes("Timeout") || raw.includes("timed out")) {
    return "连接超时，服务器未在规定时间内响应，请稍后重试";
  }

  if (raw.includes("Failed to fetch") || raw.includes("请求失败") || raw.includes("连接失败")) {
    return classifyNetworkError(raw);
  }

  return raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
}

function classifyNetworkError(raw: string): string {
  const lower = raw.toLowerCase();

  if (lower.includes("dns") || lower.includes("resolve") || lower.includes("getaddrinfo")) {
    return "域名解析失败，请检查 API 地址是否正确";
  }
  if (lower.includes("certificate") || lower.includes("ssl") || lower.includes("tls") || lower.includes("handshake")) {
    return "TLS/SSL 安全连接失败，可能是证书问题或网络代理干扰";
  }
  if (lower.includes("connection refused") || lower.includes("拒绝")) {
    return "服务器拒绝连接，请检查 API 地址和端口是否正确";
  }
  if (lower.includes("connection reset") || lower.includes("broken pipe")) {
    return "连接被重置，可能是网络不稳定或服务器繁忙";
  }
  if (lower.includes("proxy")) {
    return "代理连接失败，请检查系统代理设置";
  }

  const urlMatch = raw.match(/url=([^\s,)]+)/);
  const urlHint = urlMatch ? `（目标: ${urlMatch[1]}）` : "";
  return `网络连接失败${urlHint}，请检查：1) API 地址是否正确 2) 网络/代理是否通畅 3) 服务是否可用`;
}
