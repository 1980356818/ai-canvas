import { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { modelService } from "@/services/models";
import type { ModelInfo } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface ModelSelectorProps {
  capability: "CHAT" | "IMAGE";
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
      <div className={cn("h-7 w-28 animate-pulse rounded bg-muted", className)} />
    );
  }

  if (models.length === 0) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        {value || "无可用模型"}
      </span>
    );
  }

  return (
    <div className={cn("relative inline-block", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 appearance-none rounded border border-input bg-background pl-2 pr-6 text-xs outline-none ring-ring focus:ring-1"
      >
        {!models.some((m) => m.id === value) && value && (
          <option value={value}>{value}</option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.display_name || m.id}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
