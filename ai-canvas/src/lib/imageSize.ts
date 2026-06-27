/**
 * 图片 → 画布卡尺寸的**单一真相**(换算侧)。
 *
 * 任何"把一张图落成 ai_image 卡"的路径(文件/聊天媒体拖入、出图结果回写、换装/多角度…)
 * 都必须经此把图片真实宽高换算成卡尺寸,杜绝各处各算导致比例漂移。
 *
 * 历史坑:出图结果回写卡片(`taskBridge`/`cardRunner`)只写图片字段、从不改卡片几何 →
 * 3:4 竖图被塞进默认/导入的方框里被 object-cover 裁切显示成「方形」。根治 = 落卡前量真实
 * 宽高按比例定卡(长边 = `CARD_MAX_EDGE`,与 `sizeFromRatio` 同口径)。
 */

import { sizeFromRatio } from "@/shared/constants";

/**
 * 载入图片取其自然宽高(用于换算卡片比例)。
 * 失败 / 5s 超时 → 返回 {0,0}(调用方据此回退默认尺寸)。永不 reject。
 */
export function getImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      resolve({ width: 0, height: 0 });
    }, 5000);
    img.onload = () => {
      clearTimeout(timer);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve({ width: 0, height: 0 });
    };
    img.src = src;
  });
}

/**
 * 把图片(显示地址)的真实宽高换算成画布卡尺寸(长边 = `CARD_MAX_EDGE`)。
 * 载入失败 / 拿不到尺寸 → 回退方形,保证落卡永远成功、不卡死。
 *
 * @param displayUrl 已经过 `getDisplayUrl` 转换的可加载地址(http(s)/asset/本地缓存皆可)。
 */
export async function imageCardSizeFromUrl(
  displayUrl: string,
): Promise<{ width: number; height: number }> {
  const dims = await getImageDimensions(displayUrl);
  if (dims.width > 0 && dims.height > 0) {
    return sizeFromRatio(dims.width / dims.height);
  }
  return sizeFromRatio(1);
}
