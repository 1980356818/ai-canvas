import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { CanvasCard, Connection } from "@/types";
import { saveCardsBatch, saveConnections } from "@/platform";
import { cardToRow, connectionToRow } from "@/lib/mappers";
import { CARD_DEFAULTS, type WorkflowTemplate } from "@/shared/constants";
import { isFrontendAssetUrl, persistFrontendAsset } from "@/lib/media";

const TEMPLATE_MEDIA_URL_KEYS = new Set([
  "imageUrl",
  "personImageUrl",
  "garmentImageUrl",
  "resultImageUrl",
  "videoUrl",
  "audioUrl",
  "url",
]);

type MaterializeCache = Map<string, Promise<string>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

async function materializeTemplateMediaValue(
  source: string,
  title: string,
  projectId: string,
  cache: MaterializeCache,
): Promise<string> {
  const cacheKey = `${title}\u0000${source}`;
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = persistFrontendAsset(source, title, projectId).then(result => result.localPath);
    cache.set(cacheKey, pending);
  }
  return pending;
}

async function materializeTemplateDataValue(
  value: unknown,
  title: string,
  projectId: string,
  cache: MaterializeCache,
  key?: string,
): Promise<unknown> {
  if (
    key &&
    TEMPLATE_MEDIA_URL_KEYS.has(key) &&
    typeof value === "string" &&
    isFrontendAssetUrl(value)
  ) {
    return materializeTemplateMediaValue(value, title, projectId, cache);
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map(item => materializeTemplateDataValue(item, title, projectId, cache)),
    );
  }

  if (isPlainObject(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([entryKey, entryValue]) => [
        entryKey,
        await materializeTemplateDataValue(entryValue, title, projectId, cache, entryKey),
      ] as const),
    );
    return Object.fromEntries(entries);
  }

  return value;
}

async function materializeTemplateData(
  data: Record<string, unknown>,
  title: string,
  projectId: string,
  cache: MaterializeCache,
): Promise<Record<string, unknown>> {
  return materializeTemplateDataValue(data, title, projectId, cache) as Promise<Record<string, unknown>>;
}

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
  const materializeCache: MaterializeCache = new Map();

  for (const preset of template.cards) {
    const defaults = CARD_DEFAULTS[preset.type];
    const presetData = await materializeTemplateData(
      preset.data,
      preset.title,
      projectId,
      materializeCache,
    );
    const card: CanvasCard = {
      id: crypto.randomUUID(),
      projectId,
      type: preset.type,
      x: anchorX + preset.relativeX,
      y: anchorY + preset.relativeY,
      width: preset.width ?? defaults.width,
      height: preset.height ?? defaults.height,
      zIndex: cardStore.maxZIndex + 1,
      locked: false,
      collapsed: false,
      title: preset.title,
      data: { _showLabel: true, ...presetData },
      createdAt: now,
      updatedAt: now,
    };
    cardStore.addCard(card);
    cards.push(card);
    cardIds.push(card.id);
  }

  const connections: Connection[] = [];
  if (template.connections) {
    for (const preset of template.connections) {
      const sourceId = cardIds[preset.sourceIndex];
      const targetId = cardIds[preset.targetIndex];
      if (sourceId && targetId) {
        const conn: Connection = {
          id: crypto.randomUUID(),
          projectId,
          sourceCardId: sourceId,
          targetCardId: targetId,
          createdAt: now,
        };
        connStore.addConnection(conn);
        connections.push(conn);
      }
    }
  }

  if (cards.length > 0) {
    await saveCardsBatch(cards.map(cardToRow));
  }
  if (connections.length > 0) {
    await saveConnections(projectId, connections.map(connectionToRow));
  }

  return cardIds;
}
