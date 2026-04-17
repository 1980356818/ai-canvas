import { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { modelService } from "@/services/models";
import type { ModelInfo } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface ModelSelectorProps {
  capability: "CHAT" | "IMAGE" | "VIDEO";
  value: string;
  onChange: (modelId: string) => void;
  className?: string;
}

export default function ModelSelector({
  capability,
  value,
  onChange,
  className,
}: ModelSelectorProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    modelService
      .getByCapability(capability)
      .then((list) => {
        if (!cancelled) setModels(list);
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
  }, [capability]);

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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 appearance-none rounded border border-input bg-background pl-2.5 pr-7 text-sm outline-none ring-ring focus:ring-1"
      >
        {!models.some((m) => m.id === value) && value && (
          <option value={value}>
            {modelService.getDisplayName(value)}
          </option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.display_name || m.id}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
