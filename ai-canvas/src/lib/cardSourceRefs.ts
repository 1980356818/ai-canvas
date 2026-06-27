/**
 * 卡片 data 里「引用其它卡(源卡 id)」的全部字段 —— **单一真相**。
 *
 * 背景:一张卡的 data 会通过多种字段指向上游源卡的 id(参考图/参考视频/参考帧/参考音频/直接媒体/
 * 上游文字/上游卡 id/内联 @ 引用…)。历史上「按源卡 id 操作 data」的逻辑散落多处、各自硬编码这份
 * 字段清单:
 *   - 复制/粘贴/移动重映射 id(clipboard.materialize)
 *   - 断连/删卡清理悬挂引用(referenceConsistency.cleanup)
 *   - 提取上游 id(getInlineUpstreamSourceIds 等)
 * 任一处漏一个字段就出 bug —— 典型:复制组时副本只重映射了一部分字段,剩下的带旧 id → 注入管线
 * 找不到槽 → 参考图/视频被按连线序整列重建,用户拖动的顺序丢失。
 *
 * 本模块把「**哪些字段、各是什么形状**」收口成一张声明式表 {@link SOURCE_REF_FIELDS},并据此派生
 * 「重映射 id」{@link remapCardSourceIds} 与「收集源卡 id」{@link collectCardSourceIds};
 * referenceConsistency 的机械型清理也复用同一张表。
 *
 * **新增任何带 sourceCardId 的 data 字段:只改这张表。**
 */
import type { RefImageEntry } from "@/config/model-ref-images";
import type { RefImages } from "@/lib/refImageSlots";
import type { InlineImageRef } from "@/lib/promptSerializer";

/** data 字段引用源卡 id 的形状。 */
export type SourceRefFieldKind =
  /** `Record<slotKey, { sourceCardId? }>` —— 槽位记账(refImages)。槽 key 是位置/角色,不是源卡 id。 */
  | "slotRecord"
  /** `Array<{ sourceCardId? }>` —— 有序数组(refFrames / refAudios / refVideos / directMedia)。 */
  | "sourceArray"
  /** `Record<sourceCardId, unknown>` —— **键本身**是源卡 id(upstreamTexts)。 */
  | "idKeyedRecord"
  /** `string` —— 单值源卡 id(upstreamCardId / sourceVideoCardId / upstreamChatCardId)。 */
  | "scalarId"
  /** `Array<InlineImageRef>` —— 仅 `source.type === "upstream"` 的项带 sourceCardId(inlineRefs)。 */
  | "inlineRefs";

export interface SourceRefField {
  field: string;
  kind: SourceRefFieldKind;
}

/**
 * 卡片 data 里所有「指向源卡」的字段清单(单一真相)。顺序无关紧要;新增字段往这里加一行即可,
 * remap / collect / cleanup 三处会自动覆盖。
 */
export const SOURCE_REF_FIELDS: readonly SourceRefField[] = [
  { field: "refImages", kind: "slotRecord" },
  { field: "refFrames", kind: "sourceArray" },
  { field: "refAudios", kind: "sourceArray" },
  { field: "refVideos", kind: "sourceArray" },
  { field: "directMedia", kind: "sourceArray" },
  { field: "upstreamTexts", kind: "idKeyedRecord" },
  { field: "upstreamCardId", kind: "scalarId" },
  { field: "sourceVideoCardId", kind: "scalarId" },
  { field: "upstreamChatCardId", kind: "scalarId" },
  { field: "inlineRefs", kind: "inlineRefs" },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SourceEntry = { sourceCardId?: string } & Record<string, unknown>;

function isUpstreamInlineRef(
  ref: InlineImageRef,
): ref is InlineImageRef & { source: { type: "upstream"; sourceCardId: string } } {
  return ref?.source?.type === "upstream";
}

/**
 * 把卡片 data 里所有源卡 id 按 `idMap` 改写,返回**新的 data 对象**(不改原对象)。
 *
 * 映射规则 `idMap.get(old) ?? old`:被一起复制/移动的源卡 → 新 id;未被复制的外部上游
 *(incoming 复制 / 跨项目)保持原 id(其连线在 materialize 里也按原 id 重连,仍有效)。
 *
 * 复制/粘贴/移动/撤销重建卡时务必经此 —— 副本若带旧源卡 id,注入管线(upsertBySource)按
 * sourceCardId 找不到槽,会把参考图/视频按连线插入序整列重建,打乱用户拖动的顺序。重映射后注入
 * 原位命中(no-op)、清理判定连线有效,顺序与槽位原样保留。
 */
export function remapCardSourceIds(
  data: Record<string, unknown>,
  idMap: Map<string, string>,
): Record<string, unknown> {
  const map = (id: string): string => idMap.get(id) ?? id;
  const next: Record<string, unknown> = { ...data };

  for (const { field, kind } of SOURCE_REF_FIELDS) {
    const value = next[field];
    switch (kind) {
      case "slotRecord": {
        if (!isPlainObject(value)) break;
        const out: Record<string, RefImageEntry> = {};
        for (const [key, entry] of Object.entries(value as RefImages)) {
          out[key] = entry?.sourceCardId ? { ...entry, sourceCardId: map(entry.sourceCardId) } : entry;
        }
        next[field] = out;
        break;
      }
      case "sourceArray": {
        if (!Array.isArray(value)) break;
        next[field] = (value as SourceEntry[]).map((item) =>
          item?.sourceCardId ? { ...item, sourceCardId: map(item.sourceCardId) } : item,
        );
        break;
      }
      case "idKeyedRecord": {
        if (!isPlainObject(value)) break;
        const out: Record<string, unknown> = {};
        for (const [sid, v] of Object.entries(value)) out[map(sid)] = v;
        next[field] = out;
        break;
      }
      case "scalarId": {
        if (typeof value === "string") next[field] = map(value);
        break;
      }
      case "inlineRefs": {
        if (!Array.isArray(value)) break;
        next[field] = (value as InlineImageRef[]).map((ref) =>
          isUpstreamInlineRef(ref)
            ? { ...ref, source: { ...ref.source, sourceCardId: map(ref.source.sourceCardId) } }
            : ref,
        );
        break;
      }
    }
  }

  return next;
}

/** 收集卡片 data 里引用到的全部源卡 id(去重)。与 remap 同表派生,口径一致。 */
export function collectCardSourceIds(data: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const { field, kind } of SOURCE_REF_FIELDS) {
    const value = data[field];
    switch (kind) {
      case "slotRecord":
        if (isPlainObject(value)) {
          for (const entry of Object.values(value as RefImages)) {
            if (entry?.sourceCardId) ids.add(entry.sourceCardId);
          }
        }
        break;
      case "sourceArray":
        if (Array.isArray(value)) {
          for (const item of value as SourceEntry[]) if (item?.sourceCardId) ids.add(item.sourceCardId);
        }
        break;
      case "idKeyedRecord":
        if (isPlainObject(value)) for (const sid of Object.keys(value)) ids.add(sid);
        break;
      case "scalarId":
        if (typeof value === "string") ids.add(value);
        break;
      case "inlineRefs":
        if (Array.isArray(value)) {
          for (const ref of value as InlineImageRef[]) {
            if (isUpstreamInlineRef(ref) && ref.source.sourceCardId) ids.add(ref.source.sourceCardId);
          }
        }
        break;
    }
  }
  return ids;
}
