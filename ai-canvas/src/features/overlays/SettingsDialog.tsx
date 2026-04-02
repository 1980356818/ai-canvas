import { useState, useEffect, useCallback } from "react";
import {
  X,
  Eye,
  EyeOff,
  Save,
  Settings,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { getSetting, setSetting, validateConnection, invalidateApiKeyCache } from "@/lib/tauri";
import { modelService } from "@/services/models";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";

type ConnectionStatus = "idle" | "testing" | "ok" | "error";

interface FieldState {
  value: string;
  show: boolean;
}

export default function SettingsDialog() {
  const visible = useUIStore((s) => s.settingsVisible);
  const toggleSettings = useUIStore((s) => s.toggleSettings);

  const [apiKey, setApiKey] = useState<FieldState>({ value: "", show: false });
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("idle");
  const [connError, setConnError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setConnStatus("idle");
    setConnError("");
    Promise.all([
      getSetting("openai_api_key"),
      getSetting("openai_base_url"),
    ]).then(([key, url]) => {
      setApiKey({ value: key ?? "", show: false });
      setBaseUrl(url ?? "");
    });
  }, [visible]);

  const handleTestConnection = useCallback(async () => {
    setConnStatus("testing");
    setConnError("");
    try {
      await validateConnection();
      setConnStatus("ok");
    } catch (err) {
      setConnStatus("error");
      setConnError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (apiKey.value) {
        await setSetting("openai_api_key", apiKey.value);
      }
      if (baseUrl) {
        await setSetting("openai_base_url", baseUrl);
      }
      invalidateApiKeyCache();
      modelService.invalidateCache();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);

      setConnStatus("testing");
      setConnError("");
      try {
        await validateConnection();
        setConnStatus("ok");
      } catch (err) {
        setConnStatus("error");
        setConnError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }, [apiKey.value, baseUrl]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">API 设置</h2>
          </div>
          <button
            onClick={toggleSettings}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">API Key</label>
            <div className="relative">
              <input
                type={apiKey.show ? "text" : "password"}
                value={apiKey.value}
                onChange={(e) =>
                  setApiKey((s) => ({ ...s, value: e.target.value }))
                }
                placeholder="sk-..."
                className="w-full rounded-lg border border-input bg-background px-3 py-2 pr-10 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
              />
              <button
                type="button"
                onClick={() =>
                  setApiKey((s) => ({ ...s, show: !s.show }))
                }
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {apiKey.show ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              服务器地址
              <span className="ml-1 text-xs text-muted-foreground">
                (API Base URL)
              </span>
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com"
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
            />
          </div>

          {connStatus !== "idle" && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-xs",
                connStatus === "testing" && "bg-muted text-muted-foreground",
                connStatus === "ok" && "bg-emerald-500/10 text-emerald-600",
                connStatus === "error" && "bg-destructive/10 text-destructive",
              )}
            >
              {connStatus === "testing" && (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在测试连接...
                </>
              )}
              {connStatus === "ok" && (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  连接成功
                </>
              )}
              {connStatus === "error" && (
                <>
                  <XCircle className="h-3.5 w-3.5" />
                  {connError || "连接失败"}
                </>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={handleTestConnection}
            disabled={connStatus === "testing" || !apiKey.value}
            className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
          >
            测试连接
          </button>

          <div className="flex items-center gap-2">
            {saved && (
              <span className="text-xs text-emerald-500">已保存</span>
            )}
            <button
              onClick={toggleSettings}
              className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-accent"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className={cn(
                "flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90",
                saving && "opacity-60",
              )}
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
