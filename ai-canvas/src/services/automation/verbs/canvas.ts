/** 画布动词:快照。读 store 当前状态,遵守黑箱(封装卡不吐明文提示词)。 */

import type { VerbDefinition } from "../types";
import type { CanvasCard } from "@/types";
import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { isCloaked } from "@/lib/promptCloak";
import { resolveAndOpenProject } from "../projectGateway";

/** 单卡紧凑摘要。`content` 字段:封装卡返回 "[已封装]" + cloaked:true,绝不吐明文。 */
function toCardSummary(card: CanvasCard) {
  const data = (card.data ?? {}) as Record<string, unknown>;
  const rawContent = typeof data.content === "string" ? data.content : "";
  const cloaked = isCloaked(rawContent);
  const hasResult = Boolean(
    data.imageUrl ||
      data.videoUrl ||
      data.result ||
      (Array.isArray(data.results) && data.results.length > 0),
  );
  return {
    id: card.id,
    type: card.type,
    title: card.title ?? null,
    x: Math.round(card.x),
    y: Math.round(card.y),
    width: card.width,
    height: card.height,
    prompt: cloaked ? "[已封装]" : rawContent.slice(0, 300),
    cloaked,
    hasResult,
    model: typeof data.model === "string" ? data.model : undefined,
    size: typeof data.size === "string" ? data.size : undefined,
  };
}

const canvasSnapshot: VerbDefinition = {
  name: "canvas.snapshot",
  description:
    "返回当前(或指定)项目画布上所有卡片与连线的紧凑快照,用于了解画布现状、拿卡片 id。",
  params: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "省略则用当前打开的项目" },
    },
  },
  async handler(params) {
    const projectId = await resolveAndOpenProject(
      params.projectId != null ? String(params.projectId) : undefined,
    );
    const cards = useCardStore
      .getState()
      .getCardsByProject(projectId)
      .map(toCardSummary);
    const connections = useConnectionStore
      .getState()
      .getConnectionsByProject(projectId)
      .map((c) => ({ id: c.id, from: c.sourceCardId, to: c.targetCardId }));
    return { projectId, cards, connections };
  },
};

export const canvasVerbs: VerbDefinition[] = [canvasSnapshot];
