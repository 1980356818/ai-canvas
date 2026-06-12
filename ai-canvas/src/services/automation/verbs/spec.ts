/**
 * 工程文件协议 Canvas Spec v1 —— 声明式一次性导入/导出整张工作流。
 *
 * 让 agent 不必一卡一卡 RPC:一个 JSON 声明所有卡片(用 ref 互相引用)+ 连线,整体校验通过
 * 后**事务式**创建(中途失败回滚已建卡)。这也是对外的「工程文件协议」实体 —— 内部 data.db
 * schema 永不对外,spec 才是稳定契约。
 *
 * spec.import 完全复用 card.create / connection.create 动词(零重复逻辑),只多一层校验 + ref→id
 * 映射 + 回滚。
 */

import type { VerbDefinition } from "../types";
import { fail } from "../types";
import { resolveAndOpenProject } from "../projectGateway";
import { verbRegistry } from "../registry";
import { createProject, deleteCard } from "@/platform";
import { useProjectStore } from "@/stores/projectStore";
import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { isCloaked } from "@/lib/promptCloak";

const SPEC_VERSION = 1;

interface SpecCard {
  ref: string;
  type: string;
  title?: string;
  prompt?: string;
  model?: string;
  size?: string;
  resolution?: string;
  x?: number;
  y?: number;
}

interface SpecConnection {
  from: string;
  to: string;
}

interface CanvasSpec {
  specVersion: number;
  title?: string;
  cards: SpecCard[];
  connections: SpecConnection[];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** 全量校验 spec,通过则返回规整后的强类型结构;任一处不合法整单拒绝(不创建任何东西)。 */
function validateSpec(raw: unknown): CanvasSpec {
  if (!raw || typeof raw !== "object") {
    throw fail("INVALID_ARGS", "spec 必须是对象");
  }
  const spec = raw as Record<string, unknown>;
  if (spec.specVersion !== SPEC_VERSION) {
    throw fail("INVALID_ARGS", `不支持的 specVersion: ${spec.specVersion}(当前支持 ${SPEC_VERSION})`);
  }
  if (!Array.isArray(spec.cards) || spec.cards.length === 0) {
    throw fail("INVALID_ARGS", "spec.cards 必须是非空数组");
  }

  const refs = new Set<string>();
  const cards: SpecCard[] = spec.cards.map((item, idx) => {
    const c = item as Record<string, unknown>;
    const ref = asString(c.ref);
    if (!ref) throw fail("INVALID_ARGS", `第 ${idx + 1} 张卡片缺少字符串 ref`);
    if (refs.has(ref)) throw fail("INVALID_ARGS", `ref 重复: ${ref}`);
    refs.add(ref);
    const type = asString(c.type);
    if (!type) throw fail("INVALID_ARGS", `卡片 ${ref} 缺少 type`);
    return {
      ref,
      type,
      title: asString(c.title),
      prompt: asString(c.prompt),
      model: asString(c.model),
      size: asString(c.size),
      resolution: asString(c.resolution),
      x: asNumber(c.x),
      y: asNumber(c.y),
    };
  });

  const rawConns = spec.connections ?? [];
  if (!Array.isArray(rawConns)) {
    throw fail("INVALID_ARGS", "spec.connections 必须是数组");
  }
  const connections: SpecConnection[] = rawConns.map((item, idx) => {
    const conn = item as Record<string, unknown>;
    const from = asString(conn.from);
    const to = asString(conn.to);
    if (!from || !to) throw fail("INVALID_ARGS", `第 ${idx + 1} 条连线缺少 from/to`);
    if (!refs.has(from)) throw fail("INVALID_ARGS", `连线 from 引用了不存在的 ref: ${from}`);
    if (!refs.has(to)) throw fail("INVALID_ARGS", `连线 to 引用了不存在的 ref: ${to}`);
    if (from === to) throw fail("INVALID_ARGS", `连线不能自环: ${from}`);
    return { from, to };
  });

  return {
    specVersion: SPEC_VERSION,
    title: asString(spec.title),
    cards,
    connections,
  };
}

const specImport: VerbDefinition = {
  name: "spec.import",
  description:
    "声明式一次性导入整张工作流(卡片 + 连线)。整体校验通过后才事务式创建,失败整单拒绝并回滚。省略 projectId 则按 spec.title 新建项目。返回 ref→cardId 映射。",
  params: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "导入到的项目;省略则新建一个" },
      spec: {
        type: "object",
        description:
          "Canvas Spec v1:{ specVersion:1, title?, cards:[{ref,type,prompt?,model?,size?,resolution?,x?,y?}], connections?:[{from,to}] }。ref 仅 spec 内寻址用。",
      },
    },
    required: ["spec"],
  },
  async handler(params) {
    const spec = validateSpec(params.spec);

    // 项目:指定则用(打开+等水合),否则按 title 新建。
    let projectId: string;
    if (params.projectId != null) {
      projectId = await resolveAndOpenProject(String(params.projectId));
    } else {
      const project = await createProject(spec.title?.trim() || "导入的工作流");
      useProjectStore.getState().addProject(project);
      projectId = await resolveAndOpenProject(project.id);
    }

    const cardVerb = verbRegistry.get("card.create");
    const connVerb = verbRegistry.get("connection.create");
    if (!cardVerb || !connVerb) {
      throw fail("INTERNAL", "card.create / connection.create 动词未注册");
    }
    const vctx = { source: "bridge" as const, requestId: `spec_${projectId}` };

    const refToId = new Map<string, string>();
    const createdCardIds: string[] = [];
    try {
      for (const c of spec.cards) {
        const out = (await cardVerb.handler(
          {
            projectId,
            type: c.type,
            title: c.title,
            prompt: c.prompt,
            model: c.model,
            size: c.size,
            resolution: c.resolution,
            x: c.x,
            y: c.y,
          },
          vctx,
        )) as { cardId: string };
        refToId.set(c.ref, out.cardId);
        createdCardIds.push(out.cardId);
      }
      for (const conn of spec.connections) {
        await connVerb.handler(
          { sourceCardId: refToId.get(conn.from), targetCardId: refToId.get(conn.to) },
          vctx,
        );
      }
    } catch (err) {
      // 回滚:删掉本次已建的卡(连带连线),保证"失败整单拒绝、不留半成品"。
      for (const id of createdCardIds) {
        useConnectionStore.getState().removeConnectionsForCard(id);
        useCardStore.getState().removeCard(id);
        await deleteCard(id).catch(() => undefined);
      }
      throw err;
    }

    return {
      projectId,
      cardCount: spec.cards.length,
      connectionCount: spec.connections.length,
      refToId: Object.fromEntries(refToId),
    };
  },
};

const specExport: VerbDefinition = {
  name: "spec.export",
  description:
    "把当前(或指定)项目导出为 Canvas Spec(卡片 + 连线声明)。封装卡的提示词以 [已封装] 占位,绝不吐明文。",
  params: {
    type: "object",
    properties: { projectId: { type: "string", description: "省略则用当前打开的项目" } },
  },
  async handler(params) {
    const projectId = await resolveAndOpenProject(
      params.projectId != null ? String(params.projectId) : undefined,
    );
    const title = useProjectStore.getState().projects.find((p) => p.id === projectId)?.title;
    const cards = useCardStore.getState().getCardsByProject(projectId);

    const idToRef = new Map<string, string>();
    cards.forEach((c, i) => idToRef.set(c.id, `c${i + 1}`));

    const specCards: SpecCard[] = cards.map((c) => {
      const data = (c.data ?? {}) as Record<string, unknown>;
      const content = typeof data.content === "string" ? data.content : "";
      return {
        ref: idToRef.get(c.id)!,
        type: c.type,
        title: c.title,
        prompt: isCloaked(content) ? "[已封装]" : content || undefined,
        model: asString(data.model),
        size: asString(data.size),
        resolution: asString(data.resolution),
        x: Math.round(c.x),
        y: Math.round(c.y),
      };
    });

    const connections: SpecConnection[] = useConnectionStore
      .getState()
      .getConnectionsByProject(projectId)
      .filter((c) => idToRef.has(c.sourceCardId) && idToRef.has(c.targetCardId))
      .map((c) => ({ from: idToRef.get(c.sourceCardId)!, to: idToRef.get(c.targetCardId)! }));

    return { spec: { specVersion: SPEC_VERSION, title, cards: specCards, connections } };
  },
};

export const specVerbs: VerbDefinition[] = [specImport, specExport];
