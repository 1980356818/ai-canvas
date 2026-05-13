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
  LogOut,
  UserCircle,
  KeyRound,
  Monitor,
  GripVertical,
  RefreshCw,
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
import { useAuthStore } from "@/stores/authStore";
import { apiChangePassword, apiGetDeviceInfo, apiUnbindDevice, type DeviceInfo } from "@/platform/auth.api";
import { isTauri } from "@/platform/runtime";
import { invoke } from "@tauri-apps/api/core";
import { isPlatformVisible } from "@/config/platforms";
import { cn } from "@/lib/utils";

type SettingsTab = "platforms" | "general" | "account";
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
  autoRotate: boolean;
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
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    if (isTauri) {
      import("@tauri-apps/api/app")
        .then((m) => m.getVersion())
        .then(setAppVersion)
        .catch(() => setAppVersion(__APP_VERSION__));
    } else {
      setAppVersion(__APP_VERSION__);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;

    (async () => {
      try {
        const [autoSave, exp] = await Promise.all([
          getSetting("file_auto_save_path"),
          getSetting("file_export_path"),
        ]);
        setAutoSavePath(autoSave || "");
        setExportPath(exp || "");

        const states: PlatformState[] = [];
        for (const p of PLATFORMS) {
          const [keysJson, activeId, legacyKey, url, legacyUrl, enabledStr, autoRotateStr] =
            await Promise.all([
              getSetting(`${p.id}_api_keys`),
              getSetting(`${p.id}_active_key_id`),
              p.id === "comfly"
                ? getSetting("openai_api_key")
                : getSetting(`${p.id}_api_key`),
              getSetting(`${p.id}_base_url`),
              p.id === "comfly" ? getSetting("openai_base_url") : null,
              getSetting(`${p.id}_enabled`),
              getSetting(`${p.id}_auto_rotate`),
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
            autoRotate: autoRotateStr !== "false",
          });
        }
        setPlatforms(states);
      } catch (err) {
        console.error("[Settings] failed to load platform config:", err);
      }
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
        await setSetting(`${p.id}_auto_rotate`, String(p.autoRotate));

        if (p.id === "comfly") {
          await setSetting("openai_api_key", activeKey);
          if (trimmedUrl) await setSetting("openai_base_url", trimmedUrl);
        }

        const existingExtra = registry.getConfig(p.id)?.extra ?? {};
        registry.setConfig(p.id, {
          id: p.id,
          apiKey: activeKey,
          baseUrl: trimmedUrl || p.defaultBaseUrl,
          extra: existingExtra,
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
    } catch (err) {
      console.error("[Settings] save failed:", err);
      useUIStore.getState().addToast({
        type: "error",
        title: "保存失败",
        description: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    } finally {
      setSaving(false);
    }
  }, [platforms, autoSavePath, exportPath, toggleSettings]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex w-full max-w-2xl flex-col rounded-2xl border border-border bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Settings className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">设置</h2>
            {appVersion && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                v{appVersion}
              </span>
            )}
          </div>
          <button
            onClick={toggleSettings}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border px-6">
          {([
            { key: "platforms" as const, icon: Zap, label: "AI 平台" },
            { key: "general" as const, icon: FolderOpen, label: "通用" },
            { key: "account" as const, icon: UserCircle, label: "账号" },
          ]).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                tab === t.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <form
          className="max-h-[60vh] overflow-y-auto px-6 py-6"
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
                hint="AI 生成的图片/视频自动保存到此目录，按项目分组"
                value={autoSavePath}
                placeholder="未设置则使用：程序运行目录/文件自动保存"
                onPick={handlePickAutoSavePath}
                onClear={() => setAutoSavePath("")}
              />
              <PathField
                label="导出路径"
                hint="手动下载时保存到此目录（未设置则使用自动保存目录）"
                value={exportPath}
                placeholder="未设置则使用自动保存目录"
                onPick={handlePickExportPath}
                onClear={() => setExportPath("")}
              />
            </div>
          )}

          {tab === "account" && <AccountTab onClose={toggleSettings} />}

          {/* Footer */}
          <div className="mt-6 flex items-center justify-end gap-3 border-t border-border pt-5">
            <button
              type="button"
              onClick={toggleSettings}
              className="rounded-lg px-5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className={cn(
                "flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90",
                saving && "opacity-60",
              )}
            >
              <Save className="h-4 w-4" />
              {saving ? "保存中..." : "保存设置"}
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
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

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

  const handleDragEnd = () => {
    if (dragIdx != null && overIdx != null && dragIdx !== overIdx) {
      const reordered = [...p.keys];
      const [moved] = reordered.splice(dragIdx, 1);
      reordered.splice(overIdx, 0, moved!);
      onUpdate({ keys: reordered });
    }
    setDragIdx(null);
    setOverIdx(null);
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
      <div className="flex items-center gap-2.5 px-4 py-3">
        <button
          type="button"
          onClick={() => onUpdate({ expanded: !p.expanded })}
          className="flex-shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          {p.expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>

        <button
          type="button"
          onClick={() => onUpdate({ expanded: !p.expanded })}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-semibold">{p.name}</span>
            {keyCount > 0 ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {keyCount} 个密钥{activeEntry ? ` · ${activeEntry.name || maskKey(activeEntry.key)}` : ""}
              </span>
            ) : (
              <span className="text-xs font-medium text-amber-500">未配置</span>
            )}
            {p.autoRotate && keyCount > 1 && (
              <RefreshCw className="h-3.5 w-3.5 text-primary/60" />
            )}
          </div>
        </button>

        {p.connStatus === "ok" && (
          <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-500" />
        )}
        {p.connStatus === "error" && (
          <XCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
        )}
        {p.connStatus === "testing" && (
          <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground" />
        )}

        <button
          type="button"
          onClick={() => onUpdate({ enabled: !p.enabled })}
          className="flex-shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          title={p.enabled ? "禁用" : "启用"}
        >
          {p.enabled ? (
            <ToggleRight className="h-6 w-6 text-primary" />
          ) : (
            <ToggleLeft className="h-6 w-6" />
          )}
        </button>
      </div>

      {/* Expanded */}
      {p.expanded && (
        <div className="space-y-4 border-t border-border/50 px-4 pb-4 pt-3">
          {/* Auto-rotate toggle */}
          {p.keys.length > 1 && (
            <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2.5">
              <div>
                <p className="text-xs font-semibold text-foreground">自动切换 Key</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Key 不可用时自动尝试下一个，按列表顺序
                </p>
              </div>
              <button
                type="button"
                onClick={() => onUpdate({ autoRotate: !p.autoRotate })}
                className="flex-shrink-0"
              >
                {p.autoRotate ? (
                  <ToggleRight className="h-6 w-6 text-primary" />
                ) : (
                  <ToggleLeft className="h-6 w-6 text-muted-foreground" />
                )}
              </button>
            </div>
          )}

          {/* Keys */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-semibold text-foreground">
                API Key
                {p.autoRotate && p.keys.length > 1 && (
                  <span className="ml-2 font-normal text-muted-foreground">
                    拖拽调整优先级
                  </span>
                )}
              </label>
              <button
                type="button"
                onClick={handleAddKey}
                className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
              >
                <Plus className="h-3.5 w-3.5" />
                添加
              </button>
            </div>

            {p.keys.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
                暂无密钥，点击「添加」创建
              </div>
            ) : (
              <div className="space-y-2">
                {p.keys.map((entry, idx) => {
                  const isActive = entry.id === p.activeKeyId;
                  const isEditing = entry.id === p.editingKeyId;
                  const isShown = p.showKeyIds.has(entry.id);
                  const isDragOver = overIdx === idx && dragIdx !== idx;

                  return (
                    <div
                      key={entry.id}
                      draggable={p.keys.length > 1 && !isEditing}
                      onDragStart={() => setDragIdx(idx)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setOverIdx(idx);
                      }}
                      onDragEnd={handleDragEnd}
                      className={cn(
                        "rounded-lg border px-3 py-2.5 transition-colors",
                        isActive
                          ? "border-primary/30 bg-primary/[0.03]"
                          : "border-border",
                        isDragOver && "border-primary/50 bg-primary/5",
                        dragIdx === idx && "opacity-50",
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        {/* Drag handle */}
                        {p.keys.length > 1 && !isEditing && (
                          <div className="flex-shrink-0 cursor-grab text-muted-foreground/40 active:cursor-grabbing">
                            <GripVertical className="h-4 w-4" />
                          </div>
                        )}

                        {/* Priority badge */}
                        {p.autoRotate && p.keys.length > 1 && (
                          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                            {idx + 1}
                          </span>
                        )}

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
                              "flex h-4 w-4 items-center justify-center rounded-full border-2 transition-colors",
                              isActive
                                ? "border-primary"
                                : "border-muted-foreground/30 hover:border-muted-foreground",
                            )}
                          >
                            {isActive && (
                              <div className="h-2 w-2 rounded-full bg-primary" />
                            )}
                          </div>
                        </button>

                        {/* Content */}
                        <div className="min-w-0 flex-1">
                          {isEditing ? (
                            <div className="space-y-1.5">
                              <input
                                type="text"
                                value={entry.name}
                                onChange={(e) =>
                                  handleUpdateKey(entry.id, {
                                    name: e.target.value,
                                  })
                                }
                                placeholder="名称（如：生产环境）"
                                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs outline-none ring-ring placeholder:text-muted-foreground/60 focus:ring-1"
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
                                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 pr-8 text-xs outline-none ring-ring placeholder:text-muted-foreground/60 focus:ring-1"
                                />
                                <button
                                  type="button"
                                  onClick={() => toggleShowKey(entry.id)}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                                >
                                  {isShown ? (
                                    <EyeOff className="h-3.5 w-3.5" />
                                  ) : (
                                    <Eye className="h-3.5 w-3.5" />
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
                              <div className="truncate text-xs font-medium text-foreground">
                                {entry.name || "未命名"}
                              </div>
                              <div className="mt-0.5 text-xs text-muted-foreground">
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
                              onClick={() =>
                                onUpdate({ editingKeyId: null })
                              }
                              className="rounded-md px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                            >
                              完成
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                onUpdate({ editingKeyId: entry.id })
                              }
                              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                              title="编辑"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRemoveKey(entry.id)}
                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            title="删除"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
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
            <label className="mb-1.5 block text-xs font-semibold text-foreground">
              Base URL
            </label>
            <input
              type="text"
              value={p.baseUrl}
              onChange={(e) => onUpdate({ baseUrl: e.target.value })}
              placeholder={p.defaultBaseUrl}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground/60 focus:ring-1"
            />
          </div>

          {/* Test connection */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onTestConnection}
              disabled={!activeEntry?.key || p.connStatus === "testing"}
              className="rounded-lg border border-input px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
            >
              {p.connStatus === "testing" ? "测试中..." : "测试连接"}
            </button>
            {p.connStatus === "ok" && (
              <span className="text-xs font-medium text-emerald-600">连接成功</span>
            )}
            {p.connStatus === "error" && (
              <span className="max-w-[300px] truncate text-xs text-destructive" title={p.connError}>
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

function AccountTab({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const addToast = useUIStore((s) => s.addToast);
  const [confirming, setConfirming] = useState(false);

  const [showChangePwd, setShowChangePwd] = useState(false);
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [changePwdLoading, setChangePwdLoading] = useState(false);
  const [changePwdError, setChangePwdError] = useState("");
  const [showOldPwd, setShowOldPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);

  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [unbindLoading, setUnbindLoading] = useState(false);

  useEffect(() => {
    setDeviceLoading(true);
    apiGetDeviceInfo()
      .then(setDeviceInfo)
      .catch(() => {})
      .finally(() => setDeviceLoading(false));
  }, []);

  const handleUnbind = async () => {
    setUnbindLoading(true);
    try {
      let mc: string | undefined;
      if (isTauri) {
        try { mc = await invoke<string>("get_machine_code"); } catch {}
      }
      if (!mc) {
        addToast({ type: "error", title: "无法获取当前设备标识", duration: 3000 });
        return;
      }
      await apiUnbindDevice(mc, navigator.userAgent);
      addToast({ type: "success", title: "设备已解绑并绑定当前设备", duration: 3000 });
      const updated = await apiGetDeviceInfo();
      setDeviceInfo(updated);
    } catch (err: any) {
      addToast({ type: "error", title: err.message || "解绑失败", duration: 4000 });
    } finally {
      setUnbindLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    onClose();
  };

  const handleChangePassword = async () => {
    setChangePwdError("");
    if (!oldPwd.trim() || !newPwd.trim()) {
      setChangePwdError("请填写所有字段");
      return;
    }
    if (newPwd.length < 6) {
      setChangePwdError("新密码至少需要6位");
      return;
    }
    if (newPwd !== confirmPwd) {
      setChangePwdError("两次输入的新密码不一致");
      return;
    }
    setChangePwdLoading(true);
    try {
      await apiChangePassword(oldPwd, newPwd);
      setShowChangePwd(false);
      setOldPwd("");
      setNewPwd("");
      setConfirmPwd("");
      addToast({ type: "success", title: "密码修改成功", duration: 3000 });
    } catch (err: any) {
      setChangePwdError(err.message || "修改失败");
    } finally {
      setChangePwdLoading(false);
    }
  };

  const pwdInputClass =
    "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground/60 focus:ring-1";

  return (
    <div className="space-y-5">
      {/* User profile card */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserCircle className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">{user?.username ?? "未知用户"}</p>
            {user?.email && (
              <p className="mt-0.5 text-xs text-muted-foreground">{user.email}</p>
            )}
          </div>
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium",
              user?.status === "active"
                ? "bg-emerald-500/10 text-emerald-600"
                : "bg-amber-500/10 text-amber-600",
            )}
          >
            {user?.status === "active" ? "已激活" : "未激活"}
          </span>
        </div>
        {user?.memberExpireAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            会员到期：{new Date(user.memberExpireAt).toLocaleDateString("zh-CN")}
          </p>
        )}
      </div>

      {/* Change password */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">修改密码</h3>
          {!showChangePwd && (
            <button
              type="button"
              onClick={() => setShowChangePwd(true)}
              className="flex items-center gap-1.5 text-xs font-medium text-primary transition-colors hover:underline"
            >
              <KeyRound className="h-3.5 w-3.5" />
              修改
            </button>
          )}
        </div>
        {showChangePwd && (
          <div className="mt-3 space-y-3">
            {changePwdError && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {changePwdError}
              </p>
            )}
            <div className="relative">
              <input
                type={showOldPwd ? "text" : "password"}
                value={oldPwd}
                onChange={(e) => setOldPwd(e.target.value)}
                placeholder="原密码"
                className={cn(pwdInputClass, "pr-9")}
              />
              <button
                type="button"
                onClick={() => setShowOldPwd(!showOldPwd)}
                tabIndex={-1}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                {showOldPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="relative">
              <input
                type={showNewPwd ? "text" : "password"}
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                placeholder="新密码（至少6位）"
                className={cn(pwdInputClass, "pr-9")}
              />
              <button
                type="button"
                onClick={() => setShowNewPwd(!showNewPwd)}
                tabIndex={-1}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                {showNewPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <input
              type="password"
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              placeholder="确认新密码"
              className={pwdInputClass}
            />
            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={handleChangePassword}
                disabled={changePwdLoading}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {changePwdLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                确认修改
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowChangePwd(false);
                  setOldPwd("");
                  setNewPwd("");
                  setConfirmPwd("");
                  setChangePwdError("");
                }}
                className="rounded-lg px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Device info */}
      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center gap-2">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">设备绑定</h3>
        </div>
        {deviceLoading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">加载中...</span>
          </div>
        ) : deviceInfo ? (
          <div className="space-y-2.5">
            {deviceInfo.bound ? (
              <>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">设备标识</span>
                    <span className="font-mono text-foreground">{deviceInfo.machineCode ?? "—"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">绑定时间</span>
                    <span className="text-foreground">
                      {deviceInfo.boundAt ? new Date(deviceInfo.boundAt).toLocaleString("zh-CN") : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">本月解绑余额</span>
                    <span className={cn(
                      "font-medium",
                      deviceInfo.unbindRemaining > 0 ? "text-foreground" : "text-amber-600",
                    )}>
                      {deviceInfo.unbindRemaining} / {deviceInfo.unbindLimit}
                    </span>
                  </div>
                </div>
                {deviceInfo.unbindRemaining > 0 && (
                  <button
                    type="button"
                    onClick={handleUnbind}
                    disabled={unbindLoading}
                    className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-amber-500/30 px-3.5 py-2 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/10 disabled:opacity-50"
                  >
                    {unbindLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    解绑旧设备，绑定当前设备
                  </button>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                尚未绑定设备，下次登录时将自动绑定当前设备。
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">无法获取设备信息</p>
        )}
      </div>

      {/* Logout */}
      <div className="rounded-lg border border-destructive/20 p-4">
        <h3 className="mb-1.5 text-sm font-semibold text-foreground">退出登录</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          退出后需要重新登录才能继续使用
        </p>
        {confirming ? (
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-1.5 rounded-lg bg-destructive px-4 py-2 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
            >
              <LogOut className="h-4 w-4" />
              确认退出
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-4 py-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        )}
      </div>
    </div>
  );
}

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
    <div className="rounded-lg border border-border p-4">
      <label className="block text-sm font-semibold text-foreground">{label}</label>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      <div className="mt-2.5 flex gap-2">
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground/60 focus:ring-1"
          readOnly
        />
        <button
          type="button"
          onClick={onPick}
          className="flex items-center gap-1.5 rounded-lg border border-input px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          <FolderOpen className="h-4 w-4" />
          选择
        </button>
      </div>
      {value && (
        <button
          type="button"
          onClick={onClear}
          className="mt-2 text-xs text-muted-foreground transition-colors hover:text-destructive"
        >
          清除路径
        </button>
      )}
    </div>
  );
}
