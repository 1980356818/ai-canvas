import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { CanvasCard, Connection } from "@/types";
import { saveCardsBatch, saveConnections } from "@/platform";
import { cardToRow, connectionToRow } from "@/lib/mappers";
import { CARD_DEFAULTS, type WorkflowTemplate } from "@/shared/constants";
import type { ModelRef } from "@/services/models";
import { resolveDefaultModelForCardType, cardTypeNeedsModel } from "@/services/modelDefaults";

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
  // 默认模型缓存:同类型只解析一次(getDefaultImageModel 等是异步聚合,避免重复)。
  const modelDefaultCache = new Map<string, ModelRef | null>();
  const defaultModelFor = async (type: string): Promise<ModelRef | null> => {
    if (!modelDefaultCache.has(type)) {
      modelDefaultCache.set(type, await resolveDefaultModelForCardType(type));
    }
    return modelDefaultCache.get(type) ?? null;
  };

  for (let i = 0; i < template.cards.length; i++) {
    const preset = template.cards[i]!;
    const presetData = (preset.data ?? {}) as Record<string, unknown>;

    const defaults = CARD_DEFAULTS[preset.type];
    zIndexCursor += 1;

    // 模板预设基本不带 model;给"需要模型"的卡补默认模型,让模板生成的卡一出生就能
    // 直接运行(组运行 / agent 等不经过编辑器的路径不再因空 model 失败)。预设已显式
    // 指定 model 的(如分镜分析卡)保留不覆盖。单一口径见 services/modelDefaults.ts。
    const data: Record<string, unknown> = { _showLabel: true, ...presetData };
    if (cardTypeNeedsModel(preset.type) && !data.model) {
      const ref = await defaultModelFor(preset.type);
      if (ref) {
        data.model = ref.modelId;
        data.provider = ref.providerId;
      }
    }

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
      data,
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
  // 批量加连线:onConnectionsAdded 钩子一次性把上游已有输出（图片/文字）注入下游对应字段,
  // 无需手动调 injectOnConnect。逐条加会让兜底清理在部分连线时误删多源卡的参考图、打乱顺序。
  connStore.addConnections(connections);

  if (persistError) {
    throw persistError;
  }

  return cardIds;
}
