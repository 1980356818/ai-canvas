/**
 * 按 cardId 重跑一张卡(企业级"运行"统一抽象)。
 *
 * ─── 为什么需要这一层 ───────────────────────────────────────────
 * 现有的 `handleGenerate` 散落在每个 Editor 组件里(ChatEditor/MediaEditor/
 * VideoEditor/...),都跟 React state 紧耦合 —— 既不能从 Editor 之外触发,
 * 也不能批量调度。组运行(groupRunner)、未来的 agent 工具、定时调度都需要
 * 一个"按 cardId 跑该卡"的入口。
 *
 * 本模块就是这一层。它经 `services/generation/` 的 build*Request 从 `card.data`
 * 重建请求并调 provider,带 cardId 走 TaskManager 持久化路径,进度/结果通过
 * taskBridge 自动同步到 UI,跟用户手点 Editor 的"生成"按钮行为一致。
 *
 * ─── 当前支持的卡片类型 ─────────────────────────────────────────
 *   ✅ ai_image / ai_multiangle   → buildImageRequest → generateImage
 *   ✅ ai_tryon                   → buildTryonRequest → generateImage
 *   ✅ ai_video                   → buildVideoRequest → generateVideo
 *   ✅ ai_chat                    → buildChatRequest  → streamChatToResult(流式,根治反代 524)
 *   ✅ frame_extractor            → runFrameExtraction(cardId)
 *   ⏭️ text / sticky_note / audio → 永远跳过(无运行语义)
 *
 * ─── 翻译逻辑与 Editor 共用(P2 统一重构)──────────────────────
 * 五条 build*Request 是"从 card.data 翻成 provider 请求体"的**唯一**实现,编辑器
 * 手点与本模块组运行调同一份 —— 手点和组跑发出的 model/body 完全一致(杜绝旧版
 * 组跑发 canonical alias 而非真实 SKU、丢首尾帧/参考素材、chat 只发纯文本 stub
 * 等不一致)。本模块只做"路由 + provider 调用 + 结果落地";几何 resize / 成功
 * toast 等纯 UI 善后留在编辑器。batchSize>1 经 runCard({ count }) 支持(组运行默认 1)。
 */

import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useTasksStore } from "@/stores/tasksStore";
import { modelService } from "@/services/models";
import { taskManager } from "@/services/taskManager";
import { buildVideoRequest } from "@/services/generation/buildVideoRequest";
import { buildImageRequest } from "@/services/generation/buildImageRequest";
import { buildTryonRequest } from "@/services/generation/buildTryonRequest";
import { buildChatRequest } from "@/services/generation/buildChatRequest";
import { streamChatToCard } from "@/services/generation/streamChatToResult";
import { runFrameExtraction } from "@/lib/frameExtraction";
import { hasApiKey } from "@/platform";
import { scheduleCardMediaLocalization } from "@/lib/mediaLocalize";
import { autoSave } from "@/lib/autoSave";
import type { CanvasCard } from "@/types";
import type { ImageGenResponse } from "@/providers/types";

export type RunCardOutcome = "ok" | "skipped" | "failed";

export interface RunCardResult {
  outcome: RunCardOutcome;
  /** 失败时的可读消息,成功/跳过时为空。 */
  reason?: string;
}

export interface RunCardOptions {
  /** 图片批量张数(仅 ai_image)。缺省 1;>1 走 legacy 逐张直连。 */
  count?: number;
  /**
   * 中止信号(组运行 GroupRunControl.signal)。abort 时:
   *   - 已排到但未开跑 → 直接跳过;
   *   - image/video 在途 → 取消本卡活跃 TaskManager 任务(经 tasksStore.getActiveByCard);
   *   - chat 在途 → 经 request.signal 中断 provider.chat。
   *
   * ⚠️ 仅**强制中止**(forceAbortGroup)会 abort 此信号;默认的**排空式停止**(stopGroup)
   * 不碰它 —— 排空式停止靠 executor 的派发闸门「不再发新卡」,在途的(已扣费)放它跑完。
   * 故组运行常态下此信号永不 abort;它只是 forceAbort 救场(如任务卡死)的逃生通道。
   */
  signal?: AbortSignal;
}

// ────────────────────────────────────────────────────────────────
// 各类型卡片的执行入口
// ────────────────────────────────────────────────────────────────

async function runImageCard(card: CanvasCard, count = 1): Promise<RunCardResult> {
  // 翻译逻辑(SKU 解析 / enhancer / Real-ESRGAN 预检 / 参考素材上传 / prompt 特判)统一走
  // build*Request,与编辑器手点共用同一份:ai_tryon → buildTryonRequest(person/garment 双槽),
  // ai_image / ai_multiangle → buildImageRequest(后者 prompt 走角度编码)。组运行不传 onUploadProgress。
  const built =
    card.type === "ai_tryon"
      ? await buildTryonRequest(card)
      : await buildImageRequest(card);
  if (!built.ok) {
    return { outcome: built.outcome, reason: built.reason };
  }

  const provider = modelService.tryResolveProvider(built.modelId, built.providerId);
  if (!provider?.generateImage) {
    return { outcome: "failed", reason: "当前模型不支持图片生成" };
  }

  // 组运行默认 count=1:带 cardId 走 TaskManager,结果由 taskBridge 回写 UI。
  if (count <= 1) {
    await provider.generateImage(built.request);
    return { outcome: "ok" };
  }

  // count>1(P3 统一入口 / agent 批量,仅 ai_image 有批量语义):TaskManager 是 per-card 的,
  // 不能并发 N 个,去 cardId 走 legacy 直连逐张,结果手动回写(等价 MediaEditor 批量分支善后)。
  const batchBase = { ...built.request, cardId: undefined };
  const settled = await Promise.allSettled(
    Array.from({ length: count }, () => provider.generateImage!(batchBase)),
  );
  const results = settled
    .filter((r): r is PromiseFulfilledResult<ImageGenResponse> => r.status === "fulfilled")
    .map((r) => ({ url: r.value.url, revisedPrompt: r.value.revisedPrompt }));
  if (results.length === 0) {
    return { outcome: "failed", reason: "所有图片生成均失败" };
  }
  useCardStore.getState().updateCardData(card.id, {
    imageUrl: results[0]!.url, results, selectedIndex: 0,
  });
  autoSave.markDirty(card.id);
  // 批量结果可能残留远端 URL(saveMedia 当时失败)——整卡交给统一收敛模块,
  // imageUrl 与 results[].url 一起补,无远端时是 no-op。
  scheduleCardMediaLocalization(card.id);
  return { outcome: "ok" };
}

async function runVideoCard(card: CanvasCard): Promise<RunCardResult> {
  // 翻译逻辑(五族 tier→真实 SKU / 首尾帧·参考素材上传 / 约束校验)统一走 buildVideoRequest,
  // 与 VideoEditor 手点共用同一份 —— 杜绝组跑发 canonical alias 而非真实 SKU 的老 bug。
  // 组运行不传 onUploadProgress(组级进度由 GroupLayer 显示)。
  const built = await buildVideoRequest(card);
  if (!built.ok) {
    return { outcome: built.outcome, reason: built.reason };
  }

  const provider = modelService.tryResolveProvider(built.modelId, built.providerId);
  if (!provider?.generateVideo) {
    return { outcome: "failed", reason: "当前模型不支持视频生成" };
  }

  await provider.generateVideo(built.request);
  return { outcome: "ok" };
}

async function runChatCard(card: CanvasCard, signal?: AbortSignal): Promise<RunCardResult> {
  // 翻译逻辑(多模态 serialize / 媒体并行上传 / vision 判定 / <upstream_context> 前缀)统一走
  // buildChatRequest,与 ChatEditor 手点共用同一份 —— 修复组跑只发纯文本、丢参考图/视频的老 stub。
  const built = await buildChatRequest(card);
  if (!built.ok) {
    return { outcome: built.outcome, reason: built.reason };
  }

  const provider = modelService.tryResolveProvider(built.request.model, built.providerId);
  if (!provider) {
    return { outcome: "failed", reason: `未找到模型 "${built.request.model}" 的平台` };
  }

  // 标"过期",编辑器若开着会显示旧结果半透明
  useCardStore.getState().updateCardData(card.id, { _resultStale: true });

  // chat 走流式(streamChatToResult)而非 provider.chat:gpt-5.5 等推理模型单次响应
  // 90–140s,非流式长连接会被 Cloudflare/反代切成 524(源站已完成并计费,客户端却拿不到)。
  // 流式持续吐字节,反代不空闲超时,根治该问题。取消靠 signal 中断出网。
  // 详见 services/generation/streamChatToResult.ts 顶部注释。
  const { content, finishReason } = await streamChatToCard(provider, built.request, card.id, { signal });

  let result = content || "(无回复 — 模型未返回任何内容)";
  if (finishReason === "length" && content) {
    result +=
      "\n\n---\n⚠️ *回复因达到输出上限被截断,可尝试拆分提问以获取完整内容。*";
  }

  // 原子合并到最新 card.data,避免长生成期间的并发改动被旧快照覆盖。
  useCardStore.getState().updateCardData(card.id, { result, _resultStale: false });
  autoSave.markDirty(card.id);
  return { outcome: "ok" };
}

// ────────────────────────────────────────────────────────────────
// 公共入口
// ────────────────────────────────────────────────────────────────

/**
 * 跑一张卡。语义:
 *   • 成功(任务完成,结果已通过 taskBridge 写入 card.data)→ outcome="ok"
 *   • 因配置/前置条件不满足,合理跳过(text/sticky_note 类型 / 缺 prompt 等)
 *     → outcome="skipped"
 *   • 出错(provider 异常 / API 失败)→ outcome="failed"
 *
 * 调用方(groupRunner)根据 outcome 决定继续或中止。
 *
 * @param opts.count 图片批量张数(仅 ai_image 有批量语义)。组运行 / 缺省 = 1;
 *   >1 走 legacy 逐张直连(见 runImageCard)。batchSize 是运行时量,不进 build*Request。
 */
export async function runCard(
  cardId: string,
  opts?: RunCardOptions,
): Promise<RunCardResult> {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return { outcome: "failed", reason: "卡片不存在" };

  // P3.2: 已取消(组运行 abort 后 runWithLimit 仍可能排到本卡)→ 不发请求,直接跳过。
  if (opts?.signal?.aborted) return { outcome: "skipped", reason: "已取消" };

  // text / sticky_note / audio:无运行语义,直接跳过
  if (
    card.type === "text" ||
    card.type === "sticky_note" ||
    card.type === "audio"
  ) {
    return { outcome: "skipped", reason: "该类型节点无运行语义" };
  }

  // 检查 API Key 配置(toast 由调用方负责更友好的弹窗;这里只返回失败)
  if (
    card.type === "ai_image" ||
    card.type === "ai_video" ||
    card.type === "ai_multiangle" ||
    card.type === "ai_tryon"
  ) {
    if (!(await hasApiKey())) {
      useUIStore.getState().addToast({
        type: "warning",
        title: "请先配置 API Key",
        duration: 4000,
      });
      return { outcome: "failed", reason: "未配置 API Key" };
    }
  }

  // 统一"生成中"占位:任何经 runCard 的卡(组运行 / agent / 重试)从这一刻起
  // 就进 generatingCards —— 消灭"组运行准备阶段 / ai_chat 不写进度"的空档,
  // 让所有读 generatingCards 的 UI(卡片进度条 / 拖拽拦截 / 数据流 watcher)
  // 一致地知道这张卡在生成中。task 路径下 taskBridge 会接管并覆盖进度;
  // 非 task 路径(ai_chat / frame_extractor)靠这里点亮、靠 finally 清。
  // 强制中止 —— signal abort 时取消本卡活跃的 TaskManager 任务(image/video 走 task 路径),
  // chat 经 request.signal 中断(见 runChatCard)。仅 forceAbortGroup 触发,排空式停止不走这里。
  const onAbort = () => {
    const active = useTasksStore.getState().getActiveByCard(card.id);
    if (active) void taskManager.cancel(active.id);
  };
  opts?.signal?.addEventListener("abort", onAbort, { once: true });

  const ui = useUIStore.getState();
  ui.setCardProgress(card.id, { percent: 0, label: "正在提交请求…" });
  try {
    switch (card.type) {
      case "ai_image":
      case "ai_multiangle":
      case "ai_tryon":
        return await runImageCard(card, opts?.count ?? 1);
      case "ai_video":
        return await runVideoCard(card);
      case "frame_extractor":
        // runFrameExtraction 抽帧后会合成一张 ai_image 卡(挂在 frame_extractor 下方)
        // 并自动建立连线;内部 toast + status,失败也不抛错,当 ok 返回。
        // 若用户想拆成独立子卡,在合成卡上手点"拆分"即可。
        await runFrameExtraction(card.id);
        return { outcome: "ok" };
      case "ai_chat":
        return await runChatCard(card, opts?.signal);
      default:
        return { outcome: "skipped", reason: "未识别的节点类型" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", reason: msg };
  } finally {
    opts?.signal?.removeEventListener("abort", onAbort);
    // 幂等清:task 路径下 taskBridge 在终态已 set null,这里再清无害;
    // 非 task 路径(ai_chat / frame_extractor)靠这里收尾。
    ui.setCardProgress(card.id, null);
  }
}
