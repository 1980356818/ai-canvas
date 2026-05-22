import type { CardRow } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { lsGet, lsSet } from "./storage";
import { invokeBatched } from "@/lib/ipcBatch";

export async function loadCards(projectId: string): Promise<CardRow[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<CardRow[]>("load_cards", { projectId });
  }

  return lsGet<CardRow[]>("cards_" + projectId, []);
}

/**
 * 批量持久化卡片。Tauri 路径强制走 [`invokeBatched`](@/lib/ipcBatch.ts)
 * 守门 —— 单次 invoke 不会超出 WebView2 的 ~3MB IPC 雷区。
 *
 * 历史：曾把整个 dirty 集合一次性塞给 `save_cards_batch`，5000+ 张卡片
 * 一次 flush 时静默崩 WebView2 渲染进程，Rust 日志干净。
 */
export async function saveCardsBatch(cards: CardRow[]): Promise<void> {
  if (cards.length === 0) return;
  if (isTauri) {
    await invokeBatched({
      command: "save_cards_batch",
      items: cards,
      buildArgs: (chunk) => ({ cards: chunk }),
    });
    return;
  }

  const projectId = cards[0]!.project_id;
  const existing = lsGet<CardRow[]>("cards_" + projectId, []);
  const map = new Map(existing.map((c) => [c.id, c]));
  for (const card of cards) map.set(card.id, card);
  lsSet("cards_" + projectId, Array.from(map.values()));
}

export async function deleteCard(id: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("delete_card", { id });
    return;
  }

  const projectKeys = Object.keys(localStorage).filter((k) =>
    k.startsWith("ai_canvas_cards_"),
  );
  for (const key of projectKeys) {
    try {
      const cards: CardRow[] = JSON.parse(localStorage.getItem(key)!);
      const filtered = cards.filter((c) => c.id !== id);
      if (filtered.length !== cards.length) {
        localStorage.setItem(key, JSON.stringify(filtered));
        break;
      }
    } catch { /* skip */ }
  }
}
