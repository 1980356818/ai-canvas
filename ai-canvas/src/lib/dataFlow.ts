import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUIStore } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";
import { getRefSlotsForModel, getRefSlotsForChatModel, getRefSlotsForVideoModel, compactRefImages, type RefImageEntry } from "@/config/model-ref-images";
import { isSeedanceModel } from "@/providers/shared/video";

const DEBUG = import.meta.env.DEV;

const IMAGE_SOURCE_TYPES = new Set(["ai_image", "ai_multiangle", "ai_tryon", "ai_video"]);
const AUDIO_SOURCE_TYPES = new Set(["audio"]);

const REF_IMAGE_TARGETS = new Set(["ai_image", "ai_multiangle", "ai_chat"]);

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
  if (!target) return true;

  const source = cardStore.getCard(sourceCardId);
  if (!source) return true;

  const isAudioSource = AUDIO_SOURCE_TYPES.has(source.type);
  const isImageSource = IMAGE_SOURCE_TYPES.has(source.type);
  if (!isImageSource && !isAudioSource) return true;

  if (isAudioSource) {
    if (target.type !== "ai_video") return true;
    const d = target.data as Record<string, unknown>;
    if ((d.imageMode as string ?? "reference") !== "reference") return false;
    type AudioRef = { sourceCardId: string };
    const audios = (d.refAudios as AudioRef[]) || [];
    if (audios.some((a) => a.sourceCardId === sourceCardId)) return true;
    return audios.length < 3;
  }

  if (target.type === "ai_video") {
    const d = target.data as Record<string, unknown>;
    const mode = (d.imageMode as string) ?? "reference";

    if (source.type === "ai_video") {
      if (mode !== "reference") return false;
      // Dale Seedance 上游硬约束: fast/标准都不接受 video reference (2026-05-16 实测).
      // 提前拒掉 video → Seedance 的连线, 避免无效的 refVideos 状态污染.
      if (isSeedanceModel((d.model as string) || "")) return false;
      type VideoRef = { sourceCardId: string };
      const videos = (d.refVideos as VideoRef[]) || [];
      if (videos.some((v) => v.sourceCardId === sourceCardId)) return true;
      return videos.length < 3;
    }

    if (mode === "text") return false;

    if (mode === "reference") {
      const slots = getRefSlotsForVideoModel((d.model as string) || "", "reference");
      const refImages = (d.refImages || {}) as Record<string, RefImageEntry>;
      for (const slot of slots) {
        if (refImages[slot.key]?.sourceCardId === sourceCardId) return true;
      }
      return slots.some((s) => !refImages[s.key]);
    }

    type FrameRef = { url: string; sourceCardId: string };
    const frames = (d.refFrames as FrameRef[]) || [];
    if (frames.some((f) => f.sourceCardId === sourceCardId)) return true;
    const maxFrames = mode === "firstFrame" ? 1 : 2;
    return frames.length < maxFrames;
  }

  if (target.type === "ai_chat" && source.type === "ai_video") {
    const d = target.data as Record<string, unknown>;
    type VideoRef = { sourceCardId: string };
    const videos = (d.refVideos as VideoRef[]) || [];
    if (videos.some((v) => v.sourceCardId === sourceCardId)) return true;
    return videos.length < 3;
  }

  if (!REF_IMAGE_TARGETS.has(target.type)) return true;

  const d = target.data as Record<string, unknown>;
  const slots = getRefSlots({ type: target.type, data: d });
  const refImages = (d.refImages || {}) as Record<string, RefImageEntry>;

  for (const slot of slots) {
    if (refImages[slot.key]?.sourceCardId === sourceCardId) return true;
  }
  return slots.some((s) => !refImages[s.key]);
}

function hasRefImages(target: { type: string; data: Record<string, unknown> }): boolean {
  if (REF_IMAGE_TARGETS.has(target.type)) return true;
  if (target.type === "ai_tryon") return true;
  const videoMode = target.type === "ai_video" ? (target.data.imageMode as string | undefined) ?? "reference" : null;
  if (videoMode === "reference") return true;
  return false;
}

function getRefSlotsAny(target: { type: string; data: Record<string, unknown> }) {
  if (target.type === "ai_video") {
    const mode = (target.data.imageMode as string) ?? "reference";
    return getRefSlotsForVideoModel((target.data.model as string) || "", mode);
  }
  return getRefSlots(target);
}

export function removeRefImageForSource(
  targetCardId: string,
  sourceCardId: string,
): void {
  const cardStore = useCardStore.getState();
  const target = cardStore.getCard(targetCardId);
  if (!target || !hasRefImages({ type: target.type, data: target.data as Record<string, unknown> })) return;

  const d = { ...(target.data as Record<string, unknown>) };
  const refImages = { ...((d.refImages || {}) as Record<string, RefImageEntry>) };

  let changed = false;
  const removedKeys: string[] = [];
  for (const key of Object.keys(refImages)) {
    if (refImages[key]?.sourceCardId === sourceCardId) {
      removedKeys.push(key);
      delete refImages[key];
      changed = true;
    }
  }

  if (changed) {
    if (target.type === "ai_tryon") {
      for (const key of removedKeys) {
        if (key === "person") d.personImageUrl = undefined;
        if (key === "garment") d.garmentImageUrl = undefined;
      }
      d.refImages = Object.keys(refImages).length > 0 ? refImages : undefined;
    } else {
      const slots = getRefSlotsAny({ type: target.type, data: d });
      d.refImages = compactRefImages(refImages, slots);
    }
    cardStore.updateCard(targetCardId, { data: d });
    autoSave.markDirty(targetCardId);
  }
}

export function removeUpstreamTextForSource(
  targetCardId: string,
  sourceCardId: string,
): void {
  const cardStore = useCardStore.getState();
  const target = cardStore.getCard(targetCardId);
  if (!target) return;

  const d = { ...(target.data as Record<string, unknown>) };
  let changed = false;

  if (target.type === "text" || target.type === "sticky_note") {
    if (d.upstreamCardId === sourceCardId) {
      d.upstreamText = undefined;
      d.upstreamCardId = undefined;
      changed = true;
    }
  }

  const upstreamTexts = {
    ...((d.upstreamTexts as Record<string, string>) || {}),
  };
  if (sourceCardId in upstreamTexts) {
    delete upstreamTexts[sourceCardId];
    d.upstreamTexts = Object.keys(upstreamTexts).length > 0 ? upstreamTexts : undefined;
    changed = true;
  }

  if (!changed) return;

  cardStore.updateCard(targetCardId, { data: d });
  autoSave.markDirty(targetCardId);
}

export function removeVideoFrameForSource(
  targetCardId: string,
  sourceCardId: string,
): void {
  const cardStore = useCardStore.getState();
  const target = cardStore.getCard(targetCardId);
  if (!target || target.type !== "ai_video") return;

  const d = { ...(target.data as Record<string, unknown>) };
  type FrameRef = { url: string; sourceCardId: string };
  const frames = (d.refFrames as FrameRef[]) || [];
  const filtered = frames.filter((f) => f.sourceCardId !== sourceCardId);

  if (filtered.length === frames.length) return;

  d.refFrames = filtered.length > 0 ? filtered : undefined;
  cardStore.updateCard(targetCardId, { data: d });
  autoSave.markDirty(targetCardId);
}

export function removeAudioForSource(
  targetCardId: string,
  sourceCardId: string,
): void {
  const cardStore = useCardStore.getState();
  const target = cardStore.getCard(targetCardId);
  if (!target || target.type !== "ai_video") return;

  const d = { ...(target.data as Record<string, unknown>) };
  type AudioRef = { url: string; filename: string; sourceCardId: string };
  const audios = (d.refAudios as AudioRef[]) || [];
  const filtered = audios.filter((a) => a.sourceCardId !== sourceCardId);

  if (filtered.length === audios.length) return;

  d.refAudios = filtered.length > 0 ? filtered : undefined;
  cardStore.updateCard(targetCardId, { data: d });
  autoSave.markDirty(targetCardId);
}

export function removeVideoRefForSource(
  targetCardId: string,
  sourceCardId: string,
): void {
  const cardStore = useCardStore.getState();
  const target = cardStore.getCard(targetCardId);
  if (!target || (target.type !== "ai_video" && target.type !== "ai_chat")) return;

  const d = { ...(target.data as Record<string, unknown>) };
  let changed = false;

  type VideoRef = { url: string; sourceCardId: string };
  const videos = (d.refVideos as VideoRef[]) || [];
  const filtered = videos.filter((v) => v.sourceCardId !== sourceCardId);
  if (filtered.length !== videos.length) {
    d.refVideos = filtered.length > 0 ? filtered : undefined;
    changed = true;
  }

  if (target.type === "ai_chat") {
    type MediaEntry = { url: string; displayUrl: string; kind: string; sourceCardId?: string };
    const media = (d.directMedia as MediaEntry[]) || [];
    const filteredMedia = media.filter((m) => !(m.kind === "video" && m.sourceCardId === sourceCardId));
    if (filteredMedia.length !== media.length) {
      d.directMedia = filteredMedia.length > 0 ? filteredMedia : undefined;
      changed = true;
    }
  }

  if (!changed) return;

  cardStore.updateCard(targetCardId, { data: d });
  autoSave.markDirty(targetCardId);
}


export type OutputPayload =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string }
  | { kind: "video"; url: string }
  | { kind: "audio"; url: string; filename: string }
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

    case "ai_image":
    case "ai_multiangle": {
      const results = d.results as Array<{ url: string }> | undefined;
      if (results && results.length > 0) {
        const idx = (d.selectedIndex as number) ?? 0;
        const url = results[Math.min(idx, results.length - 1)]?.url;
        if (url) return { kind: "image", url };
      }
      if (typeof d.imageUrl === "string" && d.imageUrl)
        return { kind: "image", url: d.imageUrl };
      return { kind: "none" };
    }

    case "ai_video": {
      if (typeof d.videoUrl === "string" && d.videoUrl)
        return { kind: "video", url: d.videoUrl };
      return { kind: "none" };
    }

    case "ai_tryon": {
      if (typeof d.resultImageUrl === "string" && d.resultImageUrl)
        return { kind: "image", url: d.resultImageUrl };
      return { kind: "none" };
    }

    case "audio": {
      if (typeof d.audioUrl === "string" && d.audioUrl)
        return { kind: "audio", url: d.audioUrl, filename: (d.filename as string) ?? "audio" };
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
        const upstreamTexts = {
          ...((d.upstreamTexts as Record<string, string>) || {}),
        };
        if (upstreamTexts[sourceCardId] !== payload.text) {
          upstreamTexts[sourceCardId] = payload.text;
          d.upstreamTexts = upstreamTexts;
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
      } else if (payload.kind === "video") {
        const MAX_VIDEOS = 3;
        type VideoRef = { url: string; sourceCardId: string };
        const videos = [...((d.refVideos as VideoRef[]) || [])];

        const existIdx = videos.findIndex((v) => v.sourceCardId === sourceCardId);
        if (existIdx >= 0) {
          if (videos[existIdx]!.url !== payload.url) {
            videos[existIdx] = { url: payload.url, sourceCardId };
            d.refVideos = videos;
            changed = true;
          }
        } else if (videos.length < MAX_VIDEOS) {
          videos.push({ url: payload.url, sourceCardId });
          d.refVideos = videos;
          changed = true;
        }
      }
      break;
    }

    case "ai_image":
    case "ai_multiangle": {
      if (payload.kind === "text") {
        const upstreamTexts = {
          ...((d.upstreamTexts as Record<string, string>) || {}),
        };
        if (upstreamTexts[sourceCardId] !== payload.text) {
          upstreamTexts[sourceCardId] = payload.text;
          d.upstreamTexts = upstreamTexts;
          d.upstreamCardId = sourceCardId;
          changed = true;
        }
        if (DEBUG) console.log("[DataFlow] ai_image 注入文本", {
          sourceCardId,
          targetId: target.id,
          textLength: payload.text.length,
          textPreview: payload.text.slice(0, 100),
          allUpstreamTexts: Object.fromEntries(
            Object.entries(upstreamTexts).map(([k, v]) => [k, (v as string).slice(0, 80)]),
          ),
        });
      } else if (payload.kind === "image") {
        const model = (d.model as string) || "";
        const slots = getRefSlotsForModel(model);
        const refImages = {
          ...((d.refImages || {}) as Record<string, RefImageEntry>),
        };

        if (DEBUG) console.log("[DataFlow] ai_image 注入图片 - 开始", {
          sourceCardId,
          targetId: target.id,
          model,
          slotsCount: slots.length,
          slotKeys: slots.map((s) => s.key),
          existingRefKeys: Object.keys(refImages),
          imageUrlPreview: payload.url.slice(0, 80),
        });

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
            if (DEBUG) console.log("[DataFlow] ai_image 图片更新已有槽位", { slotKey: slot.key });
            break;
          }
        }

        if (!found) {
          let assigned = false;
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
              assigned = true;
              if (DEBUG) console.log("[DataFlow] ai_image 图片分配到空槽位", { slotKey: slot.key });
              break;
            }
          }
          if (!assigned) {
            console.warn("[DataFlow] ai_image 图片注入失败: 所有槽位已满", {
              occupiedSlots: Object.keys(refImages),
            });
          }
        }
      }
      break;
    }

    case "ai_video": {
      if (payload.kind === "text") {
        const upstreamTexts = {
          ...((d.upstreamTexts as Record<string, string>) || {}),
        };
        if (upstreamTexts[sourceCardId] !== payload.text) {
          upstreamTexts[sourceCardId] = payload.text;
          d.upstreamTexts = upstreamTexts;
          d.upstreamCardId = sourceCardId;
          changed = true;
        }
      } else if (payload.kind === "image") {
        const imageMode = (d.imageMode as string) ?? "reference";

        if (imageMode === "text") {
          // text mode rejects images
        } else if (imageMode === "reference") {
          const slots = getRefSlotsForVideoModel((d.model as string) || "", "reference");
          const refImages = {
            ...((d.refImages || {}) as Record<string, RefImageEntry>),
          };

          let found = false;
          for (const slot of slots) {
            if (refImages[slot.key]?.sourceCardId === sourceCardId) {
              if (refImages[slot.key]!.url !== payload.url) {
                refImages[slot.key] = { url: payload.url, sourceCardId, sourceType: "card" };
                d.refImages = refImages;
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
                changed = true;
                break;
              }
            }
          }
        } else {
          const maxFrames = imageMode === "firstFrame" ? 1 : 2;
          type FrameRef = { url: string; sourceCardId: string };
          const frames = [...((d.refFrames as FrameRef[]) || [])];

          const existIdx = frames.findIndex((f) => f.sourceCardId === sourceCardId);
          if (existIdx >= 0) {
            if (frames[existIdx]!.url !== payload.url) {
              frames[existIdx] = { url: payload.url, sourceCardId };
              d.refFrames = frames;
              d.upstreamCardId = sourceCardId;
              changed = true;
            }
          } else if (frames.length < maxFrames) {
            frames.push({ url: payload.url, sourceCardId });
            d.refFrames = frames;
            d.upstreamCardId = sourceCardId;
            changed = true;
          }
        }
      } else if (payload.kind === "audio") {
        if ((d.imageMode as string ?? "reference") === "reference") {
          const MAX_AUDIOS = 3;
          type AudioRef = { url: string; filename: string; sourceCardId: string };
          const audios = [...((d.refAudios as AudioRef[]) || [])];

          const existIdx = audios.findIndex((a) => a.sourceCardId === sourceCardId);
          if (existIdx >= 0) {
            if (audios[existIdx]!.url !== payload.url) {
              audios[existIdx] = { url: payload.url, filename: payload.filename, sourceCardId };
              d.refAudios = audios;
              changed = true;
            }
          } else if (audios.length < MAX_AUDIOS) {
            audios.push({ url: payload.url, filename: payload.filename, sourceCardId });
            d.refAudios = audios;
            changed = true;
          }
        }
      } else if (payload.kind === "video") {
        // Seedance 上游不支持 video reference, 不要把 refVideos 注入到 Seedance 视频卡里.
        // (canConnect 已经拦住新连线; 这里再防一道历史连线被重新触发注入的情况.)
        if (
          (d.imageMode as string ?? "reference") === "reference"
          && !isSeedanceModel((d.model as string) || "")
        ) {
          const MAX_VIDEOS = 3;
          type VideoRef = { url: string; sourceCardId: string };
          const videos = [...((d.refVideos as VideoRef[]) || [])];

          const existIdx = videos.findIndex((v) => v.sourceCardId === sourceCardId);
          if (existIdx >= 0) {
            if (videos[existIdx]!.url !== payload.url) {
              videos[existIdx] = { url: payload.url, sourceCardId };
              d.refVideos = videos;
              changed = true;
            }
          } else if (videos.length < MAX_VIDEOS) {
            videos.push({ url: payload.url, sourceCardId });
            d.refVideos = videos;
            changed = true;
          }
        }
      }
      break;
    }

    case "ai_tryon": {
      if (payload.kind === "image") {
        const refImages = { ...((d.refImages || {}) as Record<string, RefImageEntry>) };
        if (!d.personImageUrl || refImages.person?.sourceCardId === sourceCardId) {
          d.personImageUrl = payload.url;
          refImages.person = { url: payload.url, sourceCardId, sourceType: "card" };
          d.refImages = refImages;
          d.upstreamCardId = sourceCardId;
          changed = true;
        } else if (!d.garmentImageUrl || refImages.garment?.sourceCardId === sourceCardId) {
          d.garmentImageUrl = payload.url;
          refImages.garment = { url: payload.url, sourceCardId, sourceType: "card" };
          d.refImages = refImages;
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

  const downstream = getDownstreamCards(sourceCardId);
  if (downstream.length === 0) return 0;

  const output = extractOutput(sourceCard);

  if (output.kind === "none") {
    for (const { targetCard } of downstream) {
      removeRefImageForSource(targetCard.id, sourceCardId);
      removeUpstreamTextForSource(targetCard.id, sourceCardId);
      removeVideoFrameForSource(targetCard.id, sourceCardId);
      removeAudioForSource(targetCard.id, sourceCardId);
      removeVideoRefForSource(targetCard.id, sourceCardId);
    }
    return 0;
  }

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

  // 启动时一次性同步：把已有输出注入到下游卡片的空槽位
  const conns = useConnectionStore.getState().connections;
  if (DEBUG) console.log("[DataFlow] 初始同步开始, 连接数:", conns.size);
  for (const conn of conns.values()) {
    const source = useCardStore.getState().getCard(conn.sourceCardId);
    const target = useCardStore.getState().getCard(conn.targetCardId);
    if (!source || !target) continue;
    const output = extractOutput(source);
    if (DEBUG) console.log("[DataFlow] 初始同步检查连接:", {
      sourceId: conn.sourceCardId.slice(0, 8),
      sourceType: source.type,
      sourceTitle: source.title,
      targetId: conn.targetCardId.slice(0, 8),
      targetType: target.type,
      targetTitle: target.title,
      outputKind: output.kind,
      outputUrl: output.kind === "image" ? output.url?.slice(0, 60) : undefined,
      targetRefImages: (target.data as Record<string, unknown>).refImages,
    });
    if (output.kind !== "none") {
      const injected = injectIntoCard(target, output, conn.sourceCardId);
      if (DEBUG) console.log("[DataFlow] 初始同步注入结果:", injected, "→", target.title);
    }
  }
  // 同步后刷新快照，避免订阅器重复触发
  for (const [id, card] of useCardStore.getState().cards) {
    prevSnapshots.set(id, JSON.stringify(card.data));
  }

  const unsubCards = useCardStore.subscribe((state) => {
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

  let prevGeneratingIds = new Set(useUIStore.getState().generatingCards.keys());

  const unsubUI = useUIStore.subscribe((state) => {
    const currentIds = new Set(state.generatingCards.keys());
    for (const id of prevGeneratingIds) {
      if (!currentIds.has(id)) {
        const card = useCardStore.getState().getCard(id);
        if (card) {
          prevSnapshots.set(id, JSON.stringify(card.data));
          propagateFromCard(id);
        }
      }
    }
    prevGeneratingIds = currentIds;
  });

  return () => {
    unsubCards();
    unsubUI();
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

/**
 * 批量注入。被 `connectionStore` 的 `onConnectionsAdded` 钩子调用，
 * 让"建立连接 → 上游数据自动写入下游对应字段"成为连线生命周期的一部分，
 * 调用方不再需要手动调 `injectOnConnect`（CardShell / ImageToolbar /
 * clipboard / WireDropMenu / templateFactory 等）。
 */
export function injectOnConnections(
  added: Iterable<{ sourceCardId: string; targetCardId: string }>,
): void {
  for (const conn of added) {
    injectOnConnect(conn.sourceCardId, conn.targetCardId);
  }
}
