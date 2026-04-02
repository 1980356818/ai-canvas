export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isAuthError() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isRateLimited() {
    return this.status === 429;
  }
  get isInsufficientBalance() {
    return this.status === 402 || this.code === "insufficient_balance";
  }
}

export function parseApiError(status: number, body: string): ApiError {
  let message: string;
  let code: string | undefined;

  try {
    const parsed = JSON.parse(body);
    const err = parsed.error ?? parsed;
    message = err.message ?? err.msg ?? body;
    code = err.code ?? err.type;
  } catch {
    message = body || `HTTP ${status}`;
  }

  switch (status) {
    case 401:
      return new ApiError(
        message || "API Key 无效或已过期，请在设置中检查",
        status,
        code,
      );
    case 402:
      return new ApiError(message || "账户余额不足", status, code);
    case 403:
      return new ApiError(
        message || "API Key 缺少所需权限",
        status,
        code,
      );
    case 429:
      return new ApiError(
        message || "请求过于频繁，请稍后再试",
        status,
        code,
      );
    default:
      return new ApiError(message || `请求失败 (HTTP ${status})`, status, code);
  }
}

export function throwIfError(status: number, body: string): void {
  if (status >= 400) {
    throw parseApiError(status, body);
  }
}
