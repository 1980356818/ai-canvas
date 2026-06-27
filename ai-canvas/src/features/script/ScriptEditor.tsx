import { useState, useEffect, useCallback } from "react";
import { Clapperboard, ImageIcon, Video, FileText, Sparkles, CheckCircle2 } from "lucide-react";
import type { CanvasCard } from "@/types";
import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { modelService } from "@/services/models";
import { resolveDefaultModelForCardType } from "@/services/modelDefaults";
import ModelSelector from "@/features/editor/ModelSelector";
import type { ScriptCardData } from "@/lib/scriptModel";

function countImages(data: ScriptCardData): number {
  const refs = data.refImages ? Object.keys(data.refImages).length : 0;
  const direct = (data.directMedia ?? []).filter((m) => m.kind === "image").length;
  return refs + direct;
}

/**
 * 「帮我写」浮动编辑器(双击卡片打开)。紧凑视图:选视觉模型 + 看已连素材 + 打开向导。
 * 真正的三步流程在全屏 ScriptWizard 里。
 */
export default function ScriptEditor({ card }: { card: CanvasCard }) {
  const data = card.data as ScriptCardData;
  const updateCardData = useCardStore((s) => s.updateCardData);
  const openWizard = useUIStore((s) => s.openScriptWizard);
  const [currentModel, setCurrentModel] = useState(data.model ?? "");

  // 默认模型解析(与 ChatEditor 同口径):空 model 时按 ai_script→chat 兜底并写回。
  useEffect(() => {
    if (data.model) {
      setCurrentModel(data.model);
      if (!data.provider) {
        const p = modelService.tryResolveProvider(data.model);
        if (p) updateCardData(card.id, { provider: p.descriptor.id });
      }
      return;
    }
    let cancelled = false;
    resolveDefaultModelForCardType(card.type).then((ref) => {
      if (cancelled || !ref) return;
      setCurrentModel(ref.modelId);
      updateCardData(card.id, { model: ref.modelId, provider: ref.providerId });
    });
    return () => {
      cancelled = true;
    };
  }, [data.model, data.provider, card.id, card.type, updateCardData]);

  const handleModelChange = useCallback(
    (modelId: string, providerId: string) => {
      setCurrentModel(modelId);
      updateCardData(card.id, { model: modelId, provider: providerId });
      autoSave.markDirty(card.id);
      useSettingsStore.getState().setLastModel("chat", modelId, providerId);
    },
    [card.id, updateCardData],
  );

  const imgCount = countImages(data);
  const vidCount = data.refVideos?.length ?? 0;
  const txtCount = data.upstreamTexts ? Object.keys(data.upstreamTexts).length : 0;
  const hasMaterial = imgCount + vidCount + txtCount > 0;

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Clapperboard className="h-4 w-4" />
        帮我写 · 分析素材写分镜脚本
      </div>

      <div>
        <div className="mb-1 text-[11px] text-muted-foreground">分析模型(需视觉)</div>
        <ModelSelector
          capability="CHAT"
          value={currentModel}
          providerId={data.provider}
          onChange={handleModelChange}
        />
      </div>

      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2.5">
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">已连入素材</div>
        <div className="flex flex-wrap gap-3 text-[11px] text-foreground/80">
          <span className="flex items-center gap-1">
            <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" /> 图片 {imgCount}
          </span>
          <span className="flex items-center gap-1">
            <Video className="h-3.5 w-3.5 text-muted-foreground" /> 视频 {vidCount}
          </span>
          <span className="flex items-center gap-1">
            <FileText className="h-3.5 w-3.5 text-muted-foreground" /> 文本 {txtCount}
          </span>
        </div>
        {!hasMaterial && (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            把图片/视频卡片连到本卡，作为分析素材。
          </p>
        )}
      </div>

      {data.result && (
        <div className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          已生成分镜脚本，可在向导中查看或重新生成
        </div>
      )}

      <div className="flex-1" />

      <button
        onClick={() => openWizard(card.id)}
        disabled={!hasMaterial}
        className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Sparkles className="h-4 w-4" />
        {data.result ? "重新打开「帮我写」" : "开始「帮我写」"}
      </button>
    </div>
  );
}
