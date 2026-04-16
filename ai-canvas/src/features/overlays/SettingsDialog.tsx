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
  FolderOpen,
} from "lucide-react";
import { getSetting, setSetting, validateConnection, invalidateApiKeyCache, pickDirectory } from "@/lib/tauri";
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
  const [autoSavePath, setAutoSavePath] = useState("");
  const [exportPath, setExportPath] = useState("");
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
      getSetting("file_auto_save_path"),
      getSetting("image_auto_save_path"),
      getSetting("file_export_path"),
    ]).then(([key, url, fsp, legacyAsp, exp]) => {
      setApiKey({ value: key ?? "", show: false });
      setBaseUrl(url ?? "");
      setAutoSavePath(fsp || legacyAsp || "");
      setExportPath(exp || "");
    });
  }, [visible]);

  const handlePickAutoSavePath = useCallback(async () => {
    const dir = await pickDirectory();
    if (dir) setAutoSavePath(dir);
  }, []);

  const handlePickExportPath = useCallback(async () => {
    const dir = await pickDirectory();
    if (dir) setExportPath(dir);
  }, []);

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
      const trimmedKey = apiKey.value.trim();
      const trimmedUrl = baseUrl.trim();
      const trimmedAutoSave = autoSavePath.trim();
      const trimmedExport = exportPath.trim();
      if (trimmedKey) {
        await setSetting("openai_api_key", trimmedKey);
        setApiKey((s) => ({ ...s, value: trimmedKey }));
      }
      if (trimmedUrl) {
        await setSetting("openai_base_url", trimmedUrl);
        setBaseUrl(trimmedUrl);
      }
      await setSetting("file_auto_save_path", trimmedAutoSave);
      setAutoSavePath(trimmedAutoSave);
      await setSetting("file_export_path", trimmedExport);
      setExportPath(trimmedExport);

      invalidateApiKeyCache();
      modelService.invalidateCache();
      toggleSettings();
      useUIStore.getState().addToast({
        type: "info",
        title: "设置已保存",
        duration: 2000,
      });
    } finally {
      setSaving(false);
    }
  }, [apiKey.value, baseUrl, autoSavePath, exportPath, toggleSettings]);

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

        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void handleSave(); }} autoComplete="off">
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

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              文件自动保存路径
              <span className="ml-1 text-xs text-muted-foreground">
                (AI 生成的图片和视频自动保存到此目录/项目名)
              </span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={autoSavePath}
                placeholder="未设置则仅保存到应用内部"
                className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
                readOnly
              />
              <button
                type="button"
                onClick={handlePickAutoSavePath}
                className="flex items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="选择文件夹"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                选择
              </button>
            </div>
            {autoSavePath && (
              <button
                type="button"
                onClick={() => setAutoSavePath("")}
                className="mt-1 text-[11px] text-muted-foreground hover:text-destructive"
              >
                清除路径
              </button>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              手动保存/导出路径
              <span className="ml-1 text-xs text-muted-foreground">
                (点击下载按钮时保存到此目录，未设置则使用自动保存路径)
              </span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={exportPath}
                placeholder="未设置则使用上方自动保存路径"
                className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
                readOnly
              />
              <button
                type="button"
                onClick={handlePickExportPath}
                className="flex items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="选择文件夹"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                选择
              </button>
            </div>
            {exportPath && (
              <button
                type="button"
                onClick={() => setExportPath("")}
                className="mt-1 text-[11px] text-muted-foreground hover:text-destructive"
              >
                清除路径
              </button>
            )}
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

          <div className="mt-6 flex items-center justify-between">
            <button
              type="button"
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
                type="button"
                onClick={toggleSettings}
                className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-accent"
              >
                取消
              </button>
              <button
                type="submit"
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
        </form>
      </div>
    </div>
  );
}
