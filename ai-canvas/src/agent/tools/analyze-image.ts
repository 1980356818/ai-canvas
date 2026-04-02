import type { ToolDefinition } from "../types";
import type { ChatResponse } from "../providers/base";

export const analyzeImageTool: ToolDefinition = {
  name: "analyze_image",
  description:
    "分析用户提供的图片，提取内容、风格、色彩、构图等信息。用于在生成新图片之前理解参考图。",
  parameters: {
    type: "object",
    properties: {
      imageUrl: {
        type: "string",
        description: "要分析的图片 URL 或 data-URL",
      },
      focus: {
        type: "string",
        enum: ["content", "style", "color", "composition", "all"],
        description: "分析侧重点，默认 all",
      },
    },
    required: ["imageUrl"],
  },

  async execute(args, ctx) {
    const { imageUrl, focus } = args as {
      imageUrl: string;
      focus?: string;
    };

    const focusLabel = focus ?? "all";
    const focusMap: Record<string, string> = {
      content: "主体内容和场景",
      style: "视觉风格和设计语言",
      color: "主色调和配色方案",
      composition: "构图方式和布局",
      all: "所有方面（主体内容、视觉风格、主色调、构图方式）",
    };

    const result = (await ctx.callProvider("chat", {
      model: ctx.model,
      systemPrompt: "你是一个专业的视觉分析助手。请用结构化 JSON 回复。",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `请分析这张图片的${focusMap[focusLabel] ?? focusMap.all}。以 JSON 格式返回，包含 subject、style、colors（数组）、composition、mood 字段。`,
            },
            { type: "image", url: imageUrl, mimeType: "image/png" },
          ],
        },
      ],
    })) as ChatResponse;

    let analysis: unknown;
    try {
      const raw = result.content ?? "{}";
      const jsonMatch = raw.match(/```json?\s*([\s\S]*?)```/) ?? [null, raw];
      analysis = JSON.parse(jsonMatch[1]!.trim());
    } catch {
      analysis = { raw: result.content };
    }

    return {
      success: true,
      data: analysis,
    };
  },
};
