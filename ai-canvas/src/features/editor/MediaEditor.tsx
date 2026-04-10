import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, RefreshCw, X, Eye, EyeOff, ArrowDownLeft, Lock } from "lucide-react";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey, readMediaBase64 } from "@/lib/tauri";
import { modelService } from "@/services/models";
import { providerManager } from "@/stores/agentStore";
import { cn } from "@/lib/utils";
import {
  getRefSlotsForModel,
  compactRefImages,
  type RefImageEntry,
} from "@/config/model-ref-images";
import { useConnectionStore, type Connection } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { IMAGE_SIZE_OPTIONS, sizeFromRatio, normalizeImageSize } from "@/shared/constants";
import ModelSelector from "./ModelSelector";
import RefImageSlot from "./RefImageSlot";

interface MediaData {
  content?: string;
  imageUrl?: string;
  model?: string;
  size?: string;
  refImages?: Record<string, RefImageEntry>;
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

interface MediaEditorProps {
  card: CanvasCard;
}

export default function MediaEditor({ card }: MediaEditorProps) {
  const updateCard = useCardStore((s) => s.updateCard);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore((s) => s.generatingCards.has(card.id));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [currentModel, setCurrentModel] = useState("");
  const [currentSize, setCurrentSize] = useState(
    () => normalizeImageSize((card.data as MediaData).size) || useSettingsStore.getState().lastImageSize,
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
  const canGenerate = finalPrompt.length > 0;

  useEffect(() => {
    if (data.model) {
      setCurrentModel(data.model);
    } else {
      modelService.getDefaultImageModel().then(setCurrentModel);
    }
  }, [data.model]);

  const refSlots = useMemo(
    () => getRefSlotsForModel(currentModel),
    [currentModel],
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      setCurrentModel(modelId);
      updateCard(card.id, { data: { ...data, model: modelId } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleSizeChange = useCallback(
    (sizeValue: string) => {
      setCurrentSize(sizeValue);
      useSettingsStore.getState().setLastImageSize(sizeValue);

      const opt = IMAGE_SIZE_OPTIONS.find((o) => o.value === sizeValue);
      const dims = opt ? sizeFromRatio(opt.ratio) : {};
      updateCard(card.id, { ...dims, data: { ...data, size: sizeValue } });
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
      const compacted = compactRefImages(refImages, refSlots);
      updateCard(card.id, { data: { ...data, refImages: compacted } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard, refSlots],
  );

  const handleGenerate = useCallback(async () => {
    const prompt = buildFinalPrompt(data);
    if (!prompt || generating) return;

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

    try {
      const provider = providerManager.getDefault();
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

      const referenceImages: Array<{ url: string; role: string }> = [];
      for (const ref of rawRefImages) {
        if (
          ref.url.startsWith("data:") ||
          ref.url.startsWith("http://") ||
          ref.url.startsWith("https://")
        ) {
          referenceImages.push(ref);
        } else {
          console.log("[MediaEditor] 转换本地文件为 base64:", ref.url.slice(0, 80));
          const dataUrl = await readMediaBase64(ref.url);
          console.log("[MediaEditor] base64 转换结果长度:", dataUrl.length, "前缀:", dataUrl.slice(0, 40));
          referenceImages.push({ ...ref, url: dataUrl });
        }
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

      const result = await provider.generateImage({
        prompt,
        size: currentSize,
        model: currentModel || undefined,
        quality: "standard",
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
        onProgress: (p) => {
          setCardProgress(card.id, { percent: p.percent, label: p.label });
        },
      });

      console.log("[MediaEditor] 生成成功:", { resultUrl: result.url?.slice(0, 100), revisedPrompt: result.revisedPrompt?.slice(0, 100) });
      console.groupEnd();

      updateCard(card.id, {
        data: { ...data, imageUrl: result.url },
      });
      autoSave.markDirty(card.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[MediaEditor] 生成失败:", msg);
      console.groupEnd();
      setError(msg);
    } finally {
      setCardProgress(card.id, null);
    }
  }, [data, card.id, generating, updateCard, currentModel, currentSize, setCardProgress, refSlots]);

  const hasRefImages = refSlots.some((s) => data.refImages?.[s.key]);
  const isLocked = !!data._locked;

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
      {refSlots.length > 0 && (
        <div className="flex shrink-0 gap-2">
          {refSlots.map((slot, idx) => (
            <RefImageSlot
              key={slot.key}
              label={slot.label}
              description={slot.description}
              entry={data.refImages?.[slot.key]}
              onImage={(entry) => setRefImage(slot.key, entry)}
              onClear={() => clearRefImage(slot.key)}
              disabled={generating}
              targetCardId={card.id}
              slotKey={slot.key}
              index={idx}
            />
          ))}
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
            placeholder={hasUpstream ? "追加你的提示词（可选）…" : "描述你想生成的图片…"}
            disabled={generating}
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

      <div className="flex items-center gap-2">
        <ModelSelector
          capability="IMAGE"
          value={currentModel}
          onChange={handleModelChange}
        />
        {!isLocked && (
          <div className="flex shrink-0 items-center rounded-lg border border-border p-0.5">
            {IMAGE_SIZE_OPTIONS.map((opt) => {
              const active = currentSize === opt.value;
              const boxH = 12;
              const boxW = opt.ratio >= 1 ? boxH : Math.round(boxH * opt.ratio);
              const boxHFinal = opt.ratio >= 1 ? Math.round(boxH / opt.ratio) : boxH;
              return (
                <button
                  key={opt.value}
                  onClick={() => handleSizeChange(opt.value)}
                  disabled={generating}
                  title={opt.value}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    generating && "cursor-not-allowed opacity-40",
                  )}
                >
                  <span
                    className={cn(
                      "inline-block shrink-0 rounded-[2px] border",
                      active ? "border-primary-foreground/50" : "border-current/40",
                    )}
                    style={{ width: boxW, height: boxHFinal }}
                  />
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
        {hasRefImages && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            +参考图
          </span>
        )}
        {!isLocked && hasUpstream && (
          <button
            onClick={() => setShowPreview((v) => !v)}
            className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            title={showPreview ? "隐藏预览" : "预览最终提示词"}
          >
            {showPreview
              ? <><EyeOff className="h-3 w-3" />隐藏</>
              : <><Eye className="h-3 w-3" />预览</>
            }
          </button>
        )}
        {error && (
          <span className="min-w-0 truncate text-[11px] text-destructive">{error}</span>
        )}
        <div className="flex-1" />
        <button
          onClick={handleGenerate}
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
          ) : data.imageUrl ? (
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
