import { useRef, useCallback, type RefObject } from "react";
import { useCardStore } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import type { CanvasCard } from "@/types";
import { CARD_DEFAULTS, sizeFromRatio } from "@/shared/constants";
import {
  IMAGE_EXTENSIONS_REGEX,
  VIDEO_EXTENSIONS_REGEX,
  AUDIO_EXTENSIONS_REGEX,
} from "@/shared/mediaFormats";
import { autoSave } from "@/lib/autoSave";
import { updateProjectMeta } from "@/platform";
import {
  persistFile,
  persistImage,
  getDisplayUrl,
  normalizeToStoragePath,
  type PersistImageResult,
} from "@/lib/media";
import { ensureDisplayableImage, isHeicFile } from "@/lib/heicConverter";
import { runWithLimit } from "@/lib/concurrency";
import { extractFirstFrame } from "@/lib/videoThumbnails";

// Utility helpers

function cardSizeFromPersist(
  saved: PersistImageResult,
): { width: number; height: number } {
  if (saved.width && saved.height && saved.width > 0 && saved.height > 0) {
    return sizeFromRatio(saved.width / saved.height);
  }
  return { width: CARD_DEFAULTS.ai_image.width, height: CARD_DEFAULTS.ai_image.height };
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS_REGEX.test(file.name) || isHeicFile(file);
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || VIDEO_EXTENSIONS_REGEX.test(file.name);
}

function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/") || AUDIO_EXTENSIONS_REGEX.test(file.name);
}

function unsupportedVideoToast(filename: string): void {
  useUIStore.getState().addToast({
    type: "error",
    title: "视频格式不支持",
    description: `「${filename}」无法播放。常见原因：HEVC/H.265 编码（Windows 需安装 HEVC 视频扩展，或转成 H.264 的 MP4）。`,
    duration: 6000,
  });
}

type DragFileKinds = { hasImage: boolean; hasVideo: boolean };

// dragover 阶段拿不到 File 对象,只能读 DataTransferItem.kind+.type(MIME)。
// MIME 缺失时(部分跨应用拖拽 / WebView)退化成"两种都假设有",避免误拒。
function itemsFileKinds(items: DataTransferItemList): DragFileKinds {
  let hasImage = false;
  let hasVideo = false;
  let totalFiles = 0;
  let typedFiles = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind !== "file") continue;
    totalFiles += 1;
    if (!it.type) continue;
    typedFiles += 1;
    if (it.type.startsWith("image/")) hasImage = true;
    else if (it.type.startsWith("video/")) hasVideo = true;
  }
  if (totalFiles > 0 && typedFiles === 0) {
    return { hasImage: true, hasVideo: true };
  }
  return { hasImage, hasVideo };
}

function filesKinds(files: File[]): DragFileKinds {
  let hasImage = false;
  let hasVideo = false;
  for (const f of files) {
    if (isImageFile(f)) hasImage = true;
    if (isVideoFile(f)) hasVideo = true;
  }
  return { hasImage, hasVideo };
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

function canCardAcceptFileDrop(cardId: string, kinds: DragFileKinds): boolean {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return false;
  if (useUIStore.getState().generatingCards.has(cardId)) return false;
  if (card.type === "ai_image" || card.type === "ai_multiangle") {
    return kinds.hasImage;
  }
  if (card.type === "ai_video") {
    return kinds.hasVideo;
  }
  if (card.type === "ai_tryon") {
    if (!kinds.hasImage) return false;
    const d = card.data as { personImageUrl?: string; garmentImageUrl?: string };
    return !d.personImageUrl || !d.garmentImageUrl;
  }
  return false;
}

function findAcceptingCardIdAt(
  clientX: number,
  clientY: number,
  kinds: DragFileKinds,
): string | null {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const cardEl = el.closest("[data-card-id]") as HTMLElement | null;
    const candidateId = cardEl?.dataset.cardId ?? null;
    if (candidateId && canCardAcceptFileDrop(candidateId, kinds)) return candidateId;
  }
  return null;
}

function findAcceptingCardIdAtCanvasPoint(
  projectId: string,
  worldX: number,
  worldY: number,
  kinds: DragFileKinds,
): string | null {
  const cards = useCardStore
    .getState()
    .getCardsByProject(projectId)
    .filter(
      (card) =>
        worldX >= card.x &&
        worldX <= card.x + card.width &&
        worldY >= card.y &&
        worldY <= card.y + card.height,
    )
    .sort((a, b) => b.zIndex - a.zIndex);

  return cards.find((card) => canCardAcceptFileDrop(card.id, kinds))?.id ?? null;
}

function findAcceptingCardIdAtClientPoint(
  projectId: string,
  clientX: number,
  clientY: number,
  screenToCanvas: (x: number, y: number) => { x: number; y: number },
  kinds: DragFileKinds,
): string | null {
  const domHit = findAcceptingCardIdAt(clientX, clientY, kinds);
  if (domHit) return domHit;
  const world = screenToCanvas(clientX, clientY);
  return findAcceptingCardIdAtCanvasPoint(projectId, world.x, world.y, kinds);
}

// 历史:clientPointToCanvas / readFileAsDataUrl 已在 2026-05-23 移除。
//   - clientPointToCanvas:只被已删的 Tauri-native drop 用,liveViewport 也跟着不再 import
//   - readFileAsDataUrl:所有调用方改走 `persistFile(file, ...)`,在那里按 size 自动
//     分流:小文件走 dataURL + 单 invoke;大文件走 `persistLargeFile` 分块上传。
//     根治了"大视频/大图 dataURL 撞 IPC 雷区"的崩溃链。

async function handleDropOnCard(
  targetCardId: string,
  saved: PersistImageResult,
  videoExtras?: { width: number; height: number; posterPath?: string },
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
  } else if (latest.type === "ai_video" && videoExtras) {
    d.videoUrl = saved.localPath;
    d.posterUrl = videoExtras.posterPath;
    const sized = sizeFromRatio(videoExtras.width / videoExtras.height);
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
  posterPath?: string,
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
      ? { videoUrl: localPath, posterUrl: posterPath, content }
      : { imageUrl: localPath, content },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 把 `extractFirstFrame` 返回的 JPEG dataUrl 落盘成 poster 文件。
 * 失败不阻断主流程 —— 此时建一张没 poster 的卡，VideoPreview 退化成黑底。
 */
async function persistPoster(
  frameDataUrl: string | null,
  projectId: string,
): Promise<string | undefined> {
  if (!frameDataUrl) return undefined;
  try {
    const p = await persistImage(frameDataUrl, undefined, projectId);
    return p.localPath;
  } catch {
    return undefined;
  }
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

// Hook

export function useFileDrop(
  containerRef: RefObject<HTMLDivElement | null>,
  screenToCanvas: (x: number, y: number) => { x: number; y: number },
) {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
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

      const kinds = itemsFileKinds(e.dataTransfer.items);
      const newTargetId = findAcceptingCardIdAtClientPoint(
        currentProjectId,
        e.clientX,
        e.clientY,
        screenToCanvas,
        kinds,
      );

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
    [currentProjectId, screenToCanvas],
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
          const safeUrl = normalizeToStoragePath(media.url) ?? media.url;
          const card = createMediaCard(
            currentProjectId, dropPos.x, dropPos.y,
            maxZIndex + 1, cardW, cardH, isVideo, safeUrl, media.prompt ?? "",
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
        (f) => isImageFile(f) || isVideoFile(f) || isAudioFile(f),
      );
      if (rawFiles.length === 0) return;

      const dropKinds = filesKinds(rawFiles);
      const targetCardId =
        fileDragTargetRef.current ??
        findAcceptingCardIdAtClientPoint(
          currentProjectId,
          e.clientX,
          e.clientY,
          screenToCanvas,
          dropKinds,
        );
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
            // 音频常常 > 1.5MB → 走 persistFile 自动分流(大文件分块上传)
            const saved = await persistFile(af, undefined, currentProjectId);
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

        // 用户一次拖 N 个 HEIC：libheif decode 走 wasm/canvas，N 个并发会同时
        // 占满 N 张全分辨率 RGBA bitmap。限到 4 并发避免 GPU/JS heap 暴涨。
        const heicSettled = await runWithLimit(
          mediaRawFiles.map((f) => () => ensureDisplayableImage(f)),
          4,
        );
        let files = heicSettled.map((r, i) =>
          r.status === "fulfilled" ? r.value : mediaRawFiles[i]!,
        );

        if (targetCardId) {
          const targetCard = useCardStore.getState().getCard(targetCardId);
          if (targetCard) {
            // 按目标卡类型挑该消费哪个文件 —— 视频卡只吃视频,图片/换装卡只吃图片。
            // 拖错类型时 consumedIdx=-1,该文件留到下面循环作为新卡。
            let consumedIdx = -1;
            if (targetCard.type === "ai_video") {
              const idx = files.findIndex(isVideoFile);
              if (idx !== -1) {
                const vf = files[idx]!;
                const blobUrl = URL.createObjectURL(vf);
                const frame = await extractFirstFrame(blobUrl);
                URL.revokeObjectURL(blobUrl);
                if (frame) {
                  const saved = await persistFile(vf, undefined, currentProjectId);
                  const posterPath = await persistPoster(frame.dataUrl, currentProjectId);
                  await handleDropOnCard(targetCardId, saved, {
                    width: frame.width,
                    height: frame.height,
                    posterPath,
                  });
                  consumedIdx = idx;
                } else {
                  // 解码失败:报错,同时消费掉这个文件免得下面循环再次黑卡 + 重复 toast
                  unsupportedVideoToast(vf.name);
                  consumedIdx = idx;
                }
              }
            } else {
              const idx = files.findIndex(isImageFile);
              if (idx !== -1) {
                const saved = await persistFile(files[idx]!, undefined, currentProjectId);
                await handleDropOnCard(targetCardId, saved);
                consumedIdx = idx;
              }
            }
            if (consumedIdx !== -1) {
              files = files.filter((_, i) => i !== consumedIdx);
            }
          }
        }

        const remaining = files;
        if (remaining.length === 0) return;

        dropPos = screenToCanvas(e.clientX, e.clientY);
        const GAP = 20;
        let cursorX = 0;

        for (let idx = 0; idx < remaining.length; idx++) {
          const file = remaining[idx]!;
          const video = isVideoFile(file);

          let cardW = 0;
          let cardH = 0;
          let posterPath: string | undefined;

          // 视频：import 时让 WebView 自己探一次解码 + 抽第一帧。失败就直接拒,别走完
          // base64 IPC + 写盘之后让用户对着黑卡发愣。preload="none" 让卡片上的 <video>
          // 在用户点播放前不加载元数据,所以缩略图必须在 drop 这一刻当场抽,事后没机会。
          // 典型踩坑:iPhone/QuickTime 导出的 HEVC mp4 在无 HEVC 扩展的 Windows WebView2
          // 必然失败;Mac WKWebView 上 HEVC-in-mp4 也比 HEVC-in-mov 脆弱得多。
          if (video) {
            const blobUrl = URL.createObjectURL(file);
            const frame = await extractFirstFrame(blobUrl);
            URL.revokeObjectURL(blobUrl);
            if (!frame) {
              unsupportedVideoToast(file.name);
              continue;
            }
            ({ width: cardW, height: cardH } = sizeFromRatio(frame.width / frame.height));
            posterPath = await persistPoster(frame.dataUrl, currentProjectId);
          }

          // 视频 / 大图都走 persistFile —— 大文件自动改走分块上传,不再撞 IPC 雷区
          const saved = await persistFile(file, undefined, currentProjectId);
          if (!video) {
            ({ width: cardW, height: cardH } = cardSizeFromPersist(saved));
          }

          const { maxZIndex } = useCardStore.getState();
          const card = createMediaCard(
            currentProjectId, dropPos.x + cursorX, dropPos.y,
            maxZIndex + 1 + idx, cardW, cardH, video, saved.localPath, "",
            posterPath,
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

  // 历史:Tauri-native file-drop fallback 已在 2026-05-23 删除。
  //
  // 之前 130 行代码监听 `tauri://file-drop` 事件,只在 tauri.conf.json 的
  // `dragDropEnabled: true` 下才会触发,而我们一直设 false —— 路径死的。
  //
  // 它本身还有一个未修的 bug:visual probe 失败时,文件已被 save_media 复制
  // 进 media/images + 用户 auto-save 目录,留下两个孤儿文件没人清。要复活
  // native drop 必须配套加 stage/commit 两阶段 + delete_media 命令。
  //
  // 现在 HTML drag-drop 走 persistFile 自动分流(小文件 dataURL / 大文件
  // 分块上传)已经能覆盖所有场景,包括 100MB 视频 —— 没有保留 native drop
  // 路径的必要。要恢复请阅读: docs/性能与IPC规范.md §12 之前的版本 +
  // git log -- src/hooks/useFileDrop.ts。

  return { handleDragOver, handleDragLeave, handleDrop };
}

