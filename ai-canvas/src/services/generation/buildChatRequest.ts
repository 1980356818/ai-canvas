/**
 * 多模态对话(ai_chat)请求构建 —— 编辑器手点 / cardRunner 组运行 共用的唯一翻译层。
 *
 * 背景见 docs/生成统一重构施工图.md §P2.3。此前 ChatEditor 把完整多模态逻辑
 * (serializeForApi 内联图保序 / 非内联 media 并行上传 / vision 判定 / <upstream_context>
 * 前缀)写在 handleGenerate 里;cardRunner.runChatCard 只发**纯文本 stub**,组跑对话
 * 丢掉所有参考图 / 视频 / 内联引用。这里把那段逐字搬出来,两路共用。
 *
 * 与生图/视频 build 的差异:chat 产出的是 `ChatGenRequest`(model/systemPrompt/messages/
 * maxTokens),由调用方调 `provider.chat`(同步,不带 cardId、不落 task —— P3 再议)。
 *
 * 契约:
 *  - 违例返回 `{ ok:false, outcome, reason }`;非致命提示(模型不支持媒体)走 `ok:true` 的
 *    `warning` 字段,由调用方决定是否弹 toast(编辑器弹,cardRunner 忽略)。
 *  - 上传失败直接 throw,由调用方 try/catch。
 *  - 结果落盘 / _resultStale 标记 / 成功 toast 等"善后"留在调用方。
 *  - model fallback 统一走 resolveDefaultModelForCardType(消除编辑器 + cardRunner 两处硬编码默认)。
 *
 * 对照源:`ChatEditor.tsx` 的 `handleGenerate`(P2.3 迁移基线)。
 */

import type { CanvasCard } from "@/types";
import type { UnifiedMessage, UnifiedContentPart } from "@/providers/types";
import { resolveDefaultModelForCardType } from "@/services/modelDefaults";
import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { CHAT_EDITOR_DEFAULT_SYSTEM_PROMPT } from "@/lib/systemPrompts";
import { uploadMediaBatch, type MediaUploadProgress } from "@/platform/media";
import { getRefSlotsForChatModel, modelSupportsVision, type RefImageEntry } from "@/config/model-ref-images";
import { computeImageRefSources } from "@/hooks/useImageRefSources";
import {
  type InlineImageRef,
  type ContentPart,
  serializeForApi,
  getInlineRefUrls,
  toDisplayText,
} from "@/lib/promptSerializer";
import { uncloakPrompt } from "@/lib/promptCloak";

interface MediaAttachment {
  url: string;
  displayUrl?: string;
  kind: "image" | "video";
}

interface VideoRefEntry {
  url: string;
  sourceCardId?: string;
}

/** buildChatRequest 读取的 card.data 字段子集(与 ChatEditor.ChatData 对齐)。 */
interface ChatCardData {
  content?: string;
  model?: string;
  provider?: string;
  refImages?: Record<string, RefImageEntry>;
  inlineRefs?: InlineImageRef[];
  directMedia?: MediaAttachment[];
  refVideos?: VideoRefEntry[];
  upstreamTexts?: Record<string, string>;
  _systemPrompt?: string;
}

export interface ChatGenRequest {
  model: string;
  systemPrompt: string;
  messages: UnifiedMessage[];
  maxTokens: number;
}

export interface BuildChatRequestOptions {
  /** 上传进度回调(编辑器写 setCardProgress;cardRunner 传 undefined)。 */
  onUploadProgress?: (kind: string, progress: { uploaded: number; total: number }) => void;
}

export type BuildChatRequestResult =
  | {
      ok: true;
      request: ChatGenRequest;
      providerId?: string;
      /** 非致命提示(如模型不支持媒体已忽略)。编辑器弹 toast;cardRunner 忽略。 */
      warning?: { title: string; description: string };
    }
  | {
      ok: false;
      outcome: "skipped" | "failed";
      reason: string;
    };

/**
 * 从一张对话卡的 data 重建 provider.chat 请求。
 *
 * @param card ai_chat 卡。
 * @param opts onUploadProgress 透传到 uploadMediaBatch。
 */
export async function buildChatRequest(
  card: CanvasCard,
  opts?: BuildChatRequestOptions,
): Promise<BuildChatRequestResult> {
  const data = card.data as ChatCardData;

  // 试用版模板提示词以 ENC1:: 编码存放;在此「读 content」处 just-in-time 解码。
  // uncloak 对非编码文本透传 → 普通对话卡零副作用。绝不在卡片 data 落地处解码。
  const rawPrompt = uncloakPrompt(data.content).trim() || undefined;
  const displayPrompt = rawPrompt ? toDisplayText(rawPrompt, data.inlineRefs ?? []) : "";
  const hasUpstreamText = !!(data.upstreamTexts && Object.keys(data.upstreamTexts).length > 0);
  if (!displayPrompt.trim() && !hasUpstreamText) {
    return { ok: false, outcome: "skipped", reason: "缺少提示词" };
  }

  // model fallback:统一走 modelDefaults 单一口径,消除 ChatEditor / cardRunner 两处
  // 硬编码 "gemini-3.1-pro-preview"。空 model 时写回卡片。
  let modelId = (data.model ?? "").trim();
  let providerId = data.provider;
  if (!modelId) {
    const fallback = await resolveDefaultModelForCardType(card.type);
    if (!fallback) return { ok: false, outcome: "failed", reason: "无法解析默认对话模型" };
    modelId = fallback.modelId;
    providerId = fallback.providerId;
    useCardStore.getState().updateCardData(card.id, { model: modelId, provider: providerId });
    autoSave.markDirty(card.id);
  }

  const inlineRefs = data.inlineRefs ?? [];
  const hasInlineRefs = inlineRefs.length > 0;
  const refSlots = getRefSlotsForChatModel(modelId);
  // 非 React 路径也能解析 @ 引用素材(upstream/video 选项),与编辑器同一口径。
  const imageOptions = computeImageRefSources(card.id, refSlots, data.refImages, undefined, data.refVideos);

  const imageEntries = refSlots
    .map((slot) => data.refImages?.[slot.key])
    .filter((e): e is RefImageEntry => !!e);
  const directImageItems = (data.directMedia ?? []).filter((m) => m.kind === "image");
  const refVideoEntries = data.refVideos ?? [];
  const totalMedia = imageEntries.length + directImageItems.length + refVideoEntries.length;

  const reportUpload = (
    kind: string,
  ): ((p: MediaUploadProgress) => void) | undefined =>
    opts?.onUploadProgress
      ? ({ uploaded, total }: MediaUploadProgress) =>
          opts.onUploadProgress!(kind, { uploaded, total })
      : undefined;

  let userContent: ContentPart[];
  let warning: { title: string; description: string } | undefined;

  if (hasInlineRefs && modelSupportsVision(modelId)) {
    userContent = await serializeForApi(rawPrompt!, inlineRefs, data.refImages, imageOptions);

    // 非内联 ref 媒体并行上传。顺序契约:逐个 unshift 到 userContent 头部,
    // 等价于"反转后塞前面"(后 unshift 的更靠前)。
    const inlineUrls = getInlineRefUrls(inlineRefs, data.refImages, imageOptions);
    const refsToUpload = [
      ...imageEntries.filter((e) => !inlineUrls.has(e.url)).map((e) => e.url),
      ...directImageItems.map((m) => m.url),
      ...refVideoEntries.filter((v) => !inlineUrls.has(v.url)).map((v) => v.url),
    ];
    const uploadedRefs = await uploadMediaBatch(refsToUpload, {
      onProgress: reportUpload("参考媒体"),
    });
    uploadedRefs
      .slice()
      .reverse()
      .forEach((url) => {
        userContent.unshift({ type: "image_url", image_url: { url } });
      });
  } else {
    userContent = [];
    if (modelSupportsVision(modelId)) {
      // 同样并行上传 + 保序 append(无内联 ref,按遍历顺序)。
      const allMedia = [
        ...imageEntries.map((e) => e.url),
        ...directImageItems.map((m) => m.url),
        ...refVideoEntries.map((v) => v.url),
      ];
      const uploaded = await uploadMediaBatch(allMedia, {
        onProgress: reportUpload("媒体"),
      });
      uploaded.forEach((url) => {
        userContent.push({ type: "image_url", image_url: { url } });
      });
    } else if (totalMedia > 0) {
      warning = {
        title: "当前模型不支持媒体输入",
        description: `${modelId} 不支持视觉能力，已忽略参考图/视频。`,
      };
    }
    userContent.push({ type: "text", text: displayPrompt });
  }

  // <upstream_context> 前缀(合并 ChatEditor + 旧 cardRunner.runChatCard 的重复实现)。
  const upstreamEntries = data.upstreamTexts ? Object.entries(data.upstreamTexts) : [];
  let contextPrefix = "";
  if (upstreamEntries.length > 0) {
    const cs = useCardStore.getState();
    const sections = upstreamEntries.map(([cid, txt]) => {
      const label = cs.getCard(cid)?.title || "上游节点";
      return `## ${label}\n${txt}`;
    });
    contextPrefix =
      "<upstream_context>\n" + sections.join("\n\n") + "\n</upstream_context>\n\n";
  }
  // _systemPrompt 同样可能被 ENC1:: 编码(试用模板)→ 解码后再拼;空/undefined 透传为 ""。
  const systemPrompt =
    contextPrefix + (uncloakPrompt(data._systemPrompt) || CHAT_EDITOR_DEFAULT_SYSTEM_PROMPT);

  const hasMedia = userContent.some((p) => p.type === "image_url");
  const unifiedUserContent: UnifiedContentPart[] = hasMedia
    ? userContent.map((p): UnifiedContentPart => {
        if (p.type === "text") return { type: "text", text: p.text };
        if (p.type === "image_url") return { type: "image", url: p.image_url.url };
        return { type: "text", text: "" };
      })
    : [{ type: "text", text: displayPrompt }];

  const messages: UnifiedMessage[] = [{ role: "user", content: unifiedUserContent }];

  return {
    ok: true,
    request: {
      model: modelId,
      systemPrompt: systemPrompt || CHAT_EDITOR_DEFAULT_SYSTEM_PROMPT,
      messages,
      maxTokens: 65536,
    },
    providerId,
    warning,
  };
}
