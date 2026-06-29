/**
 * P2「一键铺下游 ai_video 生产线」:把「帮我写」脚本(markdown)里的逐镜 Seedance 提示词
 * 铺成下游视频卡——每镜一张 ai_video,预填该镜中文视频提示词,并连上它引用的 @图N 源素材。
 *
 * 落卡/连线/持久化范式镜像 lib/templateFactory.ts(先 saveCardsBatch+saveConnections 落库,
 * 再 addCard + addConnections;批量加连线由 onConnectionsAdded 钩子自动把源图注入 refImages,
 * 无需手动 injectOnConnect)。@图N→源卡用 computeImageRefSources 同一口径(与喂模型的标签一致)。
 */

import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { CanvasCard, Connection } from "@/types";
import { saveCardsBatch, saveConnections } from "@/platform";
import { cardToRow, connectionToRow } from "@/lib/mappers";
import { CARD_DEFAULTS } from "@/shared/constants";
import { resolveDefaultModelForCardType } from "@/services/modelDefaults";
import { computeImageRefSources } from "@/hooks/useImageRefSources";
import { getRefSlotsForChatModel } from "@/config/model-ref-images";
import { parseSeedanceShots } from "@/lib/scriptShots";
import type { ScriptCardData } from "@/lib/scriptModel";

export interface SpawnVideoLineResult {
  shots: number;     // 解析出的镜头数
  created: number;   // 实际建出的视频卡数
  connected: number; // 连上的参考图/视频源条数
}

/** 帮我写卡的素材标签 → 源卡 id(图1/视频1 → sourceCardId),与喂模型的标签同口径。 */
function buildLabelToSource(scriptCard: CanvasCard): Map<string, string> {
  const d = scriptCard.data as ScriptCardData;
  const refSlots = getRefSlotsForChatModel((d.model ?? "").trim());
  const options = computeImageRefSources(scriptCard.id, refSlots, d.refImages, undefined, d.refVideos);
  const map = new Map<string, string>();
  for (const o of options) {
    let srcId: string | undefined;
    if (o.source.type === "upstream") {
      srcId = o.source.sourceCardId;
    } else if (o.source.type === "refSlot") {
      srcId = d.refImages?.[o.source.slotKey]?.sourceCardId;
    } else if (o.source.type === "videoSlot") {
      srcId = d.refVideos?.[o.source.index]?.sourceCardId;
    }
    if (srcId) map.set(o.label, srcId);
  }
  return map;
}

/**
 * 从一张已生成脚本的 ai_script 卡铺出下游 ai_video 生产线。
 * 解析不到逐镜(parseSeedanceShots 空)则返回 created:0,不建任何卡。
 */
export async function spawnVideoLineFromScript(scriptCard: CanvasCard): Promise<SpawnVideoLineResult> {
  const md = (scriptCard.data as ScriptCardData).result ?? "";
  const shots = parseSeedanceShots(md);
  if (shots.length === 0) return { shots: 0, created: 0, connected: 0 };

  const cardStore = useCardStore.getState();
  const connStore = useConnectionStore.getState();
  const projectId = scriptCard.projectId;
  const now = new Date().toISOString();

  const labelToSource = buildLabelToSource(scriptCard);
  const videoModel = await resolveDefaultModelForCardType("ai_video");

  const W = CARD_DEFAULTS.ai_video.width;
  const H = CARD_DEFAULTS.ai_video.height;
  const COLS = Math.min(Math.max(shots.length, 1), 4);
  const GAP_X = 24;
  const GAP_Y = 48;
  const startX = scriptCard.x;
  const startY = scriptCard.y + scriptCard.height + 56;

  // zIndex 用本地游标递增(maxZIndex 是快照,见 templateFactory 注释)。
  let z = cardStore.maxZIndex;
  const cards: CanvasCard[] = [];
  const connections: Connection[] = [];

  shots.forEach((shot, i) => {
    z += 1;
    const col = i % COLS;
    const row = Math.floor(i / COLS);

    const data: Record<string, unknown> = {
      _showLabel: true,
      content: shot.prompt,
      imageMode: "reference", // r2v:把源图当参考(商品一致性),连线后自动落 refImages
    };
    if (videoModel) {
      data.model = videoModel.modelId;
      data.provider = videoModel.providerId;
    }

    const card: CanvasCard = {
      id: crypto.randomUUID(),
      projectId,
      type: "ai_video",
      x: startX + col * (W + GAP_X),
      y: startY + row * (H + GAP_Y),
      width: W,
      height: H,
      zIndex: z,
      locked: false,
      collapsed: false,
      title: `镜头 ${shot.shotNo}`,
      data,
      createdAt: now,
      updatedAt: now,
    };
    cards.push(card);

    // 连每个被引用素材的源卡 → 本视频卡(addConnections 后自动注入参考图/视频)。
    const seen = new Set<string>();
    for (const ref of shot.refs) {
      const srcId = labelToSource.get(ref);
      if (srcId && !seen.has(srcId)) {
        seen.add(srcId);
        connections.push({
          id: crypto.randomUUID(),
          projectId,
          sourceCardId: srcId,
          targetCardId: card.id,
          createdAt: now,
        });
      }
    }
  });

  // 先落库(容错),再写 store —— 镜像 templateFactory。
  let persistError: unknown = null;
  if (cards.length > 0) {
    try {
      await saveCardsBatch(cards.map(cardToRow));
    } catch (e) {
      persistError = e;
      console.error("[帮我写·生产线] 卡片落库失败：", e);
    }
  }
  if (connections.length > 0) {
    try {
      await saveConnections(projectId, connections.map(connectionToRow));
    } catch (e) {
      persistError = persistError ?? e;
      console.error("[帮我写·生产线] 连接落库失败：", e);
    }
  }

  for (const c of cards) cardStore.addCard(c);
  connStore.addConnections(connections);

  if (persistError) throw persistError;

  return { shots: shots.length, created: cards.length, connected: connections.length };
}
