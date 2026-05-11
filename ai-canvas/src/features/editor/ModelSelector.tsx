import { useState, useEffect, useCallback, useMemo } from "react";
import { modelService } from "@/services/models";
import type { ModelOption } from "@/providers/types";
import { cn } from "@/lib/utils";
import PortalSelect from "./PortalSelect";

interface ModelSelectorProps {
  capability: "CHAT" | "IMAGE" | "VIDEO";
  value: string;
  providerId?: string;
  onChange: (modelId: string, providerId: string) => void;
  className?: string;
  filter?: (model: ModelOption) => boolean;
}

function toCompositeKey(m: ModelOption): string {
  return `${m.providerId}:${m.id}`;
}

function parseCompositeKey(key: string): { providerId: string; modelId: string } {
  const sep = key.indexOf(":");
  if (sep < 0) {
    const p = modelService.tryResolveProvider(key);
    return { providerId: p?.descriptor.id ?? "", modelId: key };
  }
  return { providerId: key.slice(0, sep), modelId: key.slice(sep + 1) };
}

export default function ModelSelector({
  capability,
  value,
  providerId: propProviderId,
  onChange,
  className,
  filter,
}: ModelSelectorProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    modelService
      .getByCapability(capability)
      .then((list) => {
        if (cancelled) return;
        const filtered = filter ? list.filter(filter) : list;
        setModels(filtered);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [capability, filter]);

  const selectedKey = useMemo(() => {
    if (!value) return "";
    if (propProviderId) {
      const exact = models.find((m) => m.id === value && m.providerId === propProviderId);
      if (exact) return toCompositeKey(exact);
    }
    const fallback = models.find((m) => m.id === value);
    if (fallback) return toCompositeKey(fallback);
    return value;
  }, [value, propProviderId, models]);

  const providerCount = useMemo(() => new Set(models.map((m) => m.providerId)).size, [models]);

  const options = useMemo(() => {
    const result: { value: string; label: string }[] = [];
    if (!models.some((m) => m.id === value) && value) {
      result.push({ value, label: modelService.getDisplayName(value) });
    }
    for (const m of models) {
      const label = providerCount > 1
        ? `[${m.providerName}] ${m.display_name || m.id}`
        : (m.display_name || m.id);
      result.push({ value: toCompositeKey(m), label });
    }
    return result;
  }, [models, value, providerCount]);

  const handleChange = useCallback(
    (compositeKey: string) => {
      const { providerId, modelId } = parseCompositeKey(compositeKey);
      onChange(modelId, providerId);
    },
    [onChange],
  );

  if (loading) {
    return (
      <div className={cn("h-8 w-32 animate-pulse rounded bg-muted", className)} />
    );
  }

  if (models.length === 0) {
    return (
      <span className={cn("text-sm text-muted-foreground", className)}>
        {value || "无可用模型"}
      </span>
    );
  }

  return (
    <PortalSelect
      value={selectedKey}
      onChange={handleChange}
      options={options}
      className={cn("h-8", className)}
    />
  );
}
