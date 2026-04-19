export const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

let _invoke: typeof import("@tauri-apps/api/core").invoke;
let _listen: typeof import("@tauri-apps/api/event").listen;

export async function ensureTauriAPIs() {
  if (!_invoke) {
    const core = await import("@tauri-apps/api/core");
    _invoke = core.invoke;
  }
  if (!_listen) {
    const event = await import("@tauri-apps/api/event");
    _listen = event.listen;
  }
}

export function getInvoke() {
  return _invoke;
}

export function getListen() {
  return _listen;
}
