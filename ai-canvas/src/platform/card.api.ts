import type { CardRow } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { lsGet, lsSet } from "./storage";

export async function loadCards(projectId: string): Promise<CardRow[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<CardRow[]>("load_cards", { projectId });
  }

  return lsGet<CardRow[]>("cards_" + projectId, []);
}

export async function saveCardsBatch(cards: CardRow[]): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("save_cards_batch", { cards });
    return;
  }

  if (cards.length === 0) return;
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
