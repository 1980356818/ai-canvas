/**
 * 流式对话 → 累积文本结果。ChatEditor 手点 / cardRunner 组运行 共用的唯一对话调用层。
 *
 * ## 为什么对话要走流式(streamChat)而不是 provider.chat
 *
 * gpt-5.5 等推理模型单次响应常要 90–140s(实测 app.log:vision「反推」+ 重推理普遍
 * 90s 起步,见过 140s)。非流式 `provider.chat` 走一条长连接干等整段响应,而
 * api.snoworangekeji.cn 在 Cloudflare/反代后面,对「源站迟迟不吐字节」的连接有
 * ~130s 超时 —— 超时即给客户端 **524**,但**源站已把对话生成完并计费**。表现正是
 * 用户报的「后台对话任务已完成,但前端不显示」:客户端这边读取(524/断连)失败,
 * 答案永远落不进卡片(实测 debug dump 已抓到 chat 的 524@130s 与多次网关 5xx)。
 *
 * 流式把响应拆成 SSE chunk 持续下发(推理模型先吐一大段 reasoning_content,再吐
 * content),连接全程有字节流动 → 反代永远不会「空闲超时」→ 根治 524;附带能实时
 * 反馈进度(深度思考中 / 已生成 N 字),不再是干瞪 2 分钟转圈。
 *
 * 累积口径:只收 `text`(= delta.content,最终答案),**忽略** `reasoning`(模型私有
 * 思考,不属于答案,与 provider.chat 返回的 content 语义一致)。`done` 时 resolve。
 *
 * 取消:opts.signal abort → 调底层 stream 的 abort() 停止出网,并 reject(AbortError)。
 */

import type { AIProvider, ChatRequest } from "@/providers/types";
import { useUIStore } from "@/stores/uiStore";
import { diagInfo, diagError } from "@/lib/diag";

export interface ChatStreamResult {
  /** 累积的答案文本(不含 reasoning)。空串表示模型没吐任何答案。 */
  content: string;
  finishReason: "stop" | "tool_calls" | "length";
}

export interface StreamChatToResultOptions {
  /** 上层取消信号(组运行 controller.signal / 用户中止)。abort 时停流并 reject。 */
  signal?: AbortSignal;
  /** 答案文本增量回调(fullContent, delta)。用于实时写卡 / 字数进度;建议调用方自行节流。 */
  onText?: (fullContent: string, delta: string) => void;
  /** 推理增量回调。推理模型在吐答案前会先思考很久,用它点亮「深度思考中…」。 */
  onReasoning?: (delta: string) => void;
}

/**
 * 用流式 `streamChat` 跑一次对话,累积答案文本并在 done 时 resolve。
 *
 * @param provider 已 resolve 的 AIProvider(jijing/comfly/custom 均继承 streamChat)。
 * @param req      ChatRequest(buildChatRequest 产出的 ChatGenRequest 兼容此形)。
 * @param opts     signal / onText / onReasoning。
 */
export function streamChatToResult(
  provider: AIProvider,
  req: ChatRequest,
  opts?: StreamChatToResultOptions,
): Promise<ChatStreamResult> {
  return new Promise<ChatStreamResult>((resolve, reject) => {
    if (opts?.signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }

    let content = "";
    // done 事件没带 finishReason 时的兜底(对话节点基本只会是 stop/length)。
    const defaultFinishReason: "stop" | "tool_calls" | "length" = "stop";
    let settled = false;
    let handle: { abort: () => void } | null = null;
    // 诊断计数:区分「一个 chunk 都没来(后端/网络断)」「只来 reasoning 没 content
    // (上游答案落错字段)」「content 来了但空(上游真没答)」三种空回复成因。
    let textChunks = 0;
    let reasoningChunks = 0;
    let reasoningChars = 0;
    let firstEventMs = 0;
    const startMs = performance.now();

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      opts?.signal?.removeEventListener("abort", onAbort);
      action();
    };

    const onAbort = (): void => {
      settle(() => {
        handle?.abort();
        reject(new DOMException("aborted", "AbortError"));
      });
    };

    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    diagInfo("chat-stream", "⑥ streamChat 开始(即将 invoke 后端)", { model: req.model });

    provider
      .streamChat(req, (event) => {
        if (firstEventMs === 0) firstEventMs = Math.round(performance.now() - startMs);
        switch (event.type) {
          case "text":
            textChunks += 1;
            content += event.text;
            opts?.onText?.(content, event.text);
            break;
          case "reasoning":
            reasoningChunks += 1;
            reasoningChars += event.text.length;
            opts?.onReasoning?.(event.text);
            break;
          case "done":
            diagInfo("chat-stream", "⑧ done 事件(textChunks=0 说明只收到思考或啥都没收到)", {
              model: req.model,
              textChunks,
              reasoningChunks,
              reasoningChars,
              contentLen: content.length,
              finishReason: event.finishReason ?? defaultFinishReason,
              firstEventMs,
              totalMs: Math.round(performance.now() - startMs),
            });
            settle(() =>
              resolve({ content, finishReason: event.finishReason ?? defaultFinishReason }),
            );
            break;
          case "error":
            diagError("chat-stream", new Error(event.message), {
              model: req.model,
              textChunks,
              reasoningChunks,
              contentLen: content.length,
              totalMs: Math.round(performance.now() - startMs),
            });
            settle(() => reject(new Error(event.message)));
            break;
          // tool_call_* : 对话节点不挂工具,忽略。
        }
      })
      .then((h) => {
        handle = h;
        diagInfo("chat-stream", "⑦ streamChat invoke 已建立(底层 HTTP 出网已发起)", { model: req.model });
        // streamChat 自身的 invoke 在 resolve 这个 handle 之前,abort 可能已经发生过 ——
        // 这里补一刀,确保底层出网被停掉(onAbort 当时 handle 还是 null)。
        if (opts?.signal?.aborted) h.abort();
      })
      .catch((err) => {
        diagError("chat-stream", err, { model: req.model, phase: "streamChat invoke 建立失败(没走到后端)" });
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      });
  });
}

/** 进度刷新节流粒度(字数):每多 ~16 字才 setCardProgress 一次,避免每 token 重渲染。 */
const PROGRESS_FLUSH_CHARS = 16;

/**
 * `streamChatToResult` 的「写卡进度」封装 —— ChatEditor 手点 / cardRunner 组运行共用。
 *
 * 把流式过程实时写进 `uiStore.generatingCards[cardId]`:
 *   - 推理阶段:`reasoning` 累积 + label「深度思考中…」→ 卡片实时显示思考过程
 *     (AIChatCard 读 genProgress.reasoning 渲染;**没有思考的模型不下发该字段、卡片不显示**)。
 *   - 出答案阶段:`streamText` 累积 + label「生成中… N 字」→ 卡片实时显示答案流。
 *
 * 终态由调用方在 finally 里 `setCardProgress(cardId, null)` 清掉(reasoning/streamText
 * 是临时态,不持久化;最终答案由调用方写 data.result)。
 */
export function streamChatToCard(
  provider: AIProvider,
  req: ChatRequest,
  cardId: string,
  opts?: { signal?: AbortSignal },
): Promise<ChatStreamResult> {
  const setCardProgress = useUIStore.getState().setCardProgress;
  let reasoning = "";
  let lastReasoningLen = 0;
  let lastTextLen = 0;

  return streamChatToResult(provider, req, {
    signal: opts?.signal,
    onReasoning: (delta) => {
      reasoning += delta;
      if (reasoning.length - lastReasoningLen < PROGRESS_FLUSH_CHARS) return;
      lastReasoningLen = reasoning.length;
      setCardProgress(cardId, { percent: 0, label: "深度思考中…", reasoning });
    },
    onText: (full) => {
      if (full.length > 0 && full.length - lastTextLen < PROGRESS_FLUSH_CHARS) return;
      lastTextLen = full.length;
      setCardProgress(cardId, {
        percent: 0,
        label: `生成中… ${full.length} 字`,
        // 思考完才出答案:把已累积的 reasoning 一并带上,卡片可保留「思考过程」在答案上方。
        reasoning: reasoning || undefined,
        streamText: full,
      });
    },
  });
}
