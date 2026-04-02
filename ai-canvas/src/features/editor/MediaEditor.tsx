import { useRef, useCallback, useState, useEffect } from "react";
import { ImageIcon, Sparkles, Loader2, X, RefreshCw, Maximize2 } from "lucide-react";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/lib/tauri";
import { modelService } from "@/services/models";
import { providerManager } from "@/stores/agentStore";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import ModelSelector from "./ModelSelector";

interface MediaData {
  content?: string;
  imageUrl?: string;
  model?: string;
}

interface MediaEditorProps {
  card: CanvasCard;
}

export default function MediaEditor({ card }: MediaEditorProps) {
  const updateCard = useCardStore((s) => s.updateCard);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState("");
  const data = card.data as MediaData;

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

  const onPromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const content = e.target.value;
      updateCard(card.id, { data: { ...data, content } });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, data, updateCard],
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

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

    setGenerating(true);
    setProgress(0);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

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
      });

      if (controller.signal.aborted) return;

      updateCard(card.id, {
        data: { ...data, imageUrl: result.url },
      });
      autoSave.markDirty(card.id);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setGenerating(false);
      setProgress(0);
      abortRef.current = null;
    }
  }, [data, card.id, generating, updateCard, currentModel]);

  const [fullscreen, setFullscreen] = useState(false);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">
            图片生成
          </span>
        </div>
        <ModelSelector
          capability="IMAGE"
          value={currentModel}
          onChange={handleModelChange}
        />
      </div>

      {data.imageUrl && (
        <div className="group/img relative shrink-0 overflow-hidden rounded-lg border border-border">
          <img
            src={data.imageUrl}
            alt=""
            className="max-h-[240px] w-full object-contain bg-muted/30"
          />
          <button
            onClick={() => setFullscreen(true)}
            className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground group-hover/img:opacity-100"
            title="查看大图"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <textarea
        className={cn(
          "resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1",
          data.imageUrl ? "h-20 shrink-0" : "flex-1",
        )}
        value={data.content ?? ""}
        onChange={onPromptChange}
        placeholder="描述你想生成的图片，例如「产品展示图，白色背景，极简风格」..."
        disabled={generating}
        autoFocus={!data.imageUrl}
      />

      {error && (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {generating && progress > 0 && (
        <div className="space-y-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-right text-[10px] text-muted-foreground">
            {progress}%
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={generating ? handleCancel : handleGenerate}
          disabled={!generating && !data.content?.trim()}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
            generating
              ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
              : "bg-primary text-primary-foreground hover:bg-primary/90",
            !generating &&
              !data.content?.trim() &&
              "cursor-not-allowed opacity-40",
          )}
        >
          {generating ? (
            <>
              <X className="h-3.5 w-3.5" />
              取消
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
        {generating && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {fullscreen && data.imageUrl && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setFullscreen(false)}
        >
          <img
            src={data.imageUrl}
            alt=""
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setFullscreen(false)}
            className="absolute top-4 right-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}
