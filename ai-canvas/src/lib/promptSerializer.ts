import type { ImageRefOption, InlineImageSource } from "@/hooks/useImageRefSources";
import type { RefImageEntry } from "@/config/model-ref-images";
import { uploadMediaBatch } from "@/platform/media";

// ── Data Types ──────────────────────────────────────────────

export interface InlineImageRef {
  id: string;
  displayLabel: string;
  source: InlineImageSource;
}

// Token format stored in prompt text: {{ref:ID}}
const REF_TOKEN_RE = /\{\{ref:([^}]+)\}\}/g;

// ── Serialize / Deserialize ─────────────────────────────────

export function insertRefToken(
  text: string,
  cursorPos: number,
  ref: InlineImageRef,
): { newText: string; newCursorPos: number } {
  const atSignStart = findAtSignBefore(text, cursorPos);
  const token = `{{ref:${ref.id}}}`;
  const before = text.slice(0, atSignStart);
  const after = text.slice(cursorPos);
  const newText = before + token + " " + after;
  return { newText, newCursorPos: before.length + token.length + 1 };
}

function findAtSignBefore(text: string, pos: number): number {
  for (let i = pos - 1; i >= 0; i--) {
    if (text[i] === "@") return i;
    if (text[i] === " " || text[i] === "\n") return pos;
  }
  return pos;
}

export function removeRefToken(text: string, refId: string): string {
  const token = `{{ref:${refId}}}`;
  return text.replace(token + " ", "").replace(token, "");
}

export function extractRefIds(text: string): string[] {
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  REF_TOKEN_RE.lastIndex = 0;
  while ((match = REF_TOKEN_RE.exec(text)) !== null) {
    ids.push(match[1]!);
  }
  return ids;
}

// ── Display ─────────────────────────────────────────────────

export function toDisplayText(
  text: string,
  refs: InlineImageRef[],
): string {
  const refMap = new Map(refs.map((r) => [r.id, r]));
  return text.replace(REF_TOKEN_RE, (_match, id: string) => {
    const ref = refMap.get(id);
    return ref ? `@${ref.displayLabel}` : `@[?]`;
  });
}

export function fromDisplayText(
  displayText: string,
  refs: InlineImageRef[],
): string {
  let result = displayText;
  for (const ref of refs) {
    const displayTag = `@${ref.displayLabel}`;
    result = result.replaceAll(displayTag, `{{ref:${ref.id}}}`);
  }
  return result;
}

// ── API Serialization ───────────────────────────────────────

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export async function serializeForApi(
  promptText: string,
  inlineRefs: InlineImageRef[],
  refImages: Record<string, RefImageEntry> | undefined,
  allOptions: ImageRefOption[],
): Promise<ContentPart[]> {
  const refMap = new Map(inlineRefs.map((r) => [r.id, r]));
  const optionMap = new Map(allOptions.map((o) => [o.id, o]));
  const usedUrls = new Set<string>();

  const segments = promptText.split(REF_TOKEN_RE);

  // 两遍走法 (改自原先单遍串行): 第一遍只解析 URL + 收集要上传的图, 第二遍
  // Promise.all 并行上传, 第三遍按 segments 顺序拼 parts。这样 N 个内联 ref
  // 图首传从 N×t 降到 max(N,4)×t (后端 MAIN_SEMAPHORE(4)), 同时保 segments
  // 顺序 (text₁ img₁ text₂ img₂ ...)。
  const refUrls: Array<string | null> = segments.map((seg, i) => {
    if (i % 2 === 0) return null;
    const ref = refMap.get(seg);
    if (!ref) return null;
    const url = resolveRefUrl(ref.source, refImages, optionMap);
    return url || null;
  });
  const uploadIndex: number[] = [];
  const uploadUrls: string[] = [];
  refUrls.forEach((u, i) => {
    if (u) {
      uploadIndex.push(i);
      uploadUrls.push(u);
    }
  });
  const uploaded = await uploadMediaBatch(uploadUrls);
  const segIndexToUrl = new Map<number, string>();
  uploadIndex.forEach((segIdx, k) => segIndexToUrl.set(segIdx, uploaded[k]!));

  const parts: ContentPart[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (i % 2 === 0) {
      const text = segments[i]!.trim();
      if (text) parts.push({ type: "text", text });
    } else {
      const uploadedUrl = segIndexToUrl.get(i);
      if (!uploadedUrl) continue;
      parts.push({ type: "image_url", image_url: { url: uploadedUrl } });
      usedUrls.add(refUrls[i]!);
    }
  }

  if (parts.length === 0) {
    const plainText = promptText.replace(REF_TOKEN_RE, "").trim();
    if (plainText) parts.push({ type: "text", text: plainText });
  }

  return parts;
}

export function getInlineRefUrls(
  inlineRefs: InlineImageRef[],
  refImages: Record<string, RefImageEntry> | undefined,
  allOptions: ImageRefOption[],
): Set<string> {
  const optionMap = new Map(allOptions.map((o) => [o.id, o]));
  const urls = new Set<string>();
  for (const ref of inlineRefs) {
    const url = resolveRefUrl(ref.source, refImages, optionMap);
    if (url) urls.add(url);
  }
  return urls;
}

function resolveRefUrl(
  source: InlineImageSource,
  refImages: Record<string, RefImageEntry> | undefined,
  optionMap: Map<string, ImageRefOption>,
): string | null {
  switch (source.type) {
    case "refSlot": {
      const entry = refImages?.[source.slotKey];
      return entry?.url ?? null;
    }
    case "upstream": {
      const opt = optionMap.get(`upstream:${source.sourceCardId}`);
      return opt?.resolvedUrl ?? null;
    }
    case "videoSlot": {
      const opt = optionMap.get(`video:${source.index}`);
      return opt?.resolvedUrl ?? null;
    }
    case "audioSlot": {
      const opt = optionMap.get(`audio:${source.index}`);
      return opt?.resolvedUrl ?? null;
    }
    default:
      return null;
  }
}

// ── Ref Management ──────────────────────────────────────────

export function createInlineRef(option: ImageRefOption): InlineImageRef {
  return {
    id: option.id,
    displayLabel: option.label,
    source: option.source,
  };
}

export function pruneOrphanedRefs(
  text: string,
  refs: InlineImageRef[],
): InlineImageRef[] {
  const activeIds = new Set(extractRefIds(text));
  return refs.filter((r) => activeIds.has(r.id));
}

/**
 * 把参考图槽变更(来自 refImageSlots 的 SlotMutation:keyMap + removed)对齐到提示词里的内联 @ 引用。
 * 这是「槽顺序 ↔ 提示词 {{ref:slot:refImageN}} token」同步的【唯一入口】,取代了
 * reorderInlineRefs / remapInlineRefs 两套手搓逻辑。
 *
 * @param keyMap    旧槽 key → 新槽 key(仅移动过的;支持互换等成环情形,两遍 temp token 防撞)
 * @param removedSlotKeys 被整条删除的槽 key(其 token 与内联引用一并删掉)
 */
export function applySlotKeyMap(
  content: string,
  inlineRefs: InlineImageRef[],
  keyMap: Map<string, string>,
  removedSlotKeys: Iterable<string> = [],
): { content: string; inlineRefs: InlineImageRef[] } {
  const removed = removedSlotKeys instanceof Set ? removedSlotKeys : new Set(removedSlotKeys);
  let newContent = content;

  // 1) 删除被移除槽的 token。
  for (const key of removed) {
    newContent = removeRefToken(newContent, `slot:${key}`);
  }

  // 2) 重命名移动过的槽 token(两遍 temp,防 refImage0↔refImage1 互换时互相覆盖)。
  const moves = [...keyMap].filter(([oldKey, newKey]) => oldKey !== newKey && !removed.has(oldKey));
  for (const [oldKey] of moves) {
    newContent = newContent.replaceAll(`{{ref:slot:${oldKey}}}`, `{{ref:slot:__SLOTMAP_${oldKey}__}}`);
  }
  for (const [oldKey, newKey] of moves) {
    newContent = newContent.replaceAll(`{{ref:slot:__SLOTMAP_${oldKey}__}}`, `{{ref:slot:${newKey}}}`);
  }

  // 3) 重建 inlineRefs:删掉移除槽的引用,移动过的更新 id/slotKey/displayLabel(图N)。
  const newRefs: InlineImageRef[] = [];
  for (const ref of inlineRefs) {
    if (ref.source.type === "refSlot") {
      const key = ref.source.slotKey;
      if (removed.has(key)) continue;
      const newKey = keyMap.get(key);
      if (newKey && newKey !== key) {
        const idx = parseInt(newKey.replace("refImage", ""), 10);
        newRefs.push({
          ...ref,
          id: `slot:${newKey}`,
          displayLabel: Number.isFinite(idx) ? `图${idx + 1}` : ref.displayLabel,
          source: { type: "refSlot", slotKey: newKey },
        });
        continue;
      }
    }
    newRefs.push(ref);
  }

  return { content: newContent, inlineRefs: newRefs };
}
