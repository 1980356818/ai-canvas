import { useRef, useCallback, useEffect, type RefObject } from "react";
import { useCardStore } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useUIStore } from "@/stores/uiStore";
import type { CanvasCard } from "@/types";
import { CARD_DEFAULTS, sizeFromRatio } from "@/shared/constants";
import { autoSave } from "@/lib/autoSave";
import { updateProjectMeta, onTauriFileDrop, isTauri } from "@/platform";
import { persistImage, getDisplayUrl, type PersistImageResult } from "@/lib/media";
import { ensureDisplayableImage, isHeicFile, convertHeicPath } from "@/lib/heicConverter";

// ── Utility helpers ─────────────────────────────────────────

function cardSizeFromPersist(
  saved: PersistImageResult,
): { width: number; height: number } {
  if (saved.width && saved.height && saved.width > 0 && saved.height > 0) {
    return sizeFromRatio(saved.width / saved.height);
  }
  return { width: CARD_DEFAULTS.ai_image.width, height: CARD_DEFAULTS.ai_image.height };
}

const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|avi|mkv)$/i;
const AUDIO_EXTENSIONS = /\.(wav|mp3)$/i;

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || VIDEO_EXTENSIONS.test(file.name);
}

function isVideoPath(path: string): boolean {
  return VIDEO_EXTENSIONS.test(path);
}

function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/") || AUDIO_EXTENSIONS.test(file.name);
}

function isAudioPath(path: string): boolean {
  return AUDIO_EXTENSIONS.test(path);
}

function getImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => { img.onload = null; img.onerror = null; resolve({ width: 0, height: 0 }); }, 5000);
    img.onload = () => { clearTimeout(timer); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { clearTimeout(timer); resolve({ width: 0, height: 0 }); };
    img.src = src;
  });
}

function getVideoDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    const cleanup = () => { video.onloadedmetadata = null; video.onerror = null; video.src = ""; };
    const timer = setTimeout(() => { cleanup(); resolve({ width: 0, height: 0 }); }, 5000);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      const { videoWidth: w, videoHeight: h } = video;
      cleanup();
      resolve({ width: w, height: h });
    };
    video.onerror = () => {
      clearTimeout(timer);
      cleanup();
      resolve({ width: 0, height: 0 });
    };
    video.src = src;
  });
}

async function videoCardSize(src: string): Promise<{ width: number; height: number }> {
  const dims = await getVideoDimensions(src);
  if (dims.width > 0 && dims.height > 0) {
    return sizeFromRatio(dims.width / dims.height);
  }
  return { width: CARD_DEFAULTS.ai_video.width, height: CARD_DEFAULTS.ai_video.height };
}

function canCardAcceptFileDrop(cardId: string): boolean {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return false;
  if (useUIStore.getState().generatingCards.has(cardId)) return false;
  if (card.type === "ai_image" || card.type === "ai_multiangle") {
    return !(card.data as { imageUrl?: string }).imageUrl;
  }
  if (card.type === "ai_tryon") {
    const d = card.data as { personImageUrl?: string; garmentImageUrl?: string };
    return !d.personImageUrl || !d.garmentImageUrl;
  }
  return false;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

async function handleDropOnCard(
  targetCardId: string,
  saved: PersistImageResult,
): Promise<void> {
  const latest = useCardStore.getState().getCard(targetCardId);
  if (!latest) return;
  const d = { ...latest.data } as Record<string, unknown>;
  const update: Partial<CanvasCard> = { data: d };
  if (latest.type === "ai_image" || latest.type === "ai_multiangle") {
    d.imageUrl = saved.localPath;
    const sized = cardSizeFromPersist(saved);
    const cx = latest.x + latest.width / 2;
    const cy = latest.y + latest.height / 2;
    update.x = cx - sized.width / 2;
    update.y = cy - sized.height / 2;
    update.width = sized.width;
    update.height = sized.height;
  } else if (latest.type === "ai_tryon") {
    if (!d.personImageUrl) d.personImageUrl = saved.localPath;
    else if (!d.garmentImageUrl) d.garmentImageUrl = saved.localPath;
  }
  useCardStore.getState().updateCard(targetCardId, update);
  autoSave.markDirty(targetCardId);
}

function createMediaCard(
  projectId: string,
  x: number,
  y: number,
  zIndex: number,
  width: number,
  height: number,
  isVideo: boolean,
  localPath: string,
  content: string,
): CanvasCard {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    projectId,
    type: isVideo ? "ai_video" : "ai_image",
    x: x - width / 2,
    y: y - height / 2,
    width,
    height,
    zIndex,
    locked: false,
    collapsed: false,
    data: isVideo
      ? { videoUrl: localPath, content }
      : { imageUrl: localPath, content },
    createdAt: now,
    updatedAt: now,
  };
}

function createAudioCard(
  projectId: string,
  x: number,
  y: number,
  zIndex: number,
  localPath: string,
  filename: string,
): CanvasCard {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    projectId,
    type: "audio",
    x: x - 120,
    y: y - 40,
    width: CARD_DEFAULTS.audio.width,
    height: CARD_DEFAULTS.audio.height,
    zIndex,
    locked: false,
    collapsed: false,
    data: { audioUrl: localPath, filename },
    createdAt: now,
    updatedAt: now,
  };
}

function updateNodeCount(projectId: string) {
  const count = useCardStore.getState().getCardsByProject(projectId).length;
  useProjectStore.getState().updateProject(projectId, { nodeCount: count });
  void updateProjectMeta(projectId, { nodeCount: count });
}

// ── Hook ────────────────────────────────────────────────────

export function useFileDrop(
  containerRef: RefObject<HTMLDivElement | null>,
  screenToCanvas: (x: number, y: number) => { x: number; y: number },
) {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const dropHandledAt = useRef(0);
  const fileDragTargetRef = useRef<string | null>(null);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!currentProjectId) return;
      const hasChatMedia = Array.from(e.dataTransfer.types).includes("application/x-chat-media");
      const hasFiles = Array.from(e.dataTransfer.types).includes("Files");
      if (!hasFiles && !hasChatMedia) return;
      e.preventDefault();
      if (hasChatMedia) {
        e.dataTransfer.dropEffect = "copy";
        return;
      }

      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cardEl = el?.closest("[data-card-id]") as HTMLElement | null;
      const candidateId = cardEl?.dataset.cardId ?? null;
      const newTargetId =
        candidateId && canCardAcceptFileDrop(candidateId) ? candidateId : null;

      if (newTargetId !== fileDragTargetRef.current) {
        if (fileDragTargetRef.current) {
          document
            .querySelector(`[data-card-id="${fileDragTargetRef.current}"]`)
            ?.classList.remove("file-drop-target");
        }
        fileDragTargetRef.current = newTargetId;
        if (newTargetId) {
          document
            .querySelector(`[data-card-id="${newTargetId}"]`)
            ?.classList.add("file-drop-target");
        }
      }
      e.dataTransfer.dropEffect = newTargetId ? "move" : "copy";
    },
    [currentProjectId],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      const related = e.relatedTarget as Node | null;
      if (related && containerRef.current?.contains(related)) return;
      if (fileDragTargetRef.current) {
        document
          .querySelector(`[data-card-id="${fileDragTargetRef.current}"]`)
          ?.classList.remove("file-drop-target");
        fileDragTargetRef.current = null;
      }
    },
    [containerRef],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      if (!currentProjectId) return;

      const chatMediaRaw = e.dataTransfer.getData("application/x-chat-media");
      if (chatMediaRaw) {
        try {
          const media = JSON.parse(chatMediaRaw) as {
            type: "image" | "video";
            url: string;
            prompt?: string;
          };
          const dropPos = screenToCanvas(e.clientX, e.clientY);
          const isVideo = media.type === "video";
          let cardW: number, cardH: number;
          if (isVideo) {
            ({ width: cardW, height: cardH } = await videoCardSize(getDisplayUrl(media.url)));
          } else {
            const dims = await getImageDimensions(getDisplayUrl(media.url));
            if (dims.width > 0 && dims.height > 0) {
              ({ width: cardW, height: cardH } = sizeFromRatio(dims.width / dims.height));
            } else {
              ({ width: cardW, height: cardH } = { width: CARD_DEFAULTS.ai_image.width, height: CARD_DEFAULTS.ai_image.height });
            }
          }

          const { maxZIndex } = useCardStore.getState();
          const card = createMediaCard(
            currentProjectId, dropPos.x, dropPos.y,
            maxZIndex + 1, cardW, cardH, isVideo, media.url, media.prompt ?? "",
          );
          useCardStore.getState().addCard(card);
          autoSave.markDirty(card.id);
          updateNodeCount(currentProjectId);
        } catch {
          /* skip malformed data */
        }
        return;
      }

      const rawFiles = Array.from(e.dataTransfer.files).filter(
        (f) => f.type.startsWith("image/") || isVideoFile(f) || isHeicFile(f) || isAudioFile(f),
      );
      if (rawFiles.length === 0) return;

      dropHandledAt.current = Date.now();

      const targetCardId = fileDragTargetRef.current;
      if (fileDragTargetRef.current) {
        document
          .querySelector(`[data-card-id="${fileDragTargetRef.current}"]`)
          ?.classList.remove("file-drop-target");
        fileDragTargetRef.current = null;
      }

      (async () => {
        const audioFiles = rawFiles.filter(isAudioFile);
        let dropPos = screenToCanvas(e.clientX, e.clientY);
        if (audioFiles.length > 0) {
          let audioOffsetY = 0;
          for (const af of audioFiles) {
            const dataUrl = await readFileAsDataUrl(af);
            const saved = await persistImage(dataUrl, undefined, currentProjectId);
            const { maxZIndex } = useCardStore.getState();
            const card = createAudioCard(
              currentProjectId, dropPos.x, dropPos.y + audioOffsetY,
              maxZIndex + 1, saved.localPath, af.name,
            );
            useCardStore.getState().addCard(card);
            autoSave.markDirty(card.id);
            audioOffsetY += CARD_DEFAULTS.audio.height + 10;
          }
          updateNodeCount(currentProjectId);
        }

        const mediaRawFiles = rawFiles.filter((f) => !isAudioFile(f));
        if (mediaRawFiles.length === 0) return;

        const files = await Promise.all(mediaRawFiles.map(ensureDisplayableImage));
        let startIdx = 0;

        if (targetCardId) {
          const targetCard = useCardStore.getState().getCard(targetCardId);
          if (targetCard) {
            const dataUrl = await readFileAsDataUrl(files[0]!);
            const saved = await persistImage(dataUrl, undefined, currentProjectId);
            await handleDropOnCard(targetCardId, saved);
            startIdx = 1;
          }
        }

        const remaining = files.slice(startIdx);
        if (remaining.length === 0) return;

        dropPos = screenToCanvas(e.clientX, e.clientY);
        const GAP = 20;
        let cursorX = 0;

        for (let idx = 0; idx < remaining.length; idx++) {
          const file = remaining[idx]!;
          const video = isVideoFile(file);
          const dataUrl = await readFileAsDataUrl(file);
          const saved = await persistImage(dataUrl, undefined, currentProjectId);

          let cardW: number, cardH: number;
          if (video) {
            const blobUrl = URL.createObjectURL(file);
            ({ width: cardW, height: cardH } = await videoCardSize(blobUrl));
            URL.revokeObjectURL(blobUrl);
          } else {
            ({ width: cardW, height: cardH } = cardSizeFromPersist(saved));
          }

          const { maxZIndex } = useCardStore.getState();
          const card = createMediaCard(
            currentProjectId, dropPos.x + cursorX, dropPos.y,
            maxZIndex + 1 + idx, cardW, cardH, video, saved.localPath, "",
          );
          useCardStore.getState().addCard(card);
          autoSave.markDirty(card.id);
          cursorX += cardW + GAP;
        }

        updateNodeCount(currentProjectId);
      })();
    },
    [currentProjectId, screenToCanvas],
  );

  // Tauri-native file-drop fallback
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    onTauriFileDrop(async (paths, sx, sy) => {
      if (cancelled) return;
      if (Date.now() - dropHandledAt.current < 1000) return;
      const pid = useProjectStore.getState().currentProjectId;
      if (!pid) return;

      const dpr = window.devicePixelRatio || 1;
      const cssx = sx / dpr;
      const cssy = sy / dpr;
      const rect = containerRef.current?.getBoundingClientRect();
      const cx = rect ? cssx - rect.left : cssx;
      const cy = rect ? cssy - rect.top : cssy;
      const vp = useCanvasStore.getState().viewport;
      const dropX = (cx - vp.x) / vp.zoom;
      const dropY = (cy - vp.y) / vp.zoom;
      const GAP = 20;

      let startIdx = 0;
      const el = document.elementFromPoint(cssx, cssy);
      const cardEl = el?.closest("[data-card-id]") as HTMLElement | null;
      const targetCardId = cardEl?.dataset.cardId ?? null;

      const audioPaths = paths.filter(isAudioPath);
      if (audioPaths.length > 0) {
        let audioOffsetY = 0;
        for (const ap of audioPaths) {
          try {
            const saved = await persistImage(ap, undefined, pid);
            const fname = ap.split(/[/\\]/).pop() ?? "audio";
            const { maxZIndex } = useCardStore.getState();
            const card = createAudioCard(
              pid, dropX, dropY + audioOffsetY,
              maxZIndex + 1, saved.localPath, fname,
            );
            useCardStore.getState().addCard(card);
            autoSave.markDirty(card.id);
            audioOffsetY += CARD_DEFAULTS.audio.height + 10;
          } catch { /* skip */ }
        }
      }

      if (targetCardId && canCardAcceptFileDrop(targetCardId)) {
        const nonAudioPaths = paths.filter((p) => !isAudioPath(p));
        if (nonAudioPaths.length > 0) {
          try {
            const src0 = await convertHeicPath(nonAudioPaths[0]!);
            const saved = await persistImage(src0, undefined, pid);
            await handleDropOnCard(targetCardId, saved);
            startIdx = 1;
          } catch { /* skip */ }
        }
      }

      const remainingPaths = paths.filter((p) => !isAudioPath(p));
      let tauriCursorX = 0;
      for (let i = startIdx; i < remainingPaths.length; i++) {
        try {
          const rawPath = remainingPaths[i]!;
          const video = isVideoPath(rawPath);
          const filePath = video ? rawPath : await convertHeicPath(rawPath);
          const saved = await persistImage(filePath, undefined, pid);

          let cardW: number, cardH: number;
          if (video) {
            ({ width: cardW, height: cardH } = await videoCardSize(getDisplayUrl(saved.localPath)));
          } else {
            ({ width: cardW, height: cardH } = cardSizeFromPersist(saved));
          }

          const { maxZIndex } = useCardStore.getState();
          const card = createMediaCard(
            pid, dropX + tauriCursorX, dropY,
            maxZIndex + 1 + (i - startIdx), cardW, cardH, video, saved.localPath, "",
          );
          useCardStore.getState().addCard(card);
          autoSave.markDirty(card.id);
          tauriCursorX += cardW + GAP;
        } catch { /* skip */ }
      }

      updateNodeCount(pid);
    }).then((fn) => { unlisten = fn; });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [containerRef]);

  return { handleDragOver, handleDragLeave, handleDrop };
}
