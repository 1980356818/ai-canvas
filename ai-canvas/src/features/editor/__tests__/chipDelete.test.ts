// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { resolveAtomicChip, REF_ATTR } from "../chipDelete";

// 构造一个内联引用 chip:<span data-ref-id><img/><span>图N</span></span>(contenteditable=false)
function makeChip(id: string, label: string, withImg = true): HTMLElement {
  const chip = document.createElement("span");
  chip.setAttribute(REF_ATTR, id);
  chip.contentEditable = "false";
  if (withImg) chip.appendChild(document.createElement("img"));
  const labelSpan = document.createElement("span");
  labelSpan.textContent = label;
  chip.appendChild(labelSpan);
  return chip;
}

function makeHost(): HTMLDivElement {
  const el = document.createElement("div");
  el.contentEditable = "true";
  document.body.appendChild(el);
  return el;
}

function caret(node: Node, offset: number): Range {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  return r;
}

describe("resolveAtomicChip", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("① 点中缩略图(光标落在 img 边)→ 命中 chip(退格)", () => {
    const host = makeHost();
    const chip = makeChip("slot:refImage0", "图1");
    host.append(chip, document.createTextNode(" "));
    const img = chip.querySelector("img")!;
    // 光标停在 chip 内部(img 之前)
    expect(resolveAtomicChip(host, caret(chip, 0), "Backspace")).toBe(chip);
    // 直接以内部元素为容器
    expect(resolveAtomicChip(host, caret(img.parentNode!, 0), "Delete")).toBe(chip);
  });

  it("① 点中「图N」文字 → 命中 chip(退格 + 删除)", () => {
    const host = makeHost();
    const chip = makeChip("slot:refImage1", "图2");
    host.append(document.createTextNode("猫 "), chip, document.createTextNode(" "));
    const labelText = chip.lastChild!.firstChild!; // “图2” 文本节点
    expect(resolveAtomicChip(host, caret(labelText, 1), "Backspace")).toBe(chip);
    expect(resolveAtomicChip(host, caret(labelText, 1), "Delete")).toBe(chip);
  });

  it("② 对象选中(非塌缩,parent 上 [i, i+1])→ 命中 chip", () => {
    const host = makeHost();
    const lead = document.createTextNode("ab");
    const chip = makeChip("slot:refImage0", "图1");
    host.append(lead, chip, document.createTextNode("cd"));
    const r = document.createRange();
    r.setStart(host, 1); // chip 在 childNodes[1]
    r.setEnd(host, 2);
    expect(r.collapsed).toBe(false);
    expect(resolveAtomicChip(host, r, "Backspace")).toBe(chip);
    expect(resolveAtomicChip(host, r, "Delete")).toBe(chip);
  });

  it("③ 塌缩光标紧跟 chip 后(文本节点 offset 0)→ 退格命中", () => {
    const host = makeHost();
    const chip = makeChip("slot:refImage0", "图1");
    const tail = document.createTextNode("x");
    host.append(chip, tail);
    expect(resolveAtomicChip(host, caret(tail, 0), "Backspace")).toBe(chip);
  });

  it("③ chip 是最后一个节点,光标在 host 末尾 → 退格命中", () => {
    const host = makeHost();
    host.append(document.createTextNode("x"), makeChip("slot:refImage0", "图1"));
    const chip = host.lastChild as HTMLElement;
    // host 有 2 个子节点,光标在 offset 2(chip 之后)
    expect(resolveAtomicChip(host, caret(host, 2), "Backspace")).toBe(chip);
  });

  it("③ Delete:光标紧贴 chip 前(文本末尾)→ 命中", () => {
    const host = makeHost();
    const lead = document.createTextNode("x");
    const chip = makeChip("slot:refImage0", "图1");
    host.append(lead, chip);
    expect(resolveAtomicChip(host, caret(lead, 1), "Delete")).toBe(chip);
  });

  it("③ Delete:chip 是首节点,光标在 host 起点 → 命中", () => {
    const host = makeHost();
    host.append(makeChip("slot:refImage0", "图1"), document.createTextNode("x"));
    const chip = host.firstChild as HTMLElement;
    expect(resolveAtomicChip(host, caret(host, 0), "Delete")).toBe(chip);
  });

  it("不误伤:光标在普通文字中间 → 退格返回 null(走默认删字)", () => {
    const host = makeHost();
    const t = document.createTextNode("hello");
    host.append(t);
    expect(resolveAtomicChip(host, caret(t, 2), "Backspace")).toBeNull();
  });

  it("不误伤:光标在文本最前且前面无 chip → 退格返回 null", () => {
    const host = makeHost();
    const t = document.createTextNode("hello");
    host.append(t);
    expect(resolveAtomicChip(host, caret(t, 0), "Backspace")).toBeNull();
  });

  it("不误伤:跨多节点的真实文本选区(端点都不在 chip)→ 返回 null,交回浏览器", () => {
    const host = makeHost();
    const t1 = document.createTextNode("ab");
    const chip = makeChip("slot:refImage0", "图1");
    const t2 = document.createTextNode("cd");
    host.append(t1, chip, t2);
    const r = document.createRange();
    r.setStart(t1, 1);
    r.setEnd(t2, 1);
    expect(r.collapsed).toBe(false);
    expect(resolveAtomicChip(host, r, "Backspace")).toBeNull();
  });

  it("无缩略图的 chip(纯「图N」)同样可命中", () => {
    const host = makeHost();
    const chip = makeChip("slot:refImage0", "图1", false);
    const tail = document.createTextNode("x");
    host.append(chip, tail);
    expect(resolveAtomicChip(host, caret(tail, 0), "Backspace")).toBe(chip);
  });
});
