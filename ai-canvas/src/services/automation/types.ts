/**
 * 自动化动词层的协议类型 —— 与 Rust 端 `src-tauri/src/automation/protocol.rs` 对齐。
 *
 * 三种入口 (外部 HTTP `/v1/call`、MCP `/mcp`、应用内对话面板) 都规约成 `{verb, params}`,
 * 由本目录下的 verbs 执行。本文件只定义形状与错误约定,不含逻辑。
 */

/**
 * 闭集错误码。Rust 自身只产生其中一个子集 (DISABLED/UNAUTHORIZED/INVALID_ARGS/TIMEOUT/
 * INTERNAL);其余由前端动词产生并经 Rust 透传。改这里要同步设计文档 §3.2 与 Rust `ErrorCode`。
 */
export type ErrorCode =
  | "DISABLED"
  | "UNAUTHORIZED"
  | "INVALID_ARGS"
  | "NOT_FOUND"
  | "GATED"
  | "UPSTREAM_FAILED"
  | "TIMEOUT"
  | "BUSY"
  | "INTERNAL";

/** Rust → 前端的事件载荷 (`listen("automation:request")`)。 */
export interface RequestEvent {
  requestId: string;
  verb: string;
  params: unknown;
  /** `bridge` = 外部 HTTP/MCP;`panel` = 应用内对话面板。 */
  source: "bridge" | "panel";
}

/** 统一响应信封,前端构造后经 `automation_respond` 回传 Rust。 */
export interface CallResponse {
  ok: boolean;
  requestId: string;
  data?: unknown;
  error?: { code: ErrorCode; message: string };
}

/** JSON Schema (动词参数的结构描述,直接喂给 MCP `inputSchema`)。 */
export type JsonSchema = Record<string, unknown>;

/** 动词执行上下文。 */
export interface VerbContext {
  source: "bridge" | "panel";
  requestId: string;
}

/** 一个动词的完整定义:名字 + 描述 + 参数 schema + 执行器。 */
export interface VerbDefinition {
  name: string;
  description: string;
  /** 参数的 JSON Schema;同时用于 MCP tools/list 的 inputSchema。 */
  params: JsonSchema;
  handler: (params: Record<string, unknown>, ctx: VerbContext) => Promise<unknown>;
}

/**
 * 动词内抛出的受控错误,携带闭集 code。未捕获的普通 Error 一律归为 `INTERNAL`。
 * 这是动词向调用方表达"为什么失败"的唯一结构化渠道。
 */
export class VerbError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "VerbError";
  }
}

/** 便捷构造器,语义比 `new VerbError(...)` 更顺口。 */
export const fail = (code: ErrorCode, message: string): VerbError =>
  new VerbError(code, message);
