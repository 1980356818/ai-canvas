import type { ToolDefinition } from "../types";

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
        enum: ["1024x1024", "1024x1792", "1792x1024"],
        description: "图片尺寸。正方形用 1024x1024，竖版用 1024x1792，横版用 1792x1024",
      },
      cardTitle: {
        type: "string",
        description: "画布卡片的标题",
      },
    },
    required: ["prompt", "size"],
  },

  async execute(args, ctx) {
    const { prompt, size, cardTitle } = args as {
      prompt: string;
      size: string;
      cardTitle?: string;
    };

    const result = (await ctx.callProvider("image_gen", {
      prompt,
      size,
      quality: "standard",
    })) as { url: string; revisedPrompt?: string };

    const [w = 1024, h = 1024] = size.split("x").map(Number);
    const scale = 400 / Math.max(w, h);

    ctx.createCard({
      type: "ai_image",
      title: cardTitle ?? "AI 生成图片",
      width: Math.round(w * scale),
      height: Math.round(h * scale),
      data: { content: prompt, imageUrl: result.url },
    });

    return {
      success: true,
      data: { imageUrl: result.url, revisedPrompt: result.revisedPrompt },
      artifacts: [{ type: "image" as const, payload: { url: result.url } }],
    };
  },
};
