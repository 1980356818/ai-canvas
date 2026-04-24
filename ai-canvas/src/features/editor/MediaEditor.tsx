import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, RefreshCw, X, Eye, EyeOff, ArrowDownLeft, Lock, AlertCircle, ZoomIn } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, Connection } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ModelCategory } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/platform";
import { getBase64ForApi } from "@/lib/media";
import { modelService } from "@/services/models";
import { scheduleBackgroundSave } from "@/lib/media";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import {
  getRefSlotsForModel,
  isEnhancerModel,
  isStandardImageModel,
  compactRefImages,
  buildCompactKeyMap,
  type RefImageEntry,
} from "@/config/model-ref-images";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { IMAGE_SIZE_OPTIONS, sizeFromRatio, normalizeImageSize, getAllowedSizesForModel, coerceToAllowedSize } from "@/shared/constants";
import { useImageRefSources } from "@/hooks/useImageRefSources";
import { type InlineImageRef, toDisplayText, remapInlineRefs, reorderInlineRefs } from "@/lib/promptSerializer";
import ModelSelector from "./ModelSelector";
import RefImageSlot from "./RefImageSlot";
import SizeCombo from "./SizeCombo";
import PromptTextarea, { type PromptTextareaHandle } from "./PromptTextarea";

interface ImageResult {
  url: string;
  revisedPrompt?: string;
}

interface MediaData {
  content?: string;
  imageUrl?: string;
  results?: ImageResult[];
  selectedIndex?: number;
  batchSize?: number;
  model?: string;
  provider?: string;
  size?: string;
  resolution?: string;
  refImages?: Record<string, RefImageEntry>;
  inlineRefs?: InlineImageRef[];
  upstreamTexts?: Record<string, string>;
  _locked?: boolean;
  _label?: string;
  _description?: string;
  _promptTemplate?: string;
  _params?: Record<string, string>;
}

function buildFinalPrompt(data: MediaData): string {
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

interface MediaEditorProps {
  card: CanvasCard;
}

export default function MediaEditor({ card }: MediaEditorProps) {
  const updateCard = useCardStore((s) => s.updateCard);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore((s) => s.generatingCards.has(card.id));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const promptRef = useRef<PromptTextareaHandle>(null);
  const [currentModel, setCurrentModel] = useState("");
  const [currentSize, setCurrentSize] = useState(
    () => normalizeImageSize((card.data as MediaData).size) || useSettingsStore.getState().lastImageSize,
  );
  const [currentResolution, setCurrentResolution] = useState(
    () => (card.data as MediaData).resolution || "2K",
  );
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const data = card.data as MediaData;

  const upstreamEntries = useMemo(
    () => Object.entries(data.upstreamTexts || {}),
    [data.upstreamTexts],
  );
  const hasUpstream = upstreamEntries.length > 0;

  const finalPrompt = useMemo(() => buildFinalPrompt(data), [data]);

  useEffect(() => {
    if (data.model && (data as MediaData).provider) {
      setCurrentModel(data.model);
    } else if (data.model) {
      setCurrentModel(data.model);
      const p = modelService.tryResolveProvider(data.model);
      if (p) updateCard(card.id, { data: { ...data, provider: p.descriptor.id } });
    } else {
      const category: ModelCategory = enhancer ? "enhancer" : "image";
      const saved = useSettingsStore.getState().getLastModel(category);
      if (saved) {
        setCurrentModel(saved.modelId);
        updateCard(card.id, { data: { ...data, model: saved.modelId, provider: saved.providerId } });
      } else {
        modelService.getDefaultImageModel().then(({ modelId, providerId }) => {
          setCurrentModel(modelId);
          updateCard(card.id, { data: { ...data, model: modelId, provider: providerId } });
        });
      }
    }
  }, [data.model]);

  const refSlots = useMemo(
    () => getRefSlotsForModel(currentModel),
    [currentModel],
  );

  const enhancer = isEnhancerModel(currentModel);
  const supportsResolution = useMemo(() => {
    if (!currentModel) return false;
    const provider = (data as MediaData).provider;
    return modelService.resolveImageModelId(currentModel, "4K", provider) !== currentModel;
  }, [currentModel, data]);
  const hasRequiredRef = enhancer
    && refSlots.some((s) => s.required && data.refImages?.[s.key]);
  const canGenerate = finalPrompt.length > 0 || !!hasRequiredRef;

  const [hoveredRefId, setHoveredRefId] = useState<string | null>(null);

  const imageOptions = useImageRefSources(card.id, refSlots, data.refImages);

  const modelFilter = useMemo(
    () => enhancer
      ? (m: { id: string }) => isEnhancerModel(m.id)
      : (m: { id: string }) => isStandardImageModel(m.id),
    [enhancer],
  );

  const allowedSizes = useMemo(() => getAllowedSizesForModel(currentModel), [currentModel]);

  const handleModelChange = useCallback(
    (modelId: string, providerId: string) => {
      setCurrentModel(modelId);
      const allowed = getAllowedSizesForModel(modelId);
      const corrected = coerceToAllowedSize(currentSize, allowed);
      if (corrected !== currentSize) {
        setCurrentSize(corrected);
        updateCard(card.id, { data: { ...data, model: modelId, provider: providerId, size: corrected } });
      } else {
        updateCard(card.id, { data: { ...data, model: modelId, provider: providerId } });
      }
      autoSave.markDirty(card.id);
      const category: ModelCategory = isEnhancerModel(modelId) ? "enhancer" : "image";
      useSettingsStore.getState().setLastModel(category, modelId, providerId);
    },
    [card.id, data, updateCard],
  );

  const handleSizeChange = useCallback(
    (sizeValue: string) => {
      setCurrentSize(sizeValue);
      useSettingsStore.getState().setLastImageSize(sizeValue);

      if (data.imageUrl || sizeValue === "auto") {
        updateCard(card.id, { data: { ...data, size: sizeValue } });
        autoSave.markDirty(card.id);
        return;
      }

      const opt = IMAGE_SIZE_OPTIONS.find((o) => o.value === sizeValue);
      if (!opt) return;
      const dims = sizeFromRatio(opt.ratio);

      const centerX = card.x + card.width / 2;
      const centerY = card.y + card.height / 2;

      updateCard(card.id, {
        x: centerX - dims.width / 2,
        y: centerY - dims.height / 2,
        ...dims,
        data: { ...data, size: sizeValue },
      });
      autoSave.markDirty(card.id);
    },
    [card.id, card.x, card.y, card.width, card.height, data, updateCard],
  );

  const handleResolutionChange = useCallback(
    (res: string) => {
      setCurrentResolution(res);
      updateCard(card.id, { data: { ...data, resolution: res } });
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

  const setRefImage = useCallback(
    (slotKey: string, entry: RefImageEntry) => {
      const refImages = { ...data.refImages, [slotKey]: entry };
      updateCard(card.id, { data: { ...data, refImages } });
      autoSave.markDirty(card.id);

      if (entry.sourceCardId) {
        const connStore = useConnectionStore.getState();
        if (!connStore.hasConnection(entry.sourceCardId, card.id)) {
          const projectId = useProjectStore.getState().currentProjectId;
          if (projectId) {
            const conn: Connection = {
              id: crypto.randomUUID(),
              projectId,
              sourceCardId: entry.sourceCardId,
              targetCardId: card.id,
              createdAt: new Date().toISOString(),
            };
            connStore.addConnection(conn);
            autoSave.markDirty();
          }
        }
      }
    },
    [card.id, data, updateCard],
  );

  const clearRefImage = useCallback(
    (slotKey: string) => {
      const entry = data.refImages?.[slotKey];
      if (entry?.sourceCardId) {
        const { connections, removeConnection } = useConnectionStore.getState();
        for (const [id, c] of connections) {
          if (c.sourceCardId === entry.sourceCardId && c.targetCardId === card.id) {
            removeConnection(id);
            break;
          }
        }
      }
      const refImages = { ...data.refImages };
      delete refImages[slotKey];
      const keyMap = buildCompactKeyMap(refImages, refSlots);
      const compacted = compactRefImages(refImages, refSlots);

      const { content: newContent, inlineRefs: newInlineRefs } = remapInlineRefs(
        data.content ?? "",
        data.inlineRefs ?? [],
        keyMap,
        slotKey,
      );

      updateCard(card.id, {
        data: { ...data, refImages: compacted, content: newContent, inlineRefs: newInlineRefs },
      });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard, refSlots],
  );

  const handleReorder = useCallback(
    (fromSlotKey: string, toSlotKey: string) => {
      if (!data.refImages?.[fromSlotKey] || !data.refImages?.[toSlotKey]) return;
      if (fromSlotKey === toSlotKey) return;

      const occupiedKeys = refSlots
        .map((s) => s.key)
        .filter((key) => data.refImages![key]);
      const fromIdx = occupiedKeys.indexOf(fromSlotKey);
      const toIdx = occupiedKeys.indexOf(toSlotKey);
      if (fromIdx === -1 || toIdx === -1) return;

      const entries = occupiedKeys.map((k) => data.refImages![k]!);
      const [moved] = entries.splice(fromIdx, 1);
      entries.splice(toIdx, 0, moved!);

      const refImages: Record<string, RefImageEntry> = {};
      entries.forEach((entry, i) => {
        refImages[occupiedKeys[i]!] = entry;
      });

      const { content: newContent, inlineRefs: newInlineRefs } = reorderInlineRefs(
        data.content ?? "",
        data.inlineRefs ?? [],
        occupiedKeys,
        fromIdx,
        toIdx,
      );
      updateCard(card.id, {
        data: { ...data, refImages, content: newContent, inlineRefs: newInlineRefs },
      });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard, refSlots],
  );

  const handleGenerate = useCallback(async () => {
    const prompt = buildFinalPrompt(data);
    if (generating) return;
    const isEnhancer = isEnhancerModel(currentModel);
    if (!prompt && !isEnhancer) return;

    console.group("[MediaEditor] handleGenerate 开始");
    console.log("[MediaEditor] 卡片数据:", {
      cardId: card.id,
      model: data.model,
      contentLength: data.content?.length ?? 0,
      contentPreview: data.content?.slice(0, 100),
      upstreamTexts: data.upstreamTexts
        ? Object.fromEntries(
            Object.entries(data.upstreamTexts).map(([k, v]) => [k, v.slice(0, 80)]),
          )
        : null,
      refImagesKeys: data.refImages ? Object.keys(data.refImages) : [],
      refImagesSummary: data.refImages
        ? Object.fromEntries(
            Object.entries(data.refImages).map(([k, v]) => [
              k,
              { urlPrefix: v.url.slice(0, 60), sourceCardId: v.sourceCardId, sourceType: v.sourceType },
            ]),
          )
        : null,
    });
    console.log("[MediaEditor] 最终 prompt:", prompt);

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
      console.groupEnd();
      return;
    }

    setCardProgress(card.id, { percent: 0, label: "正在提交请求…" });
    setError(null);
    useUIStore.getState().setCardError(card.id, null);

    if (!isEnhancer) {
      const opt = IMAGE_SIZE_OPTIONS.find((o) => o.value === currentSize);
      if (opt) {
        const dims = sizeFromRatio(opt.ratio);
        if (dims.width !== card.width || dims.height !== card.height) {
          const cx = card.x + card.width / 2;
          const cy = card.y + card.height / 2;
          updateCard(card.id, {
            x: cx - dims.width / 2,
            y: cy - dims.height / 2,
            ...dims,
          });
        }
      }
    }

    try {
      const provider = modelService.resolveProvider(currentModel, (data as MediaData).provider);
      if (!provider.generateImage) {
        throw new Error("当前 Provider 不支持图片生成");
      }

      const rawRefImages = refSlots
        .map((slot) => {
          const entry = data.refImages?.[slot.key];
          return entry ? { url: entry.url, role: slot.key } : null;
        })
        .filter(Boolean) as Array<{ url: string; role: string }>;

      console.log("[MediaEditor] refSlots:", refSlots.map((s) => s.key));
      console.log("[MediaEditor] rawRefImages 数量:", rawRefImages.length);

      if (currentModel === "Real-ESRGAN") {
        const MAX_DIM = 1024;
        for (const slot of refSlots) {
          const entry = data.refImages?.[slot.key];
          if (entry?.width && entry?.height) {
            if (entry.width > MAX_DIM || entry.height > MAX_DIM) {
              useUIStore.getState().addToast({
                type: "warning",
                title: "图片分辨率过大",
                description: `Real-ESRGAN 要求输入图片不超过 ${MAX_DIM}×${MAX_DIM}，当前图片为 ${entry.width}×${entry.height}，请缩小后重试`,
                duration: 6000,
              });
              console.groupEnd();
              return;
            }
          }
        }
      }

      const referenceImages: Array<{ url: string; role: string }> = [];
      for (const ref of rawRefImages) {
        const dataUrl = await getBase64ForApi(ref.url);
        referenceImages.push({ ...ref, url: dataUrl });
      }

      console.log("[MediaEditor] 最终 referenceImages:", referenceImages.map((r) => ({
        role: r.role,
        urlType: r.url.startsWith("data:") ? "base64" : r.url.startsWith("http") ? "http" : "local",
        urlLength: r.url.length,
        urlPrefix: r.url.slice(0, 50),
      })));

      console.log("[MediaEditor] 调用 generateImage:", {
        promptLength: prompt.length,
        promptPreview: prompt.slice(0, 200),
        size: currentSize,
        model: currentModel || "(default)",
        refImageCount: referenceImages.length,
      });

      const resolvedModel = currentModel
        ? modelService.resolveImageModelId(currentModel, currentResolution, (data as MediaData).provider)
        : undefined;

      const count = data.batchSize ?? 1;
      let results: ImageResult[];

      if (count === 1) {
        const r = await provider.generateImage!({
          prompt: prompt || undefined,
          size: isEnhancer ? undefined : currentSize,
          model: resolvedModel,
          quality: isEnhancer ? undefined : "standard",
          referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
          onProgress: (p) => setCardProgress(card.id, { percent: p.percent, label: p.label }),
        });
        console.groupEnd();
        results = [{ url: r.url, revisedPrompt: r.revisedPrompt }];
      } else {
        type SubStatus = "pending" | "running" | "done" | "error";
        const perProgress = new Array<number>(count).fill(0);
        const perStatus = new Array<SubStatus>(count).fill("pending");

        const syncProgress = () => {
          const avg = perProgress.reduce((a, b) => a + b, 0) / count;
          const doneCount = perStatus.filter((s) => s === "done").length;
          setCardProgress(card.id, {
            percent: Math.round(avg),
            label: `并行生成中 (${doneCount}/${count} 完成)`,
            subs: perProgress.map((p, i) => ({ percent: p, status: perStatus[i]! })),
          });
        };

        console.log(`[MediaEditor] 并行启动 ${count} 张生成`);
        syncProgress();

        const settled = await Promise.allSettled(
          Array.from({ length: count }, (_, i) => {
            perStatus[i] = "running";
            return provider.generateImage!({
              prompt: prompt || undefined,
              size: isEnhancer ? undefined : currentSize,
              model: resolvedModel,
              quality: isEnhancer ? undefined : "standard",
              referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
              onProgress: (p) => {
                perProgress[i] = p.percent;
                syncProgress();
              },
            });
          }),
        );

        results = [];
        for (let i = 0; i < settled.length; i++) {
          const s = settled[i]!;
          if (s.status === "fulfilled") {
            perStatus[i] = "done";
            perProgress[i] = 100;
            results.push({ url: s.value.url, revisedPrompt: s.value.revisedPrompt });
          } else {
            perStatus[i] = "error";
            console.warn(`[MediaEditor] 第 ${i + 1}/${count} 张生成失败:`, s.reason);
          }
        }
        syncProgress();
        console.log(`[MediaEditor] 并行生成完成: ${results.length}/${count} 成功`);
        console.groupEnd();
      }

      if (results.length === 0) {
        throw new Error("所有图片生成均失败");
      }

      const newData: Record<string, unknown> = {
        ...data,
        imageUrl: results[0]!.url,
        results,
        selectedIndex: 0,
      };
      updateCard(card.id, { data: newData });
      autoSave.markDirty(card.id);

      const hasRemote = results.some(
        (r) => r.url.startsWith("http://") || r.url.startsWith("https://"),
      );
      if (hasRemote) {
        const pid = useProjectStore.getState().currentProjectId ?? undefined;
        for (let i = 0; i < results.length; i++) {
          if (results[i]!.url.startsWith("http")) {
            scheduleBackgroundSave(card.id, results[i]!.url, i === 0 ? "imageUrl" : undefined, pid);
          }
        }
        useUIStore.getState().addToast({
          type: "warning",
          title: `${results.length} 张图片已生成，部分保存到本地失败`,
          description: "后台将自动重试保存",
          duration: 5000,
        });
      } else {
        useUIStore.getState().addToast({
          type: "success",
          title: results.length > 1
            ? `${results.length} 张图片生成完成`
            : "图片生成完成",
          description: `${currentModel || "默认模型"} 已完成生成`,
          duration: 3000,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[MediaEditor] 生成失败:", msg);
      console.groupEnd();
      const errMsg = friendlyError(msg);
      setError(errMsg);
      useUIStore.getState().setCardError(card.id, errMsg);
    } finally {
      setCardProgress(card.id, null);
    }
  }, [data, card.id, generating, updateCard, currentModel, currentSize, currentResolution, setCardProgress, refSlots]);

  const isLocked = !!data._locked;
  const currentBatchSize = data.batchSize ?? 1;

  const handleBatchSizeChange = useCallback(
    (size: number) => {
      updateCard(card.id, { data: { ...data, batchSize: size } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleParamChange = useCallback(
    (key: string, value: string) => {
      const params = { ...data._params, [key]: value };
      let content = data.content ?? "";
      if (data._promptTemplate) {
        content = data._promptTemplate.replace(
          new RegExp(`\\{\\{${key}\\}\\}`, "g"),
          value,
        );
      }
      updateCard(card.id, { data: { ...data, _params: params, content } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {(enhancer || refSlots.some((s) => data.refImages?.[s.key])) && (
        <div className="flex shrink-0 flex-wrap gap-2">
          {refSlots.map((slot, idx) => {
            const entry = data.refImages?.[slot.key];
            if (!entry && !enhancer) return null;
            return (
              <RefImageSlot
                key={slot.key}
                label={slot.label}
                description={slot.description}
                entry={entry}
                onImage={(e) => setRefImage(slot.key, e)}
                onClear={() => clearRefImage(slot.key)}
                onRefClick={() => {
                  const opt = imageOptions.find((o) => o.id === `slot:${slot.key}`);
                  if (opt) promptRef.current?.insertRef(opt);
                }}
                onReorder={(fromKey) => handleReorder(fromKey, slot.key)}
                disabled={generating}
                targetCardId={card.id}
                slotKey={slot.key}
                index={idx}
                highlighted={hoveredRefId === `slot:${slot.key}`}
              />
            );
          })}
        </div>
      )}

      {isLocked ? (
        <>
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
            <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">{data._label || "模板生成节点"}</p>
              {data._description && (
                <p className="text-[11px] text-muted-foreground">{data._description}</p>
              )}
            </div>
          </div>
          {data._params && (
            <div className="flex shrink-0 items-center gap-2">
              {Object.entries(data._params).map(([key, value]) => (
                <label key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{key === "gender" ? "性别" : key}</span>
                  <select
                    value={value}
                    onChange={(e) => handleParamChange(key, e.target.value)}
                    disabled={generating}
                    className="h-6 rounded border border-input bg-background px-1.5 text-xs text-foreground outline-none ring-ring focus:ring-1"
                  >
                    {key === "gender" ? (
                      <>
                        <option value="女">女</option>
                        <option value="男">男</option>
                      </>
                    ) : (
                      <option value={value}>{value}</option>
                    )}
                  </select>
                </label>
              ))}
            </div>
          )}
        </>
      ) : enhancer ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-primary/25 bg-primary/[0.03] px-3 py-2">
          <ZoomIn className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">
              {modelService.getDisplayName(currentModel, (data as MediaData).provider)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              上传图片后点击放大，无需输入提示词
            </p>
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

          <PromptTextarea
            ref={promptRef}
            value={data.content ?? ""}
            inlineRefs={data.inlineRefs ?? []}
            imageOptions={imageOptions}
            onChange={onPromptChange}
            placeholder={hasUpstream ? "追加你的提示词，按 @ 引用图片…" : "描述你想生成的图片，按 @ 引用图片…"}
            disabled={generating}
            onHoverRef={setHoveredRefId}
          />

          {showPreview && canGenerate && (
            <div className="shrink-0 rounded-lg border border-border bg-muted/50 p-2">
              <div className="mb-1 text-[10px] font-medium text-muted-foreground">
                最终提示词预览
              </div>
              <p className="max-h-[4rem] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
                {finalPrompt}
              </p>
            </div>
          )}
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

      <div className="flex shrink-0 items-center gap-2">
        <ModelSelector
          capability="IMAGE"
          value={currentModel}
          providerId={(data as MediaData).provider}
          onChange={handleModelChange}
          filter={modelFilter}
        />
        {!enhancer && !isLocked && (
          <SizeCombo
            value={currentSize}
            resolution={supportsResolution ? currentResolution : undefined}
            onChange={handleSizeChange}
            onResolutionChange={supportsResolution ? handleResolutionChange : undefined}
            disabled={generating}
            allowedSizes={allowedSizes}
          />
        )}
        {!enhancer && !isLocked && (
          <div className="flex items-center rounded-md border border-input">
            {[1, 2, 4].map((n) => (
              <button
                key={n}
                onClick={() => handleBatchSizeChange(n)}
                disabled={generating}
                className={cn(
                  "px-2 py-1 text-xs font-medium transition-colors",
                  "first:rounded-l-[5px] last:rounded-r-[5px]",
                  currentBatchSize === n
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                title={`生成 ${n} 张`}
              >
                x{n}
              </button>
            ))}
          </div>
        )}
        {!enhancer && !isLocked && hasUpstream && (
          <button
            onClick={() => setShowPreview((v) => !v)}
            className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            title={showPreview ? "隐藏预览" : "预览最终提示词"}
          >
            {showPreview
              ? <><EyeOff className="h-3 w-3" />隐藏</>
              : <><Eye className="h-3 w-3" />预览</>
            }
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={() => {
            if (!canGenerate && !generating) {
              useUIStore.getState().addToast({
                type: "info",
                title: enhancer ? "请先上传参考图" : "请先输入提示词",
                description: enhancer ? "在上方插槽中上传一张图片" : "在上方输入框中描述你想生成的图片",
                duration: 3000,
              });
              return;
            }
            handleGenerate();
          }}
          disabled={generating}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            generating && "cursor-not-allowed opacity-40",
            !generating && !canGenerate && "opacity-60",
          )}
        >
          {generating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {enhancer ? "放大中" : "生成中"}
            </>
          ) : data.imageUrl ? (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              {enhancer ? "重新放大" : "重新生成"}
            </>
          ) : (
            <>
              {enhancer ? <ZoomIn className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
              {enhancer ? "开始放大" : "生成"}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
