// 提示词输入框里的内联引用 chip(「缩略图 + 图N」)是一个 contenteditable=false
// 的内联小岛。用户想删掉它时,WebView2 / Chromium 会按「点哪了 / 光标在哪」把选区
// 留成好几种不同形状:
//   - 点在缩略图或「图N」文字上   → 光标落进 chip 子树内部
//   - 单击整个 chip              → Chromium 把它「对象选中」(非塌缩,parent 上 [i,i+1])
//   - 光标停在 chip 紧前 / 紧后   → 塌缩光标,与 chip 相邻
// 旧逻辑只认「塌缩光标紧贴 chip 后」这一种,其余手势全部落空 → 退格「没反应」。
//
// resolveAtomicChip 把上述所有形状收敛到「这一次删除应该命中的那个 chip」,让
// Backspace / Delete 永远把整块「缩略图 + 图N」当成一个原子删掉(不会只删一半,
// 也不会什么都不删)。命中返回该 chip 元素;返回 null 表示这次删除与 chip 无关,
// 交回浏览器默认行为(普通删字),由 onInput 收敛 inlineRefs。

/** chip 在 DOM 上的标识属性,内联引用的单一真相来源。 */
export const REF_ATTR = "data-ref-id";

export function resolveAtomicChip(
  host: HTMLElement,
  range: Range,
  key: "Backspace" | "Delete",
): HTMLElement | null {
  // 从任意节点上溯到它所属的 chip(含自身),并确保该 chip 落在编辑器内部。
  const chipAncestor = (n: Node | null): HTMLElement | null => {
    if (!n) return null;
    const base = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
    const chip = base?.closest(`[${REF_ATTR}]`) ?? null;
    return chip instanceof HTMLElement && chip !== host && host.contains(chip) ? chip : null;
  };
  const asChip = (n: Node | null | undefined): HTMLElement | null =>
    n instanceof HTMLElement && n.hasAttribute(REF_ATTR) ? n : null;

  // ① 选区端点落在 chip 子树内部 —— 用户点中了缩略图或「图N」文字。
  const inside = chipAncestor(range.startContainer) ?? chipAncestor(range.endContainer);
  if (inside) return inside;

  // ② 非塌缩选区。Chromium 单击 contenteditable=false 内联元素会「对象选中」成
  //    parent 节点上的 [offset, offset+1]。只认「恰好包住单个 chip」这一种;比这更宽的
  //    真实文本选区 → 返回 null 交给浏览器删,onInput 再收敛。
  if (!range.collapsed) {
    const { startContainer: s, startOffset: so, endContainer: e, endOffset: eo } = range;
    if (s.nodeType === Node.ELEMENT_NODE) {
      const c = asChip(s.childNodes[so]);
      if (c) return c;
    }
    if (e.nodeType === Node.ELEMENT_NODE && eo > 0) {
      const c = asChip(e.childNodes[eo - 1]);
      if (c) return c;
    }
    return null;
  }

  // ③ 塌缩光标紧邻 chip。Backspace 删前一个,Delete 删后一个,均按整块原子删。
  const { startContainer: node, startOffset: offset } = range;
  if (key === "Backspace") {
    if (node.nodeType === Node.TEXT_NODE && offset === 0) return asChip(node.previousSibling);
    if (node.nodeType === Node.ELEMENT_NODE && offset > 0) return asChip(node.childNodes[offset - 1]);
  } else {
    if (node.nodeType === Node.TEXT_NODE && offset === (node.textContent?.length ?? 0))
      return asChip(node.nextSibling);
    if (node.nodeType === Node.ELEMENT_NODE) return asChip(node.childNodes[offset]);
  }
  return null;
}
