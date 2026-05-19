import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronUp } from "lucide-react";
import { IMAGE_SIZE_OPTIONS, IMAGE_QUALITY_OPTIONS } from "@/shared/constants";
import type { ImageSizeOption } from "@/types";
import { cn } from "@/lib/utils";
import { getEditorZoom } from "./editorUtils";

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
  allowedSizes?: string[] | null;
  resolutionOptions?: readonly { value: string; label: string }[];
  /** Override the full option list. Defaults to IMAGE_SIZE_OPTIONS. */
  sizeOptions?: readonly ImageSizeOption[];
  /** 视频卡专用:把时长(秒)也内嵌到这个下拉里。 */
  duration?: number;
  onDurationChange?: (sec: number) => void;
  durationOptions?: readonly { value: string; label: string }[];
  /** 时长是否禁用(如 Veo 参考模式锁 8s)。 */
  durationDisabled?: boolean;
  quality?: string;
  onQualityChange?: (q: string) => void;
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
  resolution,
  onChange,
  onResolutionChange,
  disabled,
  allowedSizes,
  resolutionOptions,
  sizeOptions,
  duration,
  onDurationChange,
  durationOptions,
  durationDisabled,
  quality,
  onQualityChange,
}: SizeComboProps) {
  const allOptions = sizeOptions ?? IMAGE_SIZE_OPTIONS;
  const baseOptions = allowedSizes
    ? allOptions.filter((o) => allowedSizes.includes(o.value))
    : allOptions;
  // 当前 value 不在模型允许列表里（如模板预设 3:4 但用户上次选的模型只支持 1:1/16:9 等）。
  // 把当前值附加进选项里并标记“不支持”，避免静默 fallback 误导用户以为比例自动变了。
  const valueOption = allOptions.find((o) => o.value === value);
  const valueUnsupported = !!allowedSizes && !!valueOption && !allowedSizes.includes(value);
  const filteredOptions = valueUnsupported && valueOption
    ? [...baseOptions, valueOption]
    : baseOptions;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ bottom: number; left: number; zoom: number } | null>(null);

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
    const bottom = window.innerHeight - rect.top + gap;
    setPos((prev) => {
      if (prev && prev.bottom === bottom && prev.left === left && prev.zoom === zoom) return prev;
      return { bottom, left, zoom };
    });
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
    let rafId = 0;
    const loop = () => {
      reposition();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      cancelAnimationFrame(rafId);
    };
  }, [open, reposition]);

  const current =
    filteredOptions.find((o) => o.value === value) ?? filteredOptions[0]!;
  const isAuto = current.value === "auto";
  const currentUnsupported = valueUnsupported && current.value === value;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={currentUnsupported ? "当前模型不支持此比例，请切换比例或更换模型" : undefined}
        className={cn(
          "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm font-medium transition-colors",
          currentUnsupported
            ? "border-amber-500/50 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
            : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          disabled && "cursor-not-allowed opacity-40",
        )}
      >
        <RatioIcon ratio={current.ratio} active={false} size={12} isAuto={isAuto} />
        <span>
          {current.label}
          {quality && ` · ${IMAGE_QUALITY_OPTIONS.find((q) => q.value === quality)?.label ?? quality}`}
          {resolution && ` · ${resolutionOptions?.find((r) => r.value === resolution)?.label ?? resolution}`}
          {duration != null && ` · ${duration}s`}
          {currentUnsupported && " ⚠"}
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
            transform: `scale(${pos.zoom})`,
            transformOrigin: '0 100%',
          }}
        >
          {onQualityChange && (
            <>
              <div className="mb-2.5">
                <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">
                  质量
                </div>
                <div className="flex gap-1.5">
                  {IMAGE_QUALITY_OPTIONS.map((opt) => {
                    const active = quality === opt.value;
                    return (
                      <button
                        key={opt.value}
                        disabled={disabled}
                        onClick={() => onQualityChange(opt.value)}
                        className={cn(
                          "flex-1 rounded-lg py-1.5 text-center text-xs font-medium transition-colors",
                          active
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                          disabled && "cursor-not-allowed opacity-40",
                        )}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mb-2.5 h-px bg-border" />
            </>
          )}

          {onResolutionChange && (
            <>
              <div className="mb-2.5">
                <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">
                  画质
                </div>
                <div className="flex gap-1.5">
                  {(resolutionOptions ?? RESOLUTION_OPTIONS).map((res) => {
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

          {onDurationChange && durationOptions && (
            <>
              <div className="mb-2.5">
                <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">
                  时长
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {durationOptions.map((d) => {
                    const active = String(duration) === d.value;
                    return (
                      <button
                        key={d.value}
                        disabled={disabled || durationDisabled}
                        onClick={() => onDurationChange(Number(d.value))}
                        className={cn(
                          "min-w-[44px] flex-1 rounded-lg py-1.5 text-center text-xs font-medium transition-colors",
                          active
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                          (disabled || durationDisabled) && "cursor-not-allowed opacity-40",
                        )}
                      >
                        {d.label}
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
            <div className={cn("grid gap-1", filteredOptions.length <= 4 ? "grid-cols-3" : "grid-cols-5")}>
              {filteredOptions.map((opt) => {
                const active = value === opt.value;
                const optIsAuto = opt.value === "auto";
                const optUnsupported = !!allowedSizes && !allowedSizes.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    disabled={disabled}
                    title={optUnsupported ? `${opt.value}（当前模型不支持）` : opt.value}
                    className={cn(
                      "flex flex-col items-center rounded-lg px-1 py-2 transition-colors",
                      active
                        ? optUnsupported
                          ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
                          : "bg-primary text-primary-foreground"
                        : optUnsupported
                          ? "text-amber-600/70 hover:bg-amber-500/10 dark:text-amber-400/80"
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
                      {optUnsupported && " ⚠"}
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
