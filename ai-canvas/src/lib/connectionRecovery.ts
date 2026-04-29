import type { CanvasCard, Connection } from "@/types";

/**
 * Connections are the source of truth for card-to-card references.
 *
 * Older versions attempted to rebuild missing connections by scanning card data
 * (refImages/refFrames with sourceCardId). That made intentionally removed
 * connections come back on project load, leaving stale reference images/text in
 * editors. We now only keep persisted connections whose endpoints still exist;
 * dangling card data is cleaned separately by referenceConsistency.
 */
export function rebuildMissingConnections(
  _projectId: string,
  cards: CanvasCard[],
  persisted: Connection[],
): Connection[] {
  const cardIds = new Set(cards.map((c) => c.id));
  return persisted.filter(
    (c) => cardIds.has(c.sourceCardId) && cardIds.has(c.targetCardId),
  );
}
