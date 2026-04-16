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
  category: "slot" | "upstream";
  thumbnailUrl: string;
  resolvedUrl: string;
  source: InlineImageSource;
  cardTitle?: string;
}

export type InlineImageSource =
  | { type: "refSlot"; slotKey: string }
  | { type: "upstream"; sourceCardId: string };

export function useImageRefSources(
  cardId: string,
  refSlots: RefImageSlot[],
  refImages: Record<string, RefImageEntry> | undefined,
): ImageRefOption[] {
  const cards = useCardStore((s) => s.cards);
  const connections = useConnectionStore((s) => s.connections);

  return useMemo(() => {
    const options: ImageRefOption[] = [];
    const seenUrls = new Set<string>();

    // 1. 当前节点的参考图槽位
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

    // 2. 通过连线连接到当前节点的上游图片
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

    return options;
  }, [cardId, refSlots, refImages, cards, connections]);
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
