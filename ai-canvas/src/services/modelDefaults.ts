/**
 * 卡片默认模型解析 —— **全仓唯一口径**。
 *
 * ─── 为什么要有这一层 ───────────────────────────────────────────
 * 历史上"一张 model 为空的卡该用什么模型"这套逻辑(getLastModel(category) → 系统默认)
 * 被复制在 MediaEditor / VideoEditor / ChatEditor / TryOnEditor 各自的 on-mount
 * useEffect 里,而且**只有打开编辑器才会触发**。模板/批量创建(templateFactory)、
 * agent、组运行(cardRunner)这些不挂载编辑器 UI 的路径拿不到默认 → 卡片
 * `data.model` 一直为空 → 生成时 `tryResolveProvider("")` 失败,报
 * "当前模型不支持图片/视频生成"。(真实案例:右键加"服装多模态融合6"模板,
 * 效果图卡 model 为空,打组运行整层失败。)
 *
 * 这里把决策收成一个函数,**创建 / 编辑 / 运行三处共用**,杜绝口径分叉。
 */

import { modelService, type ModelRef } from "@/services/models";
import { useSettingsStore, type ModelCategory } from "@/stores/settingsStore";

/** 卡片类型 → settings.getLastModel 的分类 key;返回 null = 该类型没有"生成模型"概念。 */
function modelCategoryForCardType(type: string): ModelCategory | null {
  switch (type) {
    case "ai_image":
    case "ai_tryon":
      return "image";
    case "ai_multiangle":
      return "multiangle";
    case "ai_video":
      return "video";
    case "ai_chat":
      return "chat";
    default:
      // text / sticky_note / audio / frame_extractor:无生成模型
      return null;
  }
}

/** 无 last-used 时的系统兜底默认。multiangle 没有 modelService.getDefault*,沿用既有硬默认。 */
function systemDefaultModel(type: string): Promise<ModelRef> | null {
  switch (type) {
    case "ai_image":
    case "ai_tryon":
      return modelService.getDefaultImageModel();
    case "ai_video":
      return modelService.getDefaultVideoModel();
    case "ai_chat":
      return modelService.getDefaultChatModel();
    case "ai_multiangle":
      // 与 ImageToolbar 创建多角度卡时用的硬默认保持一致。
      return Promise.resolve({ modelId: "qwen-image-edit-2511-multipie", providerId: "comfly" });
    default:
      return null;
  }
}

/**
 * 解析某类型卡应使用的默认 model/provider。
 * 顺序:用户上次该类用过的模型(getLastModel) → 系统默认。
 * 返回 null = 该类型无模型概念(调用方应原样跳过,不要写 model)。
 */
export async function resolveDefaultModelForCardType(
  type: string,
): Promise<ModelRef | null> {
  const category = modelCategoryForCardType(type);
  if (!category) return null;
  const last = useSettingsStore.getState().getLastModel(category);
  if (last) return last;
  return systemDefaultModel(type);
}

/** 该类型卡是否需要 model(用于创建时决定要不要补默认)。 */
export function cardTypeNeedsModel(type: string): boolean {
  return modelCategoryForCardType(type) !== null;
}
