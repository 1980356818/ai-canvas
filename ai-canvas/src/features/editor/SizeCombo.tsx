import { useState, useEffect, useRef } from "react";
import { ChevronUp } from "lucide-react";
import { IMAGE_SIZE_OPTIONS } from "@/shared/constants";
import { cn } from "@/lib/utils";

const RESOLUTION_OPTIONS = [
  { value: "2K", label: "2K", px: 2048 },
  { value: "4K", label: "4K", px: 4096 },
] as const;

interface SizeComboProps {
  value: string;
  resolution?: string;
  onChange: (value: string) => void;
  onResolutionChange?: (res: string) => void;
  disabled?: boolean;
}

function RatioIcon({
  ratio,
  active,
  size = 14,
  isAuto,
}: {
  ratio: number;
  active: boolean;
  size?: number;
  isAuto?: boolean;
}) {
  if (isAuto) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-[2px] border text-[7px] font-bold leading-none",
          active ? "border-primary-foreground/50 text-primary-foreground" : "border-current/40",
        )}
        style={{ width: size, height: size }}
      >
        A
      </span>
    );
  }
  const w = ratio >= 1 ? size : Math.round(size * ratio);
  const h = ratio >= 1 ? Math.round(size / ratio) : size;
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded-[2px] border",
        active ? "border-primary-foreground/50" : "border-current/40",
      )}
      style={{ width: w, height: h }}
    />
  );
}

export default function SizeCombo({
  value,
  resolution = "2K",
  onChange,
  onResolutionChange,
  disabled,
}: SizeComboProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const current =
    IMAGE_SIZE_OPTIONS.find((o) => o.value === value) ?? IMAGE_SIZE_OPTIONS[0]!;
  const isAuto = current.value === "auto";

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs font-medium transition-colors",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
          disabled && "cursor-not-allowed opacity-40",
        )}
      >
        <RatioIcon ratio={current.ratio} active={false} size={12} isAuto={isAuto} />
        <span>
          {current.label}
          {resolution && ` · ${resolution}`}
        </span>
        <ChevronUp className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>

      {/* Popup panel — opens upward */}
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-[260px] rounded-xl border border-border bg-popover p-3 shadow-xl">
          {onResolutionChange && (
            <>
              {/* Resolution row */}
              <div className="mb-2.5">
                <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">
                  分辨率
                </div>
                <div className="flex gap-1.5">
                  {RESOLUTION_OPTIONS.map((res) => {
                    const active = resolution === res.value;
                    return (
                      <button
                        key={res.value}
                        disabled={disabled}
                        onClick={() => onResolutionChange(res.value)}
                        className={cn(
                          "flex-1 rounded-lg py-1.5 text-center text-xs font-medium transition-colors",
                          active
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                          disabled && "cursor-not-allowed opacity-40",
                        )}
                      >
                        {res.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* Divider */}
              <div className="mb-2.5 h-px bg-border" />
            </>
          )}

          {/* Ratio grid */}
          <div>
            <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">
              画面比例
            </div>
            <div className="grid grid-cols-5 gap-1">
              {IMAGE_SIZE_OPTIONS.map((opt) => {
                const active = value === opt.value;
                const optIsAuto = opt.value === "auto";
                return (
                  <button
                    key={opt.value}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    disabled={disabled}
                    title={opt.value}
                    className={cn(
                      "flex flex-col items-center rounded-lg px-1 py-2 transition-colors",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      disabled && "cursor-not-allowed opacity-40",
                    )}
                  >
                    <span className="flex h-5 items-center justify-center">
                      <RatioIcon
                        ratio={opt.ratio}
                        active={active}
                        size={20}
                        isAuto={optIsAuto}
                      />
                    </span>
                    <span className="mt-1 text-[10px] font-medium leading-tight">
                      {opt.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
