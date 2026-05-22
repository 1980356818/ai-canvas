import {
  useState,
  useEffect,
  useRef,
  useLayoutEffect,
  type MutableRefObject,
} from "react";
import { ImageIcon, Search, Link, Music, Video } from "lucide-react";
import type { ImageRefOption } from "@/hooks/useImageRefSources";
import { cn } from "@/lib/utils";

interface AtMentionPopoverProps {
  options: ImageRefOption[];
  query: string;
  anchorPos: { top: number; left: number };
  onSelect: (option: ImageRefOption) => void;
  onClose: () => void;
  onKeyAction: MutableRefObject<((key: string) => void) | null>;
}

const CATEGORY_META: Record<
  string,
  { label: string; icon: typeof ImageIcon }
> = {
  slot: { label: "参考图", icon: ImageIcon },
  upstream: { label: "上游节点", icon: Link },
  audio: { label: "参考音频", icon: Music },
  video: { label: "参考视频", icon: Video },
};

const VIEWPORT_PADDING = 8;
const LINE_HEIGHT = 22;

function useSmartPosition(
  anchorPos: { top: number; left: number },
  popoverRef: React.RefObject<HTMLDivElement | null>,
) {
  const [pos, setPos] = useState<{ top: number; left: number }>(anchorPos);

  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) {
      setPos(anchorPos);
      return;
    }

    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = anchorPos.top;
    let left = anchorPos.left;

    // Flip upward if popover overflows bottom of screen
    if (top + rect.height > vh - VIEWPORT_PADDING) {
      top = anchorPos.top - LINE_HEIGHT - rect.height;
    }

    // Clamp to top edge
    if (top < VIEWPORT_PADDING) {
      top = VIEWPORT_PADDING;
    }

    // Clamp to right edge
    if (left + rect.width > vw - VIEWPORT_PADDING) {
      left = vw - rect.width - VIEWPORT_PADDING;
    }

    // Clamp to left edge
    if (left < VIEWPORT_PADDING) {
      left = VIEWPORT_PADDING;
    }

    setPos({ top, left });
  }, [anchorPos, popoverRef]);

  return pos;
}

export default function AtMentionPopover({
  options,
  query,
  anchorPos,
  onSelect,
  onClose,
  onKeyAction,
}: AtMentionPopoverProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);
  const pos = useSmartPosition(anchorPos, popoverRef);

  const filtered = options.filter((opt) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      opt.label.toLowerCase().includes(q) ||
      (opt.cardTitle?.toLowerCase().includes(q) ?? false)
    );
  });

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    onKeyAction.current = (key: string) => {
      if (filtered.length === 0) return;

      switch (key) {
        case "ArrowDown":
          setActiveIndex((i) => (i + 1) % filtered.length);
          break;
        case "ArrowUp":
          setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
          break;
        case "Enter":
        case "Tab":
          if (filtered[activeIndex]) onSelect(filtered[activeIndex]);
          break;
        case "Escape":
          onClose();
          break;
      }
    };
    return () => {
      onKeyAction.current = null;
    };
  }, [filtered, activeIndex, onSelect, onClose, onKeyAction]);

  if (filtered.length === 0) {
    return (
      <div
        ref={popoverRef}
        data-at-mention-popover
        className="fixed z-[99999] w-[280px] rounded-lg border border-border bg-popover p-3 shadow-lg"
        style={{ top: pos.top, left: pos.left }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <p className="text-xs text-muted-foreground">
          暂无可引用的素材，请先上传参考图/音频或连接上游节点
        </p>
      </div>
    );
  }

  const grouped = groupByCategory(filtered);
  let flatIndex = 0;

  return (
    <div
      ref={popoverRef}
      data-at-mention-popover
      className="fixed z-[99999] w-[280px] overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          @ 引用素材{query ? ` · "${query}"` : ""}
        </span>
      </div>

      <div className="max-h-[240px] overflow-y-auto py-1">
        {grouped.map(([category, items]) => {
          const meta = CATEGORY_META[category] ?? {
            label: category,
            icon: ImageIcon,
          };
          const CategoryIcon = meta.icon;

          return (
            <div key={category}>
              <div className="flex items-center gap-1.5 px-3 py-1.5">
                <CategoryIcon className="h-3 w-3 text-muted-foreground/60" />
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                  {meta.label}
                </span>
              </div>

              {items.map((item) => {
                const idx = flatIndex++;
                const isActive = idx === activeIndex;

                return (
                  <button
                    key={item.id}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors",
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent",
                    )}
                    onClick={() => onSelect(item)}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded border border-input bg-muted/30">
                      {item.category === "audio" ? (
                        <Music className="h-4 w-4 text-muted-foreground" />
                      ) : item.category === "video" ? (
                        <Video className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <img
                          src={item.thumbnailUrl}
                          alt={item.label}
                          className="h-full w-full object-cover"
                          loading="lazy"
                          decoding="async"
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">
                        {item.label}
                      </p>
                      {item.cardTitle && item.category !== "slot" && (
                        <p className="truncate text-[10px] text-muted-foreground">
                          来自: {item.cardTitle}
                        </p>
                      )}
                    </div>
                    {isActive && (
                      <kbd className="shrink-0 rounded border border-border bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                        Enter
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function groupByCategory(
  items: ImageRefOption[],
): [string, ImageRefOption[]][] {
  const order = ["slot", "upstream", "audio", "video"];
  const map = new Map<string, ImageRefOption[]>();
  for (const item of items) {
    const list = map.get(item.category) ?? [];
    list.push(item);
    map.set(item.category, list);
  }
  return order
    .filter((cat) => map.has(cat))
    .map((cat) => [cat, map.get(cat)!]);
}
