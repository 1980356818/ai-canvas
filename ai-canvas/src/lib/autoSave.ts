import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { saveCardsBatch } from "@/lib/tauri";
import type { CardRow } from "@/lib/tauri";

function cardToRow(card: CanvasCard): CardRow {
  return {
    id: card.id,
    project_id: card.projectId,
    type: card.type,
    x: card.x,
    y: card.y,
    width: card.width,
    height: card.height,
    z_index: card.zIndex,
    locked: card.locked,
    collapsed: card.collapsed,
    color: card.color ?? null,
    title: card.title ?? null,
    data: JSON.stringify(card.data),
    created_at: card.createdAt,
    updated_at: card.updatedAt,
  };
}

class AutoSaveManager {
  private dirty = false;
  private dirtyCardIds = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private intervalMs = 30_000;

  setInterval(ms: number) {
    this.intervalMs = ms;
  }

  markDirty(cardId?: string) {
    this.dirty = true;
    if (cardId) this.dirtyCardIds.add(cardId);
    useUIStore.getState().setSaveStatus("unsaved");

    if (!this.timer && !this.saving) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }
  }

  async forceSave() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async flush() {
    if (!this.dirty || this.saving) return;
    this.saving = true;
    this.timer = null;

    const ui = useUIStore.getState();
    ui.setSaveStatus("saving");

    try {
      const cardStore = useCardStore.getState();
      const projectId = useProjectStore.getState().currentProjectId;
      if (!projectId) {
        this.saving = false;
        return;
      }

      const changedIds = [...this.dirtyCardIds];
      this.dirty = false;
      this.dirtyCardIds.clear();

      let cardsToSave: CanvasCard[];
      if (changedIds.length > 0) {
        cardsToSave = changedIds
          .map((id) => cardStore.cards.get(id))
          .filter((c): c is CanvasCard => c !== undefined);
      } else {
        cardsToSave = Array.from(cardStore.cards.values()).filter(
          (c) => c.projectId === projectId,
        );
      }

      if (cardsToSave.length > 0) {
        await saveCardsBatch(cardsToSave.map(cardToRow));
      }

      ui.setSaveStatus("saved");
    } catch (error) {
      console.error("Auto save failed:", error);
      ui.setSaveStatus("error");
      this.dirty = true;
    } finally {
      this.saving = false;
    }
  }

  destroy() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export const autoSave = new AutoSaveManager();
