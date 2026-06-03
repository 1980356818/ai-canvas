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
  Database,
  RotateCcw,
  AlertTriangle,
  ExternalLink,
  Copy,
  Check,
  Download,
} from "lucide-react";
import {
  getSetting,
  setSetting,
  validateConnection,
  invalidateApiKeyCache,
  pickDirectory,
  listBackups,
  getBackupDir,
  createBackupNow,
  prepareRestore,
  cancelPendingRestore,
  getPendingRestore,
  type BackupInfo,
} from "@/platform";
import { registry } from "@/providers/registry";
import { modelService } from "@/services/models";
import { useUIStore } from "@/stores/uiStore";
import { useAuthStore } from "@/stores/authStore";
import { apiChangePassword, apiGetDeviceInfo, apiUnbindDevice, type DeviceInfo } from "@/platform/auth.api";
import { isTauri } from "@/platform/runtime";
import { invoke } from "@tauri-apps/api/core";
import { isPlatformVisible } from "@/config/platforms";
import {
  JIJING_OVERSEAS_SETTING_KEY,
  JIJING_API_CN,
  JIJING_API_GLOBAL,
} from "@/providers/jijing/baseUrl";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import UpdatesTab from "./UpdatesTab";

type SettingsTab = "platforms" | "general" | "backup" | "updates" | "account";
type ConnStatus = "idle" | "testing" | "ok" | "error";
type KeyTag = "default" | "gemini_premium";

interface KeyEntry {
  id: string;
  name: string;
  key: string;
  tag?: KeyTag;
}

interface PlatformState {
  id: string;
  name: string;
  // API baseUrl 由代码硬编码、不展示给用户也不允许编辑。仅用于 registry.setConfig
  // 与 Tauri 校验调用——实际生效路径在 Rust 端 resolve_base_url() / Vite dev proxy。
  // 极境会在 handleSave 时根据 overseas 字段动态选 cn / global URL。
  apiBaseUrl: string;
  // 平台用户官网（登录 / 充值入口），仅在 UI 展示为可点击/可复制链接。
  homepageUrl: string;
  keys: KeyEntry[];
  activeKeyId: string;
  enabled: boolean;
  expanded: boolean;
  editingKeyId: string | null;
  showKeyIds: Set<string>;
  connStatus: ConnStatus;
  connError: string;
  autoRotate: boolean;
  // 「海外用户」开关。仅极境 (id === "jijing") 使用; 其他 provider 该字段恒为 false。
  // 持久化 key 在 baseUrl.ts::JIJING_OVERSEAS_SETTING_KEY, Rust 端 resolve_base_url 同步消费。
  overseas: boolean;
}

function genId() {
  return crypto.randomUUID().slice(0, 8);
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "····" + key.slice(-4);
}

// Comfly 两个固定保留槽位 —— 不可删除、名称不可改，KEY 值可改。
const COMFLY_RESERVED: { id: string; name: string; tag: KeyTag }[] = [
  { id: "__default__", name: "普通默认", tag: "default" },
  { id: "__gemini_premium__", name: "Gemini优质", tag: "gemini_premium" },
];

function isReservedKey(platformId: string, keyId: string): boolean {
  return platformId === "comfly" && COMFLY_RESERVED.some((r) => r.id === keyId);
}

// 把已存储的 keys 数组归一化为：两个保留槽位永远在前 + 用户自定义条目 + 必须有 tag。
function normalizeComflyKeys(rawKeys: KeyEntry[]): KeyEntry[] {
  const out: KeyEntry[] = [];
  const remaining = [...rawKeys];

  for (const r of COMFLY_RESERVED) {
    const idx = remaining.findIndex((k) => k.id === r.id);
    if (idx >= 0) {
      const existing = remaining[idx]!;
      out.push({ id: r.id, name: r.name, key: existing.key, tag: r.tag });
      remaining.splice(idx, 1);
    } else {
      // 升级老数据：第一次找到的、tag 匹配/未标记的条目当成保留槽位的 key 值
      let donorIdx = remaining.findIndex((k) => k.tag === r.tag);
      if (donorIdx === -1 && r.tag === "default") {
        donorIdx = remaining.findIndex((k) => !k.tag);
      }
      const donorKey = donorIdx >= 0 ? remaining[donorIdx]!.key : "";
      if (donorIdx >= 0) remaining.splice(donorIdx, 1);
      out.push({ id: r.id, name: r.name, key: donorKey, tag: r.tag });
    }
  }

  for (const k of remaining) {
    out.push({ ...k, tag: k.tag ?? "default" });
  }
  return out;
}

// API baseUrl 与用户官网 URL 分离：
//   - apiBaseUrl：SDK / Tauri Rust 端实际调用的地址，硬编码，不暴露给用户。
//   - homepageUrl：用户访问、登录、充值的网址，显示在设置卡片里供用户点击/复制。
// 极境两者不同：API 走 api.*，用户面板走 ai.*；Comfly 两者一致。
const ALL_PLATFORMS: { id: string; name: string; apiBaseUrl: string; homepageUrl: string }[] = [
  {
    id: "comfly",
    name: "Comfly",
    apiBaseUrl: "https://ai.comfly.org",
    homepageUrl: "https://ai.comfly.org",
  },
  {
    id: "jijing",
    name: "极境",
    apiBaseUrl: "https://api.snoworangekeji.cn",
    homepageUrl: "https://api.snoworangekeji.cn",
  },
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
          const [keysJson, activeId, legacyKey, enabledStr, autoRotateStr, overseasStr] =
            await Promise.all([
              getSetting(`${p.id}_api_keys`),
              getSetting(`${p.id}_active_key_id`),
              p.id === "comfly"
                ? getSetting("openai_api_key")
                : getSetting(`${p.id}_api_key`),
              getSetting(`${p.id}_enabled`),
              getSetting(`${p.id}_auto_rotate`),
              // 仅极境读取「海外用户」开关; 其他 provider 拿 null, 字段保持 false。
              p.id === "jijing" ? getSetting(JIJING_OVERSEAS_SETTING_KEY) : Promise.resolve(null),
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

          // Comfly: 强制保留两个固定槽位
          if (p.id === "comfly") {
            keys = normalizeComflyKeys(keys);
            if (!keys.some((k) => k.id === active)) {
              active = keys.find((k) => k.key.trim())?.id ?? keys[0]!.id;
            }
          }

          states.push({
            id: p.id,
            name: p.name,
            apiBaseUrl: p.apiBaseUrl,
            homepageUrl: p.homepageUrl,
            keys,
            activeKeyId: active || (keys.length > 0 ? keys[0]!.id : ""),
            enabled: enabledStr !== "false",
            expanded: false,
            editingKeyId: null,
            showKeyIds: new Set(),
            connStatus: "idle",
            connError: "",
            autoRotate: autoRotateStr !== "false",
            // 默认 false (国内). 仅极境会从 setting 读真实值;其他 provider 该字段无意义。
            overseas: overseasStr === "true",
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
        // 用当前表单里的 key 测试，避免"必须先保存才能测连接"的歧义。
        // baseUrl 已硬编码（Rust 端 default_base_url / Vite proxy），无需前端传。
        const p = platforms.find((x) => x.id === id);
        const activeEntry = p?.keys.find((e) => e.id === p?.activeKeyId);
        const fallbackEntry = p?.keys.find((e) => e.key.trim());
        const apiKey = (activeEntry?.key ?? fallbackEntry?.key ?? "").trim();
        await validateConnection(id, { apiKey: apiKey || undefined });
        updatePlatform(id, { connStatus: "ok" });
      } catch (err) {
        updatePlatform(id, {
          connStatus: "error",
          connError: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [updatePlatform, platforms],
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

        await setSetting(`${p.id}_api_keys`, JSON.stringify(cleanKeys));
        await setSetting(`${p.id}_active_key_id`, p.activeKeyId);
        await setSetting(`${p.id}_api_key`, activeKey);
        await setSetting(`${p.id}_enabled`, String(p.enabled));
        await setSetting(`${p.id}_auto_rotate`, String(p.autoRotate));

        if (p.id === "comfly") {
          await setSetting("openai_api_key", activeKey);
        }

        // 极境「海外用户」开关持久化。Rust 端 resolve_base_url 从 sqlite
        // 读 JIJING_OVERSEAS_SETTING_KEY 决定最终线路 (前端不再直连上游)。
        if (p.id === "jijing") {
          await setSetting(JIJING_OVERSEAS_SETTING_KEY, String(p.overseas));
        }

        // 极境的 baseUrl 由 overseas 开关派生 (cn / global 两选一), 其他 provider
        // 仍用 ALL_PLATFORMS 表里的硬编码值。这里把派生结果同步写入 ProviderConfig,
        // 保持 registry 与 settings 一致。
        const effectiveBaseUrl =
          p.id === "jijing"
            ? (p.overseas ? JIJING_API_GLOBAL : JIJING_API_CN)
            : p.apiBaseUrl;
        const existingExtra = registry.getConfig(p.id)?.extra ?? {};
        registry.setConfig(p.id, {
          id: p.id,
          apiKey: activeKey,
          baseUrl: effectiveBaseUrl,
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
            ...(isTauri
              ? [{ key: "backup" as const, icon: Database, label: "数据备份" }]
              : []),
            // updates: 仅 Tauri 桌面端有意义(走 tauri-plugin-updater 装包+重启)
            ...(isTauri
              ? [{ key: "updates" as const, icon: Download, label: "更新" }]
              : []),
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

          {tab === "backup" && <BackupTab />}

          {tab === "updates" && <UpdatesTab />}

          {tab === "account" && <AccountTab onClose={toggleSettings} />}

          {/* Footer */}
          <div className="mt-6 flex items-center justify-end gap-3 border-t border-border pt-5">
            <button
              type="button"
              onClick={toggleSettings}
              className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {tab === "backup" ? "关闭" : "取消"}
            </button>
            {tab !== "backup" && (
              <button
                type="submit"
                disabled={saving}
                className={cn(
                  "flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/25 transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/30",
                  saving && "opacity-60",
                )}
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {saving ? "保存中..." : "保存设置"}
              </button>
            )}
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
  const isComfly = p.id === "comfly";

  const handleAddKey = (tag?: KeyTag) => {
    const entry: KeyEntry = isComfly
      ? { id: genId(), name: "", key: "", tag: tag ?? "default" }
      : { id: genId(), name: "", key: "" };
    const next = [...p.keys, entry];
    onUpdate({
      keys: next,
      activeKeyId: p.keys.length === 0 ? entry.id : p.activeKeyId,
      editingKeyId: entry.id,
    });
  };

  const handleRemoveKey = (id: string) => {
    if (isReservedKey(p.id, id)) return;
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
    // 保留槽位的名字和 tag 不允许改
    const safePatch = isReservedKey(p.id, id)
      ? { key: patch.key }
      : patch;
    onUpdate({
      keys: p.keys.map((e) => (e.id === id ? { ...e, ...safePatch } : e)),
    });
  };

  const toggleShowKey = (id: string) => {
    const next = new Set(p.showKeyIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onUpdate({ showKeyIds: next });
  };

  // Comfly 分组拖动：仅在同一槽位内重排——避免把 default 的 key 拖到 premium 槽。
  const handleDragEnd = () => {
    if (dragIdx != null && overIdx != null && dragIdx !== overIdx) {
      const from = p.keys[dragIdx];
      const to = p.keys[overIdx];
      if (isComfly && from && to && from.tag !== to.tag) {
        setDragIdx(null);
        setOverIdx(null);
        return;
      }
      // 保留槽位不能被拖走
      if (from && isReservedKey(p.id, from.id)) {
        setDragIdx(null);
        setOverIdx(null);
        return;
      }
      const reordered = [...p.keys];
      const [moved] = reordered.splice(dragIdx, 1);
      reordered.splice(overIdx, 0, moved!);
      onUpdate({ keys: reordered });
    }
    setDragIdx(null);
    setOverIdx(null);
  };

  const keyCount = p.keys.filter((e) => e.key.trim()).length;
  const defaultKeys = isComfly ? p.keys.filter((k) => (k.tag ?? "default") === "default") : [];
  const premiumKeys = isComfly ? p.keys.filter((k) => k.tag === "gemini_premium") : [];

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
          className={cn(
            "flex h-7 w-12 flex-shrink-0 items-center rounded-full px-0.5 transition-colors",
            p.enabled ? "bg-primary" : "bg-muted",
          )}
          title={p.enabled ? "禁用" : "启用"}
        >
          <span
            className={cn(
              "h-6 w-6 rounded-full bg-background shadow-sm transition-transform",
              p.enabled ? "translate-x-5" : "translate-x-0",
            )}
          />
        </button>
      </div>

      {/* Expanded */}
      {p.expanded && (
        <div className="space-y-4 border-t border-border/50 px-4 pb-4 pt-3">
          {/* 极境「海外用户」线路开关。开启后所有极境请求改走香港线路。 */}
          {p.id === "jijing" && (
            <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2.5">
              <div className="min-w-0 flex-1 pr-3">
                <p className="text-xs font-semibold text-foreground">海外用户</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  开启后所有请求走香港线路，国内用户请保持关闭
                </p>
              </div>
              <button
                type="button"
                onClick={() => onUpdate({ overseas: !p.overseas })}
                className="flex-shrink-0"
                title={p.overseas ? "关闭海外线路" : "开启海外线路"}
              >
                {p.overseas ? (
                  <ToggleRight className="h-7 w-7 text-primary" />
                ) : (
                  <ToggleLeft className="h-7 w-7 text-muted-foreground" />
                )}
              </button>
            </div>
          )}

          {/* Auto-rotate toggle */}
          {p.keys.length > 1 && (
            <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2.5">
              <div>
                <p className="text-xs font-semibold text-foreground">自动切换 Key</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {isComfly
                    ? "同槽位内 Key 不可用时自动尝试下一个，按列表顺序"
                    : "Key 不可用时自动尝试下一个，按列表顺序"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onUpdate({ autoRotate: !p.autoRotate })}
                className="flex-shrink-0"
              >
                {p.autoRotate ? (
                  <ToggleRight className="h-7 w-7 text-primary" />
                ) : (
                  <ToggleLeft className="h-7 w-7 text-muted-foreground" />
                )}
              </button>
            </div>
          )}

          {/* Keys */}
          {isComfly ? (
            <>
              <KeyGroup
                title="普通默认"
                hint="用于 GPT 系列、Seedance 等非 Gemini 模型"
                tag="default"
                entries={defaultKeys}
                allKeys={p.keys}
                platformId={p.id}
                activeKeyId={p.activeKeyId}
                editingKeyId={p.editingKeyId}
                showKeyIds={p.showKeyIds}
                autoRotate={p.autoRotate}
                dragIdx={dragIdx}
                overIdx={overIdx}
                onUpdate={onUpdate}
                onUpdateKey={handleUpdateKey}
                onRemoveKey={handleRemoveKey}
                onToggleShow={toggleShowKey}
                onAdd={() => handleAddKey("default")}
                onDragStart={setDragIdx}
                onDragOver={setOverIdx}
                onDragEnd={handleDragEnd}
              />
              <KeyGroup
                title="Gemini优质"
                hint="用于 Nano-banana、Veo 3.1、Gemini 对话模型"
                tag="gemini_premium"
                entries={premiumKeys}
                allKeys={p.keys}
                platformId={p.id}
                activeKeyId={p.activeKeyId}
                editingKeyId={p.editingKeyId}
                showKeyIds={p.showKeyIds}
                autoRotate={p.autoRotate}
                dragIdx={dragIdx}
                overIdx={overIdx}
                onUpdate={onUpdate}
                onUpdateKey={handleUpdateKey}
                onRemoveKey={handleRemoveKey}
                onToggleShow={toggleShowKey}
                onAdd={() => handleAddKey("gemini_premium")}
                onDragStart={setDragIdx}
                onDragOver={setOverIdx}
                onDragEnd={handleDragEnd}
              />
            </>
          ) : (
            <FlatKeyList
              entries={p.keys}
              platformId={p.id}
              activeKeyId={p.activeKeyId}
              editingKeyId={p.editingKeyId}
              showKeyIds={p.showKeyIds}
              autoRotate={p.autoRotate}
              dragIdx={dragIdx}
              overIdx={overIdx}
              onUpdate={onUpdate}
              onUpdateKey={handleUpdateKey}
              onRemoveKey={handleRemoveKey}
              onToggleShow={toggleShowKey}
              onAdd={() => handleAddKey()}
              onDragStart={setDragIdx}
              onDragOver={setOverIdx}
              onDragEnd={handleDragEnd}
            />
          )}

          {/* 平台官网（登录 / 充值入口） */}
          <PlatformHomepage url={p.homepageUrl} platformName={p.name} />

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

// ── Platform Homepage Link ───────────────────────────────────

/**
 * 把平台用户官网作为只读链接展示，提供「打开」与「复制」两个动作。
 * 用户不再能编辑 API baseUrl——它由代码硬编码。
 */
function PlatformHomepage({ url, platformName }: { url: string; platformName: string }) {
  const [copied, setCopied] = useState(false);
  const addToast = useUIStore((s) => s.addToast);

  const handleOpen = async () => {
    try {
      if (isTauri) {
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      addToast({
        type: "error",
        title: "打开链接失败",
        description: err instanceof Error ? err.message : String(err),
        duration: 3000,
      });
    }
  };

  const handleCopy = async () => {
    try {
      const { clipboardWriteText } = await import("@/platform");
      await clipboardWriteText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      addToast({
        type: "error",
        title: "复制失败",
        description: err instanceof Error ? err.message : String(err),
        duration: 3000,
      });
    }
  };

  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold text-foreground">
        {platformName}官网
      </label>
      <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={url}>
          {url}
        </span>
        <button
          type="button"
          onClick={handleOpen}
          className="flex flex-shrink-0 items-center gap-1 rounded-md bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          title="在浏览器中打开"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          打开
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "flex flex-shrink-0 items-center gap-1 rounded-md bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent",
            copied ? "text-emerald-600" : "text-foreground",
          )}
          title="复制网址"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        登录、充值、查看用量请访问上方网址。
      </p>
    </div>
  );
}

// ── Key Group (Comfly slot) / Flat Key List (other platforms) ──

interface KeyListSharedProps {
  entries: KeyEntry[];
  platformId: string;
  activeKeyId: string;
  editingKeyId: string | null;
  showKeyIds: Set<string>;
  autoRotate: boolean;
  dragIdx: number | null;
  overIdx: number | null;
  onUpdate: (patch: Partial<PlatformState>) => void;
  onUpdateKey: (id: string, patch: Partial<KeyEntry>) => void;
  onRemoveKey: (id: string) => void;
  onToggleShow: (id: string) => void;
  onAdd: () => void;
  onDragStart: (idx: number) => void;
  onDragOver: (idx: number) => void;
  onDragEnd: () => void;
}

interface KeyGroupProps extends KeyListSharedProps {
  title: string;
  hint: string;
  tag: KeyTag;
  allKeys: KeyEntry[];
}

function KeyGroup(props: KeyGroupProps) {
  const { title, hint, entries, allKeys, autoRotate } = props;
  const filledCount = entries.filter((e) => e.key.trim()).length;
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            <span className="rounded-full bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {filledCount} / {entries.length}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
        </div>
        <button
          type="button"
          onClick={props.onAdd}
          className="flex flex-shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </button>
      </div>
      <div className="space-y-2">
        {entries.map((entry) => {
          const idx = allKeys.indexOf(entry);
          return (
            <KeyRow
              key={entry.id}
              entry={entry}
              idx={idx}
              groupLen={entries.length}
              {...props}
              autoRotate={autoRotate}
            />
          );
        })}
      </div>
    </div>
  );
}

function FlatKeyList(props: KeyListSharedProps) {
  const { entries, autoRotate } = props;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-semibold text-foreground">
          API Key
          {autoRotate && entries.length > 1 && (
            <span className="ml-2 font-normal text-muted-foreground">拖拽调整优先级</span>
          )}
        </label>
        <button
          type="button"
          onClick={props.onAdd}
          className="flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
          暂无密钥，点击「添加」创建
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry, idx) => (
            <KeyRow
              key={entry.id}
              entry={entry}
              idx={idx}
              groupLen={entries.length}
              {...props}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface KeyRowProps extends KeyListSharedProps {
  entry: KeyEntry;
  idx: number;
  groupLen: number;
}

function KeyRow({
  entry,
  idx,
  groupLen,
  platformId,
  activeKeyId,
  editingKeyId,
  showKeyIds,
  autoRotate,
  dragIdx,
  overIdx,
  onUpdate,
  onUpdateKey,
  onRemoveKey,
  onToggleShow,
  onDragStart,
  onDragOver,
  onDragEnd,
}: KeyRowProps) {
  const reserved = isReservedKey(platformId, entry.id);
  const isActive = entry.id === activeKeyId;
  const isEditing = entry.id === editingKeyId;
  const isShown = showKeyIds.has(entry.id);
  const isDragOver = overIdx === idx && dragIdx !== idx;
  const canDrag = !reserved && groupLen > 1 && !isEditing;

  return (
    <div
      draggable={canDrag}
      onDragStart={() => onDragStart(idx)}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver(idx);
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "rounded-lg border bg-background px-3 py-2.5 transition-colors",
        isActive ? "border-primary/30 bg-primary/[0.03]" : "border-border",
        isDragOver && "border-primary/50 bg-primary/5",
        dragIdx === idx && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2.5">
        {canDrag ? (
          <div className="flex-shrink-0 cursor-grab text-muted-foreground/40 active:cursor-grabbing">
            <GripVertical className="h-4 w-4" />
          </div>
        ) : reserved ? (
          <div
            className="flex-shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary"
            title="固定槽位，名称不可改、不可删除"
          >
            固定
          </div>
        ) : null}

        {autoRotate && groupLen > 1 && (
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
            {idx + 1}
          </span>
        )}

        <button
          type="button"
          onClick={() => onUpdate({ activeKeyId: entry.id })}
          className="flex-shrink-0"
          title="设为当前使用（用于显示，不影响路由）"
        >
          <div
            className={cn(
              "flex h-4 w-4 items-center justify-center rounded-full border-2 transition-colors",
              isActive ? "border-primary" : "border-muted-foreground/30 hover:border-muted-foreground",
            )}
          >
            {isActive && <div className="h-2 w-2 rounded-full bg-primary" />}
          </div>
        </button>

        <div className="min-w-0 flex-1">
          {isEditing ? (
            <div className="space-y-1.5">
              {reserved ? (
                <div className="px-1 py-0.5 text-xs font-semibold text-foreground">
                  {entry.name}
                </div>
              ) : (
                <input
                  type="text"
                  value={entry.name}
                  onChange={(e) => onUpdateKey(entry.id, { name: e.target.value })}
                  placeholder="名称（如：生产环境）"
                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs outline-none ring-ring placeholder:text-muted-foreground/60 focus:ring-1"
                  autoFocus
                />
              )}
              <div className="relative">
                <input
                  type={isShown ? "text" : "password"}
                  value={entry.key}
                  onChange={(e) => onUpdateKey(entry.id, { key: e.target.value })}
                  placeholder="sk-..."
                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 pr-8 text-xs outline-none ring-ring placeholder:text-muted-foreground/60 focus:ring-1"
                  autoFocus={reserved}
                />
                <button
                  type="button"
                  onClick={() => onToggleShow(entry.id)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                >
                  {isShown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="w-full text-left"
              onClick={() => onUpdate({ editingKeyId: entry.id })}
            >
              <div className="truncate text-xs font-medium text-foreground">
                {entry.name || "未命名"}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {entry.key.trim() ? maskKey(entry.key) : "（未填写）"}
              </div>
            </button>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-1">
          {isEditing ? (
            <button
              type="button"
              onClick={() => onUpdate({ editingKeyId: null })}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              完成
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onUpdate({ editingKeyId: entry.id })}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="编辑"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {reserved ? (
            <span
              className="rounded-md p-1.5 text-muted-foreground/30"
              title="保留槽位，不可删除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onRemoveKey(entry.id)}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              title="删除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
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

// ── Backup Tab ───────────────────────────────────────────────

function formatBackupTime(ms: number): string {
  if (!ms) return "未知";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function BackupTab() {
  const [backupDir, setBackupDir] = useState("");
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<BackupInfo | null>(null);
  const addToast = useUIStore((s) => s.addToast);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [dir, list, pend] = await Promise.all([
        getBackupDir(),
        listBackups(),
        getPendingRestore(),
      ]);
      setBackupDir(dir);
      setBackups(list);
      setPending(pend);
    } catch (e) {
      console.error("[Backup] load failed:", e);
      addToast({
        type: "error",
        title: "加载备份列表失败",
        description: String(e),
        duration: 4000,
      });
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleBackupNow = async () => {
    setBusy(true);
    try {
      await createBackupNow();
      addToast({ type: "success", title: "已创建新备份", duration: 2500 });
      await refresh();
    } catch (e) {
      addToast({
        type: "error",
        title: "备份失败",
        description: String(e),
        duration: 4000,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmRestore = async () => {
    const target = confirmTarget;
    if (!target) return;
    setConfirmTarget(null);
    try {
      await prepareRestore(target.path);
      const next = await getPendingRestore();
      setPending(next);
      addToast({
        type: "success",
        title: "已安排恢复",
        description: "重启应用后从该备份恢复数据",
        duration: 4000,
      });
    } catch (e) {
      addToast({
        type: "error",
        title: "安排恢复失败",
        description: String(e),
        duration: 4000,
      });
    }
  };

  const handleCancelPending = async () => {
    try {
      await cancelPendingRestore();
      setPending(null);
      addToast({ type: "info", title: "已取消恢复计划", duration: 2500 });
    } catch (e) {
      addToast({
        type: "error",
        title: "取消失败",
        description: String(e),
        duration: 4000,
      });
    }
  };

  const handleOpenBackupDir = async () => {
    if (!backupDir) return;
    try {
      await invoke("open_in_explorer", { path: backupDir, projectId: null });
    } catch (e) {
      addToast({
        type: "error",
        title: "打开目录失败",
        description: String(e),
        duration: 4000,
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-foreground" />
          <h3 className="text-sm font-semibold text-foreground">数据备份</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          AICat 会在启动时和每 30 分钟自动备份你的项目数据库，保留最近 10 份。备份位于用户文档目录，不受应用卸载/重装影响。
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value={backupDir}
            className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none ring-ring focus:ring-1"
          />
          <button
            type="button"
            onClick={() => void handleOpenBackupDir()}
            disabled={!backupDir}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-input px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            <FolderOpen className="h-4 w-4" />
            打开目录
          </button>
          <button
            type="button"
            onClick={() => void handleBackupNow()}
            disabled={busy}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90",
              busy && "opacity-60",
            )}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            立即备份
          </button>
        </div>
      </div>

      {pending && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                已安排在下次启动时从备份恢复
              </p>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {pending}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleCancelPending()}
              className="shrink-0 rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h4 className="text-sm font-semibold text-foreground">历史备份</h4>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            刷新
          </button>
        </div>
        {backups.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {loading ? "加载中..." : "暂无备份。下次启动时会自动创建。"}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {backups.map((b) => (
              <li key={b.path} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-foreground">
                    {formatBackupTime(b.modified_ms)}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {b.name} · {formatBytes(b.size)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmTarget(b)}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <RotateCcw className="h-3 w-3" />
                  恢复
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmTarget}
        title="确认从备份恢复？"
        description={
          confirmTarget
            ? `将用 ${formatBackupTime(confirmTarget.modified_ms)} 的备份覆盖当前数据库。\n\n应用重启后才会生效。当前数据库会自动保存一份带 .before-restore 后缀的副本，以防你后悔。`
            : ""
        }
        confirmLabel="安排恢复"
        cancelLabel="取消"
        variant="danger"
        onConfirm={() => void handleConfirmRestore()}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
