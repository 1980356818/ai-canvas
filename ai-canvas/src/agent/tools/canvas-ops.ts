import type { ToolDefinition } from "../types";

export const canvasOpsTool: ToolDefinition = {
  name: "canvas_operations",
  description:
    "对画布上的卡片执行操作：创建新卡片、更新卡片内容、查看所有卡片列表。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "list"],
        description: "操作类型",
      },
      cardType: {
        type: "string",
        enum: ["text", "sticky_note", "ai_chat", "ai_image", "ai_multiangle"],
        description: "卡片类型（create 时必填）",
      },
      cardId: {
        type: "string",
        description: "卡片 ID（update 时必填）",
      },
      title: { type: "string", description: "卡片标题" },
      content: { type: "string", description: "卡片文本内容" },
      width: { type: "number" },
      height: { type: "number" },
    },
    required: ["action"],
  },

  async execute(args, ctx) {
    const { action, cardType, cardId, title, content, width, height } =
      args as {
        action: string;
        cardType?: string;
        cardId?: string;
        title?: string;
        content?: string;
        width?: number;
        height?: number;
      };

    switch (action) {
      case "create": {
        const type = cardType ?? "text";
        const data: Record<string, unknown> =
          type === "ai_chat"
            ? { messages: [] }
            : { content: content ?? "" };

        const id = ctx.createCard({ type, title, width, height, data });
        return {
          success: true,
          data: { cardId: id, action: "created" },
          artifacts: [{ type: "card" as const, payload: { id, cardType: type } }],
        };
      }

      case "update": {
        if (!cardId)
          return { success: false, data: { error: "cardId is required for update" } };

        const existing = ctx.readCard(cardId);
        if (!existing)
          return { success: false, data: { error: `Card ${cardId} not found` } };

        const patch: Record<string, unknown> = {};
        if (title !== undefined) patch.title = title;
        if (width !== undefined) patch.width = width;
        if (height !== undefined) patch.height = height;
        if (content !== undefined) {
          patch.data = { ...existing.data, content };
        }

        ctx.updateCard(cardId, patch);
        return { success: true, data: { cardId, action: "updated" } };
      }

      case "list": {
        const cards = ctx.listCards().map((c) => ({
          id: c.id,
          type: c.type,
          title: c.title,
          x: c.x,
          y: c.y,
        }));
        return { success: true, data: { cards, count: cards.length } };
      }

      default:
        return {
          success: false,
          data: { error: `Unknown action: ${action}` },
        };
    }
  },
};
