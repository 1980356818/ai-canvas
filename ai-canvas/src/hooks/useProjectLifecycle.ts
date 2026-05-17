import { useEffect, useRef } from "react";
import { useCardStore } from "@/stores/cardStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { Connection } from "@/types";
import {
  loadCards,
  loadConnections,
  saveCardsBatch,
  saveConnections,
  saveProjectViewport,
  loadProjectViewport,
  migrateApiConfig,
  cleanupTerminalTasks,
} from "@/platform";
import { rebuildMissingConnections } from "@/lib/connectionRecovery";
import { cleanupDanglingReferencesInCards } from "@/lib/referenceConsistency";
import { autoSave } from "@/lib/autoSave";
import { history } from "@/lib/history";
import { startDataFlowWatcher } from "@/lib/dataFlow";
import { initMediaService } from "@/lib/media";
import { cardToRow, rowToCard, connectionToRow, rowToConnection } from "@/lib/mappers";
import { taskManager } from "@/services/taskManager";
import { installTaskBridge, uninstallTaskBridge } from "@/services/taskBridge";

export function useProjectLifecycle() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const dataFlowCleanup = useRef<(() => void) | null>(null);
  const prevProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    useSettingsStore.getState().applyTheme();
    void initMediaService();
    void migrateApiConfig();
    // 启动一次性维护：清掉 30 天以前的终态任务，避免 tasks 表无限增长。
    void cleanupTerminalTasks(30).catch((err) => {
      console.warn("[lifecycle] cleanupTerminalTasks failed:", err);
    });

    // 装上 task→UI 桥接器：所有任务的进度/错误/结果会自动同步到
    // genProgress / cardErrors / card.data。**特别重要**：被 resumeAll
    // 拉回来的孤儿任务，没有"等待者"持有 Promise，必须靠这个桥接器把结
    // 果落到卡片，否则就算后端成功了 UI 也不知道。
    installTaskBridge();

    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    document.addEventListener("dragover", prevent);
    document.addEventListener("drop", prevent);

    // 网络恢复时主动 resumeAll：捕获那些在离线期间没机会启动的任务（一般是
    // 用户从启动到上网的间隔里创建/恢复的）。对于已经在 transient 重试中的
    // 任务这是 no-op（running map 命中即跳过）。
    const onOnline = () => {
      void taskManager.resumeAll().catch((err) => {
        console.warn("[lifecycle] resumeAll on online failed:", err);
      });
    };
    window.addEventListener("online", onOnline);

    return () => {
      document.removeEventListener("dragover", prevent);
      document.removeEventListener("drop", prevent);
      window.removeEventListener("online", onOnline);
      uninstallTaskBridge();
    };
  }, []);

  useEffect(() => {
    const prevId = prevProjectIdRef.current;
    if (prevId) {
      const stillExists = useProjectStore.getState().projects.some((p) => p.id === prevId);
      if (stillExists) {
        const vp = useCanvasStore.getState().viewport;
        saveProjectViewport(prevId, { x: vp.x, y: vp.y, zoom: vp.zoom });

        const conns = useConnectionStore.getState().getConnectionsByProject(prevId);
        void saveConnections(prevId, conns.map(connectionToRow));
      }
    }
    prevProjectIdRef.current = currentProjectId;

    useCanvasStore.getState().setEditingCardId(null);

    if (!currentProjectId) {
      useCardStore.getState().clear();
      useConnectionStore.getState().clear();
      history.clear();
      return;
    }
    history.clear();

    const savedViewport = loadProjectViewport(currentProjectId);
    if (savedViewport) {
      useCanvasStore.getState().setViewport(savedViewport);
    } else {
      useCanvasStore.getState().setViewport({ x: 0, y: 0, zoom: 1 });
    }

    (async () => {
      console.log("[生命周期诊断] 切换项目，开始 loadCards", { projectId: currentProjectId });
      const rows = await loadCards(currentProjectId);
      const loadedCards = rows.map(rowToCard);
      console.log("[生命周期诊断] loadCards 返回", { count: loadedCards.length, projectId: currentProjectId });

      const connRows = await loadConnections(currentProjectId);
      const persistedConnections: Connection[] = connRows.map(rowToConnection);

      const validConnections = rebuildMissingConnections(currentProjectId, loadedCards, persistedConnections);
      const { cards, changedCardIds } = cleanupDanglingReferencesInCards(loadedCards, validConnections);
      console.log("[生命周期诊断] setCards", { final: cards.length, dropped: loadedCards.length - cards.length });

      useCardStore.getState().setCards(cards);
      useConnectionStore.getState().setConnections(validConnections);

      const persistenceTasks: Promise<unknown>[] = [];
      if (validConnections.length !== persistedConnections.length) {
        persistenceTasks.push(saveConnections(currentProjectId, validConnections.map(connectionToRow)));
      }
      if (changedCardIds.length > 0) {
        const changedCards = cards.filter((card) => changedCardIds.includes(card.id));
        persistenceTasks.push(saveCardsBatch(changedCards.map(cardToRow)));
      }
      if (persistenceTasks.length > 0) {
        await Promise.all(persistenceTasks);
      }

      dataFlowCleanup.current?.();
      dataFlowCleanup.current = startDataFlowWatcher();

      // 关键恢复点：任何在上一次会话被中断的"活动中"任务（queued/submitting/
      // polling），TaskManager 会在这里从 SQLite 一次性捞回来继续轮询。
      // 用户体验：打开应用后失败的视频卡会自动复活，不需要任何操作。
      try {
        const resumed = await taskManager.resumeAll(currentProjectId);
        if (resumed > 0) {
          console.log(`[生命周期诊断] resumed ${resumed} in-flight tasks for project`, currentProjectId);
        }
      } catch (err) {
        console.warn("[生命周期诊断] resumeAll failed:", err);
      }
    })().catch(console.error);

    return () => {
      dataFlowCleanup.current?.();
      dataFlowCleanup.current = null;
      const pid = useProjectStore.getState().currentProjectId;
      if (pid) autoSave.forceSave();
    };
  }, [currentProjectId]);
}
