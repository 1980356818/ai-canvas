import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUIStore } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";
import { getRefSlotsForModel, getRefSlotsForChatModel, getRefSlotsForVideoModel, resolveVideoImageMode, type RefImageEntry } from "@/config/model-ref-images";
import { upsertBySource, type RefImages } from "@/lib/refImageSlots";
import { isSeedanceModel, isOmniModel } from "@/providers/shared/video";
import { createLogger } from "@/lib/debug";

const log = createLogger("DataFlow");

// ─── Connection compatibility: single source of truth ───
// outputKindOf 和 canKindFlowInto 是验证(canAcceptConnection)与注入(injectIntoCard)的
// 共同基准。新增节点类型时必须同步更新这两个函数，否则会出现"能连线但没反应"的 bug。

type PayloadKind = "text" | "image" | "video" | "audio";

function outputKindOf(sourceType: string): PayloadKind | null {
  switch (sourceType) {
    case "ai_video": return "video";
    case "ai_image": case "ai_multiangle": case "ai_tryon": return "image";
    case "text": case "sticky_note": case "ai_chat": case "ai_script": return "text";
    case "audio": return "audio";
    // frame_extractor 通过 ctx.createCard 派生独立的 ai_image 卡片,自身不向下游推送 payload。
    case "frame_extractor": return null;
    default: return null;
  }
}

function canKindFlowInto(kind: PayloadKind, targetType: string): boolean {
  switch (targetType) {
    case "text": case "sticky_note": return kind === "text";
    case "ai_chat": case "ai_script": return kind === "text" || kind === "image" || kind === "video";
    case "ai_image": case "ai_multiangle": return kind === "text" || kind === "image";
    case "ai_video": return true;
    case "ai_tryon": return kind === "image";
    // frame_extractor 接收上游 ai_chat 的分镜 JSON 文本 + 可选 ai_video 源
    case "frame_extractor": return kind === "text" || kind === "video";
    default: return true;
  }
}

function targetTypeLabel(type: string): string {
  switch (type) {
    case "text": case "sticky_note": return "文本节点";
    case "ai_chat": return "对话节点";
    case "ai_script": return "帮我写节点";
    case "ai_image": return "图片节点";
    case "ai_multiangle": return "多角度节点";
    case "ai_video": return "视频节点";
    case "ai_tryon": return "试衣节点";
    case "frame_extractor": return "关键帧提取节点";
    default: return "该节点";
  }
}

function getRefSlots(target: { type: string; data: Record<string, unknown> }) {
  const model = (target.data.model as string) || "";
  return target.type === "ai_chat" || target.type === "ai_script"
    ? getRefSlotsForChatModel(model)
    : getRefSlotsForModel(model);
}

export type ConnectionReject = { title: string; description?: string };

export function canAcceptConnection(
  targetCardId: string,
  sourceCardId: string,
): true | ConnectionReject {
  const cardStore = useCardStore.getState();
  const target = cardStore.getCard(targetCardId);
  if (!target) return true;
  const source = cardStore.getCard(sourceCardId);
  if (!source) return true;

  const kind = outputKindOf(source.type);
  if (!kind || kind === "text") return true;

  const td = target.data as Record<string, unknown>;

  // ── Step 1: kind 兼容性（来自 canKindFlowInto 真值表）──
  if (!canKindFlowInto(kind, target.type)) {
    const kindLabel: Record<string, string> = { image: "图片", video: "视频", audio: "音频" };
    return { title: `${kindLabel[kind]}节点不能连入${targetTypeLabel(target.type)}` };
  }

  // ── Step 2: 槽位 / 模式 / 模型容量检查 ──

  // audio → ai_video
  if (kind === "audio") {
    if (isOmniModel((td.model as string) || ""))
      return { title: "该模型不支持参考音频" };
    if (resolveVideoImageMode(td.imageMode as string) !== "reference")
      return { title: "当前模式不支持音频输入", description: "请将视频卡片切换到「参考图」模式" };
    type AudioRef = { sourceCardId: string };
    const audios = (td.refAudios as AudioRef[]) || [];
    if (audios.some((a) => a.sourceCardId === sourceCardId)) return true;
    return audios.length < 3
      ? true
      : { title: "参考音频已满", description: "最多 3 段，请先断开已有连线" };
  }

  // image/video → ai_video
  if (target.type === "ai_video") {
    const mode = resolveVideoImageMode(td.imageMode as string);

    if (kind === "video") {
      if (mode !== "reference")
        return { title: "当前模式不支持参考视频", description: "请切换到「参考图」模式" };
      if (isSeedanceModel((td.model as string) || ""))
        return { title: "Seedance 模型不支持参考视频" };
      type VideoRef = { sourceCardId: string };
      const videos = (td.refVideos as VideoRef[]) || [];
      if (videos.some((v) => v.sourceCardId === sourceCardId)) return true;
      // omni-edit 只接受 1 段源视频; 其余 (seedance-v2 参考) 上限 3。
      const maxVideos = isOmniModel((td.model as string) || "") ? 1 : 3;
      if (videos.length < maxVideos) return true;
      return maxVideos === 1
        ? { title: "源视频已连接", description: "omni 视频编辑只能连 1 段源视频，请先断开已有连线" }
        : { title: "参考视频已满", description: "最多 3 段，请先断开已有连线" };
    }

    // kind === "image"
    if (mode === "reference") {
      const slots = getRefSlotsForVideoModel((td.model as string) || "", "reference");
      const refImages = (td.refImages || {}) as Record<string, RefImageEntry>;
      for (const slot of slots) {
        if (refImages[slot.key]?.sourceCardId === sourceCardId) return true;
      }
      return slots.some((s) => !refImages[s.key])
        ? true
        : { title: "参考图已满", description: "请先移除已有参考图或断开连线" };
    }

    // firstLastFrame: 首帧 + 尾帧,最多 2 张
    type FrameRef = { url: string; sourceCardId: string };
    const frames = (td.refFrames as FrameRef[]) || [];
    if (frames.some((f) => f.sourceCardId === sourceCardId)) return true;
    if (frames.length < 2) return true;
    // omni: 首尾帧满 2 帧后再连图 → 允许, 注入时自动切到参考模式 (P4-A, 见 injectIntoCard)。
    if (isOmniModel((td.model as string) || "")) return true;
    return { title: "参考帧已满", description: "最多 2 帧，请先断开已有连线" };
  }

  // video → ai_chat / ai_script
  if ((target.type === "ai_chat" || target.type === "ai_script") && kind === "video") {
    type VideoRef = { sourceCardId: string };
    const videos = (td.refVideos as VideoRef[]) || [];
    if (videos.some((v) => v.sourceCardId === sourceCardId)) return true;
    return videos.length < 3
      ? true
      : { title: "参考视频已满", description: "最多 3 段，请先断开已有连线" };
  }

  // image → ai_tryon
  if (target.type === "ai_tryon") {
    const refImages = (td.refImages || {}) as Record<string, RefImageEntry>;
    if (!td.personImageUrl || refImages.person?.sourceCardId === sourceCardId) return true;
    if (!td.garmentImageUrl || refImages.garment?.sourceCardId === sourceCardId) return true;
    return { title: "参考图已满", description: "人物图和服装图都已占用，请先断开已有连线" };
  }

  // image → ai_image / ai_multiangle / ai_chat
  const slots = getRefSlots({ type: target.type, data: td });
  const refImages = (td.refImages || {}) as Record<string, RefImageEntry>;
  for (const slot of slots) {
    if (refImages[slot.key]?.sourceCardId === sourceCardId) return true;
  }
  return slots.some((s) => !refImages[s.key])
    ? true
    : { title: "参考图已满", description: "请先移除已有参考图或断开连线" };
}

// removeRefImageForSource / hasRefImages / getRefSlotsAny 已移除:
// 参考图删除统一走 refImageSlots.removeSources(连线断开时由 referenceConsistency 调用)。
// 「连线仍在、上游产物暂态为空」的情形**不删**参考图(见下方 propagateFromCard 的 none 分支),
// 否则重跑/报错会冲掉用户手动拖的顺序。

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
  if (!target || (target.type !== "ai_video" && target.type !== "ai_chat" && target.type !== "ai_script")) return;

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
    case "ai_chat":
    case "ai_script": {
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
  if (payload.kind !== "text" && !canKindFlowInto(payload.kind as PayloadKind, target.type)) {
    log.error(
      `BUG: payload "${payload.kind}" → target "${target.type}" 不兼容,`,
      `canAcceptConnection 应该已拦截此连线。源卡: ${sourceCardId}`,
    );
    return false;
  }
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

    case "ai_chat":
    case "ai_script": {
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
        const m = upsertBySource(
          d.refImages as RefImages | undefined,
          getRefSlotsForChatModel((d.model as string) || ""),
          sourceCardId,
          payload.url,
        );
        if (m.changed) {
          d.refImages = m.refImages;
          d.upstreamCardId = sourceCardId;
          changed = true;
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
        log.log("ai_image 注入文本", {
          sourceCardId,
          targetId: target.id,
          textLength: payload.text.length,
          textPreview: payload.text.slice(0, 100),
        });
      } else if (payload.kind === "image") {
        const m = upsertBySource(
          d.refImages as RefImages | undefined,
          getRefSlotsForModel((d.model as string) || ""),
          sourceCardId,
          payload.url,
        );
        if (m.changed) {
          d.refImages = m.refImages;
          d.upstreamCardId = sourceCardId;
          changed = true;
        } else if (!m.refImages || Object.keys(m.refImages).length >= getRefSlotsForModel((d.model as string) || "").length) {
          log.warn("ai_image 图片注入失败: 所有槽位已满", { sourceCardId, targetId: target.id });
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
        const imageMode = resolveVideoImageMode(d.imageMode as string);

        if (imageMode === "reference") {
          const m = upsertBySource(
            d.refImages as RefImages | undefined,
            getRefSlotsForVideoModel((d.model as string) || "", "reference"),
            sourceCardId,
            payload.url,
          );
          if (m.changed) {
            d.refImages = m.refImages;
            changed = true;
          }
        } else {
          const maxFrames = 2;
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
          } else if (isOmniModel((d.model as string) || "")) {
            // omni P4-A: 首尾帧已满 2 帧 (i2v 上游仅吃首+尾), 第 3 张图 → 自动切参考模式 (r2v),
            // 把已有 2 帧 + 新图都迁到 refImages, 清空 refFrames。reference 槽位足够 (OMNI 7 张)。
            const slots = getRefSlotsForVideoModel((d.model as string) || "", "reference");
            const migrated: Record<string, RefImageEntry> = {};
            [...frames, { url: payload.url, sourceCardId }].forEach((f, i) => {
              const key = slots[i]?.key;
              if (key) migrated[key] = { url: f.url, sourceCardId: f.sourceCardId, sourceType: "card" };
            });
            d.imageMode = "reference";
            d.refImages = migrated;
            d.refFrames = undefined;
            changed = true;
          }
        }
      } else if (payload.kind === "audio") {
        if (
          resolveVideoImageMode(d.imageMode as string) === "reference"
          && !isOmniModel((d.model as string) || "")
        ) {
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
          resolveVideoImageMode(d.imageMode as string) === "reference"
          && !isSeedanceModel((d.model as string) || "")
        ) {
          // omni-edit 单源视频; 其余上限 3 (与 canAcceptConnection 同步)。
          const MAX_VIDEOS = isOmniModel((d.model as string) || "") ? 1 : 3;
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

    case "frame_extractor": {
      if (payload.kind === "text") {
        // 上游 ai_chat 的分镜分析结果(包含 JSON shots)
        if (d.upstreamChatResult !== payload.text) {
          d.upstreamChatResult = payload.text;
          d.upstreamChatCardId = sourceCardId;
          changed = true;
        }
      } else if (payload.kind === "video") {
        // 上游 ai_video 直接连过来,提供视频文件 URL
        if (d.sourceVideoUrl !== payload.url) {
          d.sourceVideoUrl = payload.url;
          d.sourceVideoCardId = sourceCardId;
          changed = true;
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
      // 参考图(refImages)**不在这里删**:downstream 全部来自现存连线,output=none
      // 几乎只发生在「上游正在重跑 / 报错」这类**暂态**(rerun 先 clearRunnableOutput 清产物
      // → dataVersion 变 → 本函数被 watcher 调到、此刻 output=none)。若此时把下游参考图删掉
      // 再 compact,等上游新产物落卡时 injectIntoCard 会把它塞进**第一个空槽**(队尾)——
      // 用户手动拖动的参考图顺序就被冲掉了(整组「重新生成」后顺序自己变)。
      // 参考图是「连线」语义,真正该删的时机是**连线被断开**——那条路由
      // referenceConsistency 的 onConnectionsRemoved 钩子兜底(权威删除路径)。
      // 这里保留旧图(下个产物到来时 injectIntoCard 原位更新),顺序与槽位都稳定。
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

/**
 * v5：dataFlow watcher 不再做 per-card JSON.stringify 快照对比。
 *
 * 旧实现：每次 cardStore subscribe 触发都遍历 **所有** cards 做 stringify，
 *         对 50 张卡 × 50 token/s 的流式期间是主线程持续被 stringify 占满
 *         （v4 漏修的高频累积卡顿源，见 docs/性能与IPC规范.md v5 章节）。
 *
 * 新实现：cardStore 在每次 data 真改动时维护 `dataVersion`（+1）和
 *         `lastMutatedDataIds`（本次涉及的 cardId 集合，原子写入）。watcher
 *         只需比 dataVersion 数字、对 lastMutatedDataIds 跑 propagate，
 *         单卡编辑只 propagate 单卡，根除 stringify。
 *
 * propagate 链式 / 死循环防护：`propagateFromCard` 内部调 `injectIntoCard`
 *         调 `updateCardData`，但 cardStore.updateCardData 内部有"实质性
 *         changed 检测"短路（patch 跟当前 data 等同则 return s 不触发
 *         setState），所以"父注入子但子的字段已是该值"不会再触发新一轮
 *         watcher，链式传播自然收敛。
 */
export function startDataFlowWatcher(): () => void {
  // 启动时一次性同步：把已有输出注入到下游卡片的空槽位
  const conns = useConnectionStore.getState().connections;
  log.log("初始同步开始, 连接数:", conns.size);
  for (const conn of conns.values()) {
    const source = useCardStore.getState().getCard(conn.sourceCardId);
    const target = useCardStore.getState().getCard(conn.targetCardId);
    if (!source || !target) continue;
    const output = extractOutput(source);
    log.log("初始同步检查连接:", {
      sourceId: conn.sourceCardId.slice(0, 8),
      sourceType: source.type,
      targetId: conn.targetCardId.slice(0, 8),
      targetType: target.type,
      outputKind: output.kind,
    });
    if (output.kind !== "none") {
      const injected = injectIntoCard(target, output, conn.sourceCardId);
      log.log("初始同步注入结果:", injected, "→", target.title);
    }
  }

  // 订阅 dataVersion：每次有卡片真改 data，对 lastMutatedDataIds 跑 propagate。
  const unsubCards = useCardStore.subscribe((state, prev) => {
    if (state.dataVersion === prev.dataVersion) return;
    const generating = useUIStore.getState().generatingCards;
    for (const id of state.lastMutatedDataIds) {
      if (generating.has(id)) continue;
      propagateFromCard(id);
    }
  });

  let prevGeneratingIds = new Set(useUIStore.getState().generatingCards.keys());

  const unsubUI = useUIStore.subscribe((state) => {
    const currentIds = new Set(state.generatingCards.keys());
    for (const id of prevGeneratingIds) {
      if (!currentIds.has(id)) {
        // 生成结束的瞬间：现在再 propagate 上游输出到下游空槽。
        propagateFromCard(id);
      }
    }
    prevGeneratingIds = currentIds;
  });

  return () => {
    unsubCards();
    unsubUI();
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
  // v5：不再维护 stringify 快照。updateCardData 内部 changed 短路保证
  // "注入相同值不会再触发 watcher"，无需额外快照。
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
