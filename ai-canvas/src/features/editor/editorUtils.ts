/**
 * 读取最近的 FloatingEditor 施加的画布缩放级别。
 * FloatingEditor 通过 data-editor-zoom 属性同步 viewport.zoom，
 * 编辑器内的 portal 组件（SizeCombo、ModelSelector 等）用此值做定位缩放。
 */
export function getEditorZoom(el: HTMLElement): number {
  const editor = el.closest("[data-editor-zoom]");
  if (!editor) return 1;
  return parseFloat((editor as HTMLElement).dataset.editorZoom ?? "1") || 1;
}
