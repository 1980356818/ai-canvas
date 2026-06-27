/**
 * 图片产物 → 卡片几何的**统一收口**(单一真相的「写」侧)。
 *
 * `lib/imageSize` 是「图片真实宽高 → 卡尺寸」的纯换算单一真相;本模块是它在**卡片落库**这一侧的
 * 唯一执行点:任何「把一张图的生成结果写进 ai_image / ai_multiangle / ai_tryon 卡」的路径,都必须
 * 在写完图片字段后调用 {@link normalizeImageCardGeometry},让卡片几何跟随产物的真实比例。
 *
 * ## 为什么需要它(历史坑)
 * 卡片的 `width/height` 与生成参数 `data.size`(如 "3:4")是**两个独立量**:size 只是发给模型的
 * 目标比例,卡框几何并不会自动跟随。出图结果回写走 `taskBridge` / `cardRunner` 这两条路径,它们从不
 * 改几何,于是 3:4 竖图被塞进默认/导入的方框里(object-cover 裁切)显示成「方形」。本模块把几何归一
 * 从「某几条路径各自记得调」收敛成「所有落卡路径共用的一个闸口」,并由
 * `scripts/check-image-landing.mjs` 在构建期强制(见该脚本)。
 *
 * ## 契约
 * - **fire-and-forget**:调用方 `void` 调用即可,不阻塞图片字段的即时落库(几何随图片 load 完成后
 *   补写,通常画布已缓存该图 → 近乎瞬时)。
 * - **幂等**:宽高已是目标值则不写、不 markDirty。
 * - **永不抛错**:`imageCardSizeFromUrl` 失败回退方形,卡不存在/类型不符则静默跳过。
 */

import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { getDisplayUrl } from "@/lib/media";
import { imageCardSizeFromUrl } from "@/lib/imageSize";
import type { CardType } from "@/types";

/**
 * 出图结果会落「图片产物」字段、且卡框需按图片真实比例定尺寸的卡类型。
 * ai_video 不在此列:视频尺寸要用 `<video>` 量,且 VideoEditor 另有归一路径。
 */
const IMAGE_RESULT_CARD_TYPES: ReadonlySet<CardType> = new Set<CardType>([
  "ai_image",
  "ai_multiangle",
  "ai_tryon",
]);

/** 该卡类型是否为「图片产物卡」(落图后应按真实比例归一几何)。 */
export function isImageResultCardType(type: CardType): boolean {
  return IMAGE_RESULT_CARD_TYPES.has(type);
}

/**
 * 把卡片几何归一到结果图的真实比例(长边 = `CARD_MAX_EDGE`,与 `sizeFromRatio` 同口径,
 * 保证全应用图片卡尺度一致)。
 *
 * @param cardId    目标卡片 id。
 * @param resultUrl 结果图地址(远程上游 URL 或本地缓存路径均可,内部经 `getDisplayUrl` 归一)。
 */
export async function normalizeImageCardGeometry(
  cardId: string,
  resultUrl: string,
): Promise<void> {
  if (!resultUrl) return;

  const card = useCardStore.getState().getCard(cardId);
  if (!card || !isImageResultCardType(card.type)) return;

  const { width, height } = await imageCardSizeFromUrl(getDisplayUrl(resultUrl));

  // 异步量图期间卡可能被删/换项目 → 重新读取;宽高已是目标值则不写(幂等 + 不脏标记)。
  const fresh = useCardStore.getState().getCard(cardId);
  if (!fresh || !isImageResultCardType(fresh.type)) return;
  if (fresh.width === width && fresh.height === height) return;

  useCardStore.getState().updateCard(cardId, { width, height });
  autoSave.markDirty(cardId);
}
