/**
 * 挂载自动化 host —— 在已认证的 app 生命周期内常驻。
 *
 * 装上事件监听(总是),并按持久化设置 `automation_enabled` 决定是否自动拉起本地 server。
 * server 由用户在设置里开关;host listener 一直在,无害。
 */

import { useEffect } from "react";
import { isTauri, getSetting } from "@/platform";
import { automationStart } from "@/platform/automation.api";
import {
  installAutomationHost,
  uninstallAutomationHost,
} from "@/services/automation";

export function useAutomationHost(): void {
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;

    void (async () => {
      await installAutomationHost();
      if (cancelled) return;
      // 上次会话开着 → 自动恢复 server。失败仅告警(端口被占等),不影响应用。
      const enabled = await getSetting("automation_enabled");
      if (enabled === "true") {
        try {
          await automationStart();
        } catch (err) {
          console.warn("[automation] 自动启动失败:", err);
        }
      }
    })();

    return () => {
      cancelled = true;
      uninstallAutomationHost();
    };
  }, []);
}
