/**
 * 图片生成请求构建 —— 编辑器手点 / cardRunner 组运行 / agent 三路共用的唯一翻译层。
 *
 * 背景见 docs/生成统一重构施工图.md §P2.2。把 `MediaEditor.handleGenerate` 里
 * "从 card.data 翻成 provider 请求体" 的逻辑(模型 SKU 解析 / enhancer 判定 /
 * Real-ESRGAN 尺寸预检 / 参考图收集上传 / resolution·quality 条件传参)抽成异步函数,
 * **编辑器与 cardRunner 共用同一份**,保证手点和组跑发出的 model/body 完全一致。
 *
 * 契约与 buildVideoRequest 对齐:
 *  - 违例返回 `{ ok:false, outcome, reason, toast? }`;调用方决定呈现(编辑器弹 toast,cardRunner 用 outcome+reason)。
 *  - 上传失败直接 throw,由调用方 try/catch。
 *  - 几何 resize(pendingGeometry)/ 批量循环 / 媒体本地化补救(mediaLocalize)等"善后"留在编辑器,本函数不碰。
 *  - **batchSize 不进本函数**:本函数只产出"一张图"的请求;批量是 `runCard(cardId, { count })` opt / 编辑器循环的事。
 *  - provider 解析留给调用方,本函数返回 `modelId` / `providerId` 供其反查。
 *
 * 服务范围:ai_image(MediaEditor)+ ai_multiangle(MultiangleEditor)。两者除 prompt
 * 外的翻译完全一致(multiangle 模型固定 qwen-multipie,不支持 quality/resolution,走通用分支即对)。
 * ai_tryon 因 prompt 前缀 / person·garment 双槽 / 固定 size·quality 差异过大,单列 buildTryonRequest。
 *
 * 对照源:`MediaEditor.tsx` / `MultiangleEditor.tsx` 的 `handleGenerate`(P2.2/P2.4 迁移基线)。
 */

import type { CanvasCard } from "@/types";
import type { ImageGenRequest } from "@/providers/types";
import { resolveDefaultModelForCardType } from "@/services/modelDefaults";
import { modelService } from "@/services/models";
import { useCardStore } from "@/stores/cardStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { uploadMediaBatch, type MediaUploadProgress } from "@/platform/media";
import {
  normalizeImageSize,
  normalizeResolution,
  DEFAULT_IMAGE_QUALITY,
  supportsImageQuality,
} from "@/shared/constants";
import { type InlineImageRef, toDisplayText } from "@/lib/promptSerializer";
import { uncloakPrompt } from "@/lib/promptCloak";
import {
  getRefSlotsForModel,
  isEnhancerModel,
  type RefImageEntry,
} from "@/config/model-ref-images";

/** buildImageRequest 读取的 card.data 字段子集(与 MediaEditor.MediaData / MultiangleEditor.MultiangleData 对齐)。 */
interface ImageCardData {
  content?: string;
  inlineRefs?: InlineImageRef[];
  upstreamTexts?: Record<string, string>;
  model?: string;
  provider?: string;
  size?: string;
  resolution?: string;
  quality?: string;
  refImages?: Record<string, RefImageEntry>;
  // ai_multiangle 专属:水平/垂直角度 + 镜头距离,prompt 由三者编码而非自由文本。
  h?: number;
  v?: number;
  z?: number;
}

export interface BuildImageRequestOptions {
  /** 上传进度回调(编辑器写 setCardProgress;cardRunner 传 undefined)。 */
  onUploadProgress?: (kind: string, progress: { uploaded: number; total: number }) => void;
}

export type BuildImageRequestResult =
  | {
      ok: true;
      request: ImageGenRequest;
      /** 供调用方反查 provider 的 canonical model。 */
      modelId: string;
      providerId?: string;
    }
  | {
      ok: false;
      outcome: "skipped" | "failed";
      reason: string;
      toast?: { title: string; description: string };
    };

/** 拼接上游文字 + 本卡提示词(展开 inline ref 为显示文本)。与 MediaEditor.buildFinalPrompt 一致。 */
function buildFinalPrompt(data: ImageCardData): string {
  const parts: string[] = [];
  if (data.upstreamTexts) {
    for (const text of Object.values(data.upstreamTexts)) {
      if (text.trim()) parts.push(text.trim());
    }
  }
  // 试用版模板提示词以 ENC1:: 编码存放;在此「读 content」处 just-in-time 解码。
  // 非编码文本(普通模板/用户手输)透传,零副作用。绝不在卡片 data 落地处解码(会被
  // autoSave 把明文写回用户项目→二次泄漏)。见 docs/平面模板试用版-提示词封装-施工图.md。
  const content = uncloakPrompt(data.content);
  if (content.trim()) {
    parts.push(toDisplayText(content.trim(), data.inlineRefs ?? []));
  }
  return parts.join("\n\n");
}

/** ai_multiangle 的 prompt 由角度三元组编码。与 MultiangleEditor.buildPrompt 一致;
 *  对空 content 也能算出(组运行默认角度卡 content 未被写过的修复,见施工图 §P2.4)。 */
function buildAnglePrompt(data: ImageCardData): string {
  return `h:${data.h ?? 0},v:${data.v ?? 0},z:${data.z ?? 5}`;
}

/**
 * 从一张图片卡的 data 重建 provider 请求(单张)。批量由调用方循环。
 *
 * @param card 图片卡(ai_image / ai_multiangle / ai_tryon 也复用,后两者 prompt 特判在各自 build 前置)。
 * @param opts onUploadProgress 透传到 uploadMediaBatch。
 */
export async function buildImageRequest(
  card: CanvasCard,
  opts?: BuildImageRequestOptions,
): Promise<BuildImageRequestResult> {
  const data = card.data as ImageCardData;

  // 模型兜底:不经过编辑器的卡(模板/批量/agent/组运行)data.model 可能为空,统一走
  // modelDefaults 单一口径并写回。编辑器路径 data.model 必有值,不会进这里。
  let modelId = (data.model ?? "").trim();
  let providerId = data.provider;
  if (!modelId) {
    const fallback = await resolveDefaultModelForCardType(card.type);
    if (!fallback) return { ok: false, outcome: "failed", reason: "无法解析默认图片模型" };
    modelId = fallback.modelId;
    providerId = fallback.providerId;
    useCardStore.getState().updateCardData(card.id, { model: modelId, provider: providerId });
    autoSave.markDirty(card.id);
  }

  const isEnhancer = isEnhancerModel(modelId);
  // multiangle 的 prompt 由角度编码(始终非空);其余图像类走上游+content 拼接。
  const prompt =
    card.type === "ai_multiangle" ? buildAnglePrompt(data) : buildFinalPrompt(data);
  // enhancer(超分等)无需 prompt;其余图像类必须有 prompt(multiangle prompt 恒非空,天然通过)。
  if (!prompt && !isEnhancer) {
    return { ok: false, outcome: "skipped", reason: "缺少提示词" };
  }

  const refSlots = getRefSlotsForModel(modelId);

  // Real-ESRGAN 上游硬约束:输入图不超过 1024×1024。预检失败由调用方决定呈现。
  if (modelId === "Real-ESRGAN") {
    const MAX_DIM = 1024;
    for (const slot of refSlots) {
      const entry = data.refImages?.[slot.key];
      if (entry?.width && entry?.height && (entry.width > MAX_DIM || entry.height > MAX_DIM)) {
        return {
          ok: false,
          outcome: "skipped",
          reason: "图片分辨率过大",
          toast: {
            title: "图片分辨率过大",
            description: `Real-ESRGAN 要求输入图片不超过 ${MAX_DIM}×${MAX_DIM}，当前图片为 ${entry.width}×${entry.height}，请缩小后重试`,
          },
        };
      }
    }
  }

  // 参考图按 slot 顺序收集(role = slot.key),保持与编辑器一致的顺序与角色。
  const rawRefImages = refSlots
    .map((slot) => {
      const entry = data.refImages?.[slot.key];
      return entry ? { url: entry.url, role: slot.key } : null;
    })
    .filter((r): r is { url: string; role: string } => Boolean(r));

  const reportUpload = (
    kind: string,
  ): ((p: MediaUploadProgress) => void) | undefined =>
    opts?.onUploadProgress
      ? ({ uploaded, total }: MediaUploadProgress) =>
          opts.onUploadProgress!(kind, { uploaded, total })
      : undefined;

  const uploaded = await uploadMediaBatch(rawRefImages.map((r) => r.url), {
    onProgress: reportUpload("参考图"),
  });
  const referenceImages = rawRefImages.map((ref, i) => ({ ...ref, url: uploaded[i]! }));

  // 画质/分辨率支持度按模型 + provider 判定;不支持的维度不传,避免上游报错。
  const qualitySupported = supportsImageQuality(modelId, providerId);
  const supportsResolution = modelService.supportsImageResolution(modelId, providerId);
  const currentSize =
    normalizeImageSize(data.size) || useSettingsStore.getState().lastImageSize;
  const currentResolution = normalizeResolution(data.resolution);
  const currentQuality = data.quality || DEFAULT_IMAGE_QUALITY;

  // model SKU:按 (分辨率, 画质) 解析到具体上游 id(nano-banana/gemini flash 换 id;gpt-image-2 走 size)。
  const resolvedModel = modelService.resolveImageModelId(
    modelId,
    currentResolution,
    qualitySupported ? currentQuality : undefined,
    providerId,
  );

  const request: ImageGenRequest = {
    prompt: prompt || undefined,
    size: isEnhancer ? undefined : currentSize,
    resolution: supportsResolution ? currentResolution : undefined,
    model: resolvedModel,
    quality: isEnhancer ? undefined : qualitySupported ? currentQuality : "standard",
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    cardId: card.id,
    projectId: card.projectId,
  };

  return { ok: true, request, modelId, providerId };
}

/**
 * 采集 ai_image / ai_multiangle 的运行输入切片(同步,供 runInputFingerprint)。
 * 与上方 buildImageRequest 读的 ImageCardData 一一对应 —— 改 builder 输入字段必同步改这里
 * (runInputs.test.ts 的敏感性/不敏感性断言会卡住漂移)。排除几何/title/产物字段。
 */
export function collectImageInputs(card: CanvasCard): Record<string, unknown> {
  const data = card.data as ImageCardData;
  const modelId = (data.model ?? "").trim();
  // prompt 复用 builder 同款合成:multiangle 走角度编码,其余走上游+content(含 uncloak/inlineRefs/upstreamTexts)。
  const prompt =
    card.type === "ai_multiangle" ? buildAnglePrompt(data) : buildFinalPrompt(data);
  // 参考图按模型 slot 收集 url(role=slotKey),与请求体顺序一致;不含 width/height/sourceCardId。
  const refs = getRefSlotsForModel(modelId)
    .map((slot) => {
      const e = data.refImages?.[slot.key];
      return e ? { role: slot.key, url: e.url } : null;
    })
    .filter((r): r is { role: string; url: string } => Boolean(r));
  return {
    kind: card.type,
    model: modelId,
    provider: data.provider ?? "",
    prompt,
    size: normalizeImageSize(data.size) || "",
    resolution: normalizeResolution(data.resolution) || "",
    quality: data.quality || DEFAULT_IMAGE_QUALITY,
    refs,
  };
}
