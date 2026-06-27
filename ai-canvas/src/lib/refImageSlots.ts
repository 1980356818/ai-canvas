/**
 * 参考图槽位 —— 顺序/增删改的【单一真相】。
 *
 * 背景:历史上「参考图顺序」没有显式存储,而是隐含在「哪个槽 key(refImage0/1/2…)放哪条」,
 * 且增(注入/连线/拖入)、删(清除/断连/删卡)、改(替换/重排)、读(构建请求/编辑器展示)
 * 的逻辑散落在 4 个编辑器 + dataFlow + referenceConsistency,各写一份、彼此口径不一:
 *   - 注入把新源塞「第一个空槽」、删除有的 compact 有的留空洞、重排各自手搓、内联 @ 引用各自重映射。
 * 任一处疏忽就会「重新生成 / 替换 / 断连后顺序自己变」。
 *
 * 本模块把这套逻辑收口成**一组纯函数 + 一个落库胶水**,所有调用方只经这里:
 *
 *   规范不变量(canonical invariant):
 *   ── 定位型(positional)模型(图片/对话/帮我写/视频参考,槽 key 形如 refImageN):
 *      refImages 永远**紧凑、连续(从 refImage0 起、无空洞)**,且**槽索引 == 展示/请求顺序**。
 *   ── 具名型(named)模型(试衣 person/garment):槽由「角色」固定,无顺序概念、**不 compact**,
 *      按 key 原位增删改。
 *
 *   统一行为:
 *   - 读顺序        → listRefEntries / listRefSlots(唯一读序入口)
 *   - 内容替换(同源)→ upsertBySource:按 sourceCardId 命中则**原位更新 url**(位置不变),否则追加到队尾
 *   - 指定槽替换    → setAt:在该槽原位替换(位置不变)
 *   - 删除(清/断连)→ removeAt / removeSources:删后 compact(定位型),内联 @ 引用随 keyMap 重映射
 *   - 拖动重排      → reorder:移动后 compact,内联 @ 引用随 keyMap 重映射
 *   - 暂态产物为空   → 调用方**不要**删参考图(由 dataFlow none 分支保证);只有连线真断才删
 *
 * 每个变更函数都返回 {@link SlotMutation}(新 refImages + keyMap + removed),由 {@link applySlotKeyMap}
 * 把提示词里的 `{{ref:slot:refImageN}}` 内联引用一并对齐——内联 @ 引用与槽顺序的同步**只此一处**。
 */
import {
  getRefSlotsForModel,
  getRefSlotsForChatModel,
  getRefSlotsForVideoModel,
  type RefImageSlot,
  type RefImageEntry,
} from "@/config/model-ref-images";
import type { CanvasCard } from "@/types";
import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { applySlotKeyMap, type InlineImageRef } from "@/lib/promptSerializer";

export type RefImages = Record<string, RefImageEntry>;

export interface SlotMutation {
  /** 新的槽映射;空时为 undefined(沿用 store「空即删字段」约定)。 */
  refImages: RefImages | undefined;
  /** 旧槽 key → 新槽 key(仅发生移动的条目);驱动内联 @ 引用 / 提示词 token 重映射。 */
  keyMap: Map<string, string>;
  /** 被整条移除的槽 key(其内联 @ 引用需一并删掉)。 */
  removed: string[];
  /** 是否真有变化(无变化时调用方可短路,不写库、不触发下游 watcher)。 */
  changed: boolean;
}

const POSITIONAL_KEY = /^refImage\d+$/;

/** 定位型(顺序敏感、可 compact)还是具名型(角色固定、不可 compact)。 */
export function isPositional(slots: RefImageSlot[]): boolean {
  return slots.length > 0 && slots.every((s) => POSITIONAL_KEY.test(s.key));
}

function noChange(refImages: RefImages | undefined): SlotMutation {
  return { refImages: emptyToUndef(refImages), keyMap: new Map(), removed: [], changed: false };
}

function emptyToUndef(refImages: RefImages | undefined): RefImages | undefined {
  return refImages && Object.keys(refImages).length > 0 ? refImages : undefined;
}

function positionalIndex(key: string): number {
  const n = parseInt(key.replace("refImage", ""), 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * 当前占用条目的规范顺序——**从 refImages 自身的 key 推导**(定位型按 refImageN 数字升序,
 * 具名型按对象键序),不依赖 slots 是否完整。这样即便 slots 解析为空(如对话卡切到无视觉模型后
 * 仍残留 refImages)或条目数超过模型槽数,变更操作也不会丢条目。slots 只用来判定定位/具名。
 */
function currentOrder(
  refImages: RefImages,
  slots: RefImageSlot[],
): Array<{ slotKey: string; entry: RefImageEntry }> {
  const keys = Object.keys(refImages);
  if (isPositional(slots)) keys.sort((a, b) => positionalIndex(a) - positionalIndex(b));
  return keys.map((k) => ({ slotKey: k, entry: refImages[k]! }));
}

// ── 读序(唯一入口)────────────────────────────────────────────

/** 按槽顺序取出 [slotKey, entry](跳过空槽)。= 用户看到 / 请求发送的顺序。 */
export function listRefSlots(
  refImages: RefImages | undefined,
  slots: RefImageSlot[],
): Array<{ slotKey: string; entry: RefImageEntry }> {
  if (!refImages) return [];
  const out: Array<{ slotKey: string; entry: RefImageEntry }> = [];
  for (const s of slots) {
    const entry = refImages[s.key];
    if (entry) out.push({ slotKey: s.key, entry });
  }
  return out;
}

/** 按槽顺序取出 entry 列表。 */
export function listRefEntries(
  refImages: RefImages | undefined,
  slots: RefImageSlot[],
): RefImageEntry[] {
  return listRefSlots(refImages, slots).map((x) => x.entry);
}

// ── 内部:把有序条目重排进槽,产出 keyMap ──────────────────────

/**
 * 把 `ordered`(有序的 {原槽key, entry})落进 slots:
 * - 定位型:packed 到 refImage0..(紧凑连续,不依赖 slots 长度,溢出也不丢条目)。
 * - 具名型:保持各自原 key 不动(无 compact)。
 */
function pack(
  ordered: Array<{ slotKey: string; entry: RefImageEntry }>,
  slots: RefImageSlot[],
  removed: string[],
): SlotMutation {
  const next: RefImages = {};
  const keyMap = new Map<string, string>();

  if (isPositional(slots)) {
    ordered.forEach(({ slotKey, entry }, i) => {
      const newKey = `refImage${i}`;
      next[newKey] = entry;
      if (slotKey !== newKey) keyMap.set(slotKey, newKey);
    });
  } else {
    for (const { slotKey, entry } of ordered) next[slotKey] = entry;
  }

  const changed = removed.length > 0 || keyMap.size > 0;
  return { refImages: emptyToUndef(next), keyMap, removed, changed };
}

// ── 变更操作(均返回 SlotMutation)──────────────────────────────

/** 规范化:压成紧凑连续(定位型)。幂等;已规范则 changed=false。 */
export function normalize(refImages: RefImages | undefined, slots: RefImageSlot[]): SlotMutation {
  if (!refImages) return noChange(undefined);
  return pack(currentOrder(refImages, slots), slots, []);
}

/** 截断到最多 max 条(超出的从队尾丢弃),再规范化。用于切换到容量更小的模型/档位。 */
export function clampTo(refImages: RefImages | undefined, slots: RefImageSlot[], max: number): SlotMutation {
  if (!refImages) return noChange(undefined);
  const all = currentOrder(refImages, slots);
  if (all.length <= max) return normalize(refImages, slots);
  const kept = all.slice(0, max);
  const removed = all.slice(max).map((x) => x.slotKey);
  const m = pack(kept, slots, removed);
  m.changed = true;
  return m;
}

/** 拖动重排:把 fromSlotKey 的条目移到 toSlotKey 的位置,再规范化。仅定位型有意义。 */
export function reorder(
  refImages: RefImages | undefined,
  slots: RefImageSlot[],
  fromSlotKey: string,
  toSlotKey: string,
): SlotMutation {
  if (!refImages || fromSlotKey === toSlotKey) return noChange(refImages);
  if (!refImages[fromSlotKey] || !refImages[toSlotKey]) return noChange(refImages);

  const occupied = currentOrder(refImages, slots);
  const fromIdx = occupied.findIndex((x) => x.slotKey === fromSlotKey);
  const toIdx = occupied.findIndex((x) => x.slotKey === toSlotKey);
  if (fromIdx === -1 || toIdx === -1) return noChange(refImages);

  const [moved] = occupied.splice(fromIdx, 1);
  occupied.splice(toIdx, 0, moved!);
  const m = pack(occupied, slots, []);
  m.changed = true; // 重排后即便 keyMap 看似为空(极端),语义上也算变了
  return m;
}

/** 删除指定槽,删后 compact(定位型)。 */
export function removeAt(refImages: RefImages | undefined, slots: RefImageSlot[], slotKey: string): SlotMutation {
  if (!refImages || !refImages[slotKey]) return noChange(refImages);
  const kept = currentOrder(refImages, slots).filter((x) => x.slotKey !== slotKey);
  const m = pack(kept, slots, [slotKey]);
  m.changed = true;
  return m;
}

/** 删除来自这些源卡(sourceCardId)的所有参考图,删后 compact(定位型)。用于断连/删卡清理。 */
export function removeSources(
  refImages: RefImages | undefined,
  slots: RefImageSlot[],
  sourceIds: Iterable<string>,
): SlotMutation {
  if (!refImages) return noChange(undefined);
  const ids = sourceIds instanceof Set ? sourceIds : new Set(sourceIds);
  if (ids.size === 0) return noChange(refImages);
  const all = currentOrder(refImages, slots);
  const removed = all.filter((x) => x.entry.sourceCardId && ids.has(x.entry.sourceCardId)).map((x) => x.slotKey);
  if (removed.length === 0) return noChange(refImages);
  const kept = all.filter((x) => !(x.entry.sourceCardId && ids.has(x.entry.sourceCardId)));
  const m = pack(kept, slots, removed);
  m.changed = true;
  return m;
}

/** 在指定槽原位替换/写入(位置不变)。用于拖图到某槽 / 超分卡上传。写入后规范化兜底(防空洞)。 */
export function setAt(
  refImages: RefImages | undefined,
  slots: RefImageSlot[],
  slotKey: string,
  entry: RefImageEntry,
): SlotMutation {
  const base: RefImages = { ...(refImages ?? {}) };
  const prev = base[slotKey];
  if (prev && prev.url === entry.url && prev.sourceCardId === entry.sourceCardId && prev.sourceType === entry.sourceType) {
    return noChange(refImages);
  }
  base[slotKey] = entry;
  const m = normalize(base, slots);
  m.changed = true;
  return m;
}

/**
 * 按源卡身份增改:已存在该 sourceCardId 的槽 → **原位更新 url**(位置不变);否则**追加到队尾**(第一个空槽)。
 * 这是 dataFlow 连线注入的统一口径(原 injectIntoCard 各分支的 find-by-source / first-empty 行为)。
 */
export function upsertBySource(
  refImages: RefImages | undefined,
  slots: RefImageSlot[],
  sourceCardId: string,
  url: string,
  sourceType: RefImageEntry["sourceType"] = "card",
): SlotMutation {
  const base: RefImages = { ...(refImages ?? {}) };

  for (const s of slots) {
    if (base[s.key]?.sourceCardId === sourceCardId) {
      if (base[s.key]!.url === url) return noChange(refImages);
      base[s.key] = { url, sourceCardId, sourceType };
      return { refImages: emptyToUndef(base), keyMap: new Map(), removed: [], changed: true };
    }
  }
  for (const s of slots) {
    if (!base[s.key]) {
      base[s.key] = { url, sourceCardId, sourceType };
      return { refImages: emptyToUndef(base), keyMap: new Map(), removed: [], changed: true };
    }
  }
  return noChange(refImages); // 槽满,注入失败(调用方按需告警)
}

// ── 槽解析(按卡类型/模型)──────────────────────────────────────

/** 解析一张卡的参考图槽集合。定位型返回 refImageN 槽;具名型(试衣)返回角色槽。 */
export function resolveRefSlots(card: Pick<CanvasCard, "type"> & { data: Record<string, unknown> }): RefImageSlot[] {
  const d = card.data ?? {};
  const model = (d.model as string) || "";
  switch (card.type) {
    case "ai_image":
    case "ai_multiangle":
      return getRefSlotsForModel(model);
    case "ai_chat":
    case "ai_script":
      return getRefSlotsForChatModel(model);
    case "ai_video":
      return getRefSlotsForVideoModel(model, d.imageMode as string | undefined);
    case "ai_tryon":
      // 具名槽:角色固定、无顺序、不 compact。
      return [
        { key: "person", label: "人物图", description: "", required: false },
        { key: "garment", label: "服装图", description: "", required: false },
      ];
    default:
      return [];
  }
}

// ── 落库胶水:变更 + 提示词内联引用对齐 + 写 store ─────────────

/**
 * 对一张卡执行参考图变更:读最新 data → 跑 `op` 得 {@link SlotMutation} →
 * 用 keyMap/removed 对齐提示词里的内联 @ 引用 → 一次 updateCardData 写回(refImages + content + inlineRefs)。
 * 编辑器的「清除 / 重排 / 替换」都走这里,保证「槽顺序」与「提示词内联引用」永远同步。
 */
export function editRefImages(
  cardId: string,
  slots: RefImageSlot[],
  op: (refImages: RefImages | undefined, slots: RefImageSlot[]) => SlotMutation,
  opts: { markDirty?: boolean } = {},
): SlotMutation {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return noChange(undefined);
  const data = (card.data ?? {}) as Record<string, unknown>;
  const mutation = op(data.refImages as RefImages | undefined, slots);
  if (!mutation.changed) return mutation;

  const patch: Record<string, unknown> = { refImages: mutation.refImages };

  if (mutation.keyMap.size > 0 || mutation.removed.length > 0) {
    const { content, inlineRefs } = applySlotKeyMap(
      (data.content as string) ?? "",
      (data.inlineRefs as InlineImageRef[]) ?? [],
      mutation.keyMap,
      mutation.removed,
    );
    patch.content = content;
    patch.inlineRefs = inlineRefs.length > 0 ? inlineRefs : undefined;
  }

  useCardStore.getState().updateCardData(cardId, patch);
  if (opts.markDirty !== false) autoSave.markDirty(cardId);
  return mutation;
}
