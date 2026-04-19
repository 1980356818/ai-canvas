import { useState, useCallback, useEffect } from "react";
import {
  Eye,
  EyeOff,
  ToggleLeft,
  ToggleRight,
  ChevronDown,
  ChevronRight,
  Zap,
} from "lucide-react";
import { registry } from "@/providers/registry";
import type { ProviderConfig, ProviderConfigField } from "@/providers/types";
import { cn } from "@/lib/utils";

interface ProviderRow {
  id: string;
  name: string;
  caps: string;
  configSchema: ProviderConfigField[];
  config: ProviderConfig;
  expanded: boolean;
}

function defaultConfig(id: string): ProviderConfig {
  return { id, apiKey: "", baseUrl: "", extra: {}, enabled: true };
}

function capLabel(c: string): string {
  const map: Record<string, string> = {
    chat: "对话",
    vision: "视觉",
    tool_calling: "工具",
    image_gen: "图片",
    video_gen: "视频",
    streaming: "流式",
  };
  return map[c] ?? c;
}

function ConfigField({
  field,
  value,
  onChange,
}: {
  field: ProviderConfigField;
  value: string;
  onChange: (val: string) => void;
}) {
  const [show, setShow] = useState(false);

  if (field.type === "select") {
    return (
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {field.label}
          {field.required && <span className="ml-0.5 text-destructive">*</span>}
        </label>
        <select
          value={value || field.default || ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs outline-none ring-ring focus:ring-1"
        >
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const isPassword = field.type === "password";

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {field.label}
        {field.required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      <div className="relative">
        <input
          type={isPassword && !show ? "password" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? field.default ?? ""}
          className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 pr-8 text-xs outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {show ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </button>
        )}
      </div>
    </div>
  );
}

export default function ProviderConfigPanel() {
  const [rows, setRows] = useState<ProviderRow[]>([]);

  useEffect(() => {
    const providers = registry.getAll();
    const result: ProviderRow[] = providers.map((p) => {
      const existing = registry.getConfig(p.descriptor.id);
      return {
        id: p.descriptor.id,
        name: p.descriptor.name,
        caps: p.descriptor.capabilities.map(capLabel).join(" · "),
        configSchema: [...p.descriptor.configSchema],
        config: existing ?? defaultConfig(p.descriptor.id),
        expanded: false,
      };
    });
    setRows(result);
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, expanded: !r.expanded } : r)),
    );
  }, []);

  const toggleEnabled = useCallback((id: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...r, config: { ...r.config, enabled: !r.config.enabled } }
          : r,
      ),
    );
  }, []);

  const updateField = useCallback((id: string, key: string, value: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        if (key === "apiKey") {
          return { ...r, config: { ...r.config, apiKey: value } };
        }
        if (key === "baseUrl") {
          return { ...r, config: { ...r.config, baseUrl: value } };
        }
        return {
          ...r,
          config: { ...r.config, extra: { ...r.config.extra, [key]: value } },
        };
      }),
    );
  }, []);

  const saveAll = useCallback(async () => {
    for (const row of rows) {
      registry.setConfig(row.id, row.config);
    }
    await registry.saveConfigs();
  }, [rows]);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__providerConfigSave = saveAll;
    return () => {
      delete (window as unknown as Record<string, unknown>).__providerConfigSave;
    };
  }, [saveAll]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Zap className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">AI 平台</span>
      </div>

      <div className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.id}
            className={cn(
              "rounded-lg border transition-colors",
              row.config.enabled
                ? "border-border bg-background"
                : "border-border/50 bg-muted/30 opacity-60",
            )}
          >
            <div className="flex items-center gap-2 px-3 py-2.5">
              <button
                type="button"
                onClick={() => toggleExpand(row.id)}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground"
              >
                {row.expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>

              <button
                type="button"
                onClick={() => toggleExpand(row.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{row.name}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {row.id}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {row.caps}
                </div>
              </button>

              <button
                type="button"
                onClick={() => toggleEnabled(row.id)}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                title={row.config.enabled ? "禁用" : "启用"}
              >
                {row.config.enabled ? (
                  <ToggleRight className="h-5 w-5 text-primary" />
                ) : (
                  <ToggleLeft className="h-5 w-5" />
                )}
              </button>
            </div>

            {row.expanded && row.configSchema.length > 0 && (
              <div className="border-t border-border/50 px-3 pb-3 pt-2">
                <div className="space-y-2">
                  {row.configSchema.map((field) => {
                    const val =
                      field.key === "apiKey"
                        ? row.config.apiKey
                        : field.key === "baseUrl"
                          ? row.config.baseUrl
                          : row.config.extra[field.key] ?? "";
                    return (
                      <ConfigField
                        key={field.key}
                        field={field}
                        value={val}
                        onChange={(v) => updateField(row.id, field.key, v)}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
