/**
 * 编辑器"生成"十步骨架的统一包装(施工图 §P2.5)。
 *
 * 5 个编辑器 handleGenerate 的公共外壳 —— 此前各写一份:
 *   1. API Key 预检(没配就弹"去设置"toast 并中止);
 *   2. 提交瞬间写占位进度 + 清本地/全局 error 态;
 *   3. try { … } catch(友好化错误 → setError + setCardError) finally(清进度)。
 *
 * 真正干活(build*Request → provider 调用 → 编辑器特有善后)塞进 `run` thunk。
 * 约束违例(built.ok === false)由 run 内部按各编辑器口径处理(toast / setError)后
 * 自行 return —— 本包装只管骨架,不掺业务分支。
 *
 * 不放进来的(编辑器特有,留在各自 run / handleGenerate):
 *   - prompt / 素材 守卫(条件各不相同,放在调用本包装之前);
 *   - 批量循环(MediaEditor)、几何 resize、结果回写、成功 toast。
 */

import type { CanvasCard } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { hasApiKey } from "@/platform";
import { friendlyError } from "@/lib/errors";
import { diagInfo, diagWarn, diagError } from "@/lib/diag";

export interface RunEditorGenerationOptions {
  /** 编辑器本地 error 态 setter:本包装会 setError(null) 重置、出错时 setError(友好消息)。 */
  setError: (msg: string | null) => void;
  /** 提交瞬间的占位进度文案。默认"正在提交请求…";ChatEditor 传"正在生成…"。 */
  submitLabel?: string;
  /** 干活体:build*Request → provider → 善后。约束违例在内部自行 toast/setError 后 return。 */
  run: () => Promise<void>;
}

/**
 * 包住编辑器一次"生成"的公共骨架。先过 API Key 预检,再点亮进度、清错误,
 * 跑 `run`,统一兜错与收尾(清进度)。
 */
export async function runEditorGeneration(
  card: CanvasCard,
  opts: RunEditorGenerationOptions,
): Promise<void> {
  diagInfo("editor-gen", "② runEditorGeneration 开始(即将 API Key 预检)", { cardId: card.id });
  if (!(await hasApiKey())) {
    diagWarn("editor-gen", "② 无 API Key，弹 toast 并静默中止(不会有后端日志)", { cardId: card.id });
    useUIStore.getState().addToast({
      type: "warning",
      title: "请先配置 API Key",
      description: "前往设置页面配置你的 API Key",
      action: {
        label: "打开设置",
        onClick: () => useUIStore.getState().toggleSettings(),
      },
      duration: 5000,
    });
    return;
  }

  // 这一行把 card 标记为「生成中」(generatingCards.has(card.id)=true) —— 编辑器的
  // generating 守卫就读它。**只有下面的 finally 能解除**;若 run() 永不 settle(流式
  // 既不 done 也不 error),finally 不执行 → generating 永真 → 之后点生成全部静默 return。
  useUIStore.getState().setCardProgress(card.id, {
    percent: 0,
    label: opts.submitLabel ?? "正在提交请求…",
  });
  opts.setError(null);
  useUIStore.getState().setCardError(card.id, null);

  try {
    await opts.run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errMsg = friendlyError(msg);
    diagError("editor-gen", err, { cardId: card.id, friendly: errMsg, phase: "run() 抛错→红框" });
    opts.setError(errMsg);
    useUIStore.getState().setCardError(card.id, errMsg);
  } finally {
    diagInfo("editor-gen", "⑩ finally：清除进度(generating→false，解除生成中锁)", { cardId: card.id });
    useUIStore.getState().setCardProgress(card.id, null);
  }
}
