/**
 * 运行溯源戳 —— 一枚「本轮真生成」的凭证,存于 `card.data._run`,只经本模块读写。
 *
 * 为什么需要:判断「一张卡做没做完」**不能看它有没有产物** —— 模板演示图、导入内容、
 * 上一轮残留都会污染 imageUrl/results/videoUrl 字段。只有「有戳 && 戳里的输入指纹 ==
 * 当前输入指纹 && 非在途」才算真做完(见 runFreshness.isCardFresh)。
 *
 * ─── 生命周期(唯一原则:fp 在提交时捕获,成功只确认不重算)──────
 *   提交(submit) ─► beginGeneration : 写 { fp: 指纹(现), at: now, pending: true }
 *      ├─ 成功 ───► confirmGeneration: pending=false(fp/at 不动)
 *      ├─ 失败 ───► failGeneration   : 清戳(回到「无戳」→ 必重跑)
 *      └─ 取消 ───► failGeneration   : 同失败
 *
 *  fp 提交时即落 card.data(天然持久化),无需穿过 provider/task 类型。崩溃恢复:
 *  pending:true 已落库,重启后任务 resume 成功 → confirm 翻 false;任务丢失 → pending
 *  恒 true → isCardFresh 为假 → 下次断点运行重跑。安全。
 */

import type { CanvasCard } from "@/types";
import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { runInputFingerprint } from "./runInputs";

export interface CardRunProvenance {
  /** 提交时捕获的输入指纹。 */
  fp: string;
  /** ISO 时间(成功确认时间;pending 期间为提交时间)。 */
  at: string;
  /** true = 已提交、未确认成功(在途 / 崩溃残留);false/缺省 = 已确认。 */
  pending?: boolean;
}

/** card.data 内运行期元字段,沿用 `_` 前缀规约(同 `_showLabel` / `_systemPrompt`)。 */
const RUN_KEY = "_run";

/** 读戳(裸读裸写禁止,只经此)。结构非法 → 当作无戳。 */
export function getRunProvenance(card: CanvasCard): CardRunProvenance | undefined {
  const raw = (card.data as Record<string, unknown> | undefined)?.[RUN_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<CardRunProvenance>;
  if (typeof r.fp !== "string") return undefined;
  return {
    fp: r.fp,
    at: typeof r.at === "string" ? r.at : "",
    pending: r.pending === true,
  };
}

function writeRun(cardId: string, run: CardRunProvenance | undefined): void {
  useCardStore.getState().updateCardData(cardId, { [RUN_KEY]: run });
  autoSave.markDirty(cardId);
}

/**
 * 提交咽喉调用:捕获当前输入指纹,写 pending 戳。
 * 放在 build*Request 归一好 model/输入之后、调 provider 之前(见 cardRunner 提交点)。
 */
export function beginGeneration(cardId: string): void {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return;
  writeRun(cardId, {
    fp: runInputFingerprint(card),
    at: new Date().toISOString(),
    pending: true,
  });
}

/** 成功确认:只翻 pending=false,**不重算 fp**(生成途中用户改卡也不污染本轮溯源)。 */
export function confirmGeneration(cardId: string): void {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return;
  const cur = getRunProvenance(card);
  if (!cur) return; // 没 begin 过(未挂溯源的路径)→ 不无中生有
  writeRun(cardId, { fp: cur.fp, at: cur.at || new Date().toISOString(), pending: false });
}

/** 失败 / 取消:清戳,回到「无戳」→ 下次断点运行必重跑。 */
export function failGeneration(cardId: string): void {
  const card = useCardStore.getState().getCard(cardId);
  if (!card || !getRunProvenance(card)) return; // 无戳可清则免一次写
  writeRun(cardId, undefined);
}
