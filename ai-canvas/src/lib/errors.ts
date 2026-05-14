// 数字 code 对应 JiJing 后端 com.jijing.common.core.exception.ErrorCode：
//   10001 = FAILED          (操作失败 / 业务级失败的兜底)
//   10002 = BAD_REQUEST     (参数错误 / 调用非法)
//   10003 = NOT_FOUND       (资源不存在 / 任务不存在 / 模型路由缺失)
//   10004 = INTERNAL_ERROR  (后端内部异常, 上游适配器抛错通常落这里)
//   20003 = AUTH_TOKEN_EXPIRED (网关认证体系自己的码段, 通用前端兜底)
// 字符串 type 对应 OpenAI 风格错误（保留向后兼容，调用 OpenAI 兼容渠道时上游会回这些）。
const ERROR_CODE_MAP: Record<string, string> = {
  "10001": "操作失败，请稍后重试或检查请求参数",
  "10002": "请求参数错误，请检查输入",
  "10003": "资源或任务不存在",
  "10004": "服务内部错误，请稍后重试",
  "20003": "登录已过期，请重新登录",
  insufficient_quota: "余额不足，请充值后重试",
  model_not_found: "模型不存在，请检查模型名称",
  invalid_api_key: "API Key 无效",
  rate_limit_exceeded: "请求频率过高，请稍后重试",
  context_length_exceeded: "输入内容过长，请缩短提示词",
};

// HTTP 状态码 → 友好文案。覆盖网关/上游最常见的错误，让用户能区分"我方问题"还是"上游问题"。
const HTTP_STATUS_MAP: Record<string, string> = {
  "400": "请求格式错误（HTTP 400），请检查参数",
  "401": "未授权（HTTP 401），API Key 无效或登录已过期",
  "403": "访问被拒绝（HTTP 403），可能权限不足或被风控",
  "404": "接口不存在（HTTP 404），请检查 API 路径",
  "408": "请求超时（HTTP 408），请稍后重试",
  "413": "请求体过大（HTTP 413），请减少图片数量或压缩输入",
  "429": "请求频率过高（HTTP 429），请稍后重试",
  "500": "上游服务内部错误（HTTP 500），请稍后重试",
  "502": "上游网关错误（HTTP 502 Bad Gateway），上游模型服务暂时不可用或正在重启，请稍后重试",
  "503": "上游服务暂不可用（HTTP 503），可能在维护或过载，请稍后重试",
  "504": "上游网关超时（HTTP 504 Gateway Timeout），上游响应过慢，请稍后重试",
};

function matchHttpStatus(raw: string): string | null {
  // 网关 HTML 错误页：<title>502 Bad Gateway</title>
  if (/<html[\s>]/i.test(raw)) {
    const titleMatch = raw.match(/<title>\s*(\d{3})\s+([^<]+?)\s*<\/title>/i);
    const h1Match = raw.match(/<h1>\s*(\d{3})\s+([^<]+?)\s*<\/h1>/i);
    const m = titleMatch ?? h1Match;
    if (m) {
      const status = m[1]!;
      const reason = m[2]!.trim();
      return HTTP_STATUS_MAP[status] ?? `上游返回 HTTP ${status} ${reason}，请稍后重试`;
    }
    return "上游服务器返回错误页面，请稍后重试";
  }

  // 纯文本：形如 "HTTP 502" / "status 502" / "502 Bad Gateway"
  const textMatch = raw.match(/(?:HTTP[/ ]?\d?\.?\d?\s+|status[:\s]+|^|\s)(\d{3})\s+(Bad\s+Gateway|Gateway\s+Timeout|Service\s+Unavailable|Internal\s+Server\s+Error|Not\s+Found|Unauthorized|Forbidden|Too\s+Many\s+Requests)/i);
  if (textMatch) {
    const status = textMatch[1]!;
    return HTTP_STATUS_MAP[status] ?? null;
  }

  return null;
}

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

  const httpMatched = matchHttpStatus(raw);
  if (httpMatched) return httpMatched;

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
