/**
 * 新鲜度判定 —— 断点续跑(resume)据此决定「跳过 or 重跑」一张卡。
 *
 * 新鲜 = 有戳 && 非在途 && 戳里的输入指纹 == 当前输入指纹。
 *   - 无戳(模板演示图 / 导入卡 / 从没真生成过)→ 不新鲜 → 重跑;
 *   - pending(在途 / 崩溃残留)→ 不新鲜 → 重跑;
 *   - 有戳但输入变了(改了提示词 / 换了上游图)→ 不新鲜 → 重跑;
 *   - 有戳且输入没变 → 新鲜 → 跳过。
 */

import type { CanvasCard } from "@/types";
import { getRunProvenance } from "./runProvenance";
import { runInputFingerprint } from "./runInputs";

/** 无运行语义、永远视为「已就绪」(resume 跳过)的类型。 */
const NO_RUN_TYPES = new Set<string>(["text", "sticky_note", "audio"]);

export function isCardFresh(card: CanvasCard): boolean {
  if (NO_RUN_TYPES.has(card.type)) return true;
  // frame_extractor:P0–P2 暂按「非新鲜」对待(每次都跑,与现状一致,不会漏跑);
  // P3 再加「已有派生子卡 && 抽帧参数未变」的幂等新鲜度,避免 resume 重复堆叠子卡。
  if (card.type === "frame_extractor") return false;
  const p = getRunProvenance(card);
  if (!p || p.pending) return false;
  return p.fp === runInputFingerprint(card);
}
