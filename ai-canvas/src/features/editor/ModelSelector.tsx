import { useState, useEffect, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { modelService } from "@/services/models";
import type { ModelOption } from "@/providers/types";
import { cn } from "@/lib/utils";

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
        filtered.sort((a, b) => {
          const aOwn = a.providerId === "jijing" ? 0 : 1;
          const bOwn = b.providerId === "jijing" ? 0 : 1;
          return aOwn - bOwn;
        });
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

  const handleChange = (compositeKey: string) => {
    const { providerId, modelId } = parseCompositeKey(compositeKey);
    onChange(modelId, providerId);
  };

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
    <div className={cn("relative inline-block", className)}>
      <select
        value={selectedKey}
        onChange={(e) => handleChange(e.target.value)}
        className="h-8 appearance-none rounded border border-input bg-background pl-2.5 pr-7 text-sm outline-none ring-ring focus:ring-1"
      >
        {!models.some((m) => m.id === value) && value && (
          <option value={value}>
            {modelService.getDisplayName(value)}
          </option>
        )}
        {models.map((m) => {
          const label = `[${m.providerName}] ${m.display_name || m.id}`;
          return (
            <option key={toCompositeKey(m)} value={toCompositeKey(m)}>
              {label}
            </option>
          );
        })}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
