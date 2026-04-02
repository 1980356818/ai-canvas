export type AgentErrorCode =
  | "NO_API_KEY"
  | "PROVIDER_ERROR"
  | "TOOL_ERROR"
  | "MAX_ROUNDS"
  | "UNKNOWN";

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }

  static noApiKey(provider: string) {
    return new AgentError(
      "NO_API_KEY",
      `Provider "${provider}" 的 API Key 未配置，请在设置中填写`,
    );
  }

  static providerError(detail: string) {
    return new AgentError("PROVIDER_ERROR", detail);
  }

  static toolError(tool: string, detail: string) {
    return new AgentError("TOOL_ERROR", `工具 "${tool}" 执行失败: ${detail}`);
  }

  static maxRounds() {
    return new AgentError("MAX_ROUNDS", "已达到最大执行轮次");
  }
}
