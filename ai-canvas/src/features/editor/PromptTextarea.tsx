import {
  useRef,
  useState,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { createPortal } from "react-dom";
import type { ImageRefOption } from "@/hooks/useImageRefSources";
import {
  type InlineImageRef,
  createInlineRef,
} from "@/lib/promptSerializer";
import AtMentionPopover from "./AtMentionPopover";
import { cn } from "@/lib/utils";

const REF_ATTR = "data-ref-id";

const CHIP_CLS =
  "inline-flex items-center gap-0.5 rounded-sm bg-primary/15 px-1 py-px text-xs text-primary align-middle cursor-default select-none whitespace-nowrap";
const CHIP_IMG_CLS =
  "inline-block h-3.5 w-3.5 rounded-sm object-cover";

export interface PromptTextareaHandle {
  insertRef: (option: ImageRefOption) => void;
}

interface PromptTextareaProps {
  value: string;
  inlineRefs: InlineImageRef[];
  imageOptions: ImageRefOption[];
  onChange: (value: string, refs: InlineImageRef[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onHoverRef?: (refId: string | null) => void;
}

// ── DOM → raw text ─────────────────────────────────────────

function domToRaw(el: HTMLElement): string {
  let result = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += (node.textContent ?? "").replace(/\u00A0/g, " ");
    } else if (node instanceof HTMLElement) {
      const refId = node.getAttribute(REF_ATTR);
      if (refId) {
        result += `{{ref:${refId}}}`;
      } else if (node.tagName === "BR") {
        result += "\n";
      } else if (node.tagName === "DIV" || node.tagName === "P") {
        if (result.length > 0 && !result.endsWith("\n")) result += "\n";
        result += domToRaw(node);
      } else {
        result += domToRaw(node);
      }
    }
  }
  return result;
}

// ── raw text → HTML ────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function rawToHtml(
  raw: string,
  refs: InlineImageRef[],
  options: ImageRefOption[],
): string {
  const refMap = new Map(refs.map((r) => [r.id, r]));
  const optMap = new Map(options.map((o) => [o.id, o]));
  const TOKEN = /\{\{ref:([^}]+)\}\}/g;

  let html = "";
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = TOKEN.exec(raw)) !== null) {
    html += esc(raw.slice(last, m.index)).replace(/\n/g, "<br>");
    const id = m[1]!;
    const ref = refMap.get(id);
    const opt = optMap.get(id);
    const label = ref?.displayLabel ?? "?";
    const thumb = opt?.thumbnailUrl;

    html += `<span ${REF_ATTR}="${esc(id)}" contenteditable="false" class="${CHIP_CLS}">`;
    if (thumb) {
      html += `<img src="${esc(thumb)}" class="${CHIP_IMG_CLS}" />`;
    }
    html += `<span>${esc(label)}</span></span>`;
    last = m.index + m[0].length;
  }

  html += esc(raw.slice(last)).replace(/\n/g, "<br>");
  return html;
}

// ── Helpers ────────────────────────────────────────────────

function collectRefIds(el: HTMLElement): Set<string> {
  const ids = new Set<string>();
  el.querySelectorAll(`[${REF_ATTR}]`).forEach((chip) => {
    const id = chip.getAttribute(REF_ATTR);
    if (id) ids.add(id);
  });
  return ids;
}

function isEditorEmpty(el: HTMLElement): boolean {
  return !el.textContent?.trim() && !el.querySelector(`[${REF_ATTR}]`);
}

// ── Component ──────────────────────────────────────────────

const PromptTextarea = forwardRef<PromptTextareaHandle, PromptTextareaProps>(function PromptTextarea({
  value,
  inlineRefs,
  imageOptions,
  onChange,
  placeholder,
  disabled,
  className,
  onHoverRef,
}, ref) {
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [anchorPos, setAnchorPos] = useState({ top: 0, left: 0 });
  const [empty, setEmpty] = useState(!value);
  const lastRawRef = useRef(value);
  const popoverKeyRef = useRef<((key: string) => void) | null>(null);

  // ── Sync external value → DOM ────────────────────────────
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (domToRaw(el) === value) return;
    el.innerHTML = rawToHtml(value, inlineRefs, imageOptions) || "<br>";
    lastRawRef.current = value;
    setEmpty(!value);
  }, [value, inlineRefs, imageOptions]);

  // ── Emit DOM → parent ────────────────────────────────────
  const emitChange = useCallback(
    (el: HTMLElement, refs: InlineImageRef[]) => {
      const rawText = domToRaw(el);
      lastRawRef.current = rawText;
      setEmpty(isEditorEmpty(el));
      const activeIds = collectRefIds(el);
      onChange(rawText, refs.filter((r) => activeIds.has(r.id)));
    },
    [onChange],
  );

  // ── Input handler ────────────────────────────────────────
  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;

    emitChange(el, inlineRefs);

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;

    if (!mentionOpen) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const offset = range.startOffset;
        if (offset > 0 && text[offset - 1] === "@") {
          const rect = range.getBoundingClientRect();
          setAnchorPos({ top: rect.bottom + 2, left: rect.left });
          setMentionQuery("");
          setMentionOpen(true);
          return;
        }
      }
    } else {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const offset = range.startOffset;
        let atPos = -1;
        for (let i = offset - 1; i >= 0; i--) {
          if (text[i] === "@") { atPos = i; break; }
          if (text[i] === " " || text[i] === "\n") break;
        }
        if (atPos === -1) {
          setMentionOpen(false);
        } else {
          setMentionQuery(text.slice(atPos + 1, offset));
        }
      } else {
        setMentionOpen(false);
      }
    }
  }, [emitChange, inlineRefs, mentionOpen]);

  // ── Keyboard: forward to popover + Backspace chip deletion
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (mentionOpen) {
        switch (e.key) {
          case "ArrowDown":
          case "ArrowUp":
          case "Enter":
          case "Tab":
            e.preventDefault();
            popoverKeyRef.current?.(e.key);
            return;
          case "Escape":
            e.preventDefault();
            setMentionOpen(false);
            return;
        }
      }

      if (e.key === "Backspace" || e.key === "Delete") {
        const el = editorRef.current;
        if (!el) return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;

        const range = sel.getRangeAt(0);
        const { startContainer: node, startOffset: offset } = range;

        let chip: Element | null = null;

        if (e.key === "Backspace") {
          if (node.nodeType === Node.TEXT_NODE && offset === 0) {
            const prev = node.previousSibling;
            if (prev instanceof HTMLElement && prev.hasAttribute(REF_ATTR))
              chip = prev;
          } else if (node.nodeType === Node.ELEMENT_NODE && offset > 0) {
            const child = node.childNodes[offset - 1];
            if (child instanceof HTMLElement && child.hasAttribute(REF_ATTR))
              chip = child;
          }
        } else {
          if (node.nodeType === Node.TEXT_NODE && offset === (node.textContent?.length ?? 0)) {
            const next = node.nextSibling;
            if (next instanceof HTMLElement && next.hasAttribute(REF_ATTR))
              chip = next;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const child = node.childNodes[offset];
            if (child instanceof HTMLElement && child.hasAttribute(REF_ATTR))
              chip = child;
          }
        }

        if (chip) {
          e.preventDefault();
          chip.remove();
          emitChange(el, inlineRefs);
        }
      }
    },
    [mentionOpen, inlineRefs, emitChange],
  );

  // ── Paste: plain text only ───────────────────────────────
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  }, []);

  // ── Mention selection: insert chip ───────────────────────
  const handleSelect = useCallback(
    (option: ImageRefOption) => {
      const el = editorRef.current;
      if (!el) return;

      const ref = createInlineRef(option);
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE || !node.parentNode) return;

      const text = node.textContent ?? "";
      const offset = range.startOffset;

      let atPos = offset;
      for (let i = offset - 1; i >= 0; i--) {
        if (text[i] === "@") { atPos = i; break; }
        if (text[i] === " " || text[i] === "\n") break;
      }

      const before = text.slice(0, atPos);
      const after = text.slice(offset);

      const chip = document.createElement("span");
      chip.setAttribute(REF_ATTR, ref.id);
      chip.contentEditable = "false";
      chip.className = CHIP_CLS;
      if (option.thumbnailUrl) {
        const img = document.createElement("img");
        img.src = option.thumbnailUrl;
        img.className = CHIP_IMG_CLS;
        chip.appendChild(img);
      }
      const labelSpan = document.createElement("span");
      labelSpan.textContent = ref.displayLabel;
      chip.appendChild(labelSpan);

      const parent = node.parentNode;
      const beforeNode = document.createTextNode(before);
      const afterNode = document.createTextNode(" " + after);

      parent.insertBefore(beforeNode, node);
      parent.insertBefore(chip, node);
      parent.insertBefore(afterNode, node);
      parent.removeChild(node);

      const newRange = document.createRange();
      newRange.setStart(afterNode, 1);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);

      const newRefs = [...inlineRefs, ref];
      emitChange(el, newRefs);
      setMentionOpen(false);
    },
    [inlineRefs, emitChange],
  );

  const handleClose = useCallback(() => {
    setMentionOpen(false);
    editorRef.current?.focus();
  }, []);

  // ── Imperative: insert ref at cursor from outside ───────
  const insertRefAtCursor = useCallback(
    (option: ImageRefOption) => {
      const el = editorRef.current;
      if (!el) return;

      el.focus();
      const newRef = createInlineRef(option);
      const sel = window.getSelection();

      const chip = document.createElement("span");
      chip.setAttribute(REF_ATTR, newRef.id);
      chip.contentEditable = "false";
      chip.className = CHIP_CLS;
      if (option.thumbnailUrl) {
        const img = document.createElement("img");
        img.src = option.thumbnailUrl;
        img.className = CHIP_IMG_CLS;
        chip.appendChild(img);
      }
      const labelSpan = document.createElement("span");
      labelSpan.textContent = newRef.displayLabel;
      chip.appendChild(labelSpan);

      const space = document.createTextNode("\u00A0");

      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(space);
        range.insertNode(chip);
        const newRange = document.createRange();
        newRange.setStartAfter(space);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      } else {
        el.appendChild(chip);
        el.appendChild(space);
        const range = document.createRange();
        range.setStartAfter(space);
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }

      emitChange(el, [...inlineRefs, newRef]);
    },
    [inlineRefs, emitChange],
  );

  useImperativeHandle(ref, () => ({ insertRef: insertRefAtCursor }), [insertRefAtCursor]);

  // ── Click outside ────────────────────────────────────────
  useEffect(() => {
    if (!mentionOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-at-mention-popover]")) return;
      const container = containerRef.current;
      if (container && !container.contains(target)) {
        setMentionOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [mentionOpen]);

  // ── Chip hover → RefImageSlot highlight ──────────────────
  const handleMouseOver = useCallback(
    (e: React.MouseEvent) => {
      if (!onHoverRef) return;
      const chip = (e.target as HTMLElement).closest(`[${REF_ATTR}]`);
      onHoverRef(chip ? chip.getAttribute(REF_ATTR) : null);
    },
    [onHoverRef],
  );

  const handleMouseLeave = useCallback(() => {
    onHoverRef?.(null);
  }, [onHoverRef]);

  return (
    <div
      ref={containerRef}
      className={cn("relative min-h-[3rem] flex-1", className)}
    >
      <div
        ref={editorRef}
        contentEditable={!disabled}
        className={cn(
          "h-full min-h-[3rem] w-full rounded-lg border border-input bg-background px-3 py-1.5 text-sm leading-relaxed text-foreground outline-none ring-ring focus:ring-1",
          disabled && "cursor-not-allowed opacity-50",
        )}
        style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onMouseOver={handleMouseOver}
        onMouseLeave={handleMouseLeave}
        spellCheck={false}
        suppressContentEditableWarning
      />

      {empty && placeholder && (
        <div className="pointer-events-none absolute inset-0 flex items-start px-3 py-1.5 text-sm text-muted-foreground">
          {placeholder}
        </div>
      )}

      {mentionOpen &&
        createPortal(
          <AtMentionPopover
            options={imageOptions}
            query={mentionQuery}
            anchorPos={anchorPos}
            onSelect={handleSelect}
            onClose={handleClose}
            onKeyAction={popoverKeyRef}
          />,
          document.body,
        )}
    </div>
  );
});

export default PromptTextarea;
