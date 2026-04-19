import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { Connection } from "@/types";
import { autoSave } from "@/lib/autoSave";
import { CARD_DEFAULTS, type WorkflowTemplate } from "@/shared/constants";

export function instantiateWorkflowTemplate(
  template: WorkflowTemplate,
  projectId: string,
  anchorX: number,
  anchorY: number,
): string[] {
  const now = new Date().toISOString();
  const cardStore = useCardStore.getState();
  const connStore = useConnectionStore.getState();
  const cardIds: string[] = [];

  for (const preset of template.cards) {
    const defaults = CARD_DEFAULTS[preset.type];
    const card = {
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
      data: { ...preset.data },
      createdAt: now,
      updatedAt: now,
    };
    cardStore.addCard(card);
    autoSave.markDirty(card.id);
    cardIds.push(card.id);
  }

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
      }
    }
    autoSave.markDirty();
  }

  return cardIds;
}
