import { memo, useCallback } from "react";
import { Clapperboard, Loader2, AlertTriangle, Sparkles, RefreshCw } from "lucide-react";
import type { CanvasCard } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { ElapsedTimer } from "@/features/cards/CardContent";
import { TYPE_COLORS } from "@/shared/constants";
import type { ScriptCardData } from "@/lib/scriptModel";

/**
 * 「帮我写」卡的画布展示面。
 *   - 空态:邀请连入素材并打开向导。
 *   - 有脚本:展示分镜脚本文本(data.result)+ 重新打开向导。
 *   - 生成中:转圈(向导内调用也会经 uiStore.generatingCards 点亮)。
 * 入口统一走 uiStore.openScriptWizard(cardId) → 全屏向导。
 */
export default memo(function ScriptCard({ card }: { card: CanvasCard }) {
  const data = card.data as ScriptCardData;
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));
  const cardError = useUIStore((s) => s.cardErrors.get(card.id));
  const openWizard = useUIStore((s) => s.openScriptWizard);

  const open = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      openWizard(card.id);
    },
    [card.id, openWizard],
  );
  const stop = useCallback((e: React.PointerEvent | React.WheelEvent) => {
    e.stopPropagation();
  }, []);

  if (genProgress) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <Loader2 className="h-7 w-7 animate-spin text-primary/60" />
        <p className="text-center text-[11px] text-muted-foreground">{genProgress.label}</p>
        <p className="text-center text-[10px] text-muted-foreground/60">
          <ElapsedTimer />
        </p>
      </div>
    );
  }

  const hasResult = !!data.result;

  return (
    <div className="flex h-full w-full flex-col p-3">
      <div className="mb-2 flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Clapperboard className="h-3.5 w-3.5" style={{ color: TYPE_COLORS.ai_script }} />
        帮我写 · 分镜脚本
      </div>

      {cardError && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="line-clamp-2">{cardError}</span>
        </div>
      )}

      {hasResult ? (
        <>
          <div
            className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] leading-relaxed text-card-foreground"
            onPointerDown={stop}
            onWheel={stop}
          >
            {data.result}
          </div>
          <button
            onClick={open}
            onPointerDown={stop}
            className="mt-2 flex shrink-0 items-center justify-center gap-1.5 self-end rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            重新生成
          </button>
        </>
      ) : (
        <button
          onClick={open}
          onPointerDown={stop}
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Sparkles className="h-8 w-8 opacity-50" />
          <span className="text-sm font-medium">帮我写</span>
          <span className="px-4 text-center text-[11px] opacity-70">
            连入图片/视频素材，自动分析并写分镜脚本
          </span>
        </button>
      )}
    </div>
  );
});
