import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, RefreshCw, AlertCircle, X } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { useUIStore, selectCardBusy } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";
import { modelService } from "@/services/models";
import { resolveDefaultModelForCardType } from "@/services/modelDefaults";
import { buildTryonRequest } from "@/services/generation/buildTryonRequest";
import { runEditorGeneration } from "@/services/generation/runEditorGeneration";
import { cn } from "@/lib/utils";
import { isStandardImageModel, type RefImageEntry } from "@/config/model-ref-images";
import ModelSelector from "./ModelSelector";
import RefImageSlot from "./RefImageSlot";

interface TryOnData {
  content?: string;
  personImageUrl?: string;
  garmentImageUrl?: string;
  resultImageUrl?: string;
  model?: string;
  provider?: string;
  refImages?: Record<string, RefImageEntry>;
}

interface TryOnEditorProps {
  card: CanvasCard;
}

export default function TryOnEditor({ card }: TryOnEditorProps) {
  const updateCard = useCardStore((s) => s.updateCard);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore(selectCardBusy(card.id));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [currentModel, setCurrentModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const data = card.data as TryOnData;

  const standardImageFilter = useMemo(
    () => (m: { id: string }) => isStandardImageModel(m.id),
    [],
  );

  useEffect(() => {
    if (data.model && data.provider) {
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

  const handleModelChange = useCallback(
    (modelId: string, providerId: string) => {
      setCurrentModel(modelId);
      updateCard(card.id, { data: { ...data, model: modelId, provider: providerId } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const personEntry: RefImageEntry | undefined = data.personImageUrl
    ? (data.refImages?.person ?? { url: data.personImageUrl, sourceType: "file" })
    : data.refImages?.person;

  const garmentEntry: RefImageEntry | undefined = data.garmentImageUrl
    ? (data.refImages?.garment ?? { url: data.garmentImageUrl, sourceType: "file" })
    : data.refImages?.garment;

  const setPersonImage = useCallback(
    (entry: RefImageEntry) => {
      const refImages = { ...data.refImages, person: entry };
      updateCard(card.id, {
        data: { ...data, personImageUrl: entry.url, refImages },
      });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const setGarmentImage = useCallback(
    (entry: RefImageEntry) => {
      const refImages = { ...data.refImages, garment: entry };
      updateCard(card.id, {
        data: { ...data, garmentImageUrl: entry.url, refImages },
      });
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

  const handleGenerate = useCallback(async () => {
    if (generating) return;
    // 十步骨架(API Key 预检 / 进度开关 / 错误兜底)统一走 runEditorGeneration。
    await runEditorGeneration(card, {
      setError,
      run: async () => {
        // 翻译逻辑(模特换装 prompt 前缀 / person·garment 参考图收集上传)统一走 buildTryonRequest,
        // 与 cardRunner 组运行共用同一份 —— 修复旧手点根本不发参考图的 bug。
        const built = await buildTryonRequest(card, {
          onUploadProgress: (kind, { uploaded, total }) =>
            setCardProgress(card.id, {
              percent: 0,
              label: `上传${kind} ${uploaded}/${total}…`,
            }),
        });
        if (!built.ok) {
          // 缺图等约束 → 置 error 态(与旧行为一致,不弹 toast)。
          setError(built.reason);
          useUIStore.getState().setCardError(card.id, built.reason);
          return;
        }

        const provider = modelService.resolveProvider(built.modelId, built.providerId);
        if (!provider.generateImage) {
          throw new Error("当前 Provider 不支持图片生成");
        }

        const result = await provider.generateImage({
          ...built.request,
          onProgress: (p) => {
            setCardProgress(card.id, { percent: p.percent, label: p.label });
          },
        });

        updateCard(card.id, { data: { ...data, resultImageUrl: result.url } });
        autoSave.markDirty(card.id);
        useUIStore.getState().addToast({
          type: "success",
          title: "换装完成",
          description: "模特换装已完成",
          duration: 3000,
        });
      },
    });
  }, [data, card, generating, updateCard, setCardProgress]);

  const canGenerate = !generating && (data.personImageUrl || data.garmentImageUrl);

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex min-h-0 flex-1 gap-2">
        <RefImageSlot
          label="人物照片"
          description="上传人物图或拖入卡片"
          entry={personEntry}
          onImage={setPersonImage}
          onClear={() => {
            const refImages = { ...data.refImages };
            delete refImages.person;
            updateCard(card.id, {
              data: { ...data, personImageUrl: undefined, refImages },
            });
            autoSave.markDirty(card.id);
          }}
          disabled={generating}
          targetCardId={card.id}
          slotKey="person"
        />
        <RefImageSlot
          label="服装图片"
          description="上传服装图或拖入卡片"
          entry={garmentEntry}
          onImage={setGarmentImage}
          onClear={() => {
            const refImages = { ...data.refImages };
            delete refImages.garment;
            updateCard(card.id, {
              data: { ...data, garmentImageUrl: undefined, refImages },
            });
            autoSave.markDirty(card.id);
          }}
          disabled={generating}
          targetCardId={card.id}
          slotKey="garment"
        />
      </div>

      <textarea
        className="h-10 shrink-0 resize-none rounded-lg border border-input bg-background px-3 py-1.5 text-xs leading-relaxed text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
        value={data.content ?? ""}
        onChange={onPromptChange}
        placeholder="换装要求（可选）…"
        disabled={generating}
        rows={1}
      />

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
          capability="IMAGE"
          value={currentModel}
          providerId={data.provider}
          onChange={handleModelChange}
          filter={standardImageFilter}
        />
        <div className="flex-1" />
        <button
          onClick={handleGenerate}
          disabled={!canGenerate}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            !canGenerate && "cursor-not-allowed opacity-40",
          )}
        >
          {generating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              换装中
            </>
          ) : data.resultImageUrl ? (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              重新换装
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              换装
            </>
          )}
        </button>
      </div>
    </div>
  );
}
