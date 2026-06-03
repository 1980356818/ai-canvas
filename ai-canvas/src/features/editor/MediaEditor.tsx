import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, RefreshCw, X, ArrowDownLeft, Lock, AlertCircle, ZoomIn } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, Connection } from "@/types";
import { useUIStore, selectCardBusy } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ModelCategory } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { modelService } from "@/services/models";
import { resolveDefaultModelForCardType } from "@/services/modelDefaults";
import { buildImageRequest } from "@/services/generation/buildImageRequest";
import { runEditorGeneration } from "@/services/generation/runEditorGeneration";
import { scheduleBackgroundSave } from "@/lib/media";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/debug";
import {
  getRefSlotsForModel,
  isEnhancerModel,
  isStandardImageModel,
  compactRefImages,
  buildCompactKeyMap,
  type RefImageEntry,
} from "@/config/model-ref-images";
import { useConnectionStore } from "@/stores/connectionStore";
import { disconnectCardPairAndCleanup } from "@/lib/referenceConsistency";
import {
  IMAGE_SIZE_OPTIONS,
  sizeFromRatio,
  normalizeImageSize,
  getAllowedSizesForModel,
  coerceToAllowedSize,
  normalizeResolution,
  DEFAULT_IMAGE_QUALITY,
  supportsImageQuality,
} from "@/shared/constants";
import { useImageRefSources } from "@/hooks/useImageRefSources";
import { type InlineImageRef, toDisplayText, remapInlineRefs, reorderInlineRefs } from "@/lib/promptSerializer";
import ModelSelector from "./ModelSelector";
import RefImageSlot from "./RefImageSlot";
import SizeCombo from "./SizeCombo";
import PromptTextarea, { type PromptTextareaHandle } from "./PromptTextarea";

const log = createLogger("MediaEditor");

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
  quality?: string;
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
  const updateCardData = useCardStore((s) => s.updateCardData);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore(selectCardBusy(card.id));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const promptRef = useRef<PromptTextareaHandle>(null);
  const [currentModel, setCurrentModel] = useState("");
  const [currentSize, setCurrentSize] = useState(
    () => normalizeImageSize((card.data as MediaData).size) || useSettingsStore.getState().lastImageSize,
  );
  const [currentResolution, setCurrentResolution] = useState(
    () => normalizeResolution((card.data as MediaData).resolution),
  );
  const [currentQuality, setCurrentQuality] = useState(
    () => (card.data as MediaData).quality || DEFAULT_IMAGE_QUALITY,
  );
  const [error, setError] = useState<string | null>(null);
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
      // 默认模型统一走 modelDefaults 的单一口径(见 services/modelDefaults.ts)。
      let cancelled = false;
      resolveDefaultModelForCardType(card.type).then((ref) => {
        if (cancelled || !ref) return;
        setCurrentModel(ref.modelId);
        updateCard(card.id, { data: { ...data, model: ref.modelId, provider: ref.providerId } });
      });
      return () => {
        cancelled = true;
      };
    }
  }, [data.model]);

  const refSlots = useMemo(
    () => getRefSlotsForModel(currentModel),
    [currentModel],
  );

  const enhancer = isEnhancerModel(currentModel);
  const qualitySupported = useMemo(() => supportsImageQuality(currentModel, (data as MediaData).provider), [currentModel, data]);
  const supportsResolution = useMemo(() => {
    const provider = (data as MediaData).provider;
    return modelService.supportsImageResolution(currentModel, provider);
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
      // 收敛到 "2K" | "4K",避免 SizeCombo 等上游传入未规范化值导致 state 漂移。
      const next = normalizeResolution(res);
      setCurrentResolution(next);
      updateCard(card.id, { data: { ...data, resolution: next } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleQualityChange = useCallback(
    (q: string) => {
      setCurrentQuality(q);
      updateCard(card.id, { data: { ...data, quality: q } });
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
      disconnectCardPairAndCleanup(sourceCardId, card.id);
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
          const conn: Connection = {
            id: crypto.randomUUID(),
            projectId: card.projectId,
            sourceCardId: entry.sourceCardId,
            targetCardId: card.id,
            createdAt: new Date().toISOString(),
          };
          connStore.addConnection(conn);
          autoSave.markDirty();
        }
      }
    },
    [card.id, data, updateCard],
  );

  const clearRefImage = useCallback(
    (slotKey: string) => {
      const entry = data.refImages?.[slotKey];
      if (entry?.sourceCardId) {
        // Lifecycle hook strips the slot synchronously when the connection
        // disappears, so any subsequent reads see consistent state.
        disconnectCardPairAndCleanup(entry.sourceCardId, card.id, { markDirty: false });
      }
      const latest = useCardStore.getState().getCard(card.id)?.data as MediaData | undefined;
      const refImages = { ...(latest?.refImages ?? {}) };
      delete refImages[slotKey];
      const keyMap = buildCompactKeyMap(refImages, refSlots);
      const compacted = compactRefImages(refImages, refSlots);

      const { content: newContent, inlineRefs: newInlineRefs } = remapInlineRefs(
        latest?.content ?? "",
        latest?.inlineRefs ?? [],
        keyMap,
        slotKey,
      );

      updateCardData(card.id, {
        refImages: Object.keys(compacted).length > 0 ? compacted : undefined,
        content: newContent,
        inlineRefs: newInlineRefs.length > 0 ? newInlineRefs : undefined,
      });
      autoSave.markDirty(card.id);
    },
    [card.id, data.refImages, updateCardData, refSlots],
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

    // 十步骨架(API Key 预检 / 进度开关 / 错误兜底)统一走 runEditorGeneration;
    // MediaEditor 特有的几何 pendingGeometry / 批量循环 / 诊断日志留在 run 内。
    await runEditorGeneration(card, {
      setError,
      run: async () => {
        // ─── 点击瞬间的同步阶段必须保持纤细 ───
        // 历史教训:这里曾塞 console.group + 10+ 处 console.log + 同步几何 resize,
        // DevTools 一开就冻 100~300ms。现在 dev 日志走 createLogger(prod tree-shake);
        // 几何 resize 推到 result 回写时一并 updateCard,layoutVersion 只 bump 一次。
        log.group("handleGenerate");
        try {
          log.log("submit", {
            cardId: card.id,
            model: data.model,
            promptLen: prompt.length,
            refCount: data.refImages ? Object.keys(data.refImages).length : 0,
            upstreamCount: data.upstreamTexts ? Object.keys(data.upstreamTexts).length : 0,
          });

          // 几何 resize 的目标尺寸 —— **不在点击瞬间 updateCard**,留到结果回写时
          // 跟 data 一起 bump 一次 layoutVersion(见下方 newData)。
          let pendingGeometry: { x: number; y: number; width: number; height: number } | null = null;
          if (!isEnhancer) {
            const opt = IMAGE_SIZE_OPTIONS.find((o) => o.value === currentSize);
            if (opt) {
              const dims = sizeFromRatio(opt.ratio);
              if (dims.width !== card.width || dims.height !== card.height) {
                const cx = card.x + card.width / 2;
                const cy = card.y + card.height / 2;
                pendingGeometry = {
                  x: cx - dims.width / 2,
                  y: cy - dims.height / 2,
                  width: dims.width,
                  height: dims.height,
                };
              }
            }
          }

          // 翻译逻辑(SKU 解析 / enhancer / Real-ESRGAN 预检 / 参考图上传 / 条件传参)统一走
          // buildImageRequest,与 cardRunner 组运行共用同一份。batchSize 不进 build,批量在这里循环。
          const built = await buildImageRequest(card, {
            onUploadProgress: (kind, { uploaded, total }) =>
              setCardProgress(card.id, {
                percent: 0,
                label: `上传${kind} ${uploaded}/${total}…`,
              }),
          });
          if (!built.ok) {
            // Real-ESRGAN 输入过大等约束 → 提示并中止本次生成(不置 error 态)。
            useUIStore.getState().addToast({
              type: "warning",
              title: built.toast?.title ?? "无法生成",
              description: built.toast?.description ?? built.reason,
              duration: 6000,
            });
            return;
          }

          const provider = modelService.resolveProvider(built.modelId, built.providerId);
          if (!provider.generateImage) {
            throw new Error("当前 Provider 不支持图片生成");
          }

          // batchSize 防御性 clamp 到 [1, 4]：
          // - UI 只暴露 1/2/4，但 data.batchSize 是持久化的，老项目/手动编辑可能塞进来更大的值
          // - 4 张并行的 RGBA 解码已经接近 WebView2 GPU 进程容量上限，再多就是白屏崩溃风险
          const requestedCount = Math.max(1, Math.floor(data.batchSize ?? 1));
          const count = Math.min(requestedCount, 4);
          if (count !== requestedCount) {
            log.warn(`batchSize ${requestedCount} clamped to ${count} (max 4 to avoid GPU pressure)`);
          }
          // 把卡片自身的 projectId 作为本次任务的归属,整个异步链都用这个快照(请求体里已由 build 快照)。
          const ownerProjectId = card.projectId;
          let results: ImageResult[];

          if (count === 1) {
            const r = await provider.generateImage!({
              ...built.request,
              onProgress: (p) => {
                setCardProgress(card.id, { percent: p.percent, label: p.label });
              },
            });
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
                label: `批量生成中 (${doneCount}/${count} 完成)`,
                subs: perProgress.map((p, i) => ({ percent: p, status: perStatus[i]! })),
              });
            };

            perStatus.fill("running");
            syncProgress();

            // 批量:TaskManager 是 per-card 的,去 cardId 走 legacy 直连逐张并发。
            const settled = await Promise.allSettled(
              Array.from({ length: count }, (_, i) =>
                provider.generateImage!({
                  ...built.request,
                  cardId: undefined,
                  onProgress: (p) => {
                    perProgress[i] = p.percent;
                    syncProgress();
                  },
                }),
              ),
            );

            results = [];
            for (let i = 0; i < settled.length; i++) {
              const r = settled[i]!;
              if (r.status === "fulfilled") {
                perStatus[i] = "done";
                perProgress[i] = 100;
                results.push({ url: r.value.url, revisedPrompt: r.value.revisedPrompt });
              } else {
                perStatus[i] = "error";
                log.warn(`subtask ${i + 1}/${count} failed:`, r.reason);
              }
            }
            syncProgress();
          }
          log.log("done", { ok: results.length, requested: count });

          if (results.length === 0) {
            throw new Error("所有图片生成均失败");
          }

          const newData: Record<string, unknown> = {
            ...data,
            imageUrl: results[0]!.url,
            results,
            selectedIndex: 0,
          };
          // 同一次 updateCard 一次性写完 data + 几何,layoutVersion 只 bump 一次,
          // CardLayer 不会因为"先 resize 再写 data"被触发两次重算。
          updateCard(card.id, pendingGeometry ? { data: newData, ...pendingGeometry } : { data: newData });
          autoSave.markDirty(card.id);

          const hasRemote = results.some(
            (r) => r.url.startsWith("http://") || r.url.startsWith("https://"),
          );
          if (hasRemote) {
            for (let i = 0; i < results.length; i++) {
              if (results[i]!.url.startsWith("http")) {
                scheduleBackgroundSave(card.id, results[i]!.url, i === 0 ? "imageUrl" : undefined, ownerProjectId);
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
          // 保留生图特有诊断日志;再抛给 runEditorGeneration 统一兜错(setError + 红框)。
          const msg = err instanceof Error ? err.message : String(err);
          log.error("生成失败:", msg);
          throw err;
        } finally {
          log.groupEnd();
        }
      },
    });
  }, [card, data, generating, updateCard, currentModel, currentSize, setCardProgress]);

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
        content = data._promptTemplate;
        for (const [k, v] of Object.entries(params)) {
          content = content.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
        }
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
              {Object.entries(data._params).map(([key, value]) => {
                const genderOptions = [
                  { label: "女", value: "female" },
                  { label: "男", value: "male" },
                ];
                const options = key === "gender"
                  ? genderOptions
                  : [{ label: value, value }];
                return (
                  <div key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{key === "gender" ? "性别" : key}</span>
                    <div className="flex items-center rounded-md border border-input">
                      {options.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => handleParamChange(key, opt.value)}
                          disabled={generating}
                          className={cn(
                            "px-2.5 py-1 text-xs font-medium transition-colors",
                            "first:rounded-l-[5px] last:rounded-r-[5px]",
                            value === opt.value
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
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
        {!enhancer && (
          <SizeCombo
            value={currentSize}
            resolution={supportsResolution ? currentResolution : undefined}
            onChange={handleSizeChange}
            onResolutionChange={supportsResolution ? handleResolutionChange : undefined}
            quality={qualitySupported ? currentQuality : undefined}
            onQualityChange={qualitySupported ? handleQualityChange : undefined}
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
