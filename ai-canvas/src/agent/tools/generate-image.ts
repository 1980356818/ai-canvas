import type { ToolDefinition } from "../types";
import {
  IMAGE_SIZE_OPTIONS,
  sizeFromRatio,
  SUPPORTED_RESOLUTIONS,
  normalizeResolution,
} from "@/shared/constants";

export const generateImageTool: ToolDefinition = {
  name: "generate_image",
  description:
    "根据文字描述生成图片（海报、Banner、产品图等），并将结果放置到画布上。",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "图片生成 prompt（英文，详细描述画面内容、风格、色彩）",
      },
      size: {
        type: "string",
        enum: IMAGE_SIZE_OPTIONS.map((o) => o.value),
        description: "图片比例。正方形用 1:1，竖版用 9:16，横版用 16:9",
      },
      resolution: {
        type: "string",
        enum: [...SUPPORTED_RESOLUTIONS],
        description:
          "图像画质档位。用户明确说出 4K / 4k / 超清 / ultra HD 时填 \"4K\"；其它情况省略此字段，系统会默认 2K。",
      },
      cardTitle: {
        type: "string",
        description: "画布卡片的标题",
      },
    },
    required: ["prompt", "size"],
  },

  async execute(args, ctx) {
    const { prompt, size, resolution, cardTitle } = args as {
      prompt: string;
      size: string;
      resolution?: string;
      cardTitle?: string;
    };

    // 用户没明说就走默认 2K;明说 4K 则走 4K。base.ts 也会做一次同样的兜底,
    // 这里显式 normalize 是为了让所有 generateImage 入口的语义对称、好搜索。
    const normalizedResolution = normalizeResolution(resolution);

    const result = (await ctx.callProvider("image_gen", {
      prompt,
      size,
      resolution: normalizedResolution,
      quality: "standard",
    })) as { url: string; revisedPrompt?: string };

    const opt = IMAGE_SIZE_OPTIONS.find((o) => o.value === size);
    const { width, height } = sizeFromRatio(opt?.ratio ?? 1);

    ctx.createCard({
      type: "ai_image",
      title: cardTitle ?? "AI 生成图片",
      width,
      height,
      data: { content: prompt, imageUrl: result.url, size, resolution: normalizedResolution },
    });

    return {
      success: true,
      data: { imageUrl: result.url, revisedPrompt: result.revisedPrompt },
      artifacts: [{ type: "image" as const, payload: { url: result.url } }],
    };
  },
};
