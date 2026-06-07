import type { LucideIcon } from "lucide-react";

export type CardType = "ai_chat" | "ai_image" | "ai_video" | "ai_tryon" | "ai_multiangle" | "audio" | "text" | "sticky_note" | "frame_extractor";

export interface CanvasCard {
  id: string;
  projectId: string;
  type: CardType;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  locked: boolean;
  collapsed: boolean;
  color?: string;
  title?: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CardRow {
  id: string;
  project_id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  locked: boolean;
  collapsed: boolean;
  color: string | null;
  title: string | null;
  data: string;
  created_at: string;
  updated_at: string;
}

export interface CardDefaults {
  width: number;
  height: number;
  label: string;
  data: Record<string, unknown>;
}

export interface ImageSizeOption {
  value: string;
  label: string;
  ratio: number;
}

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
  /**
   * 面向用户的浏览分类 slug,见 `config/templateCategories.ts` 的 TEMPLATE_CATEGORIES
   * (flat 平面 / video 视频 / detail 详情页 / trial 试用版)。放宽为 string:既容历史值
   * (chat/image/composite),又让新分类无需改类型即可扩展(服务端驱动)。
   */
  category: string;
  coverImage?: string;
  cards: WorkflowCardPreset[];
  connections?: WorkflowConnectionPreset[];
}
