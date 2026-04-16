import type { Connection } from "@/stores/connectionStore";
import type { CanvasCard } from "@/stores/cardStore";
import type { RefImageEntry } from "@/config/model-ref-images";

/**
 * Scan card data for refImages / refFrames that reference a sourceCardId,
 * and rebuild any connections that are missing from the persisted list.
 * This recovers connections lost due to localStorage clearing or data migration.
 */
export function rebuildMissingConnections(
  projectId: string,
  cards: CanvasCard[],
  persisted: Connection[],
): Connection[] {
  const cardIds = new Set(cards.map((c) => c.id));
  const existing = new Set(
    persisted.map((c) => `${c.sourceCardId}→${c.targetCardId}`),
  );

  const validPersisted = persisted.filter(
    (c) => cardIds.has(c.sourceCardId) && cardIds.has(c.targetCardId),
  );

  const rebuilt: Connection[] = [...validPersisted];
  let added = 0;

  for (const card of cards) {
    const d = card.data as Record<string, unknown>;

    const refImages = d.refImages as Record<string, RefImageEntry> | undefined;
    if (refImages) {
      for (const entry of Object.values(refImages)) {
        if (!entry?.sourceCardId) continue;
        if (!cardIds.has(entry.sourceCardId)) continue;
        const key = `${entry.sourceCardId}→${card.id}`;
        if (existing.has(key)) continue;
        existing.add(key);
        rebuilt.push({
          id: crypto.randomUUID(),
          projectId,
          sourceCardId: entry.sourceCardId,
          targetCardId: card.id,
          createdAt: new Date().toISOString(),
        });
        added++;
      }
    }

    type FrameRef = { url: string; sourceCardId: string };
    const refFrames = d.refFrames as FrameRef[] | undefined;
    if (refFrames) {
      for (const frame of refFrames) {
        if (!frame?.sourceCardId) continue;
        if (!cardIds.has(frame.sourceCardId)) continue;
        const key = `${frame.sourceCardId}→${card.id}`;
        if (existing.has(key)) continue;
        existing.add(key);
        rebuilt.push({
          id: crypto.randomUUID(),
          projectId,
          sourceCardId: frame.sourceCardId,
          targetCardId: card.id,
          createdAt: new Date().toISOString(),
        });
        added++;
      }
    }
  }

  if (added > 0) {
    console.log(
      `[ConnectionRecovery] 从卡片数据重建了 ${added} 条连线 (项目 ${projectId.slice(0, 8)})`,
    );
  }

  return rebuilt;
}
