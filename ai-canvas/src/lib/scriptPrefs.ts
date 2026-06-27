/** 「帮我写」本地偏好（localStorage，与 settingsStore 同款约定）。 */

const KEY_SKIP_COST = "ai-canvas:script:skipCostConfirm";

export function getSkipCostConfirm(): boolean {
  try {
    return localStorage.getItem(KEY_SKIP_COST) === "1";
  } catch {
    return false;
  }
}

export function setSkipCostConfirm(v: boolean): void {
  try {
    if (v) localStorage.setItem(KEY_SKIP_COST, "1");
    else localStorage.removeItem(KEY_SKIP_COST);
  } catch {
    /* noop */
  }
}
