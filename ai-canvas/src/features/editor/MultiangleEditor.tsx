import { useCallback, useRef, useState } from "react";
import { Sparkles, Loader2, RefreshCw, ImageIcon } from "lucide-react";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/lib/tauri";
import { getBase64ForApi } from "@/lib/media";
import { providerManager } from "@/stores/agentStore";
import { cn } from "@/lib/utils";
import {
  compactRefImages,
  type RefImageEntry,
} from "@/config/model-ref-images";
import { useConnectionStore, type Connection } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import RefImageSlot from "./RefImageSlot";

const MODEL_ID = "qwen-image-edit-2511-multipie";

const ANGLE_PARAMS = [
  { key: "h", label: "水平角度", min: 0, max: 360, step: 5, unit: "°", description: "0=正面，逆时针环绕" },
  { key: "v", label: "垂直角度", min: -30, max: 60, step: 5, unit: "°", description: "0=平视" },
  { key: "z", label: "镜头距离", min: 0, max: 10, step: 1, unit: "", description: "0=超远景 4=中景 10=特写" },
] as const;

const REF_SLOTS = [
  { key: "refImage0", label: "参考图", description: "需要转换角度的图片", required: true },
];

interface MultiangleData {
  content?: string;
  imageUrl?: string;
  model?: string;
  size?: string;
  refImages?: Record<string, RefImageEntry>;
  h?: number;
  v?: number;
  z?: number;
}

function buildPrompt(h: number, v: number, z: number): string {
  return `h:${h},v:${v},z:${z}`;
}

export default function MultiangleEditor({ card }: { card: CanvasCard }) {
  const updateCard = useCardStore((s) => s.updateCard);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore((s) => s.generatingCards.has(card.id));
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const data = card.data as MultiangleData;
  const h = data.h ?? 0;
  const v = data.v ?? 0;
  const z = data.z ?? 4;
  const hasRef = !!data.refImages?.refImage0;
  const canGenerate = hasRef;

  const handleAngleChange = useCallback(
    (key: string, value: number) => {
      const newData = { ...data, [key]: value };
      newData.content = buildPrompt(
        key === "h" ? value : h,
        key === "v" ? value : v,
        key === "z" ? value : z,
      );
      newData.model = MODEL_ID;
      updateCard(card.id, { data: newData });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, data, h, v, z, updateCard],
  );

  const setRefImage = useCallback(
    (slotKey: string, entry: RefImageEntry) => {
      const refImages = { ...data.refImages, [slotKey]: entry };
      updateCard(card.id, { data: { ...data, refImages, model: MODEL_ID } });
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
      const compacted = compactRefImages(refImages, REF_SLOTS);
      updateCard(card.id, { data: { ...data, refImages: compacted } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const handleGenerate = useCallback(async () => {
    if (!canGenerate || generating) return;

    const prompt = buildPrompt(h, v, z);

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

      const rawRef = data.refImages?.refImage0;
      if (!rawRef) throw new Error("请先添加参考图");

      const dataUrl = await getBase64ForApi(rawRef.url);
      const referenceImages = [{ url: dataUrl, role: "refImage0" }];

      const result = await provider.generateImage({
        prompt,
        size: data.size || "1:1",
        model: MODEL_ID,
        quality: "standard",
        referenceImages,
        onProgress: (p) => {
          setCardProgress(card.id, { percent: p.percent, label: p.label });
        },
      });

      updateCard(card.id, {
        data: { ...data, imageUrl: result.url, content: prompt, model: MODEL_ID },
      });
      autoSave.markDirty(card.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setCardProgress(card.id, null);
    }
  }, [data, card.id, h, v, z, generating, canGenerate, updateCard, setCardProgress]);

  return (
    <div className="flex h-full flex-col gap-2.5 p-3">
      <div className="flex shrink-0 gap-2">
        {REF_SLOTS.map((slot, idx) => (
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
        {!hasRef && (
          <div className="flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
            <ImageIcon className="h-3.5 w-3.5" />
            需要先添加参考图才能生成
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2.5">
        {ANGLE_PARAMS.map((param) => {
          const val = param.key === "h" ? h : param.key === "v" ? v : z;
          return (
            <div key={param.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between">
                <label className="text-xs font-medium text-foreground">
                  {param.label}
                </label>
                <span className="tabular-nums text-xs text-primary">
                  {val}{param.unit}
                </span>
              </div>
              <input
                type="range"
                min={param.min}
                max={param.max}
                step={param.step}
                value={val}
                onChange={(e) => handleAngleChange(param.key, Number(e.target.value))}
                disabled={generating}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:cursor-not-allowed disabled:opacity-40"
              />
              <span className="text-[10px] text-muted-foreground">{param.description}</span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          通义多角度
        </span>
        <span className="text-[10px] text-muted-foreground">
          {buildPrompt(h, v, z)}
        </span>
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
