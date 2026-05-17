import { useCallback, useRef, useState } from "react";
import { Sparkles, Loader2, RefreshCw, ImageIcon, X, AlertCircle } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, Connection } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/platform";
import { getBase64ForApi, getDisplayUrl } from "@/lib/media";
import { modelService } from "@/services/models";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import {
  compactRefImages,
  type RefImageEntry,
} from "@/config/model-ref-images";
import { useConnectionStore } from "@/stores/connectionStore";
import { disconnectCardPairAndCleanup } from "@/lib/referenceConsistency";
import { IMAGE_SIZE_OPTIONS, sizeFromRatio, normalizeImageSize } from "@/shared/constants";
import SizeCombo from "./SizeCombo";

const MULTIANGLE_MODEL_ID = "qwen-image-edit-2511-multipie";

const ANGLE_PARAMS = [
  { key: "h", label: "水平角度", min: 0, max: 360, step: 5, unit: "°", description: "0°正面 90°右侧 180°背面 270°左侧" },
  { key: "v", label: "垂直角度", min: -30, max: 90, step: 5, unit: "°", description: "-30°仰拍 0°平视 60°俯拍 90°鸟瞰" },
  { key: "z", label: "镜头距离", min: 0, max: 10, step: 1, unit: "", description: "0=远景 5=中景 10=特写" },
] as const;

const REF_SLOTS = [
  { key: "refImage0", label: "参考图", description: "需要转换角度的图片", required: true },
];

interface MultiangleData {
  content?: string;
  imageUrl?: string;
  model?: string;
  provider?: string;
  size?: string;
  resolution?: string;
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
  const updateCardData = useCardStore((s) => s.updateCardData);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore((s) => s.generatingCards.has(card.id));
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const data = card.data as MultiangleData;
  const h = data.h ?? 0;
  const v = data.v ?? 0;
  const z = data.z ?? 5;
  const hasRef = !!data.refImages?.refImage0;
  const canGenerate = hasRef;
  const [currentSize, setCurrentSize] = useState(
    () => normalizeImageSize(data.size) || useSettingsStore.getState().lastImageSize,
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

  const handleAngleChange = useCallback(
    (key: string, value: number) => {
      const newData = { ...data, [key]: value };
      newData.content = buildPrompt(
        key === "h" ? value : h,
        key === "v" ? value : v,
        key === "z" ? value : z,
      );
      newData.model = MULTIANGLE_MODEL_ID;
      updateCard(card.id, { data: newData });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, data, h, v, z, updateCard],
  );

  const setRefImage = useCallback(
    (slotKey: string, entry: RefImageEntry) => {
      const refImages = { ...data.refImages, [slotKey]: entry };
      updateCard(card.id, { data: { ...data, refImages, model: MULTIANGLE_MODEL_ID } });
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
        // The lifecycle hook strips the slot synchronously when the
        // connection is removed. We then read the latest data and compact.
        disconnectCardPairAndCleanup(entry.sourceCardId, card.id, { markDirty: false });
      }
      const latest = useCardStore.getState().getCard(card.id)?.data as MultiangleData | undefined;
      const refImages = { ...(latest?.refImages ?? {}) };
      delete refImages[slotKey];
      const compacted = compactRefImages(refImages, REF_SLOTS);
      updateCardData(card.id, {
        refImages: Object.keys(compacted).length > 0 ? compacted : undefined,
      });
      autoSave.markDirty(card.id);
    },
    [card.id, data.refImages, updateCardData],
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
    useUIStore.getState().setCardError(card.id, null);

    try {
      const provider = modelService.resolveProvider(MULTIANGLE_MODEL_ID, (data as MultiangleData).provider);
      if (!provider.generateImage) {
        throw new Error("当前 Provider 不支持图片生成");
      }

      const rawRef = data.refImages?.refImage0;
      if (!rawRef) throw new Error("请先添加参考图");

      const dataUrl = await getBase64ForApi(rawRef.url);
      const referenceImages = [{ url: dataUrl, role: "refImage0" }];

      const result = await provider.generateImage({
        prompt,
        size: currentSize,
        model: MULTIANGLE_MODEL_ID,
        quality: "standard",
        referenceImages,
        cardId: card.id,
        projectId: card.projectId,
        onProgress: (p) => {
          setCardProgress(card.id, { percent: p.percent, label: p.label });
        },
      });

      updateCard(card.id, {
        data: { ...data, imageUrl: result.url, content: prompt, model: MULTIANGLE_MODEL_ID },
      });
      autoSave.markDirty(card.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMsg = friendlyError(msg);
      setError(errMsg);
      useUIStore.getState().setCardError(card.id, errMsg);
    } finally {
      setCardProgress(card.id, null);
    }
  }, [data, card.id, h, v, z, generating, canGenerate, updateCard, setCardProgress, currentSize]);

  const inputRef = useRef<HTMLInputElement>(null);
  const handleFile = useCallback(
    async (rawFile: File) => {
      if (!rawFile.type.startsWith("image/")) return;
      const { ensureDisplayableImage } = await import("@/lib/heicConverter");
      const file = await ensureDisplayableImage(rawFile);
      const { persistImage } = await import("@/lib/media");
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      const { localPath } = await persistImage(dataUrl, undefined, card.projectId);
      setRefImage("refImage0", { url: localPath, sourceType: "file" });
    },
    [setRefImage, card.projectId],
  );

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex shrink-0 items-center gap-2">
        {hasRef ? (
          <>
            <div
              data-ref-slot
              className="relative h-8 w-8 shrink-0 overflow-hidden rounded border border-input"
            >
              <img
                src={getDisplayUrl(data.refImages!.refImage0!.url)}
                alt="参考图"
                className="h-full w-full object-cover"
              />
            </div>
            <span className="text-xs text-muted-foreground">参考图已设置</span>
            <button
              onClick={() => clearRefImage("refImage0")}
              disabled={generating}
              className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => inputRef.current?.click()}
              disabled={generating}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-input px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-40"
            >
              <ImageIcon className="h-3.5 w-3.5" />
              上传参考图
            </button>
            <span className="text-[11px] text-muted-foreground">需要先添加参考图</span>
            <input
              ref={inputRef}
              type="file"
              accept="image/*,.heic,.heif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        {ANGLE_PARAMS.map((param) => {
          const val = param.key === "h" ? h : param.key === "v" ? v : z;
          return (
            <div key={param.key} className="flex items-center gap-2">
              <label
                className="w-[4.5rem] shrink-0 text-xs font-medium text-foreground"
                title={param.description}
              >
                {param.label}
              </label>
              <input
                type="range"
                min={param.min}
                max={param.max}
                step={param.step}
                value={val}
                onChange={(e) => handleAngleChange(param.key, Number(e.target.value))}
                disabled={generating}
                className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:cursor-not-allowed disabled:opacity-40"
              />
              <span className="w-8 shrink-0 text-right tabular-nums text-xs text-primary">
                {val}{param.unit}
              </span>
            </div>
          );
        })}
      </div>

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
        <SizeCombo
          value={currentSize}
          onChange={handleSizeChange}
          disabled={generating}
        />
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
