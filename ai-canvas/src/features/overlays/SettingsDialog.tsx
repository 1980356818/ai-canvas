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
  Plus,
  Trash2,
  Zap,
  Wrench,
} from "lucide-react";
import { getSetting, setSetting, validateConnection, invalidateApiKeyCache, pickDirectory } from "@/platform";
import { modelService } from "@/services/models";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import ProviderConfigPanel from "./ProviderConfigPanel";

type SettingsTab = "general" | "providers";
type ConnectionStatus = "idle" | "testing" | "ok" | "error";

interface ApiKeyEntry {
  id: string;
  name: string;
  key: string;
}

function generateId() {
  return crypto.randomUUID().slice(0, 8);
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "••••" + key.slice(-4);
}

export default function SettingsDialog() {
  const visible = useUIStore((s) => s.settingsVisible);
  const toggleSettings = useUIStore((s) => s.toggleSettings);

  const [tab, setTab] = useState<SettingsTab>("general");
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [activeKeyId, setActiveKeyId] = useState<string>("");
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [showKeyIds, setShowKeyIds] = useState<Set<string>>(new Set());
  const [baseUrl, setBaseUrl] = useState("");
  const [autoSavePath, setAutoSavePath] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("idle");
  const [connError, setConnError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setConnStatus("idle");
    setConnError("");
    setEditingKeyId(null);
    setShowKeyIds(new Set());
    Promise.all([
      getSetting("api_keys_list"),
      getSetting("active_api_key_id"),
      getSetting("openai_api_key"),
      getSetting("openai_base_url"),
      getSetting("file_auto_save_path"),
      getSetting("image_auto_save_path"),
      getSetting("file_export_path"),
    ]).then(([listJson, activeId, legacyKey, url, fsp, legacyAsp, exp]) => {
      let keys: ApiKeyEntry[] = [];
      let active = activeId ?? "";

      if (listJson) {
        try { keys = JSON.parse(listJson); } catch { keys = []; }
      }

      if (keys.length === 0 && legacyKey) {
        const entry: ApiKeyEntry = { id: generateId(), name: "默认", key: legacyKey };
        keys = [entry];
        active = entry.id;
      }

      setApiKeys(keys);
      setActiveKeyId(active || (keys.length > 0 ? keys[0]!.id : ""));
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

  const handleAddKey = useCallback(() => {
    const entry: ApiKeyEntry = { id: generateId(), name: "", key: "" };
    setApiKeys((prev) => [...prev, entry]);
    setEditingKeyId(entry.id);
    if (apiKeys.length === 0) setActiveKeyId(entry.id);
  }, [apiKeys.length]);

  const handleRemoveKey = useCallback((id: string) => {
    setApiKeys((prev) => {
      const next = prev.filter((e) => e.id !== id);
      return next;
    });
    setActiveKeyId((prev) => {
      if (prev !== id) return prev;
      const remaining = apiKeys.filter((e) => e.id !== id);
      return remaining.length > 0 ? remaining[0]!.id : "";
    });
    setEditingKeyId((prev) => (prev === id ? null : prev));
  }, [apiKeys]);

  const handleUpdateKey = useCallback((id: string, patch: Partial<ApiKeyEntry>) => {
    setApiKeys((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const toggleShowKey = useCallback((id: string) => {
    setShowKeyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const activeEntry = apiKeys.find((e) => e.id === activeKeyId);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const trimmedUrl = baseUrl.trim();
      const trimmedAutoSave = autoSavePath.trim();
      const trimmedExport = exportPath.trim();

      const cleanKeys = apiKeys.map((e) => ({
        ...e,
        name: e.name.trim() || `Key ${apiKeys.indexOf(e) + 1}`,
        key: e.key.trim(),
      })).filter((e) => e.key);

      await setSetting("api_keys_list", JSON.stringify(cleanKeys));
      await setSetting("active_api_key_id", activeKeyId);

      const active = cleanKeys.find((e) => e.id === activeKeyId);
      await setSetting("openai_api_key", active?.key ?? "");

      if (trimmedUrl) {
        await setSetting("openai_base_url", trimmedUrl);
        setBaseUrl(trimmedUrl);
      }
      await setSetting("file_auto_save_path", trimmedAutoSave);
      setAutoSavePath(trimmedAutoSave);
      await setSetting("file_export_path", trimmedExport);
      setExportPath(trimmedExport);

      setApiKeys(cleanKeys);

      // Save provider configs
      const provSave = (window as unknown as Record<string, unknown>).__providerConfigSave;
      if (typeof provSave === "function") await (provSave as () => Promise<void>)();

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
  }, [apiKeys, activeKeyId, baseUrl, autoSavePath, exportPath, toggleSettings]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-border bg-background p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">设置</h2>
          </div>
          <button
            onClick={toggleSettings}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="mb-4 flex gap-1 rounded-lg bg-muted/50 p-1">
          <button
            type="button"
            onClick={() => setTab("general")}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              tab === "general"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Wrench className="h-3.5 w-3.5" />
            通用
          </button>
          <button
            type="button"
            onClick={() => setTab("providers")}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              tab === "providers"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Zap className="h-3.5 w-3.5" />
            AI 平台
          </button>
        </div>

        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void handleSave(); }} autoComplete="off">
          {tab === "providers" && <ProviderConfigPanel />}

          {tab === "general" && <>
          {/* API Keys list */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-medium">API Key</label>
              <button
                type="button"
                onClick={handleAddKey}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10"
              >
                <Plus className="h-3 w-3" />
                添加
              </button>
            </div>

            {apiKeys.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                暂无 API Key，点击上方「添加」创建
              </div>
            ) : (
              <div className="space-y-2">
                {apiKeys.map((entry) => {
                  const isActive = entry.id === activeKeyId;
                  const isEditing = entry.id === editingKeyId;
                  const isShown = showKeyIds.has(entry.id);

                  return (
                    <div
                      key={entry.id}
                      className={cn(
                        "rounded-lg border px-3 py-2.5 transition-colors",
                        isActive
                          ? "border-primary/40 bg-primary/5"
                          : "border-border hover:border-border/80",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {/* Radio */}
                        <button
                          type="button"
                          onClick={() => setActiveKeyId(entry.id)}
                          className="flex-shrink-0"
                          title="设为当前使用"
                        >
                          <div
                            className={cn(
                              "flex h-4 w-4 items-center justify-center rounded-full border-2 transition-colors",
                              isActive
                                ? "border-primary"
                                : "border-muted-foreground/40 hover:border-muted-foreground",
                            )}
                          >
                            {isActive && (
                              <div className="h-2 w-2 rounded-full bg-primary" />
                            )}
                          </div>
                        </button>

                        {/* Name + Key */}
                        <div className="min-w-0 flex-1">
                          {isEditing ? (
                            <div className="space-y-1.5">
                              <input
                                type="text"
                                value={entry.name}
                                onChange={(e) => handleUpdateKey(entry.id, { name: e.target.value })}
                                placeholder="名称（如：生产环境）"
                                className="w-full rounded border border-input bg-background px-2 py-1 text-xs outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
                                autoFocus
                              />
                              <div className="relative">
                                <input
                                  type={isShown ? "text" : "password"}
                                  value={entry.key}
                                  onChange={(e) => handleUpdateKey(entry.id, { key: e.target.value })}
                                  placeholder="sk-..."
                                  className="w-full rounded border border-input bg-background px-2 py-1 pr-8 text-xs outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
                                />
                                <button
                                  type="button"
                                  onClick={() => toggleShowKey(entry.id)}
                                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                >
                                  {isShown ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="w-full text-left"
                              onClick={() => setEditingKeyId(entry.id)}
                            >
                              <div className="text-xs font-medium leading-tight">
                                {entry.name || "未命名"}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                {maskKey(entry.key)}
                              </div>
                            </button>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex flex-shrink-0 items-center gap-1">
                          {isEditing ? (
                            <button
                              type="button"
                              onClick={() => setEditingKeyId(null)}
                              className="rounded p-1 text-xs text-primary hover:bg-primary/10"
                            >
                              完成
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setEditingKeyId(entry.id)}
                              className="rounded p-1 text-muted-foreground hover:text-foreground"
                              title="编辑"
                            >
                              <Settings className="h-3 w-3" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRemoveKey(entry.id)}
                            className="rounded p-1 text-muted-foreground hover:text-destructive"
                            title="删除"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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
          </>}

          <div className="mt-6 flex items-center justify-between">
            {tab === "general" ? (
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={connStatus === "testing" || !activeEntry?.key}
                className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
              >
                测试连接
              </button>
            ) : (
              <div />
            )}

            <div className="flex items-center gap-2">
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
