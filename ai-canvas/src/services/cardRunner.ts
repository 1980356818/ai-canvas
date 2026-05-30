/**
 * 按 cardId 重跑一张卡(企业级"运行"统一抽象)。
 *
 * ─── 为什么需要这一层 ───────────────────────────────────────────
 * 现有的 `handleGenerate` 散落在每个 Editor 组件里(ChatEditor/MediaEditor/
 * VideoEditor/...),都跟 React state 紧耦合 —— 既不能从 Editor 之外触发,
 * 也不能批量调度。组运行(groupRunner)、未来的 agent 工具、定时调度都需要
 * 一个"按 cardId 跑该卡"的入口。
 *
 * 本模块就是这一层。它从 `card.data` 重建请求并调 provider 的
 * `generateImage` / `generateVideo`,带 cardId 走 TaskManager 持久化路径,
 * 进度/结果通过 taskBridge 自动同步到 UI,跟用户手点 Editor 的"生成"按钮
 * 行为一致。
 *
 * ─── 当前支持的卡片类型 ─────────────────────────────────────────
 *   ✅ ai_image / ai_multiangle / ai_tryon   → generateImage
 *   ✅ ai_video                              → generateVideo
 *   ✅ frame_extractor                       → runFrameExtraction(cardId)
 *   ⏭️ ai_chat                               → M3 阶段接入(LLM agent loop)
 *   ⏭️ text / sticky_note / audio            → 永远跳过(无运行语义)
 *
 * ─── 跟 Editor 的差异 ──────────────────────────────────────────
 * 本模块**只跑**,不做:
 *   • 卡片几何 resize(那是 Editor 的 UX 改进,不是核心动作);
 *   • batchSize > 1(组运行场景一次出一张即可);
 *   • Real-ESRGAN 等单个 model 的尺寸预检(失败由 provider 报错兜底)。
 * 这是个有意的取舍 —— 让本模块保持"纯路由 + 简单拼装",防止再发明一份业务逻辑。
 */

import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { modelService } from "@/services/models";
import { runFrameExtraction } from "@/lib/frameExtraction";
import { hasApiKey } from "@/platform";
import { uploadMediaBatch } from "@/platform/media";
import { autoSave } from "@/lib/autoSave";
import type { CanvasCard } from "@/types";
import type {
  ImageGenRequest,
  VideoGenRequest,
  ImageRefInput,
  UnifiedMessage,
} from "@/providers/types";

export type RunCardOutcome = "ok" | "skipped" | "failed";

export interface RunCardResult {
  outcome: RunCardOutcome;
  /** 失败时的可读消息,成功/跳过时为空。 */
  reason?: string;
}

interface MediaLikeData {
  content?: string;
  model?: string;
  provider?: string;
  size?: string;
  resolution?: string;
  quality?: string;
  refImages?: Record<string, { url: string; sourceCardId?: string }>;
  upstreamTexts?: Record<string, string>;
  // 视频专属
  duration?: number;
  frames?: number;
  generateAudio?: boolean;
}

interface ChatLikeData {
  content?: string;
  model?: string;
  provider?: string;
  result?: string;
  upstreamTexts?: Record<string, string>;
  _systemPrompt?: string;
  _resultStale?: boolean;
}

/** 把 card.data 的 prompt 文本拼成 provider 期望的 final prompt。 */
function buildFinalPrompt(data: MediaLikeData): string {
  const parts: string[] = [];
  if (data.upstreamTexts) {
    for (const text of Object.values(data.upstreamTexts)) {
      if (text && text.trim()) parts.push(text.trim());
    }
  }
  if (data.content && data.content.trim()) {
    parts.push(data.content.trim());
  }
  return parts.join("\n\n");
}

/** 把 refImages map 平铺成 provider 期望的 [{ url, role }]。 */
function flattenRefImages(
  data: MediaLikeData,
): { role: string; url: string }[] {
  if (!data.refImages) return [];
  const result: { role: string; url: string }[] = [];
  for (const [role, entry] of Object.entries(data.refImages)) {
    if (entry?.url) result.push({ role, url: entry.url });
  }
  return result;
}

/**
 * 并行批量上传参考图(本地 → 远端 URL),失败抛错由调用方捕获。
 * 等效于 MediaEditor 内 uploadMediaBatch 的最小包装。
 */
async function prepareReferenceImages(
  refs: { role: string; url: string }[],
): Promise<ImageRefInput[]> {
  if (refs.length === 0) return [];
  const uploaded = await uploadMediaBatch(
    refs.map((r) => r.url),
    { /* 无进度回调:组运行场景由 GroupLayer 显示组级别进度 */ },
  );
  return refs.map((r, i) => ({ url: uploaded[i]!, role: r.role }));
}

// ────────────────────────────────────────────────────────────────
// 各类型卡片的执行入口
// ────────────────────────────────────────────────────────────────

async function runImageCard(card: CanvasCard): Promise<RunCardResult> {
  const data = card.data as MediaLikeData;
  const prompt = buildFinalPrompt(data);

  // ai_multiangle 不需要 prompt(走预设角度参数),其它图像类需要
  const needsPrompt = card.type !== "ai_multiangle";
  if (needsPrompt && !prompt) {
    return { outcome: "skipped", reason: "缺少提示词" };
  }

  const provider = modelService.tryResolveProvider(
    data.model ?? "",
    data.provider,
  );
  if (!provider?.generateImage) {
    return { outcome: "failed", reason: "当前模型不支持图片生成" };
  }

  const referenceImages = await prepareReferenceImages(flattenRefImages(data));

  const resolvedModel = data.model
    ? modelService.resolveImageModelId(
        data.model,
        data.resolution ?? "2K",
        data.quality,
        data.provider,
      )
    : undefined;

  const req: ImageGenRequest = {
    prompt: prompt || undefined,
    size: data.size,
    resolution: data.resolution,
    quality: data.quality,
    model: resolvedModel,
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    cardId: card.id,
    projectId: card.projectId,
  };

  await provider.generateImage(req);
  return { outcome: "ok" };
}

async function runVideoCard(card: CanvasCard): Promise<RunCardResult> {
  const data = card.data as MediaLikeData;
  const prompt = buildFinalPrompt(data);
  if (!prompt) {
    return { outcome: "skipped", reason: "缺少提示词" };
  }

  const provider = modelService.tryResolveProvider(
    data.model ?? "",
    data.provider,
  );
  if (!provider?.generateVideo) {
    return { outcome: "failed", reason: "当前模型不支持视频生成" };
  }

  const referenceImages = await prepareReferenceImages(flattenRefImages(data));

  const req: VideoGenRequest = {
    prompt,
    model: data.model,
    size: data.size,
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    duration: data.duration,
    frames: data.frames,
    generateAudio: data.generateAudio,
    cardId: card.id,
    projectId: card.projectId,
  };

  await provider.generateVideo(req);
  return { outcome: "ok" };
}

async function runChatCard(card: CanvasCard): Promise<RunCardResult> {
  const data = card.data as ChatLikeData;
  const prompt = (data.content ?? "").trim();
  const hasUpstream = data.upstreamTexts && Object.keys(data.upstreamTexts).length > 0;
  if (!prompt && !hasUpstream) {
    return { outcome: "skipped", reason: "缺少提示词" };
  }

  const model = data.model || "gemini-3.1-pro-preview";
  const provider = modelService.tryResolveProvider(model, data.provider);
  if (!provider) {
    return { outcome: "failed", reason: `未找到模型 "${model}" 的平台` };
  }

  // 拼 context prefix(组内上游节点的输出),跟 ChatEditor 一致
  let contextPrefix = "";
  if (hasUpstream) {
    const cs = useCardStore.getState();
    const sections = Object.entries(data.upstreamTexts!).map(([cid, txt]) => {
      const label = cs.getCard(cid)?.title || "上游节点";
      return `## ${label}\n${txt}`;
    });
    contextPrefix =
      "<upstream_context>\n" + sections.join("\n\n") + "\n</upstream_context>\n\n";
  }

  const systemPrompt =
    contextPrefix +
    (data._systemPrompt ||
      "你是一个有用的助手,请简洁清晰地回复用户的问题或请求。");

  const messages: UnifiedMessage[] = [
    { role: "user", content: [{ type: "text", text: prompt || "(无内容)" }] },
  ];

  // 标"过期",编辑器若开着会显示旧结果半透明
  useCardStore.getState().updateCard(card.id, {
    data: { ...data, _resultStale: true },
  });

  const resp = await provider.chat({
    model,
    systemPrompt,
    messages,
    maxTokens: 65536,
  });

  let result = resp.content ?? "(无回复 — 模型未返回任何内容)";
  if (resp.finishReason === "length" && resp.content) {
    result +=
      "\n\n---\n⚠️ *回复因达到输出上限被截断,可尝试拆分提问以获取完整内容。*";
  }

  useCardStore.getState().updateCard(card.id, {
    data: { ...data, result, _resultStale: false },
  });
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
 */
export async function runCard(cardId: string): Promise<RunCardResult> {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return { outcome: "failed", reason: "卡片不存在" };

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

  try {
    switch (card.type) {
      case "ai_image":
      case "ai_multiangle":
      case "ai_tryon":
        return await runImageCard(card);
      case "ai_video":
        return await runVideoCard(card);
      case "frame_extractor":
        // runFrameExtraction 抽帧后会合成一张 ai_image 卡(挂在 frame_extractor 下方)
        // 并自动建立连线;内部 toast + status,失败也不抛错,当 ok 返回。
        // 若用户想拆成独立子卡,在合成卡上手点"拆分"即可。
        await runFrameExtraction(card.id);
        return { outcome: "ok" };
      case "ai_chat":
        return await runChatCard(card);
      default:
        return { outcome: "skipped", reason: "未识别的节点类型" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", reason: msg };
  }
}
