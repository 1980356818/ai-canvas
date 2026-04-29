import { memo, useCallback, useRef, useEffect } from "react";
import { Loader2, AlertTriangle, MessageSquareText } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useUIStore } from "@/stores/uiStore";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { autoSave } from "@/lib/autoSave";

export default memo(function AIChatCard({ card }: { card: CanvasCard }) {
  const data = card.data as { content?: string; result?: string; _resultStale?: boolean };
  const dataRef = useRef(data);
  dataRef.current = data;
  const genProgress = useUIStore((s) => s.generatingCards.get(card.id));
  const cardError = useUIStore((s) => s.cardErrors.get(card.id));
  const isEditing = useCanvasStore((s) => s.editingCardId === card.id);
  const updateCard = useCardStore((s) => s.updateCard);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const focusedOnceRef = useRef(false);
  const isComposingRef = useRef(false);
  // 非受控：textarea 自己管 value，store 只在外部 result 真正变化时（如 AI 生成完成）才同步进来，
  // 避免受控模式下每次按键都重渲染破坏光标 / IME 合成。
  const lastSyncedResultRef = useRef<string | undefined>(data.result);

  useEffect(() => {
    if (isEditing && !genProgress && promptRef.current && !focusedOnceRef.current) {
      const ta = promptRef.current;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      focusedOnceRef.current = true;
    }
    if (!isEditing) focusedOnceRef.current = false;
  }, [isEditing, genProgress]);

  // 外部数据变化时（AI 生成 / 撤销重做 / 跨卡片注入）才覆盖到 textarea。
  // 用户自己输入引发的更新通过 lastSyncedResultRef 过滤掉，避免覆盖光标。
  useEffect(() => {
    const ta = promptRef.current;
    if (!ta) return;
    const next = data.result ?? "";
    if (next === lastSyncedResultRef.current) return;
    if (isComposingRef.current) return;
    lastSyncedResultRef.current = next;
    if (ta.value !== next) ta.value = next;
  }, [data.result]);

  const commitResult = useCallback(
    (result: string) => {
      lastSyncedResultRef.current = result;
      updateCard(card.id, { data: { ...dataRef.current, result } });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => autoSave.markDirty(card.id), 400);
    },
    [card.id, updateCard],
  );

  const onResultChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      // IME 合成中不写 store。读 nativeEvent.isComposing 更稳。
      if ((e.nativeEvent as InputEvent).isComposing || isComposingRef.current) return;
      commitResult(e.target.value);
    },
    [commitResult],
  );

  const onCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(
    (e: React.CompositionEvent<HTMLTextAreaElement>) => {
      isComposingRef.current = false;
      commitResult((e.target as HTMLTextAreaElement).value);
    },
    [commitResult],
  );

  const stopDrag = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  if (genProgress) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary/60" />
        <div className="w-full max-w-[80%] space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            {genProgress.percent > 0 ? (
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{ width: `${genProgress.percent}%` }}
              />
            ) : (
              <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full bg-primary/60" />
            )}
          </div>
          <p className="text-center text-[10px] text-muted-foreground">
            {genProgress.label}
          </p>
        </div>
      </div>
    );
  }

  const isEmpty = !data.result && !cardError;

  if (isEmpty && !isEditing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <MessageSquareText className="h-12 w-12 opacity-40" />
        <span className="text-sm font-medium opacity-50">生成文字</span>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col p-4">
      {cardError && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="line-clamp-2">{cardError}</span>
        </div>
      )}
      {!cardError && data._resultStale && data.result && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>最近一次生成失败，以下为上次成功的结果</span>
        </div>
      )}
      <textarea
        ref={promptRef}
        data-card-result
        className="min-h-0 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm leading-relaxed text-card-foreground outline-none ring-ring placeholder:text-muted-foreground/50 focus:ring-1"
        style={{ pointerEvents: isEditing ? "auto" : "none" }}
        defaultValue={data.result ?? ""}
        readOnly={!isEditing}
        onChange={onResultChange}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        placeholder="点击输入文本..."
        onPointerDown={stopDrag}
        onMouseDown={stopDrag}
        onWheel={(e) => e.stopPropagation()}
      />
    </div>
  );
});
