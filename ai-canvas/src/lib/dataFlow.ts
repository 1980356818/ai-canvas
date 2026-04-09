import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUIStore } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";
import { getRefSlotsForModel, getRefSlotsForChatModel, compactRefImages, type RefImageEntry } from "@/config/model-ref-images";

const IMAGE_SOURCE_TYPES = new Set(["ai_image", "ai_tryon", "ai_video"]);

const REF_IMAGE_TARGETS = new Set(["ai_image", "ai_chat"]);

function getRefSlots(target: { type: string; data: Record<string, unknown> }) {
  const model = (target.data.model as string) || "";
  return target.type === "ai_chat"
    ? getRefSlotsForChatModel(model)
    : getRefSlotsForModel(model);
}

export function canAcceptImageConnection(
  targetCardId: string,
  sourceCardId: string,
): boolean {
  const cardStore = useCardStore.getState();
  const target = cardStore.getCard(targetCardId);
  if (!target || !REF_IMAGE_TARGETS.has(target.type)) return true;

  const source = cardStore.getCard(sourceCardId);
  if (!source || !IMAGE_SOURCE_TYPES.has(source.type)) return true;

  const d = target.data as Record<string, unknown>;
  const slots = getRefSlots({ type: target.type, data: d });
  const refImages = (d.refImages || {}) as Record<string, RefImageEntry>;

  for (const slot of slots) {
    if (refImages[slot.key]?.sourceCardId === sourceCardId) return true;
  }
  return slots.some((s) => !refImages[s.key]);
}

export function removeRefImageForSource(
  targetCardId: string,
  sourceCardId: string,
): void {
  const cardStore = useCardStore.getState();
  const target = cardStore.getCard(targetCardId);
  if (!target || !REF_IMAGE_TARGETS.has(target.type)) return;

  const d = { ...(target.data as Record<string, unknown>) };
  const refImages = { ...((d.refImages || {}) as Record<string, RefImageEntry>) };

  let changed = false;
  for (const key of Object.keys(refImages)) {
    if (refImages[key]?.sourceCardId === sourceCardId) {
      delete refImages[key];
      changed = true;
    }
  }

  if (changed) {
    const slots = getRefSlots({ type: target.type, data: d });
    d.refImages = compactRefImages(refImages, slots);
    cardStore.updateCard(targetCardId, { data: d });
    autoSave.markDirty(targetCardId);
  }
}

export type OutputPayload =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string }
  | { kind: "none" };

export function extractOutput(card: CanvasCard): OutputPayload {
  const d = card.data as Record<string, unknown>;

  switch (card.type) {
    case "ai_chat": {
      const result = d.result as string | undefined;
      if (result && !result.startsWith("错误:"))
        return { kind: "text", text: result };
      return { kind: "none" };
    }

    case "ai_image": {
      if (typeof d.imageUrl === "string" && d.imageUrl)
        return { kind: "image", url: d.imageUrl };
      return { kind: "none" };
    }

    case "ai_video": {
      if (typeof d.videoUrl === "string" && d.videoUrl)
        return { kind: "image", url: d.videoUrl };
      return { kind: "none" };
    }

    case "ai_tryon": {
      if (typeof d.resultImageUrl === "string" && d.resultImageUrl)
        return { kind: "image", url: d.resultImageUrl };
      return { kind: "none" };
    }

    case "text":
    case "sticky_note": {
      if (typeof d.content === "string" && d.content.trim())
        return { kind: "text", text: d.content };
      return { kind: "none" };
    }

    default:
      return { kind: "none" };
  }
}

function injectIntoCard(
  target: CanvasCard,
  payload: OutputPayload,
  sourceCardId: string,
): boolean {
  if (payload.kind === "none") return false;
  const d = { ...(target.data as Record<string, unknown>) };
  let changed = false;

  switch (target.type) {
    case "text":
    case "sticky_note": {
      if (payload.kind === "text") {
        const prev = (d.upstreamText as string) ?? "";
        if (prev !== payload.text) {
          d.upstreamText = payload.text;
          d.upstreamCardId = sourceCardId;
          changed = true;
        }
      }
      break;
    }

    case "ai_chat": {
      if (payload.kind === "text") {
        const prev = (d.upstreamContext as string) ?? "";
        if (prev !== payload.text) {
          d.upstreamContext = payload.text;
          d.upstreamCardId = sourceCardId;
          changed = true;
        }
      } else if (payload.kind === "image") {
        const slots = getRefSlotsForChatModel((d.model as string) || "");
        const refImages = {
          ...((d.refImages || {}) as Record<string, RefImageEntry>),
        };

        let found = false;
        for (const slot of slots) {
          if (refImages[slot.key]?.sourceCardId === sourceCardId) {
            if (refImages[slot.key]!.url !== payload.url) {
              refImages[slot.key] = { url: payload.url, sourceCardId, sourceType: "card" };
              d.refImages = refImages;
              d.upstreamCardId = sourceCardId;
              changed = true;
            }
            found = true;
            break;
          }
        }

        if (!found) {
          for (const slot of slots) {
            if (!refImages[slot.key]) {
              refImages[slot.key] = { url: payload.url, sourceCardId, sourceType: "card" };
              d.refImages = refImages;
              d.upstreamCardId = sourceCardId;
              changed = true;
              break;
            }
          }
        }
      }
      break;
    }

    case "ai_image": {
      if (payload.kind === "text") {
        const prev = (d.content as string) ?? "";
        if (!prev && payload.text) {
          d.content = payload.text;
          d.upstreamCardId = sourceCardId;
          changed = true;
        }
      } else if (payload.kind === "image") {
        const model = (d.model as string) || "";
        const slots = getRefSlotsForModel(model);
        const refImages = {
          ...((d.refImages || {}) as Record<string, RefImageEntry>),
        };

        let found = false;
        for (const slot of slots) {
          if (refImages[slot.key]?.sourceCardId === sourceCardId) {
            if (refImages[slot.key]!.url !== payload.url) {
              refImages[slot.key] = {
                url: payload.url,
                sourceCardId,
                sourceType: "card",
              };
              d.refImages = refImages;
              d.upstreamCardId = sourceCardId;
              changed = true;
            }
            found = true;
            break;
          }
        }

        if (!found) {
          for (const slot of slots) {
            if (!refImages[slot.key]) {
              refImages[slot.key] = {
                url: payload.url,
                sourceCardId,
                sourceType: "card",
              };
              d.refImages = refImages;
              d.upstreamCardId = sourceCardId;
              changed = true;
              break;
            }
          }
        }
      }
      break;
    }

    case "ai_video": {
      if (payload.kind === "text") {
        const prev = (d.content as string) ?? "";
        if (!prev && payload.text) {
          d.content = payload.text;
          d.upstreamCardId = sourceCardId;
          changed = true;
        }
      } else if (payload.kind === "image") {
        const prev = (d.upstreamImageUrl as string) ?? "";
        if (prev !== payload.url) {
          d.upstreamImageUrl = payload.url;
          d.upstreamCardId = sourceCardId;
          changed = true;
        }
      }
      break;
    }

    case "ai_tryon": {
      if (payload.kind === "image") {
        if (!d.personImageUrl) {
          d.personImageUrl = payload.url;
          d.upstreamCardId = sourceCardId;
          changed = true;
        } else if (!d.garmentImageUrl) {
          d.garmentImageUrl = payload.url;
          d.upstreamCardId = sourceCardId;
          changed = true;
        }
      }
      break;
    }
  }

  if (changed) {
    useCardStore.getState().updateCard(target.id, { data: d });
    autoSave.markDirty(target.id);
  }
  return changed;
}

function getDownstreamCards(
  sourceCardId: string,
): Array<{ targetCard: CanvasCard; connectionId: string }> {
  const conns = useConnectionStore.getState().connections;
  const cardStore = useCardStore.getState();
  const result: Array<{ targetCard: CanvasCard; connectionId: string }> = [];

  for (const conn of conns.values()) {
    if (conn.sourceCardId === sourceCardId) {
      const target = cardStore.getCard(conn.targetCardId);
      if (target) result.push({ targetCard: target, connectionId: conn.id });
    }
  }
  return result;
}

const pulsingConnections = new Set<string>();
let pulseTimer: ReturnType<typeof setTimeout> | null = null;

function triggerPulse(connectionIds: string[]) {
  for (const id of connectionIds) pulsingConnections.add(id);
  useConnectionStore.getState().setFlowingConnectionIds(new Set(pulsingConnections));

  if (pulseTimer) clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => {
    pulsingConnections.clear();
    useConnectionStore.getState().setFlowingConnectionIds(new Set());
    pulseTimer = null;
  }, 1500);
}

export function propagateFromCard(sourceCardId: string): number {
  const sourceCard = useCardStore.getState().getCard(sourceCardId);
  if (!sourceCard) return 0;

  const output = extractOutput(sourceCard);
  if (output.kind === "none") return 0;

  const downstream = getDownstreamCards(sourceCardId);
  if (downstream.length === 0) return 0;

  let count = 0;
  const flowedConnIds: string[] = [];

  for (const { targetCard, connectionId } of downstream) {
    if (injectIntoCard(targetCard, output, sourceCardId)) {
      count++;
      flowedConnIds.push(connectionId);
    }
  }

  if (count > 0) {
    triggerPulse(flowedConnIds);
    useUIStore.getState().addToast({
      type: "info",
      title: `数据已流转到 ${count} 个下游节点`,
      duration: 2000,
    });
  }

  return count;
}

let prevSnapshots = new Map<string, string>();

export function startDataFlowWatcher(): () => void {
  prevSnapshots.clear();
  for (const [id, card] of useCardStore.getState().cards) {
    prevSnapshots.set(id, JSON.stringify(card.data));
  }

  const unsub = useCardStore.subscribe((state) => {
    const generating = useUIStore.getState().generatingCards;

    for (const [id, card] of state.cards) {
      if (generating.has(id)) continue;

      const newSnap = JSON.stringify(card.data);
      const oldSnap = prevSnapshots.get(id);

      if (oldSnap !== undefined && oldSnap !== newSnap) {
        propagateFromCard(id);
      }
      prevSnapshots.set(id, newSnap);
    }

    for (const id of prevSnapshots.keys()) {
      if (!state.cards.has(id)) prevSnapshots.delete(id);
    }
  });

  return () => {
    unsub();
    prevSnapshots.clear();
  };
}

export function injectOnConnect(
  sourceCardId: string,
  targetCardId: string,
): void {
  const cardStore = useCardStore.getState();
  const source = cardStore.getCard(sourceCardId);
  const target = cardStore.getCard(targetCardId);
  if (!source || !target) return;

  const output = extractOutput(source);
  if (output.kind === "none") return;

  injectIntoCard(target, output, sourceCardId);

  prevSnapshots.set(targetCardId, JSON.stringify(
    cardStore.getCard(targetCardId)?.data,
  ));
}
