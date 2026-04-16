import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, RefreshCw, ArrowDownLeft, Lock, X, AlertCircle, ImageIcon, Volume2, VolumeX } from "lucide-react";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/lib/tauri";
import { modelService } from "@/services/models";
import { scheduleBackgroundSave, getBase64ForApi, getDisplayUrl } from "@/lib/media";
import { useProjectStore } from "@/stores/projectStore";
import { providerManager } from "@/stores/agentStore";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { useConnectionStore } from "@/stores/connectionStore";
import { useImageRefSources } from "@/hooks/useImageRefSources";
import { type InlineImageRef, toDisplayText } from "@/lib/promptSerializer";
import ModelSelector from "./ModelSelector";
import SizeCombo from "./SizeCombo";
import PromptTextarea from "./PromptTextarea";
import { normalizeImageSize } from "@/shared/constants";

interface VideoFrameRef {
  url: string;
  sourceCardId: string;
}

interface VideoData {
  content?: string;
  videoUrl?: string;
  model?: string;
  size?: string;
  upstreamTexts?: Record<string, string>;
  inlineRefs?: InlineImageRef[];
  /** @deprecated use refFrames instead */
  upstreamImageUrl?: string;
  refFrames?: VideoFrameRef[];
  upstreamCardId?: string;
  _locked?: boolean;
  _label?: string;
  _description?: string;
  duration?: number;
  resolution?: string;
  generateAudio?: boolean;
}

function buildFinalPrompt(data: VideoData): string {
  const parts: string[] = [];
  if (data.upstreamTexts) {
    for (const text of Object.values(data.upstreamTexts)) {
      if (text.trim()) parts.push(text.trim());
    }
  }
  if (data.content?.trim()) {
    const display = toDisplayText(data.content.trim(), data.inlineRefs ?? []);
    parts.push(display);
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
  const isSeedance = currentModel.startsWith("doubao-seedance");

  const [duration, setDuration] = useState<number>(data.duration ?? 5);
  const [resolution, setResolution] = useState<string>(data.resolution ?? "720p");
  const [generateAudio, setGenerateAudio] = useState<boolean>(data.generateAudio ?? true);

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

  const imageOptions = useImageRefSources(card.id, [], undefined);

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

  const handleDurationChange = useCallback(
    (val: number) => {
      setDuration(val);
      updateCard(card.id, { data: { ...data, duration: val } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleResolutionChange = useCallback(
    (val: string) => {
      setResolution(val);
      updateCard(card.id, { data: { ...data, resolution: val } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleAudioChange = useCallback(
    (val: boolean) => {
      setGenerateAudio(val);
      updateCard(card.id, { data: { ...data, generateAudio: val } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const onPromptChange = useCallback(
    (newContent: string, newRefs: InlineImageRef[]) => {
      updateCard(card.id, { data: { ...data, content: newContent, inlineRefs: newRefs } });
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

  const frames = useMemo(() => {
    if (data.refFrames && data.refFrames.length > 0) return data.refFrames;
    if (data.upstreamImageUrl) {
      return [{ url: data.upstreamImageUrl, sourceCardId: data.upstreamCardId ?? "" }];
    }
    return [];
  }, [data.refFrames, data.upstreamImageUrl, data.upstreamCardId]);

  const removeFrame = useCallback(
    (index: number) => {
      const frame = frames[index];
      if (!frame) return;

      if (frame.sourceCardId) {
        const { connections, removeConnection } = useConnectionStore.getState();
        for (const [id, c] of connections) {
          if (c.sourceCardId === frame.sourceCardId && c.targetCardId === card.id) {
            removeConnection(id);
            break;
          }
        }
      }

      const newFrames = frames.filter((_, i) => i !== index);
      updateCard(card.id, {
        data: {
          ...data,
          refFrames: newFrames.length > 0 ? newFrames : undefined,
          upstreamImageUrl: undefined,
        },
      });
      autoSave.markDirty(card.id);
    },
    [card.id, data, frames, updateCard],
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
      const isSeedance = (currentModel || "").startsWith("doubao-seedance");
      const provider = isSeedance
        ? providerManager.get("seedance") ?? providerManager.getDefault()
        : providerManager.getDefault();
      if (!provider.generateVideo) {
        throw new Error("当前 Provider 不支持视频生成");
      }

      const referenceImages: Array<{ url: string; role: string }> = [];
      for (let i = 0; i < frames.length; i++) {
        const dataUrl = await getBase64ForApi(frames[i]!.url);
        referenceImages.push({ url: dataUrl, role: i === 0 ? "firstFrame" : "lastFrame" });
      }

      const result = await provider.generateVideo({
        prompt,
        model: currentModel || undefined,
        size: currentSize,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
        onProgress: (p) => {
          setCardProgress(card.id, { percent: p.percent, label: p.label });
        },
        ...(isSeedance && {
          duration,
          resolution,
          generateAudio,
        }),
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
  }, [data, card.id, generating, updateCard, currentModel, currentSize, setCardProgress, frames, isSeedance, duration, resolution, generateAudio]);

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
          {frames.length > 0 && (
            <div className="shrink-0 rounded-lg border border-dashed border-primary/25 bg-primary/[0.03] p-2">
              <div className="mb-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <ImageIcon className="h-3 w-3" />
                参考帧 · 连线图片卡片自动填充（最多 2 帧）
              </div>
              <div className="flex gap-2">
                {frames.map((frame, idx) => (
                  <div key={frame.sourceCardId || idx} className="relative">
                    <img
                      src={getDisplayUrl(frame.url)}
                      alt={idx === 0 ? "首帧" : "尾帧"}
                      className="h-16 w-auto rounded border border-border object-cover"
                    />
                    <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 py-px text-[9px] text-white">
                      {idx === 0 ? "首帧" : "尾帧"}
                    </span>
                    <button
                      onClick={() => removeFrame(idx)}
                      disabled={generating}
                      className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-white shadow-sm transition-opacity hover:opacity-80 disabled:opacity-40"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

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

          <PromptTextarea
            value={data.content ?? ""}
            inlineRefs={data.inlineRefs ?? []}
            imageOptions={imageOptions}
            onChange={onPromptChange}
            placeholder={hasUpstream ? "追加你的提示词，按 @ 引用图片…" : "描述你想生成的视频，按 @ 引用图片…"}
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

      {isSeedance && !isLocked && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/50 bg-muted/30 px-2.5 py-1.5">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            时长
            <select
              value={duration}
              onChange={(e) => handleDurationChange(Number(e.target.value))}
              disabled={generating}
              className="h-6 rounded border border-border bg-background px-1.5 text-[11px] text-foreground disabled:opacity-40"
            >
              <option value={-1}>自动</option>
              {[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((s) => (
                <option key={s} value={s}>{s}s</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            分辨率
            <select
              value={resolution}
              onChange={(e) => handleResolutionChange(e.target.value)}
              disabled={generating}
              className="h-6 rounded border border-border bg-background px-1.5 text-[11px] text-foreground disabled:opacity-40"
            >
              <option value="480p">480p</option>
              <option value="720p">720p</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => handleAudioChange(!generateAudio)}
            disabled={generating}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
              generateAudio
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted",
              generating && "opacity-40",
            )}
          >
            {generateAudio ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
            {generateAudio ? "有声" : "无声"}
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
