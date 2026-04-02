import type { CardType } from "./types";
import type { LucideIcon } from "lucide-react";

export interface CardDefaults {
  width: number;
  height: number;
  label: string;
  data: Record<string, unknown>;
}

export const CARD_DEFAULTS: Record<CardType, CardDefaults> = {
  ai_chat: { width: 380, height: 480, label: "AI 对话", data: { messages: [] } },
  ai_image: { width: 360, height: 400, label: "AI 图片", data: { content: "" } },
  text: { width: 320, height: 240, label: "文本", data: { content: "" } },
  sticky_note: { width: 240, height: 200, label: "便签", data: { content: "" } },
};

export const TYPE_COLORS: Record<CardType, string> = {
  ai_chat: "#3B82F6",
  ai_image: "#8B5CF6",
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

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: "chat" | "image" | "composite";
  cards: WorkflowCardPreset[];
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "wf-ai-chat",
    name: "AI 对话",
    description: "快速开启一个 AI 对话，支持多轮问答与内容生成",
    icon: "MessageSquare",
    category: "chat",
    cards: [
      {
        type: "ai_chat",
        title: "AI 对话",
        relativeX: 0,
        relativeY: 0,
        width: 380,
        height: 480,
        data: { messages: [] },
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
        width: 360,
        height: 400,
        data: { content: "" },
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
        width: 380,
        height: 400,
        data: {
          messages: [],
          systemPrompt:
            "请帮我制定一套完整的内容营销策划方案，包括主题、文案方向和配图建议。",
        },
      },
      {
        type: "text",
        title: "策划备注",
        relativeX: 420,
        relativeY: 0,
        width: 320,
        height: 200,
        data: { content: "在这里记录你的想法和备注..." },
      },
    ],
  },
];
