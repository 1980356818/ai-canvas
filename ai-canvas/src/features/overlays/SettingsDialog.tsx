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
  Zap,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  ChevronDown,
  ChevronRight,
  Pencil,
} from "lucide-react";
import {
  getSetting,
  setSetting,
  validateConnection,
  invalidateApiKeyCache,
  pickDirectory,
} from "@/platform";
import { registry } from "@/providers/registry";
import { modelService } from "@/services/models";
import { useUIStore } from "@/stores/uiStore";
import { isPlatformVisible } from "@/config/platforms";
import { cn } from "@/lib/utils";

type SettingsTab = "platforms" | "general";
type ConnStatus = "idle" | "testing" | "ok" | "error";

interface KeyEntry {
  id: string;
  name: string;
  key: string;
}

interface PlatformState {
  id: string;
  name: string;
  defaultBaseUrl: string;
  keys: KeyEntry[];
  activeKeyId: string;
  baseUrl: string;
  enabled: boolean;
  expanded: boolean;
  editingKeyId: string | null;
  showKeyIds: Set<string>;
  connStatus: ConnStatus;
  connError: string;
}

function genId() {
  return crypto.randomUUID().slice(0, 8);
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "····" + key.slice(-4);
}

const ALL_PLATFORMS: { id: string; name: string; defaultBaseUrl: string }[] = [
  { id: "comfly", name: "Comfly", defaultBaseUrl: "https://ai.comfly.chat" },
  { id: "jijing", name: "极境", defaultBaseUrl: "https://ai.snoworangekeji.cn" },
];

const PLATFORMS = ALL_PLATFORMS.filter((p) => isPlatformVisible(p.id));

export default function SettingsDialog() {
  const visible = useUIStore((s) => s.settingsVisible);
  const toggleSettings = useUIStore((s) => s.toggleSettings);

  const [tab, setTab] = useState<SettingsTab>("platforms");
  const [platforms, setPlatforms] = useState<PlatformState[]>([]);
  const [autoSavePath, setAutoSavePath] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;

    (async () => {
      const [fsp, legacyAsp, exp] = await Promise.all([
        getSetting("file_auto_save_path"),
        getSetting("image_auto_save_path"),
        getSetting("file_export_path"),
      ]);
      setAutoSavePath(fsp || legacyAsp || "");
      setExportPath(exp || "");

      const states: PlatformState[] = [];
      for (const p of PLATFORMS) {
        const [keysJson, activeId, legacyKey, url, legacyUrl, enabledStr] =
          await Promise.all([
            getSetting(`${p.id}_api_keys`),
            getSetting(`${p.id}_active_key_id`),
            p.id === "comfly"
              ? getSetting("openai_api_key")
              : getSetting(`${p.id}_api_key`),
            getSetting(`${p.id}_base_url`),
            p.id === "comfly" ? getSetting("openai_base_url") : null,
            getSetting(`${p.id}_enabled`),
          ]);

        let keys: KeyEntry[] = [];
        let active = activeId ?? "";

        if (keysJson) {
          try {
            keys = JSON.parse(keysJson);
          } catch {
            keys = [];
          }
        }

        if (keys.length === 0 && legacyKey) {
          const entry: KeyEntry = { id: genId(), name: "默认", key: legacyKey };
          keys = [entry];
          active = entry.id;
        }

        states.push({
          id: p.id,
          name: p.name,
          defaultBaseUrl: p.defaultBaseUrl,
          keys,
          activeKeyId: active || (keys.length > 0 ? keys[0]!.id : ""),
          baseUrl: url || legacyUrl || "",
          enabled: enabledStr !== "false",
          expanded: false,
          editingKeyId: null,
          showKeyIds: new Set(),
          connStatus: "idle",
          connError: "",
        });
      }
      setPlatforms(states);
    })();
  }, [visible]);

  const updatePlatform = useCallback(
    (id: string, patch: Partial<PlatformState>) => {
      setPlatforms((prev) =>
        prev.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      );
    },
    [],
  );

  const handleTestConnection = useCallback(
    async (id: string) => {
      updatePlatform(id, { connStatus: "testing", connError: "" });
      try {
        await validateConnection(id);
        updatePlatform(id, { connStatus: "ok" });
      } catch (err) {
        updatePlatform(id, {
          connStatus: "error",
          connError: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [updatePlatform],
  );

  const handlePickAutoSavePath = useCallback(async () => {
    const dir = await pickDirectory();
    if (dir) setAutoSavePath(dir);
  }, []);

  const handlePickExportPath = useCallback(async () => {
    const dir = await pickDirectory();
    if (dir) setExportPath(dir);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      for (const p of platforms) {
        const cleanKeys = p.keys
          .map((e, i) => ({
            ...e,
            name: e.name.trim() || `Key ${i + 1}`,
            key: e.key.trim(),
          }))
          .filter((e) => e.key);

        const activeEntry = cleanKeys.find((e) => e.id === p.activeKeyId);
        const activeKey = activeEntry?.key ?? cleanKeys[0]?.key ?? "";
        const trimmedUrl = p.baseUrl.trim();

        await setSetting(`${p.id}_api_keys`, JSON.stringify(cleanKeys));
        await setSetting(`${p.id}_active_key_id`, p.activeKeyId);
        await setSetting(`${p.id}_api_key`, activeKey);
        if (trimmedUrl) await setSetting(`${p.id}_base_url`, trimmedUrl);
        await setSetting(`${p.id}_enabled`, String(p.enabled));

        if (p.id === "comfly") {
          await setSetting("openai_api_key", activeKey);
          if (trimmedUrl) await setSetting("openai_base_url", trimmedUrl);
        }

        registry.setConfig(p.id, {
          id: p.id,
          apiKey: activeKey,
          baseUrl: trimmedUrl || p.defaultBaseUrl,
          extra: {},
          enabled: p.enabled,
        });
      }
      await registry.saveConfigs();

      await setSetting("file_auto_save_path", autoSavePath.trim());
      await setSetting("file_export_path", exportPath.trim());

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
  }, [platforms, autoSavePath, exportPath, toggleSettings]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex w-full max-w-lg flex-col rounded-xl border border-border bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
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
        <div className="flex gap-1 border-b border-border px-6 pt-1">
          <button
            type="button"
            onClick={() => setTab("platforms")}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
              tab === "platforms"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Zap className="h-3.5 w-3.5" />
            AI 平台
          </button>
          <button
            type="button"
            onClick={() => setTab("general")}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
              tab === "general"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            通用
          </button>
        </div>

        {/* Body */}
        <form
          className="max-h-[60vh] overflow-y-auto px-6 py-5"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
          autoComplete="off"
        >
          {tab === "platforms" && (
            <div className="space-y-2.5">
              {platforms.map((p) => (
                <PlatformCard
                  key={p.id}
                  platform={p}
                  onUpdate={(patch) => updatePlatform(p.id, patch)}
                  onTestConnection={() => handleTestConnection(p.id)}
                />
              ))}
            </div>
          )}

          {tab === "general" && (
            <div className="space-y-4">
              <PathField
                label="自动保存路径"
                hint="AI 生成的图片/视频自动保存到此目录"
                value={autoSavePath}
                placeholder="未设置则仅保存到应用内部"
                onPick={handlePickAutoSavePath}
                onClear={() => setAutoSavePath("")}
              />
              <PathField
                label="导出路径"
                hint="手动下载时保存到此目录"
                value={exportPath}
                placeholder="未设置则使用自动保存路径"
                onPick={handlePickExportPath}
                onClear={() => setExportPath("")}
              />
            </div>
          )}

          {/* Footer */}
          <div className="mt-6 flex items-center justify-end gap-2 border-t border-border pt-4">
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
        </form>
      </div>
    </div>
  );
}

// ── Platform Card ────────────────────────────────────────────

function PlatformCard({
  platform: p,
  onUpdate,
  onTestConnection,
}: {
  platform: PlatformState;
  onUpdate: (patch: Partial<PlatformState>) => void;
  onTestConnection: () => void;
}) {
  const activeEntry = p.keys.find((e) => e.id === p.activeKeyId);

  const handleAddKey = () => {
    const entry: KeyEntry = { id: genId(), name: "", key: "" };
    const next = [...p.keys, entry];
    onUpdate({
      keys: next,
      activeKeyId: p.keys.length === 0 ? entry.id : p.activeKeyId,
      editingKeyId: entry.id,
    });
  };

  const handleRemoveKey = (id: string) => {
    const next = p.keys.filter((e) => e.id !== id);
    const newActive =
      p.activeKeyId === id
        ? next.length > 0
          ? next[0]!.id
          : ""
        : p.activeKeyId;
    onUpdate({
      keys: next,
      activeKeyId: newActive,
      editingKeyId: p.editingKeyId === id ? null : p.editingKeyId,
    });
  };

  const handleUpdateKey = (id: string, patch: Partial<KeyEntry>) => {
    onUpdate({
      keys: p.keys.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  };

  const toggleShowKey = (id: string) => {
    const next = new Set(p.showKeyIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onUpdate({ showKeyIds: next });
  };

  const keyCount = p.keys.filter((e) => e.key.trim()).length;

  return (
    <div
      className={cn(
        "rounded-lg border transition-colors",
        p.enabled
          ? "border-border bg-background"
          : "border-border/50 bg-muted/30 opacity-60",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => onUpdate({ expanded: !p.expanded })}
          className="flex-shrink-0 text-muted-foreground hover:text-foreground"
        >
          {p.expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        <button
          type="button"
          onClick={() => onUpdate({ expanded: !p.expanded })}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">{p.name}</span>
            {keyCount > 0 ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {keyCount} 个密钥{activeEntry ? ` · ${activeEntry.name || maskKey(activeEntry.key)}` : ""}
              </span>
            ) : (
              <span className="text-[10px] text-amber-500">未配置</span>
            )}
          </div>
        </button>

        {p.connStatus === "ok" && (
          <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
        )}
        {p.connStatus === "error" && (
          <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-destructive" />
        )}
        {p.connStatus === "testing" && (
          <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" />
        )}

        <button
          type="button"
          onClick={() => onUpdate({ enabled: !p.enabled })}
          className="flex-shrink-0 text-muted-foreground hover:text-foreground"
          title={p.enabled ? "禁用" : "启用"}
        >
          {p.enabled ? (
            <ToggleRight className="h-5 w-5 text-primary" />
          ) : (
            <ToggleLeft className="h-5 w-5" />
          )}
        </button>
      </div>

      {/* Expanded */}
      {p.expanded && (
        <div className="space-y-3 border-t border-border/50 px-3 pb-3 pt-2.5">
          {/* Keys */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-[11px] font-medium text-muted-foreground">
                API Key
              </label>
              <button
                type="button"
                onClick={handleAddKey}
                className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10"
              >
                <Plus className="h-3 w-3" />
                添加
              </button>
            </div>

            {p.keys.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
                暂无密钥，点击「添加」创建
              </div>
            ) : (
              <div className="space-y-1.5">
                {p.keys.map((entry) => {
                  const isActive = entry.id === p.activeKeyId;
                  const isEditing = entry.id === p.editingKeyId;
                  const isShown = p.showKeyIds.has(entry.id);

                  return (
                    <div
                      key={entry.id}
                      className={cn(
                        "rounded-md border px-2.5 py-2 transition-colors",
                        isActive
                          ? "border-primary/30 bg-primary/[0.03]"
                          : "border-border/70",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {/* Radio */}
                        <button
                          type="button"
                          onClick={() =>
                            onUpdate({ activeKeyId: entry.id })
                          }
                          className="flex-shrink-0"
                          title="设为当前使用"
                        >
                          <div
                            className={cn(
                              "flex h-3.5 w-3.5 items-center justify-center rounded-full border-[1.5px] transition-colors",
                              isActive
                                ? "border-primary"
                                : "border-muted-foreground/40 hover:border-muted-foreground",
                            )}
                          >
                            {isActive && (
                              <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                            )}
                          </div>
                        </button>

                        {/* Content */}
                        <div className="min-w-0 flex-1">
                          {isEditing ? (
                            <div className="space-y-1">
                              <input
                                type="text"
                                value={entry.name}
                                onChange={(e) =>
                                  handleUpdateKey(entry.id, {
                                    name: e.target.value,
                                  })
                                }
                                placeholder="名称（如：生产环境）"
                                className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
                                autoFocus
                              />
                              <div className="relative">
                                <input
                                  type={isShown ? "text" : "password"}
                                  value={entry.key}
                                  onChange={(e) =>
                                    handleUpdateKey(entry.id, {
                                      key: e.target.value,
                                    })
                                  }
                                  placeholder="sk-..."
                                  className="w-full rounded border border-input bg-background px-2 py-1 pr-7 text-[11px] outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
                                />
                                <button
                                  type="button"
                                  onClick={() => toggleShowKey(entry.id)}
                                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                >
                                  {isShown ? (
                                    <EyeOff className="h-3 w-3" />
                                  ) : (
                                    <Eye className="h-3 w-3" />
                                  )}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="w-full text-left"
                              onClick={() =>
                                onUpdate({ editingKeyId: entry.id })
                              }
                            >
                              <div className="truncate text-[11px] font-medium leading-tight">
                                {entry.name || "未命名"}
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                {maskKey(entry.key)}
                              </div>
                            </button>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex flex-shrink-0 items-center gap-0.5">
                          {isEditing ? (
                            <button
                              type="button"
                              onClick={() =>
                                onUpdate({ editingKeyId: null })
                              }
                              className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10"
                            >
                              完成
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                onUpdate({ editingKeyId: entry.id })
                              }
                              className="rounded p-1 text-muted-foreground hover:text-foreground"
                              title="编辑"
                            >
                              <Pencil className="h-2.5 w-2.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRemoveKey(entry.id)}
                            className="rounded p-1 text-muted-foreground hover:text-destructive"
                            title="删除"
                          >
                            <Trash2 className="h-2.5 w-2.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Base URL */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
              Base URL
            </label>
            <input
              type="text"
              value={p.baseUrl}
              onChange={(e) => onUpdate({ baseUrl: e.target.value })}
              placeholder={p.defaultBaseUrl}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
            />
          </div>

          {/* Test connection */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onTestConnection}
              disabled={!activeEntry?.key || p.connStatus === "testing"}
              className="rounded-md border border-input px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
            >
              {p.connStatus === "testing" ? "测试中..." : "测试连接"}
            </button>
            {p.connStatus === "ok" && (
              <span className="text-[11px] text-emerald-600">连接成功</span>
            )}
            {p.connStatus === "error" && (
              <span className="max-w-[240px] truncate text-[11px] text-destructive" title={p.connError}>
                {p.connError || "连接失败"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Path Field ───────────────────────────────────────────────

function PathField({
  label,
  hint,
  value,
  placeholder,
  onPick,
  onClear,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onPick: () => void;
  onClear: () => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium">
        {label}
        <span className="ml-1.5 font-normal text-muted-foreground">{hint}</span>
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
          readOnly
        />
        <button
          type="button"
          onClick={onPick}
          className="flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FolderOpen className="h-3 w-3" />
          选择
        </button>
      </div>
      {value && (
        <button
          type="button"
          onClick={onClear}
          className="mt-1 text-[11px] text-muted-foreground hover:text-destructive"
        >
          清除路径
        </button>
      )}
    </div>
  );
}
