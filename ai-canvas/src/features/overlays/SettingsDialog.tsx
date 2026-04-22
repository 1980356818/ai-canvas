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
  const [exportPath, setExportPath] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;

    (async () => {
      const exp = await getSetting("file_export_path");
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
  }, [platforms, exportPath, toggleSettings]);

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
          <button
            type="button"
            onClick={() => setTab("account")}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
              tab === "account"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <UserCircle className="h-3.5 w-3.5" />
            账号
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
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs font-medium">自动保存</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  AI 生成的图片/视频会自动保存到应用数据目录的 auto-save 文件夹中，按项目分组
                </p>
              </div>
              <PathField
                label="导出路径"
                hint="手动下载时保存到此目录（未设置则使用自动保存目录）"
                value={exportPath}
                placeholder="未设置则使用 auto-save 目录"
                onPick={handlePickExportPath}
                onClear={() => setExportPath("")}
              />
            </div>
          )}

          {tab === "account" && <AccountTab onClose={toggleSettings} />}

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
    "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs outline-none ring-ring placeholder:text-muted-foreground focus:ring-1";

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserCircle className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{user?.username ?? "未知用户"}</p>
            {user?.email && (
              <p className="text-xs text-muted-foreground">{user.email}</p>
            )}
          </div>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
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
          <h3 className="text-xs font-medium text-foreground">修改密码</h3>
          {!showChangePwd && (
            <button
              type="button"
              onClick={() => setShowChangePwd(true)}
              className="flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              <KeyRound className="h-3 w-3" />
              修改
            </button>
          )}
        </div>
        {showChangePwd && (
          <div className="mt-3 space-y-2.5">
            {changePwdError && (
              <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
                {changePwdError}
              </p>
            )}
            <div className="relative">
              <input
                type={showOldPwd ? "text" : "password"}
                value={oldPwd}
                onChange={(e) => setOldPwd(e.target.value)}
                placeholder="原密码"
                className={cn(pwdInputClass, "pr-7")}
              />
              <button
                type="button"
                onClick={() => setShowOldPwd(!showOldPwd)}
                tabIndex={-1}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showOldPwd ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
            </div>
            <div className="relative">
              <input
                type={showNewPwd ? "text" : "password"}
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                placeholder="新密码（至少6位）"
                className={cn(pwdInputClass, "pr-7")}
              />
              <button
                type="button"
                onClick={() => setShowNewPwd(!showNewPwd)}
                tabIndex={-1}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showNewPwd ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
            </div>
            <input
              type="password"
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              placeholder="确认新密码"
              className={pwdInputClass}
            />
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleChangePassword}
                disabled={changePwdLoading}
                className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {changePwdLoading && <Loader2 className="h-3 w-3 animate-spin" />}
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
                className="rounded-md px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Device info */}
      <div className="rounded-lg border border-border p-4">
        <div className="mb-2 flex items-center gap-2">
          <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
          <h3 className="text-xs font-medium text-foreground">设备绑定</h3>
        </div>
        {deviceLoading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">加载中...</span>
          </div>
        ) : deviceInfo ? (
          <div className="space-y-2">
            {deviceInfo.bound ? (
              <>
                <div className="space-y-1 text-[11px]">
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
                    className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-amber-500/30 px-3 py-1.5 text-[11px] text-amber-600 transition-colors hover:bg-amber-500/10 disabled:opacity-50"
                  >
                    {unbindLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                    解绑旧设备，绑定当前设备
                  </button>
                )}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                尚未绑定设备，下次登录时将自动绑定当前设备。
              </p>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">无法获取设备信息</p>
        )}
      </div>

      {/* Logout */}
      <div className="rounded-lg border border-destructive/20 p-4">
        <h3 className="mb-2 text-xs font-medium text-foreground">退出登录</h3>
        <p className="mb-3 text-[11px] text-muted-foreground">
          退出后需要重新登录才能继续使用
        </p>
        {confirming ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              <LogOut className="h-3.5 w-3.5" />
              确认退出
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="flex items-center gap-1.5 rounded-md border border-destructive/30 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
          >
            <LogOut className="h-3.5 w-3.5" />
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
