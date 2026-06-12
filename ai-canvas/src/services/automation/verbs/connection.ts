/** 连线动词:创建 / 删除。addConnection/removeConnection 经 useConnectionSync 自动持久化。 */

import type { VerbDefinition } from "../types";
import { fail } from "../types";
import type { Connection } from "@/types";
import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";

const connectionCreate: VerbDefinition = {
  name: "connection.create",
  description:
    "在两张卡片间建立连线(source → target)。上游(source)的文本/图片会在 target 生成时作为提示词/参考图注入。",
  params: {
    type: "object",
    properties: {
      sourceCardId: { type: "string", description: "上游卡片 id" },
      targetCardId: { type: "string", description: "下游卡片 id" },
    },
    required: ["sourceCardId", "targetCardId"],
  },
  async handler(params) {
    const sourceCardId = String(params.sourceCardId ?? "");
    const targetCardId = String(params.targetCardId ?? "");
    if (!sourceCardId || !targetCardId) {
      throw fail("INVALID_ARGS", "缺少 sourceCardId 或 targetCardId");
    }
    if (sourceCardId === targetCardId) {
      throw fail("INVALID_ARGS", "不能把卡片连接到自身");
    }

    const cardStore = useCardStore.getState();
    const src = cardStore.getCard(sourceCardId);
    const dst = cardStore.getCard(targetCardId);
    if (!src || !dst) throw fail("NOT_FOUND", "源或目标卡片不存在(或所在项目未打开)");
    if (src.projectId !== dst.projectId) {
      throw fail("INVALID_ARGS", "两张卡片不在同一项目");
    }

    const connStore = useConnectionStore.getState();
    if (connStore.hasConnection(sourceCardId, targetCardId)) {
      const existing = connStore
        .getConnectionsByProject(src.projectId)
        .find((c) => c.sourceCardId === sourceCardId && c.targetCardId === targetCardId);
      return { connectionId: existing?.id ?? null, created: false };
    }

    const conn: Connection = {
      id: crypto.randomUUID(),
      projectId: src.projectId,
      sourceCardId,
      targetCardId,
      createdAt: new Date().toISOString(),
    };
    connStore.addConnection(conn);
    return { connectionId: conn.id, created: true };
  },
};

const connectionDelete: VerbDefinition = {
  name: "connection.delete",
  description: "删除一条连线。",
  params: {
    type: "object",
    properties: { connectionId: { type: "string" } },
    required: ["connectionId"],
  },
  async handler(params) {
    const connectionId = String(params.connectionId ?? "");
    const store = useConnectionStore.getState();
    if (!store.connections.has(connectionId)) {
      throw fail("NOT_FOUND", `连线不存在: ${connectionId}`);
    }
    store.removeConnection(connectionId);
    return { connectionId, deleted: true };
  },
};

export const connectionVerbs: VerbDefinition[] = [connectionCreate, connectionDelete];
