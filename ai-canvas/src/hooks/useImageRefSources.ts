import { useMemo } from "react";
import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { extractOutput } from "@/lib/dataFlow";
import {
  type RefImageSlot,
  type RefImageEntry,
} from "@/config/model-ref-images";
import { getDisplayUrl } from "@/lib/media";

export interface ImageRefOption {
  id: string;
  label: string;
  category: "slot" | "upstream" | "audio" | "video";
  thumbnailUrl: string;
  resolvedUrl: string;
  source: InlineImageSource;
  cardTitle?: string;
}

export type InlineImageSource =
  | { type: "refSlot"; slotKey: string }
  | { type: "upstream"; sourceCardId: string }
  | { type: "audioSlot"; index: number }
  | { type: "videoSlot"; index: number };

interface AudioEntry {
  url: string;
  filename: string;
  duration?: number;
}

interface VideoEntry {
  url: string;
  sourceCardId?: string;
}

export function useImageRefSources(
  cardId: string,
  refSlots: RefImageSlot[],
  refImages: Record<string, RefImageEntry> | undefined,
  refAudios?: AudioEntry[],
  refVideos?: VideoEntry[],
): ImageRefOption[] {
  // v5：订阅 version 信号（数字）而不是整 Map 引用。每次任意卡片 updateCardData
  // 都会让旧写法 `useCardStore((s) => s.cards)` 把 Map 引用换新，进而让本
  // useMemo deps 触发整段重算 + 产出新 array → 上游编辑器整组件树重渲。
  // 现在只在"有卡片真改 data"或"连线集合变化"时触发；effect/useMemo 内
  // imperative 取最新 cards/connections。
  const dataVersion = useCardStore((s) => s.dataVersion);
  const layoutVersion = useCardStore((s) => s.layoutVersion);
  const connectionsVersion = useConnectionStore((s) => s.connectionsVersion);

  return useMemo(() => {
    const cards = useCardStore.getState().cards;
    const connections = useConnectionStore.getState().connections;
    const options: ImageRefOption[] = [];
    const seenUrls = new Set<string>();

    let slotIdx = 0;
    for (const slot of refSlots) {
      const entry = refImages?.[slot.key];
      if (!entry?.url) continue;
      if (seenUrls.has(entry.url)) continue;
      seenUrls.add(entry.url);
      slotIdx++;

      options.push({
        id: `slot:${slot.key}`,
        label: `图${slotIdx}`,
        category: "slot",
        thumbnailUrl: getDisplayUrl(entry.url),
        resolvedUrl: entry.url,
        source: { type: "refSlot", slotKey: slot.key },
        cardTitle: entry.sourceCardId
          ? cards.get(entry.sourceCardId)?.title ?? undefined
          : undefined,
      });
    }

    for (const conn of connections.values()) {
      if (conn.targetCardId !== cardId) continue;
      const sourceCard = cards.get(conn.sourceCardId);
      if (!sourceCard) continue;

      const output = extractOutput(sourceCard);
      if (output.kind !== "image") continue;
      if (seenUrls.has(output.url)) continue;
      seenUrls.add(output.url);

      slotIdx++;
      const title = sourceCard.title || getCardTypeLabel(sourceCard.type);
      options.push({
        id: `upstream:${sourceCard.id}`,
        label: `图${slotIdx}`,
        category: "upstream",
        thumbnailUrl: getDisplayUrl(output.url),
        resolvedUrl: output.url,
        source: { type: "upstream", sourceCardId: sourceCard.id },
        cardTitle: title,
      });
    }

    if (refAudios?.length) {
      for (let i = 0; i < refAudios.length; i++) {
        const a = refAudios[i]!;
        options.push({
          id: `audio:${i}`,
          label: `音频${i + 1}`,
          category: "audio",
          thumbnailUrl: "",
          resolvedUrl: a.url,
          source: { type: "audioSlot", index: i },
          cardTitle: a.filename,
        });
      }
    }

    if (refVideos?.length) {
      for (let i = 0; i < refVideos.length; i++) {
        const v = refVideos[i]!;
        const title = v.sourceCardId
          ? cards.get(v.sourceCardId)?.title || getCardTypeLabel(cards.get(v.sourceCardId)?.type ?? "")
          : undefined;
        options.push({
          id: `video:${i}`,
          label: `视频${i + 1}`,
          category: "video",
          thumbnailUrl: "",
          resolvedUrl: v.url,
          source: { type: "videoSlot", index: i },
          cardTitle: title,
        });
      }
    }

    return options;
    // 数字 deps：浅比较快，且只在真实"卡片 data / 增减 / 连线"变化时重算。
    // 注意：cards / connections 是 imperative 取 (getState)，故意不在 deps 里——
    // version 数字才是合法的触发信号。eslint-disable 仅针对此行。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, refSlots, refImages, refAudios, refVideos, dataVersion, layoutVersion, connectionsVersion]);
}

function getCardTypeLabel(type: string): string {
  switch (type) {
    case "ai_image":
      return "AI 图像";
    case "ai_multiangle":
      return "AI 多角度";
    case "ai_tryon":
      return "AI 试穿";
    case "ai_video":
      return "AI 视频";
    case "ai_chat":
      return "AI 对话";
    case "text":
      return "文字卡片";
    case "sticky_note":
      return "便签";
    default:
      return type;
  }
}
