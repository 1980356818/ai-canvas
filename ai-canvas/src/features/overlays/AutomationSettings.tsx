/**
 * 设置 → 通用 → 「允许本机 AI 工具控制」开关(自包含,即时生效,不走表单 saving)。
 *
 * 开关切换即时启停本地自动化桥并持久化 `automation_enabled`;开启后展示运行端口与一行
 * MCP 接入命令(可复制)。详见 docs/automation/。
 */

import { useEffect, useState } from "react";
import { TerminalSquare, Copy, Check, Loader2 } from "lucide-react";
import { isTauri, setSetting, clipboardWriteText } from "@/platform";
import {
  automationStatus,
  automationStart,
  automationStop,
  type AutomationStatus,
} from "@/platform/automation.api";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";

export function AutomationSettings() {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const addToast = useUIStore((s) => s.addToast);

  useEffect(() => {
    if (!isTauri) return;
    void automationStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  // 自动化桥依赖 Tauri 命令,纯浏览器模式下不展示。
  if (!isTauri) return null;

  const running = status?.running ?? false;

  const toggle = async () => {
    setBusy(true);
    try {
      if (running) {
        await automationStop();
        await setSetting("automation_enabled", "false");
        setStatus({ running: false, apiVersion: status?.apiVersion ?? 1 });
      } else {
        const next = await automationStart();
        await setSetting("automation_enabled", "true");
        setStatus(next);
      }
    } catch (err) {
      addToast({
        type: "error",
        title: "操作失败",
        description: String(err),
        duration: 4000,
      });
    } finally {
      setBusy(false);
    }
  };

  const mcpCommand =
    status?.port && status?.token
      ? `claude mcp add --transport http aicat http://127.0.0.1:${status.port}/mcp --header "Authorization: Bearer ${status.token}"`
      : "";

  const handleCopy = async () => {
    if (!mcpCommand) return;
    try {
      await clipboardWriteText(mcpCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      addToast({ type: "error", title: "复制失败", duration: 3000 });
    }
  };

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <TerminalSquare className="h-4 w-4 shrink-0" />
            允许本机 AI 工具控制
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            开启后,可在终端用 Claude Code / Codex 等 AI 工具操控本软件(新建项目、创建卡片、
            生成图片等)。仅监听本机 127.0.0.1,不对外网开放。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={running}
          disabled={busy}
          onClick={toggle}
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full transition-colors",
            running ? "bg-primary" : "bg-muted",
            busy && "opacity-60",
          )}
        >
          {busy ? (
            <Loader2 className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 animate-spin text-white" />
          ) : (
            <span
              className={cn(
                "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
                running ? "translate-x-[22px]" : "translate-x-0.5",
              )}
            />
          )}
        </button>
      </div>

      {running && status?.port && (
        <div className="mt-3 space-y-2 rounded-md bg-muted/40 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">运行中 · 端口 {status.port}</span>
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-accent"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "已复制" : "复制接入命令"}
            </button>
          </div>
          <code className="block break-all rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {mcpCommand}
          </code>
          <p className="text-[11px] text-muted-foreground">
            在终端粘贴上面命令即可让 Claude Code 接入;Codex 等其它工具见安装目录的 AGENTS.md。
          </p>
        </div>
      )}
    </div>
  );
}
