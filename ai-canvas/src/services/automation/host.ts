/**
 * 自动化 host —— 前端常驻分发器。
 *
 * 监听 Rust emit 的 `automation:request`,按动词名查 registry 执行,把统一信封经
 * `automation_respond` 回传 Rust。这是外部 HTTP/MCP 与画布之间的"执行端",所有动词都在
 * 这里跑,与 UI 完全同一代码路径(门禁/黑箱/持久化天然继承)。
 *
 * 应用内对话面板(P3)将复用同一 `handleRequest`,只是 source 标记为 "panel"。
 */

import { isTauri, ensureTauriAPIs, getListen } from "@/platform/runtime";
import { automationRespond, automationSetDescriptor } from "@/platform/automation.api";
import { verbRegistry } from "./registry";
import { registerAllVerbs } from "./verbs";
import { VerbError } from "./types";
import type { RequestEvent, CallResponse, ErrorCode } from "./types";

/** 单 host 在途请求上限。超出回 BUSY,防大批并发打崩 WebView2 IPC(见 ipcLimits 历史教训)。 */
const MAX_CONCURRENT = 4;
let inFlight = 0;

function errorResponse(
  requestId: string,
  code: ErrorCode,
  message: string,
): CallResponse {
  return { ok: false, requestId, error: { code, message } };
}

/** 把一个请求事件派发给对应动词并产出响应信封。对话面板与桥共用。 */
export async function handleRequest(ev: RequestEvent): Promise<CallResponse> {
  const { requestId, verb, params } = ev;

  const def = verbRegistry.get(verb);
  if (!def) {
    return errorResponse(requestId, "NOT_FOUND", `未知动词: ${verb}`);
  }
  if (inFlight >= MAX_CONCURRENT) {
    return errorResponse(requestId, "BUSY", "并发请求过多,请稍后重试");
  }

  const p =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};

  inFlight += 1;
  try {
    const data = await def.handler(p, { source: ev.source, requestId });
    return { ok: true, requestId, data };
  } catch (err) {
    if (err instanceof VerbError) {
      return errorResponse(requestId, err.code, err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(requestId, "INTERNAL", msg);
  } finally {
    inFlight -= 1;
  }
}

let unlisten: (() => void) | null = null;

/**
 * 安装 host:注册动词、把 schema 推给 Rust(MCP tools/list 用)、装上事件监听。
 * 幂等。非 Tauri 环境直接跳过(自动化桥不可用)。
 */
export async function installAutomationHost(): Promise<void> {
  if (!isTauri) return;
  registerAllVerbs();
  await ensureTauriAPIs();
  await automationSetDescriptor(verbRegistry.toDescriptor());

  if (unlisten) return;
  const listen = getListen();
  unlisten = await listen<RequestEvent>("automation:request", (event) => {
    void handleRequest(event.payload).then((resp) => automationRespond(resp));
  });
}

export function uninstallAutomationHost(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}
