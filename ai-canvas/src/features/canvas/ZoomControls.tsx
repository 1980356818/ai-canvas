import { useCallback } from "react";
import { Minus, Plus, Maximize, MessageSquare } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { MIN_ZOOM, MAX_ZOOM } from "@/shared/constants";

export default function ZoomControls({ zoom }: { zoom: number }) {
  const setViewport = useCanvasStore((s) => s.setViewport);
  const viewport = useCanvasStore((s) => s.viewport);
  const chatPanelVisible = useUIStore((s) => s.chatPanelVisible);
  const toggleChatPanel = useUIStore((s) => s.toggleChatPanel);

  const zoomTo = useCallback(
    (newZoom: number) => {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
      const cx = viewport.width / 2;
      const cy = viewport.height / 2;
      const ratio = clamped / viewport.zoom;
      setViewport({
        zoom: clamped,
        x: cx - (cx - viewport.x) * ratio,
        y: cy - (cy - viewport.y) * ratio,
      });
    },
    [viewport, setViewport],
  );

  const fitAll = useCallback(() => {
    const cards = Array.from(useCardStore.getState().cards.values()).filter(
      (c) => c.projectId === useProjectStore.getState().currentProjectId,
    );
    if (cards.length === 0) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const PAD = 60;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const c of cards) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + c.width);
      maxY = Math.max(maxY, c.y + c.height);
    }
    const cw = maxX - minX;
    const ch = maxY - minY;
    const z = Math.min(
      (viewport.width - PAD * 2) / cw,
      (viewport.height - PAD * 2) / ch,
      2,
    );
    const clamped = Math.max(MIN_ZOOM, z);
    setViewport({
      zoom: clamped,
      x: (viewport.width - cw * clamped) / 2 - minX * clamped,
      y: (viewport.height - ch * clamped) / 2 - minY * clamped,
    });
  }, [viewport.width, viewport.height, setViewport]);

  return (
    <div
      className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={toggleChatPanel}
        title={chatPanelVisible ? "关闭 AI 聊天" : "打开 AI 聊天"}
        className={`flex h-7 w-7 items-center justify-center rounded-lg border border-border/60 shadow-sm backdrop-blur-xl transition-colors ${
          chatPanelVisible
            ? "bg-primary text-primary-foreground"
            : "bg-background/80 text-muted-foreground hover:bg-accent hover:text-foreground"
        }`}
      >
        <MessageSquare className="h-3.5 w-3.5" />
      </button>
      <div className="flex items-center rounded-lg border border-border/60 bg-background/80 shadow-sm backdrop-blur-xl">
      <button
        onClick={() => zoomTo(zoom / 1.2)}
        title="缩小"
        className="flex h-7 w-7 items-center justify-center rounded-l-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => zoomTo(1)}
        title="重置为 100%"
        className="flex h-7 min-w-[3rem] items-center justify-center text-xs tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        onClick={() => zoomTo(zoom * 1.2)}
        title="放大"
        className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <div className="h-4 w-px bg-border" />
      <button
        onClick={fitAll}
        title="适配全部"
        className="flex h-7 w-7 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Maximize className="h-3.5 w-3.5" />
      </button>
      </div>
    </div>
  );
}
