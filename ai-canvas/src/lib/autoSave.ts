import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { saveCardsBatch } from "@/platform";
import { cardToRow } from "@/lib/mappers";

class AutoSaveManager {
  private dirty = false;
  private dirtyCardIds = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private intervalMs = 5_000;

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
      const changedIds = [...this.dirtyCardIds];
      this.dirty = false;
      this.dirtyCardIds.clear();

      // 按卡片自身的 projectId 取，禁止读全局 currentProjectId —— 多项目并发时
      // 卡片可能跨项目分布，按"当前项目"过滤会漏掉其它项目的脏卡片。
      const cardsToSave: CanvasCard[] =
        changedIds.length > 0
          ? changedIds
              .map((id) => cardStore.cards.get(id))
              .filter((c): c is CanvasCard => c !== undefined)
          : Array.from(cardStore.cards.values());

      if (cardsToSave.length > 0) {
        await saveCardsBatch(cardsToSave.map(cardToRow));

        // 按所属项目分桶，分别更新各项目的 updatedAt；避免把多项目的修改
        // 全部记到"当前项目"上。
        const affectedProjects = new Set<string>();
        for (const c of cardsToSave) {
          if (c.projectId) affectedProjects.add(c.projectId);
        }
        const updatedAt = new Date().toISOString();
        const projectStore = useProjectStore.getState();
        for (const pid of affectedProjects) {
          projectStore.updateProject(pid, { updatedAt });
        }
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
