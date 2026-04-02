import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
} from "lucide-react";
import { useUIStore, type ToastItem } from "@/stores/uiStore";
import { cn } from "@/lib/utils";

const typeStyles: Record<
  ToastItem["type"],
  { border: string; Icon: typeof CheckCircle2 }
> = {
  success: { border: "border-l-emerald-500", Icon: CheckCircle2 },
  error: { border: "border-l-red-500", Icon: XCircle },
  info: { border: "border-l-blue-500", Icon: Info },
  warning: { border: "border-l-amber-500", Icon: AlertTriangle },
};

function ToastRow({
  toast,
  onRemove,
}: {
  toast: ToastItem;
  onRemove: (id: string) => void;
}) {
  const [entered, setEntered] = useState(false);
  const { border, Icon } = typeStyles[toast.type];

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex max-w-sm gap-3 rounded-lg border border-border bg-card py-3 pl-3 pr-2 text-card-foreground shadow-lg transition-[transform,opacity] duration-300 ease-out",
        "border-l-4",
        border,
        entered ? "translate-x-0 opacity-100" : "translate-x-full opacity-0",
      )}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{toast.title}</p>
        {toast.description ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {toast.description}
          </p>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onRemove(toast.id);
            }}
            className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onRemove(toast.id)}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function Toast() {
  const toasts = useUIStore((s) => s.toasts);
  const removeToast = useUIStore((s) => s.removeToast);
  const visible = toasts.slice(-3).reverse();

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-h-[min(100vh-2rem,24rem)] w-[min(100vw-2rem,24rem)] flex-col-reverse gap-2"
      aria-live="polite"
    >
      {visible.map((t) => (
        <ToastRow key={t.id} toast={t} onRemove={removeToast} />
      ))}
    </div>
  );
}
