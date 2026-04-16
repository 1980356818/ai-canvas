import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
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

function getEditorZoom(el: HTMLElement): number {
  const editor = el.closest("[data-editor-zoom]");
  if (!editor) return 1;
  return parseFloat((editor as HTMLElement).dataset.editorZoom ?? "1") || 1;
}

export default function SizeCombo({
  value,
  resolution,
  onChange,
  onResolutionChange,
  disabled,
}: SizeComboProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const zoom = getEditorZoom(btn);
    const panelW = 260 * zoom;
    let left = rect.left;
    if (left + panelW > window.innerWidth - 8) {
      left = window.innerWidth - 8 - panelW;
    }
    const gap = 4 * zoom;
    setPos({ bottom: window.innerHeight - rect.top + gap, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    reposition();
    const onPointerDown = (e: PointerEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition]);

  const current =
    IMAGE_SIZE_OPTIONS.find((o) => o.value === value) ?? IMAGE_SIZE_OPTIONS[0]!;
  const isAuto = current.value === "auto";

  const zoom = triggerRef.current ? getEditorZoom(triggerRef.current) : 1;

  return (
    <>
      <button
        ref={triggerRef}
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

      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[99999] w-[260px] rounded-xl border border-border bg-popover p-3 shadow-xl"
          style={{
            bottom: pos.bottom,
            left: pos.left,
            transform: `scale(${zoom})`,
            transformOrigin: "bottom left",
          }}
        >
          {onResolutionChange && (
            <>
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
              <div className="mb-2.5 h-px bg-border" />
            </>
          )}

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
        </div>,
        document.body,
      )}
    </>
  );
}
