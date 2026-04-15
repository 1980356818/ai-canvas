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

  if (raw.includes("Failed to fetch") || raw.includes("请求失败")) {
    return "网络连接失败，请检查网络和 API 地址";
  }
  if (raw.includes("timeout") || raw.includes("Timeout")) {
    return "请求超时，请稍后重试";
  }

  return raw.length > 120 ? raw.slice(0, 120) + "…" : raw;
}
