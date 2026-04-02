import type { ToolDefinition } from "../types";
import type { ChatResponse } from "../providers/base";

export const generateTextTool: ToolDefinition = {
  name: "generate_text",
  description:
    "生成文案内容（小红书文案、营销文案、产品描述等），并将结果以文本卡片形式放到画布上。",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "文案类型，如 xiaohongshu、marketing、product_desc、article",
      },
      topic: {
        type: "string",
        description: "文案主题",
      },
      style: {
        type: "string",
        description: "风格要求，如 种草、正式、幽默、简洁",
      },
      cardTitle: {
        type: "string",
        description: "画布卡片标题",
      },
    },
    required: ["topic"],
  },

  async execute(args, ctx) {
    const { type, topic, style, cardTitle } = args as {
      type?: string;
      topic: string;
      style?: string;
      cardTitle?: string;
    };

    const typeLabel = type ?? "通用";
    const styleLabel = style ? `，风格要求：${style}` : "";

    const result = (await ctx.callProvider("chat", {
      model: ctx.model,
      systemPrompt: `你是一个专业文案创作者。直接输出文案内容，不需要额外说明。`,
      messages: [
        {
          role: "user",
          content: `请为以下主题创作一篇${typeLabel}类型的文案${styleLabel}。\n\n主题：${topic}`,
        },
      ],
    })) as ChatResponse;

    const text = result.content ?? "";

    ctx.createCard({
      type: "text",
      title: cardTitle ?? `文案: ${topic.slice(0, 20)}`,
      width: 380,
      height: Math.min(600, Math.max(240, text.length * 0.8)),
      data: { content: text },
    });

    return {
      success: true,
      data: { text, charCount: text.length },
      artifacts: [{ type: "text" as const, payload: { text } }],
    };
  },
};
