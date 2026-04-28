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

  for (const preset of template.cards) {
    const defaults = CARD_DEFAULTS[preset.type];
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
      data: { _showLabel: true, ...preset.data },
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
