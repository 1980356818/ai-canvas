import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, RefreshCw, ArrowDownLeft, Lock, X, AlertCircle } from "lucide-react";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/lib/tauri";
import { modelService } from "@/services/models";
import { scheduleBackgroundSave } from "@/lib/media";
import { useProjectStore } from "@/stores/projectStore";
import { providerManager } from "@/stores/agentStore";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { useConnectionStore } from "@/stores/connectionStore";
import ModelSelector from "./ModelSelector";
import SizeCombo from "./SizeCombo";
import { normalizeImageSize } from "@/shared/constants";

interface VideoData {
  content?: string;
  videoUrl?: string;
  model?: string;
  size?: string;
  upstreamTexts?: Record<string, string>;
  upstreamCardId?: string;
  _locked?: boolean;
  _label?: string;
  _description?: string;
}

function buildFinalPrompt(data: VideoData): string {
  const parts: string[] = [];
  if (data.upstreamTexts) {
    for (const text of Object.values(data.upstreamTexts)) {
      if (text.trim()) parts.push(text.trim());
    }
  }
  if (data.content?.trim()) {
    parts.push(data.content.trim());
  }
  return parts.join("\n\n");
}

function getCardTitle(cardId: string): string {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return "未知卡片";
  if (card.title) return card.title;
  switch (card.type) {
    case "text": return "文字卡片";
    case "sticky_note": return "便签";
    case "ai_chat": return "AI 对话";
    default: return card.type;
  }
}

export default function VideoEditor({ card }: { card: CanvasCard }) {
  const updateCard = useCardStore((s) => s.updateCard);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore((s) => s.generatingCards.has(card.id));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [currentModel, setCurrentModel] = useState("");
  const [currentSize, setCurrentSize] = useState(() => normalizeImageSize((card.data as VideoData).size));
  const [error, setError] = useState<string | null>(null);
  const data = card.data as VideoData;

  const upstreamEntries = useMemo(
    () => Object.entries(data.upstreamTexts || {}),
    [data.upstreamTexts],
  );
  const hasUpstream = upstreamEntries.length > 0;

  const finalPrompt = useMemo(() => buildFinalPrompt(data), [data]);
  const canGenerate = finalPrompt.length > 0;

  useEffect(() => {
    if (data.model) {
      setCurrentModel(data.model);
    } else {
      modelService.getDefaultVideoModel().then(setCurrentModel);
    }
  }, [data.model]);

  const handleModelChange = useCallback(
    (modelId: string) => {
      setCurrentModel(modelId);
      updateCard(card.id, { data: { ...data, model: modelId } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleSizeChange = useCallback(
    (size: string) => {
      setCurrentSize(size);
      updateCard(card.id, { data: { ...data, size } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const onPromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const content = e.target.value;
      updateCard(card.id, { data: { ...data, content } });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, data, updateCard],
  );

  const removeUpstreamEntry = useCallback(
    (sourceCardId: string) => {
      const { connections, removeConnection } = useConnectionStore.getState();
      for (const [id, c] of connections) {
        if (c.sourceCardId === sourceCardId && c.targetCardId === card.id) {
          removeConnection(id);
          break;
        }
      }
    },
    [card.id],
  );

  const handleGenerate = useCallback(async () => {
    const prompt = buildFinalPrompt(data);
    if (!prompt || generating) return;

    if (!(await hasApiKey())) {
      useUIStore.getState().addToast({
        type: "warning",
        title: "请先配置 API Key",
        description: "前往设置页面配置你的 API Key",
        action: {
          label: "打开设置",
          onClick: () => useUIStore.getState().toggleSettings(),
        },
        duration: 5000,
      });
      return;
    }

    setCardProgress(card.id, { percent: 0, label: "正在提交请求…" });
    setError(null);
    useUIStore.getState().setCardError(card.id, null);

    try {
      const provider = providerManager.getDefault();
      if (!provider.generateVideo) {
        throw new Error("当前 Provider 不支持视频生成");
      }

      const result = await provider.generateVideo({
        prompt,
        model: currentModel || undefined,
        size: currentSize,
        onProgress: (p) => {
          setCardProgress(card.id, { percent: p.percent, label: p.label });
        },
      });

      updateCard(card.id, { data: { ...data, videoUrl: result.url } });
      autoSave.markDirty(card.id);

      const isRemote = result.url.startsWith("http://") || result.url.startsWith("https://");
      if (isRemote) {
        const pid = useProjectStore.getState().currentProjectId ?? undefined;
        scheduleBackgroundSave(card.id, result.url, "videoUrl", pid);
        useUIStore.getState().addToast({
          type: "warning",
          title: "视频已生成，保存到本地失败",
          description: "已使用远程地址播放，后台将自动重试保存",
          duration: 5000,
        });
      } else {
        useUIStore.getState().addToast({
          type: "success",
          title: "视频生成完成",
          description: `${currentModel || "默认模型"} 已完成生成`,
          duration: 3000,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMsg = friendlyError(msg);
      setError(errMsg);
      useUIStore.getState().setCardError(card.id, errMsg);
    } finally {
      setCardProgress(card.id, null);
    }
  }, [data, card.id, generating, updateCard, currentModel, setCardProgress]);

  const isLocked = !!data._locked;

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {isLocked ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{data._label || "模板视频节点"}</p>
            {data._description && (
              <p className="text-[11px] text-muted-foreground">{data._description}</p>
            )}
          </div>
        </div>
      ) : (
        <>
          {hasUpstream && (
            <div className="shrink-0 rounded-lg border border-dashed border-primary/25 bg-primary/[0.03] p-2">
              <div className="mb-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <ArrowDownLeft className="h-3 w-3" />
                上游文字 · 自动拼接到提示词前
              </div>
              <div className="flex flex-wrap gap-1.5">
                {upstreamEntries.map(([cardId, text]) => (
                  <span
                    key={cardId}
                    title={text}
                    className="inline-flex max-w-[180px] items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
                  >
                    <span className="truncate">{getCardTitle(cardId)}: {text}</span>
                    <button
                      onClick={() => removeUpstreamEntry(cardId)}
                      disabled={generating}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <textarea
            className="min-h-[3rem] flex-1 resize-none rounded-lg border border-input bg-background px-3 py-1.5 text-sm leading-relaxed text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
            value={data.content ?? ""}
            onChange={onPromptChange}
            placeholder={hasUpstream ? "追加你的提示词（可选）…" : "描述你想生成的视频…"}
            disabled={generating}
          />
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-destructive">{error}</p>
          <button
            onClick={() => { setError(null); useUIStore.getState().setCardError(card.id, null); }}
            className="shrink-0 rounded p-0.5 text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <ModelSelector
          capability="VIDEO"
          value={currentModel}
          onChange={handleModelChange}
        />
        {!isLocked && (
          <SizeCombo
            value={currentSize}
            onChange={handleSizeChange}
            disabled={generating}
          />
        )}
        <div className="flex-1" />
        <button
          onClick={() => void handleGenerate()}
          disabled={generating || !canGenerate}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            (generating || !canGenerate) && "cursor-not-allowed opacity-40",
          )}
        >
          {generating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              生成中
            </>
          ) : data.videoUrl ? (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              重新生成
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              生成
            </>
          )}
        </button>
      </div>
    </div>
  );
}
