import type { CardType } from "./types";
import type { LucideIcon } from "lucide-react";

export interface CardDefaults {
  width: number;
  height: number;
  label: string;
  data: Record<string, unknown>;
}

export const CARD_MAX_EDGE = 340;

export function sizeFromRatio(ratio: number): { width: number; height: number } {
  if (ratio >= 1) {
    return { width: CARD_MAX_EDGE, height: Math.round(CARD_MAX_EDGE / ratio) };
  }
  return { width: Math.round(CARD_MAX_EDGE * ratio), height: CARD_MAX_EDGE };
}

export interface ImageSizeOption {
  value: string;
  label: string;
  ratio: number;
}

export const IMAGE_SIZE_OPTIONS: ImageSizeOption[] = [
  { value: "1:1",   label: "1:1",   ratio: 1 },
  { value: "3:4",   label: "3:4",   ratio: 3 / 4 },
  { value: "4:3",   label: "4:3",   ratio: 4 / 3 },
  { value: "9:16",  label: "9:16",  ratio: 9 / 16 },
  { value: "16:9",  label: "16:9",  ratio: 16 / 9 },
];

export const DEFAULT_IMAGE_SIZE = IMAGE_SIZE_OPTIONS[0].value;

const LEGACY_SIZE_MAP: Record<string, string> = {
  "1024x1024": "1:1",
  "1024x1792": "9:16",
  "1792x1024": "16:9",
};

export function normalizeImageSize(raw: string | undefined): string {
  if (!raw) return DEFAULT_IMAGE_SIZE;
  if (raw.includes(":")) return raw;
  return LEGACY_SIZE_MAP[raw] ?? DEFAULT_IMAGE_SIZE;
}

export const CARD_DEFAULTS: Record<CardType, CardDefaults> = {
  ai_chat:     { width: 680, height: 420, label: "生成文字", data: { content: "", result: "" } },
  ai_image:    { ...sizeFromRatio(IMAGE_SIZE_OPTIONS[0].ratio), label: "AI 图片", data: { content: "", size: IMAGE_SIZE_OPTIONS[0].value } },
  ai_video:    { ...sizeFromRatio(16 / 9), label: "AI 视频", data: { content: "" } },
  ai_tryon:    { ...sizeFromRatio(3 / 4), label: "AI 换装", data: { content: "" } },
  text:        { ...sizeFromRatio(4 / 3), label: "文本", data: { content: "" } },
  sticky_note: { ...sizeFromRatio(5 / 4), label: "便签", data: { content: "" } },
};

export const TYPE_COLORS: Record<CardType, string> = {
  ai_chat: "#3B82F6",
  ai_image: "#8B5CF6",
  ai_video: "#EF4444",
  ai_tryon: "#EC4899",
  text: "#6B7280",
  sticky_note: "#F59E0B",
};

export const CARD_COLOR_PRESETS = [
  { name: "无", value: "" },
  { name: "红色", value: "#EF4444" },
  { name: "橙色", value: "#F97316" },
  { name: "黄色", value: "#EAB308" },
  { name: "绿色", value: "#22C55E" },
  { name: "蓝色", value: "#3B82F6" },
  { name: "紫色", value: "#8B5CF6" },
  { name: "粉色", value: "#EC4899" },
];

export interface QuickCreateItem {
  type: CardType;
  icon: LucideIcon;
  label: string;
}

export interface WorkflowCardPreset {
  type: CardType;
  title: string;
  relativeX: number;
  relativeY: number;
  width: number;
  height: number;
  data: Record<string, unknown>;
}

export interface WorkflowConnectionPreset {
  sourceIndex: number;
  targetIndex: number;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: "chat" | "image" | "composite";
  cards: WorkflowCardPreset[];
  connections?: WorkflowConnectionPreset[];
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "wf-ai-chat",
    name: "AI 对话",
    description: "输入提示词，一键生成文字内容",
    icon: "MessageSquare",
    category: "chat",
    cards: [
      {
        type: "ai_chat",
        title: "生成文字",
        relativeX: 0,
        relativeY: 0,
        ...CARD_DEFAULTS.ai_chat,
      },
    ],
  },
  {
    id: "wf-ai-image",
    name: "AI 图片生成",
    description: "通过文字描述，一键生成高质量 AI 图片",
    icon: "ImageIcon",
    category: "image",
    cards: [
      {
        type: "ai_image",
        title: "AI 图片生成",
        relativeX: 0,
        relativeY: 0,
        ...CARD_DEFAULTS.ai_image,
      },
    ],
  },
  {
    id: "wf-content-plan",
    name: "内容策划",
    description: "AI 辅助制定内容策略，生成系列文案与配图方案",
    icon: "Layers",
    category: "composite",
    cards: [
      {
        type: "ai_chat",
        title: "内容策划",
        relativeX: 0,
        relativeY: 0,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: "请帮我制定一套完整的内容营销策划方案，包括主题、文案方向和配图建议。",
          result: "",
        },
      },
      {
        type: "text",
        title: "策划备注",
        relativeX: CARD_DEFAULTS.ai_chat.width + 40,
        relativeY: 0,
        ...CARD_DEFAULTS.text,
      },
    ],
  },
  {
    id: "wf-white-bg",
    name: "一键白底图",
    description: "上传商品图，AI 自动识别特征并生成白底精修图和多角度展示图",
    icon: "ImageIcon",
    category: "composite",
    cards: [
      {
        type: "ai_image",
        title: "商品原图",
        relativeX: 0,
        relativeY: CARD_DEFAULTS.ai_chat.height + 30 - sizeFromRatio(1).height / 2,
        ...sizeFromRatio(1),
        data: { content: "", size: "1:1" },
      },
      {
        type: "ai_chat",
        title: "服装特征识别",
        relativeX: sizeFromRatio(1).width + 80,
        relativeY: 0,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          _locked: true,
          _label: "服装特征识别",
          _description: "接收商品原图后点击分析",
          _systemPrompt: [
            "你是一个电商服装产品精修提示词生成专家。用户会上传服装图片，你需要：",
            "1. 识别图片中的服装品类（如牛仔裤、羽绒服、衬衣、马甲等）",
            "2. 识别服装颜色（如浅蓝色、米白色、深灰色等）",
            "3. 识别服装关键特征（如水洗做旧、菱格绗缝、亚麻纹理、纽扣细节、刺绣图案等）",
            "4. 识别版型细节（如阔腿版型、宽松版型、常规合身等）",
            "",
            "基于识别到的信息，按照以下模板生成标准化精修提示词。只输出提示词本身，不要输出任何其他内容：",
            "",
            "产品精修，将图片中的[颜色][服装品类]完整提取并转换成3D立体形状，置于纯净的纯白背景上。正面视图、背面视图，平视视角，精准还原[服装品类]的颜色、[关键特征1]、[关键特征2]、[设计细节]以及领标细节，去除多余褶皱，使衣身轮廓平整顺滑，边缘干净无杂色。清除灰尘、瑕疵，让[服装品类]看起来挺括、崭新、洁净，光线均匀无杂乱阴影，符合电商主图标准，主体突出。",
          ].join("\n"),
          content: "请分析上传的服装图片，识别服装的品类、颜色和关键特征，生成电商白底精修提示词。",
          result: "",
        },
      },
      {
        type: "ai_image",
        title: "白底精修图",
        relativeX: sizeFromRatio(1).width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: CARD_DEFAULTS.ai_chat.height + 30 - sizeFromRatio(1).height / 2,
        ...sizeFromRatio(1),
        data: { content: "", size: "1:1" },
      },
      {
        type: "ai_chat",
        title: "多角度提示词生成",
        relativeX: sizeFromRatio(1).width + 80 + CARD_DEFAULTS.ai_chat.width + 80 + sizeFromRatio(1).width + 80,
        relativeY: 0,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          _locked: true,
          _label: "多角度提示词生成",
          _description: "基于白底图自动生成多角度展示提示词",
          _systemPrompt: [
            "你是一个电商服装多角度展示图提示词生成专家。用户会提供一张服装图片，你需要：",
            "",
            "1. 识别图片中的服装品类、颜色、关键特征",
            "2. 基于以下模板生成多角度展示图提示词。只输出提示词本身，不要输出任何其他内容：",
            "",
            "基于我提供的这件[颜色][服装品类]原图，生成一组多角度产品细节特征展示图。要求保持[服装品类]的款式、[颜色]、[关键纹理/设计]、[版型/细节]等所有细节完全不变，仅从不同角度（正面、侧面、背面、45度角、[关键部位特写1]、[关键部位特写2]、[细节特写1]、[细节特写2]等）进行拍摄式呈现，不要有重复的角度呈现。整体风格为简洁的白底商业产品图，光线均匀柔和，突出质感，清晰展现[面料质感]与[版型]细节。",
          ].join("\n"),
          content: "请分析这张服装图片，识别服装特征，生成多角度展示图提示词。",
          result: "",
        },
      },
      {
        type: "ai_image",
        title: "多角度展示图",
        relativeX: sizeFromRatio(1).width + 80 + CARD_DEFAULTS.ai_chat.width + 80 + sizeFromRatio(1).width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: CARD_DEFAULTS.ai_chat.height + 30 - sizeFromRatio(16 / 9).height / 2,
        ...sizeFromRatio(16 / 9),
        data: { content: "", size: "16:9" },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 1 },
      { sourceIndex: 0, targetIndex: 2 },
      { sourceIndex: 1, targetIndex: 2 },
      { sourceIndex: 2, targetIndex: 3 },
      { sourceIndex: 2, targetIndex: 4 },
      { sourceIndex: 3, targetIndex: 4 },
    ],
  },
  {
    id: "wf-face-gen",
    name: "捏脸",
    description: "上传人脸照片，AI 融合生成人脸肖像和 4 角度人物展示",
    icon: "User",
    category: "composite",
    cards: [
      {
        type: "ai_image",
        title: "人脸照片1",
        relativeX: 0,
        relativeY: CARD_DEFAULTS.ai_chat.height + 30 - sizeFromRatio(1).height - 15,
        ...sizeFromRatio(1),
        data: { content: "", size: "1:1" },
      },
      {
        type: "ai_image",
        title: "人脸照片2",
        relativeX: 0,
        relativeY: CARD_DEFAULTS.ai_chat.height + 45,
        ...sizeFromRatio(1),
        data: { content: "", size: "1:1" },
      },
      {
        type: "ai_chat",
        title: "人脸特征分析",
        relativeX: sizeFromRatio(1).width + 80,
        relativeY: 0,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          _locked: true,
          _label: "人脸特征分析",
          _description: "接收两张人脸照片后点击分析",
          _systemPrompt: [
            "你是一个人脸特征分析与融合提示词生成专家。用户会上传两张人脸照片，你需要：",
            "",
            "1. 分析每张照片中的面部特征（脸型、眼型、鼻型、嘴型、肤色、发型等）",
            "2. 识别两张面孔的独特特征和共同特征",
            "3. 基于分析结果，生成一段融合两张面孔特征的肖像生成提示词",
            "",
            "只输出提示词本身，不要输出任何其他内容。提示词模板：",
            "",
            "A photorealistic portrait of a distinct individual who looks like the biological offspring of the people in the provided reference photos.",
            "The face should be a natural, organic blend of the input features — combining [面孔1关键特征] with [面孔2关键特征],",
            "creating a unique new identity that bears a strong family resemblance to both inputs without being a direct copy of either.",
            "Capture the subtle genetic traits from the references.",
            "",
            "Character Description:",
            "Subject: An Asian model with [融合后肤色], [融合后脸型], [融合后眼型], [融合后鼻型], [融合后嘴型], and [融合后发型].",
            "Flawless, pore-level skin texture.",
            "Expression: Neutral and candid, with a high-quality photo realism aesthetic — soft, cinematic lighting that highlights facial contours.",
            "Vibe: High-fashion, sophisticated, and authentic.",
            "Setting: white background, eye-level front face.",
            "",
            "Technical Constraints:",
            "Maintain consistent lighting across the blended features.",
            "Output in 4k resolution, raw photography style.",
          ].join("\n"),
          content: "请分析上传的两张人脸照片，识别面部特征，生成人脸融合肖像提示词。",
          result: "",
        },
      },
      {
        type: "ai_image",
        title: "人脸肖像融合",
        relativeX: sizeFromRatio(1).width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: CARD_DEFAULTS.ai_chat.height + 30 - sizeFromRatio(3 / 4).height / 2,
        ...sizeFromRatio(3 / 4),
        data: { content: "", size: "9:16" },
      },
      {
        type: "ai_chat",
        title: "多角度提示词生成",
        relativeX: sizeFromRatio(1).width + 80 + CARD_DEFAULTS.ai_chat.width + 80 + sizeFromRatio(3 / 4).width + 80,
        relativeY: 0,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          _locked: true,
          _label: "多角度提示词生成",
          _description: "基于融合肖像自动生成 4 角度展示提示词",
          _systemPrompt: [
            "你是一个人物多角度展示图提示词生成专家。用户会提供一张人脸肖像图片，你需要：",
            "",
            "1. 识别图片中人物的面部特征、发型、肤色等关键视觉特征",
            "2. 基于以下模板生成多角度展示图提示词。只输出提示词本身，不要输出任何其他内容：",
            "",
            "A 2x2 grid character sheet of the reference image, white background.",
            "The grid shows the same character from 4 different camera angles:",
            "1. Front view, 2. Left Profile view, 3. Right Three-Quarter view, 4. Low angle looking up.",
            "Headshot framing. Consistent facial features including [肤色], [脸型], [眼型], [发型] and all distinguishing characteristics.",
            "Maintain identical lighting and style across all angles.",
          ].join("\n"),
          content: "请分析这张人脸肖像，生成 4 角度展示图提示词。",
          result: "",
        },
      },
      {
        type: "ai_image",
        title: "4角度展示",
        relativeX: sizeFromRatio(1).width + 80 + CARD_DEFAULTS.ai_chat.width + 80 + sizeFromRatio(3 / 4).width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: CARD_DEFAULTS.ai_chat.height + 30 - sizeFromRatio(16 / 9).height / 2,
        ...sizeFromRatio(16 / 9),
        data: { content: "", size: "16:9" },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 2 },
      { sourceIndex: 1, targetIndex: 2 },
      { sourceIndex: 0, targetIndex: 3 },
      { sourceIndex: 1, targetIndex: 3 },
      { sourceIndex: 2, targetIndex: 3 },
      { sourceIndex: 3, targetIndex: 4 },
      { sourceIndex: 3, targetIndex: 5 },
      { sourceIndex: 4, targetIndex: 5 },
    ],
  },
];
