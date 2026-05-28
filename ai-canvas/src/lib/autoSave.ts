import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard, CardGroup } from "@/types";
import { useGroupStore } from "@/stores/groupStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { saveCardsBatch, saveGroupsBatch } from "@/platform";
import { cardToRow, groupToRow } from "@/lib/mappers";

class AutoSaveManager {
  private dirty = false;
  private dirtyCardIds = new Set<string>();
  private dirtyGroupIds = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private intervalMs = 5_000;

  setInterval(ms: number) {
    this.intervalMs = ms;
  }

  /**
   * 标脏:不带 id = 项目级脏(本次 flush 全量重刷未指定的卡/组);
   * 带 id = 仅刷该实体。`kind` 默认 "card",传 "group" 标组脏。
   */
  markDirty(id?: string, kind: "card" | "group" = "card") {
    this.dirty = true;
    if (id) {
      if (kind === "group") this.dirtyGroupIds.add(id);
      else this.dirtyCardIds.add(id);
    }
    useUIStore.getState().setSaveStatus("unsaved");

    if (!this.timer && !this.saving) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }
  }

  /** 显式标"某组脏"。语法糖,效果同 markDirty(id, "group")。 */
  markGroupDirty(groupId?: string) {
    this.markDirty(groupId, "group");
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
      const groupStore = useGroupStore.getState();

      const changedCardIds = [...this.dirtyCardIds];
      const changedGroupIds = [...this.dirtyGroupIds];
      const projectWideDirty =
        this.dirty && changedCardIds.length === 0 && changedGroupIds.length === 0;

      this.dirty = false;
      this.dirtyCardIds.clear();
      this.dirtyGroupIds.clear();

      // ── 卡片 ──
      // 按卡片自身的 projectId 取,禁止读全局 currentProjectId —— 多项目并发时
      // 卡片可能跨项目分布,按"当前项目"过滤会漏掉其它项目的脏卡片。
      const cardsToSave: CanvasCard[] =
        changedCardIds.length > 0
          ? changedCardIds
              .map((id) => cardStore.cards.get(id))
              .filter((c): c is CanvasCard => c !== undefined)
          : projectWideDirty
              ? Array.from(cardStore.cards.values())
              : [];

      // ── 组 ──
      const groupsToSave: CardGroup[] =
        changedGroupIds.length > 0
          ? changedGroupIds
              .map((id) => groupStore.groups.get(id))
              .filter((g): g is CardGroup => g !== undefined)
          : projectWideDirty
              ? Array.from(groupStore.groups.values())
              : [];

      const persistTasks: Promise<unknown>[] = [];
      if (cardsToSave.length > 0) {
        persistTasks.push(saveCardsBatch(cardsToSave.map(cardToRow)));
      }
      if (groupsToSave.length > 0) {
        persistTasks.push(saveGroupsBatch(groupsToSave.map(groupToRow)));
      }
      if (persistTasks.length > 0) {
        await Promise.all(persistTasks);
      }

      // 按所属项目分桶,分别更新各项目的 updatedAt;避免把多项目的修改
      // 全部记到"当前项目"上。
      const affectedProjects = new Set<string>();
      for (const c of cardsToSave) {
        if (c.projectId) affectedProjects.add(c.projectId);
      }
      for (const g of groupsToSave) {
        if (g.projectId) affectedProjects.add(g.projectId);
      }
      if (affectedProjects.size > 0) {
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
