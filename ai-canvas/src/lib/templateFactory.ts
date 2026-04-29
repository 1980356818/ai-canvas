import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { CanvasCard, Connection } from "@/types";
import { saveCardsBatch, saveConnections } from "@/platform";
import { cardToRow, connectionToRow } from "@/lib/mappers";
import { CARD_DEFAULTS, type WorkflowTemplate } from "@/shared/constants";

export async function instantiateWorkflowTemplate(
  template: WorkflowTemplate,
  projectId: string,
  anchorX: number,
  anchorY: number,
): Promise<string[]> {
  const now = new Date().toISOString();
  const cardStore = useCardStore.getState();
  const connStore = useConnectionStore.getState();
  const cardIds: string[] = [];
  const cards: CanvasCard[] = [];

  // 修复 zIndex snapshot bug：getState() 返回的是当前快照，maxZIndex 不会随 addCard 自动更新，
  // 导致模板内所有卡片堆叠在同一层。这里用本地游标在循环里逐张递增。
  let zIndexCursor = cardStore.maxZIndex;

  // 模板里的 imageUrl 都是 vite 打包的前端 asset（dev:`/src/assets/...`、build:`/assets/...`），
  // getDisplayUrl 对 `/` 开头直接放行、getBase64ForApi 对前端 asset 走 urlToDataUrl 现转。
  // 之前的 persistFrontendAsset 既会卡住 IPC，也只是把同一份图片再复制到 app_data/media，毫无收益。
  // 现在直接用 preset.data 原值，避免在创建模板时阻塞主流程。
  for (let i = 0; i < template.cards.length; i++) {
    const preset = template.cards[i]!;
    const presetData = (preset.data ?? {}) as Record<string, unknown>;

    const defaults = CARD_DEFAULTS[preset.type];
    zIndexCursor += 1;
    const card: CanvasCard = {
      id: crypto.randomUUID(),
      projectId,
      type: preset.type,
      x: anchorX + preset.relativeX,
      y: anchorY + preset.relativeY,
      width: preset.width ?? defaults.width,
      height: preset.height ?? defaults.height,
      zIndex: zIndexCursor,
      locked: false,
      collapsed: false,
      title: preset.title,
      data: { _showLabel: true, ...presetData },
      createdAt: now,
      updatedAt: now,
    };
    cards.push(card);
    cardIds.push(card.id);
  }

  const connections: Connection[] = [];
  if (template.connections) {
    for (const preset of template.connections) {
      const sourceId = cardIds[preset.sourceIndex];
      const targetId = cardIds[preset.targetIndex];
      if (sourceId && targetId) {
        connections.push({
          id: crypto.randomUUID(),
          projectId,
          sourceCardId: sourceId,
          targetCardId: targetId,
          createdAt: now,
        });
      }
    }
  }

  // 关键修复：先持久化到数据库，再写入 store。
  // 1. 任何一步失败都用 try/catch 容错，不再让整批模板因单环节失败而出现「项目空空如也」。
  // 2. 落库失败时仍把卡片加入 store，让用户当前会话能看见画面；同时把错误抛给调用方让外层 toast 给到用户。
  let persistError: unknown = null;
  if (cards.length > 0) {
    try {
      await saveCardsBatch(cards.map(cardToRow));
    } catch (err) {
      persistError = err;
      console.error("[模板] 卡片落库失败：", err);
    }
  }
  if (connections.length > 0) {
    try {
      await saveConnections(projectId, connections.map(connectionToRow));
    } catch (err) {
      persistError = persistError ?? err;
      console.error("[模板] 连接落库失败：", err);
    }
  }

  for (const card of cards) cardStore.addCard(card);
  for (const conn of connections) connStore.addConnection(conn);

  if (persistError) {
    throw persistError;
  }

  return cardIds;
}
