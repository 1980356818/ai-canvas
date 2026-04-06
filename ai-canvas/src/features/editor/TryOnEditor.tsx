import { useRef, useCallback, useState, useEffect } from "react";
import { Sparkles, Loader2, RefreshCw, Upload, X } from "lucide-react";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/lib/tauri";
import { modelService } from "@/services/models";
import { providerManager } from "@/stores/agentStore";
import { resolveImageUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import ModelSelector from "./ModelSelector";

interface TryOnData {
  content?: string;
  personImageUrl?: string;
  garmentImageUrl?: string;
  resultImageUrl?: string;
  model?: string;
}

interface TryOnEditorProps {
  card: CanvasCard;
}

function ImageDropZone({
  label,
  imageUrl,
  onImage,
  onClear,
  disabled,
}: {
  label: string;
  imageUrl?: string;
  onImage: (url: string) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [displayUrl, setDisplayUrl] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!imageUrl) {
      setDisplayUrl(undefined);
      return;
    }
    let stale = false;
    resolveImageUrl(imageUrl).then((url) => {
      if (!stale) setDisplayUrl(url);
    });
    return () => {
      stale = true;
    };
  }, [imageUrl]);

  const handleFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") onImage(reader.result);
      };
      reader.readAsDataURL(file);
    },
    [onImage],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const file = Array.from(e.clipboardData.items)
        .find((i) => i.type.startsWith("image/"))
        ?.getAsFile();
      if (file) {
        e.preventDefault();
        handleFile(file);
      }
    },
    [handleFile],
  );

  if (displayUrl) {
    return (
      <div className="relative flex-1 overflow-hidden rounded-lg border border-input">
        <img
          src={displayUrl}
          alt={label}
          className="h-full w-full object-cover"
        />
        {!disabled && (
          <button
            onClick={onClear}
            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        <span className="absolute bottom-1 left-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
          {label}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-input p-2 text-muted-foreground transition-colors",
        dragging && "border-primary bg-primary/5",
        !disabled && "hover:border-primary/50 hover:text-foreground",
      )}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onPaste={onPaste}
      tabIndex={0}
    >
      <Upload className="h-4 w-4" />
      <span className="text-[10px]">{label}</span>
      <span className="text-[9px] text-muted-foreground/60">
        点击上传或拖拽
      </span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export default function TryOnEditor({ card }: TryOnEditorProps) {
  const updateCard = useCardStore((s) => s.updateCard);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore((s) => s.generatingCards.has(card.id));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [currentModel, setCurrentModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const data = card.data as TryOnData;

  useEffect(() => {
    if (data.model) {
      setCurrentModel(data.model);
    } else {
      modelService.getDefaultImageModel().then(setCurrentModel);
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

  const setPersonImage = useCallback(
    (url: string) => {
      updateCard(card.id, { data: { ...data, personImageUrl: url } });
      autoSave.markDirty(card.id);
    },
    [card.id, data, updateCard],
  );

  const setGarmentImage = useCallback(
    (url: string) => {
      updateCard(card.id, { data: { ...data, garmentImageUrl: url } });
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

    const parts: string[] = [];
    if (data.content?.trim()) parts.push(data.content.trim());
    else parts.push("将服装穿在人物身上，保持人物姿态和背景不变");

    if (!data.personImageUrl && !data.garmentImageUrl) {
      setError("请至少上传一张图片");
      return;
    }

    const prompt = `AI虚拟换装: ${parts.join("。")}`;

    setCardProgress(card.id, { percent: 0, label: "正在提交请求…" });
    setError(null);

    try {
      const provider = providerManager.getDefault();
      if (!provider.generateImage) {
        throw new Error("当前 Provider 不支持图片生成");
      }

      const result = await provider.generateImage({
        prompt,
        size: "1024x1024",
        model: currentModel || undefined,
        quality: "standard",
        onProgress: (p) => {
          setCardProgress(card.id, { percent: p.percent, label: p.label });
        },
      });

      updateCard(card.id, { data: { ...data, resultImageUrl: result.url } });
      autoSave.markDirty(card.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setCardProgress(card.id, null);
    }
  }, [data, card.id, generating, updateCard, currentModel, setCardProgress]);

  const canGenerate = !generating && (data.personImageUrl || data.garmentImageUrl);

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex min-h-0 flex-1 gap-2">
        <ImageDropZone
          label="人物照片"
          imageUrl={data.personImageUrl}
          onImage={setPersonImage}
          onClear={() => {
            updateCard(card.id, {
              data: { ...data, personImageUrl: undefined },
            });
            autoSave.markDirty(card.id);
          }}
          disabled={generating}
        />
        <ImageDropZone
          label="服装图片"
          imageUrl={data.garmentImageUrl}
          onImage={setGarmentImage}
          onClear={() => {
            updateCard(card.id, {
              data: { ...data, garmentImageUrl: undefined },
            });
            autoSave.markDirty(card.id);
          }}
          disabled={generating}
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

      <div className="flex items-center gap-2">
        <ModelSelector
          capability="IMAGE"
          value={currentModel}
          onChange={handleModelChange}
        />
        {error && (
          <span className="min-w-0 truncate text-[11px] text-destructive">
            {error}
          </span>
        )}
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
