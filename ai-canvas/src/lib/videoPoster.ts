//! AI 生成视频补 poster —— 让"刚生成好 / 历史遗留"的视频卡显示首帧而非全黑。
//!
//! 背景:VideoPreview 用 `<video preload="none">`,用户点播放前不解码视频帧,首帧
//! 完全依赖 `<video poster>` 属性。文件 drop 路径在 import 当场抽好了 poster
//! (useFileDrop),但 AI 生成路径(taskBridge / VideoEditor)只写 videoUrl、不抽
//! poster —— 于是生成出来的视频卡是黑的。本模块在视频卡"有 videoUrl 但缺 posterUrl"
//! 时补抽首帧、落盘、写回 `card.data.posterUrl`,VideoPreview 下一帧即显示首帧。
//!
//! 串行执行:WebView2 同时解码多个视频极易 OOM(本项目历史崩溃高发区),所以补 poster
//! 全局排成一条链,一次只解一个视频 —— 与 videoThumbnails 的"短期独占一个 offscreen
//! video"模式一致。

import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { persistImage, getDisplayUrl } from "@/lib/media";
import { extractFirstFrame } from "@/lib/videoThumbnails";

interface VideoCardData {
  videoUrl?: string;
  posterUrl?: string;
}

// 全局串行链:一次只跑一个抽帧 job,杜绝多视频并发解码 OOM。
let chain: Promise<void> = Promise.resolve();
// cardId 去重:同一张卡在 poster 落盘前不重复入队(组件 re-render 会反复触发)。
const inFlight = new Set<string>();

/**
 * 确保某张视频卡有 poster。幂等、fire-and-forget:已有 poster / 正在处理 / 远程视频
 * 一律直接跳过。调用方(VideoPreview)只需在"有 videoUrl 无 posterUrl"时喊一声。
 *
 * @param videoStoredPath card.data.videoUrl 的**存储路径**(相对路径,不是 displayUrl)。
 */
export function ensureVideoPoster(
  cardId: string,
  videoStoredPath: string,
  projectId?: string,
): void {
  if (!cardId || !videoStoredPath) return;
  // 远程视频抽帧会被 CORS taint(canvas 读不到像素)。等 mediaLocalize 后台收敛把它
  // 本地化后 videoUrl 变成本地路径,VideoPreview 会带新路径再喊一次,那时才抽得出。
  if (videoStoredPath.startsWith("http://") || videoStoredPath.startsWith("https://")) return;
  if (inFlight.has(cardId)) return;
  inFlight.add(cardId);
  chain = chain
    .then(() => extractAndStore(cardId, videoStoredPath, projectId))
    .catch((e) => { console.warn(`[videoPoster] ${cardId} 补 poster 失败`, e); })
    .finally(() => { inFlight.delete(cardId); });
}

async function extractAndStore(
  cardId: string,
  videoStoredPath: string,
  projectId?: string,
): Promise<void> {
  // 入队后、轮到执行前,卡片可能已被补 poster / 换了视频 / 被删 —— 先复核一遍。
  const before = useCardStore.getState().getCard(cardId);
  if (!before) return;
  const bd = before.data as VideoCardData;
  if (bd.posterUrl || bd.videoUrl !== videoStoredPath) return;

  const frame = await extractFirstFrame(getDisplayUrl(videoStoredPath));
  // 解码失败 / CORS taint → 不写空 poster,维持黑底(解码错误由 VideoPreview onError 兜底)。
  if (!frame?.dataUrl) return;

  const poster = await persistImage(frame.dataUrl, undefined, projectId);

  // persistImage 是 async,落盘期间卡片可能又变了 —— 写库前再复核一次。
  const after = useCardStore.getState().getCard(cardId);
  if (!after) return;
  const ad = after.data as VideoCardData;
  if (ad.posterUrl || ad.videoUrl !== videoStoredPath) return;

  useCardStore.getState().updateCardData(cardId, { posterUrl: poster.localPath });
  autoSave.markDirty(cardId);
}
