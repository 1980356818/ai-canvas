/**
 * 模特换装(ai_tryon)生成请求构建 —— 编辑器手点 / cardRunner 组运行 共用。
 *
 * 背景见 docs/生成统一重构施工图.md §P2.4。tryon 与通用图像生成差异过大,单列一份:
 *  - prompt 固定前缀 `模特换装: ` + 换装要求(空则给默认句),不走 upstream/content 拼接;
 *  - 参考素材是 person / garment 两个具名槽(不是 refImageN),role 用 "person"/"garment";
 *  - size 固定 "1024x1024"、quality 固定 "standard"、不发 resolution。
 *
 * 修复:旧 TryOnEditor 手点**根本没发 referenceImages**(只发 prompt),换装其实拿不到图;
 * 旧 cardRunner 又用通用 flattenRefImages 发了。两路不一致(施工图 §P2.4「需定一种」)。
 * 这里统一为**发 person/garment 参考图**(换装没图无意义),手点与组跑都走这份。
 *
 * 契约与 buildImageRequest 对齐(复用 BuildImageRequestResult / Options)。
 * 对照源:`TryOnEditor.tsx` 的 `handleGenerate`(P2.4 迁移基线)。
 */

import type { CanvasCard } from "@/types";
import type { ImageGenRequest } from "@/providers/types";
import { resolveDefaultModelForCardType } from "@/services/modelDefaults";
import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { uncloakPrompt } from "@/lib/promptCloak";
import { uploadMediaBatch, type MediaUploadProgress } from "@/platform/media";
import type { RefImageEntry } from "@/config/model-ref-images";
import type {
  BuildImageRequestOptions,
  BuildImageRequestResult,
} from "./buildImageRequest";

/** 换装要求为空时的默认指令(与 TryOnEditor 一致)。 */
const TRYON_DEFAULT_INSTRUCTION = "将服装穿在人物身上，保持人物姿态和背景不变";

interface TryonCardData {
  content?: string;
  model?: string;
  provider?: string;
  personImageUrl?: string;
  garmentImageUrl?: string;
  refImages?: Record<string, RefImageEntry>;
}

/**
 * 从一张换装卡的 data 重建 provider 请求。
 *
 * @param card ai_tryon 卡。
 * @param opts onUploadProgress 透传到 uploadMediaBatch(编辑器写 setCardProgress)。
 */
export async function buildTryonRequest(
  card: CanvasCard,
  opts?: BuildImageRequestOptions,
): Promise<BuildImageRequestResult> {
  const data = card.data as TryonCardData;

  // 模型兜底:同其它 build,空 model 走 modelDefaults 单一口径并写回。
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

  // person/garment 来源:优先具名 ref 槽,回退 personImageUrl/garmentImageUrl(与 TryOnEditor 一致)。
  const personUrl = data.refImages?.person?.url ?? data.personImageUrl;
  const garmentUrl = data.refImages?.garment?.url ?? data.garmentImageUrl;
  if (!personUrl && !garmentUrl) {
    // TryOnEditor 把这条当 error 态(非 toast),调用方据 reason 呈现。
    return { ok: false, outcome: "skipped", reason: "请至少上传一张图片" };
  }

  // 试用版模板换装指令可能以 ENC1:: 编码存放;在此解码,非编码文本透传。
  const instruction = uncloakPrompt(data.content).trim() || TRYON_DEFAULT_INSTRUCTION;
  const prompt = `模特换装: ${instruction}`;

  const rawRefs = [
    personUrl ? { url: personUrl, role: "person" } : null,
    garmentUrl ? { url: garmentUrl, role: "garment" } : null,
  ].filter((r): r is { url: string; role: string } => Boolean(r));

  const reportUpload = (
    kind: string,
  ): ((p: MediaUploadProgress) => void) | undefined =>
    opts?.onUploadProgress
      ? ({ uploaded, total }: MediaUploadProgress) =>
          opts.onUploadProgress!(kind, { uploaded, total })
      : undefined;

  const uploaded = await uploadMediaBatch(rawRefs.map((r) => r.url), {
    onProgress: reportUpload("参考图"),
  });
  const referenceImages = rawRefs.map((ref, i) => ({ ...ref, url: uploaded[i]! }));

  const request: ImageGenRequest = {
    prompt,
    size: "1024x1024",
    model: modelId || undefined,
    quality: "standard",
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    cardId: card.id,
    projectId: card.projectId,
  };

  return { ok: true, request, modelId, providerId };
}

/**
 * 采集 ai_tryon 的运行输入切片(同步,供 runInputFingerprint)。
 * prompt 用 builder 同款「模特换装: 指令」合成 —— uncloak + 空 content 归一到默认句(空与默认句同 fp);
 * person/garment 用 builder 同款回退(refImages 具名槽 ?? 旧 url 字段)。size/quality 固定不入 fp。
 */
export function collectTryonInputs(card: CanvasCard): Record<string, unknown> {
  const data = card.data as TryonCardData;
  const instruction = uncloakPrompt(data.content).trim() || TRYON_DEFAULT_INSTRUCTION;
  return {
    kind: "ai_tryon",
    model: (data.model ?? "").trim(),
    provider: data.provider ?? "",
    prompt: `模特换装: ${instruction}`,
    person: data.refImages?.person?.url ?? data.personImageUrl ?? "",
    garment: data.refImages?.garment?.url ?? data.garmentImageUrl ?? "",
  };
}
