import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, RefreshCw } from "lucide-react";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/lib/tauri";
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
import ModelSelector from "./ModelSelector";
import RefImageSlot from "./RefImageSlot";

interface MediaData {
  content?: string;
  imageUrl?: string;
  model?: string;
  refImages?: Record<string, RefImageEntry>;
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
  const [error, setError] = useState<string | null>(null);
  const data = card.data as MediaData;

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

  const onPromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const content = e.target.value;
      updateCard(card.id, { data: { ...data, content } });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, data, updateCard],
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
    const prompt = data.content?.trim();
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

    try {
      const provider = providerManager.getDefault();
      if (!provider.generateImage) {
        throw new Error("当前 Provider 不支持图片生成");
      }

      const referenceImages = refSlots
        .map((slot) => {
          const entry = data.refImages?.[slot.key];
          return entry ? { url: entry.url, role: slot.key } : null;
        })
        .filter(Boolean) as Array<{ url: string; role: string }>;

      const result = await provider.generateImage({
        prompt,
        size: "1024x1024",
        model: currentModel || undefined,
        quality: "standard",
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
        onProgress: (p) => {
          setCardProgress(card.id, { percent: p.percent, label: p.label });
        },
      });

      updateCard(card.id, {
        data: { ...data, imageUrl: result.url },
      });
      autoSave.markDirty(card.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setCardProgress(card.id, null);
    }
  }, [data, card.id, generating, updateCard, currentModel, setCardProgress, refSlots]);

  const hasRefImages = refSlots.some((s) => data.refImages?.[s.key]);

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

      <textarea
        className="min-h-[3rem] flex-1 resize-none rounded-lg border border-input bg-background px-3 py-1.5 text-sm leading-relaxed text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
        value={data.content ?? ""}
        onChange={onPromptChange}
        placeholder="描述你想生成的图片…"
        disabled={generating}
        autoFocus
      />

      <div className="flex items-center gap-2">
        <ModelSelector
          capability="IMAGE"
          value={currentModel}
          onChange={handleModelChange}
        />
        {hasRefImages && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            +参考图
          </span>
        )}
        {error && (
          <span className="min-w-0 truncate text-[11px] text-destructive">{error}</span>
        )}
        <div className="flex-1" />
        <button
          onClick={handleGenerate}
          disabled={generating || !data.content?.trim()}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            (generating || !data.content?.trim()) &&
              "cursor-not-allowed opacity-40",
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
