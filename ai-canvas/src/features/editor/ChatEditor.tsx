import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Sparkles, RefreshCw, Loader2, Lock } from "lucide-react";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useConnectionStore, type Connection } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey, aiProxy } from "@/lib/tauri";
import { getBase64ForApi } from "@/lib/media";
import { modelService } from "@/services/models";
import { cn } from "@/lib/utils";
import {
  getRefSlotsForChatModel,
  modelSupportsVision,
  compactRefImages,
  type RefImageEntry,
} from "@/config/model-ref-images";
import ModelSelector from "./ModelSelector";
import RefImageSlot from "./RefImageSlot";

interface ChatData {
  content?: string;
  result?: string;
  model?: string;
  refImages?: Record<string, RefImageEntry>;
  _locked?: boolean;
  _systemPrompt?: string;
  _label?: string;
  _description?: string;
}

function friendlyError(raw: string): string {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const msg = obj.message || obj.error?.message;
      if (msg) return msg;
    } catch { /* use raw */ }
  }
  return raw;
}

export default function ChatEditor({ card }: { card: CanvasCard }) {
  const updateCard = useCardStore((s) => s.updateCard);
  const setCardProgress = useUIStore((s) => s.setCardProgress);
  const generating = useUIStore((s) => s.generatingCards.has(card.id));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [currentModel, setCurrentModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const data = card.data as ChatData;

  useEffect(() => {
    if (data.model) {
      setCurrentModel(data.model);
    } else {
      modelService.getDefaultChatModel().then(setCurrentModel);
    }
  }, [data.model]);

  const refSlots = useMemo(() => {
    const slots = getRefSlotsForChatModel(currentModel);
    if (data._locked && slots.length === 0) {
      return getRefSlotsForChatModel("");
    }
    return slots;
  }, [currentModel, data._locked]);

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

    setCardProgress(card.id, { percent: 0, label: "正在生成…" });
    setError(null);

    const model = currentModel || "deepseek-v3.2";

    const imageEntries = refSlots
      .map((slot) => data.refImages?.[slot.key])
      .filter((e): e is RefImageEntry => !!e);

    let resolvedImageUrls: string[] = [];
    if (modelSupportsVision(model)) {
      for (const img of imageEntries) {
        const dataUrl = await getBase64ForApi(img.url);
        resolvedImageUrls.push(dataUrl);
      }
    } else if (imageEntries.length > 0) {
      useUIStore.getState().addToast({
        type: "warning",
        title: "当前模型不支持图片输入",
        description: `${model} 不支持视觉能力，已忽略参考图。`,
        duration: 5000,
      });
    }

    type ContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } };

    const userContent: ContentPart[] = [];
    for (const url of resolvedImageUrls) {
      userContent.push({ type: "image_url", image_url: { url } });
    }
    userContent.push({ type: "text", text: prompt });

    const systemPrompt = data._systemPrompt || "你是一个有帮助的 AI 助手，请用中文回复。请直接回答用户的问题。";
    const apiMessages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: resolvedImageUrls.length > 0 ? userContent : prompt,
      },
    ];

    try {
      const resp = await aiProxy("openai", "/v1/chat/completions", {
        model,
        messages: apiMessages,
        max_tokens: 4096,
      });

      if (resp.status >= 400) {
        console.error(`[ChatEditor] AI 请求失败 (HTTP ${resp.status}):`, resp.body.slice(0, 1000));
        setError(friendlyError(resp.body));
        setCardProgress(card.id, null);
        return;
      }

      const json = JSON.parse(resp.body);
      const result =
        json?.choices?.[0]?.message?.content ??
        "（无回复 — 模型未返回任何内容）";

      useCardStore.getState().updateCard(card.id, {
        data: { ...data, result },
      });
      autoSave.markDirty(card.id);
    } catch (err) {
      console.error("[ChatEditor] AI 请求异常:", err);
      const msg = err instanceof Error ? err.message : String(err);
      setError(friendlyError(msg));
    } finally {
      setCardProgress(card.id, null);
    }
  }, [data, card.id, generating, updateCard, currentModel, setCardProgress, refSlots]);

  const hasRefImages = refSlots.some((s) => data.refImages?.[s.key]);
  const isLocked = !!data._locked;

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
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{data._label || "模板分析节点"}</p>
            {data._description && (
              <p className="text-[11px] text-muted-foreground">{data._description}</p>
            )}
          </div>
        </div>
      ) : (
        <textarea
          className="min-h-[3rem] flex-1 resize-none rounded-lg border border-input bg-background px-3 py-1.5 text-sm leading-relaxed text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
          value={data.content ?? ""}
          onChange={onPromptChange}
          placeholder="输入提示词，生成文字内容…"
          disabled={generating}
        />
      )}

      <div className="flex items-center gap-2">
        <ModelSelector
          capability="CHAT"
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
            (generating || !data.content?.trim()) && "cursor-not-allowed opacity-40",
          )}
        >
          {generating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {isLocked ? "分析中…" : "生成中…"}
            </>
          ) : data.result ? (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              {isLocked ? "重新分析" : "重新生成"}
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              {isLocked ? "分析" : "生成"}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
