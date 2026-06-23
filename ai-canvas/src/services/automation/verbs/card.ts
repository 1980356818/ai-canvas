/** 卡片动词:新建 / 更新 / 删除。直接写已水合的 store + autoSave 持久化,与 UI 同一路径。 */

import type { VerbDefinition } from "../types";
import { fail } from "../types";
import type { CanvasCard, CardType } from "@/types";
import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { autoSave } from "@/lib/autoSave";
import { deleteCard } from "@/platform";
import { isCloaked } from "@/lib/promptCloak";
import { resolveAndOpenProject } from "../projectGateway";

/** 可由自动化创建的卡片类型(排除 frame_extractor 等需特殊上游的内部类型)。 */
const CREATABLE_TYPES: CardType[] = [
  "text",
  "sticky_note",
  "ai_image",
  "ai_video",
  "ai_chat",
  "ai_multiangle",
  "ai_tryon",
];

/** 各类型的默认尺寸(与编辑器新建卡观感一致)。 */
const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  text: { w: 320, h: 200 },
  sticky_note: { w: 240, h: 200 },
  ai_image: { w: 360, h: 360 },
  ai_video: { w: 360, h: 360 },
  ai_chat: { w: 420, h: 520 },
  ai_multiangle: { w: 360, h: 360 },
  ai_tryon: { w: 360, h: 360 },
};

/**
 * 确定性网格布局:按现有卡片数算行列,不依赖视口。自动化场景可预测、不重叠。
 * 每行 4 张,左上角起,卡片间留 60px。
 */
function placeNewCard(projectId: string, w: number, h: number): { x: number; y: number } {
  const i = useCardStore.getState().getCardsByProject(projectId).length;
  const COLS = 4;
  const GAP = 60;
  const ORIGIN = 80;
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return { x: ORIGIN + col * (w + GAP), y: ORIGIN + row * (h + GAP) };
}

/**
 * 构造卡片初始 data。提示词写入 `content` 字段(与 buildImageRequest/dataFlow 的读取口径
 * 一致;**不是** `prompt`),上游连线注入的文本会另存 `upstreamTexts` 并在生成时与之拼接。
 */
function buildInitialData(
  type: CardType,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "ai_chat") return { messages: [] };

  const data: Record<string, unknown> = {};
  const prompt = params.prompt;
  if (prompt != null) data.content = String(prompt);
  else if (type === "text" || type === "sticky_note") data.content = "";

  if (params.model != null) data.model = String(params.model);
  if (params.size != null) data.size = String(params.size);
  if (params.resolution != null) data.resolution = String(params.resolution);
  return data;
}

const cardCreate: VerbDefinition = {
  name: "card.create",
  description:
    "在指定(或当前)项目里新建一张卡片。图片/视频卡用 prompt 写提示词、size/resolution 选规格;model 省略时由系统按类型选默认模型。",
  params: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "省略则用当前打开的项目" },
      type: {
        type: "string",
        enum: CREATABLE_TYPES,
        description: "卡片类型",
      },
      title: { type: "string", description: "卡片标题(可选)" },
      prompt: { type: "string", description: "提示词 / 文本内容(text 卡即正文,图片卡即生成提示词)" },
      model: { type: "string", description: "模型 id(可选,省略走默认)" },
      size: { type: "string", description: "图片比例,如 1:1 / 16:9 / 9:16(可选)" },
      resolution: { type: "string", description: "画质档位,如 2K / 4K(可选)" },
      x: { type: "number", description: "画布 x 坐标(可选,省略自动网格布局)" },
      y: { type: "number", description: "画布 y 坐标(可选)" },
      width: { type: "number" },
      height: { type: "number" },
    },
    required: ["type"],
  },
  async handler(params) {
    const type = String(params.type ?? "") as CardType;
    if (!CREATABLE_TYPES.includes(type)) {
      throw fail("INVALID_ARGS", `不支持的卡片类型: ${type}`);
    }
    const projectId = await resolveAndOpenProject(
      params.projectId != null ? String(params.projectId) : undefined,
    );

    const def = DEFAULT_SIZE[type] ?? { w: 360, h: 300 };
    const width = Number(params.width) || def.w;
    const height = Number(params.height) || def.h;
    const pos =
      params.x != null && params.y != null
        ? { x: Number(params.x), y: Number(params.y) }
        : placeNewCard(projectId, width, height);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const store = useCardStore.getState();
    const card: CanvasCard = {
      id,
      projectId,
      type,
      x: pos.x,
      y: pos.y,
      width,
      height,
      zIndex: store.maxZIndex + 1,
      locked: false,
      collapsed: false,
      title: params.title != null ? String(params.title) : undefined,
      data: buildInitialData(type, params),
      createdAt: now,
      updatedAt: now,
    };
    store.addCard(card);
    autoSave.markDirty(id);
    return { cardId: id, type };
  },
};

const cardUpdate: VerbDefinition = {
  name: "card.update",
  description:
    "更新一张卡片的标题 / 提示词 / 模型 / 尺寸等。封装(试用模板)卡片的提示词不可修改。",
  params: {
    type: "object",
    properties: {
      cardId: { type: "string" },
      title: { type: "string" },
      prompt: { type: "string", description: "覆盖提示词 / 文本内容" },
      model: { type: "string" },
      size: { type: "string" },
      resolution: { type: "string" },
      width: { type: "number" },
      height: { type: "number" },
    },
    required: ["cardId"],
  },
  async handler(params) {
    const cardId = String(params.cardId ?? "");
    const store = useCardStore.getState();
    const existing = store.getCard(cardId);
    if (!existing) throw fail("NOT_FOUND", `卡片不存在: ${cardId}`);

    const geomPatch: Partial<CanvasCard> = {};
    if (params.title !== undefined) geomPatch.title = String(params.title);
    if (params.width !== undefined) geomPatch.width = Number(params.width);
    if (params.height !== undefined) geomPatch.height = Number(params.height);

    const dataPatch: Record<string, unknown> = {};
    if (params.prompt !== undefined) {
      // 黑箱:封装卡的提示词不可经接口改写(防覆盖/防探明文)。
      const currentContent = (existing.data as Record<string, unknown>)?.content;
      if (isCloaked(typeof currentContent === "string" ? currentContent : undefined)) {
        throw fail("GATED", "该卡片提示词已封装,不可修改");
      }
      dataPatch.content = String(params.prompt);
    }
    if (params.model !== undefined) dataPatch.model = String(params.model);
    if (params.size !== undefined) dataPatch.size = String(params.size);
    if (params.resolution !== undefined) dataPatch.resolution = String(params.resolution);

    if (Object.keys(geomPatch).length > 0) store.updateCard(cardId, geomPatch);
    if (Object.keys(dataPatch).length > 0) store.updateCardData(cardId, dataPatch);
    autoSave.markDirty(cardId);
    return { cardId, updated: true };
  },
};

const cardDelete: VerbDefinition = {
  name: "card.delete",
  description: "删除一张卡片及其相连的所有连线。",
  params: {
    type: "object",
    properties: { cardId: { type: "string" } },
    required: ["cardId"],
  },
  async handler(params) {
    const cardId = String(params.cardId ?? "");
    const store = useCardStore.getState();
    if (!store.getCard(cardId)) throw fail("NOT_FOUND", `卡片不存在: ${cardId}`);
    // 先删相连连线(触发 useConnectionSync 持久化 + 引用一致性清理),再删卡。
    useConnectionStore.getState().removeConnectionsForCard(cardId);
    store.removeCard(cardId);
    await deleteCard(cardId);
    return { cardId, deleted: true };
  },
};

export const cardVerbs: VerbDefinition[] = [cardCreate, cardUpdate, cardDelete];
