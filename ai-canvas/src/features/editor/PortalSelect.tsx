import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { getEditorZoom } from "./editorUtils";

export interface PortalSelectOption {
  value: string;
  label: string;
}

interface PortalSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: PortalSelectOption[];
  disabled?: boolean;
  className?: string;
}

export default function PortalSelect({
  value,
  onChange,
  options,
  disabled,
  className,
}: PortalSelectProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minW: number; zoom: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

  const reposition = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const zoom = getEditorZoom(btn);
    const minW = rect.width / zoom;
    let left = rect.left;
    const panelVisualW = minW * zoom;
    if (left + panelVisualW > window.innerWidth - 8) {
      left = window.innerWidth - 8 - panelVisualW;
    }
    if (left < 8) left = 8;

    const estPanelH = Math.min(options.length * 32 + 8, 248) * zoom;
    let top = rect.bottom + 2;
    if (top + estPanelH > window.innerHeight - 8) {
      top = rect.top - estPanelH - 2;
    }
    if (top < 8) top = 8;

    setPos({ top, left, minW, zoom });
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    reposition();
    const idx = options.findIndex((o) => o.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);

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
  }, [open, reposition, options, value]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % options.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + options.length) % options.length);
          break;
        case "Enter": {
          e.preventDefault();
          const opt = options[activeIndex];
          if (opt) {
            onChange(opt.value);
            setOpen(false);
          }
          break;
        }
        case "Escape":
          setOpen(false);
          break;
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, activeIndex, options, onChange]);

  useEffect(() => {
    if (!open || activeIndex < 0 || !panelRef.current) return;
    panelRef.current
      .querySelectorAll<HTMLElement>("[data-option]")[activeIndex]
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative inline-flex items-center rounded border border-input bg-background py-1.5 pl-2.5 pr-6 text-sm outline-none ring-ring focus:ring-1",
          disabled && "cursor-not-allowed opacity-40",
          className,
        )}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown
          className={cn(
            "pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[99999] max-h-[240px] overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-xl"
            style={{
              top: pos.top,
              left: pos.left,
              minWidth: pos.minW,
              transform: `scale(${pos.zoom})`,
              transformOrigin: '0 0',
            }}
          >
            {options.map((opt, idx) => {
              const highlighted = idx === activeIndex;
              const selected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  data-option
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors",
                    highlighted
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent",
                  )}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  <span className="flex-1 truncate">{opt.label}</span>
                  {selected && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
