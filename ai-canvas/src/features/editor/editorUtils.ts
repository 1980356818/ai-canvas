/**
 * 读取最近的 FloatingEditor 施加的画布缩放级别。
 * FloatingEditor 通过 data-editor-zoom 属性同步 viewport.zoom，
 * 编辑器内的 portal 组件（SizeCombo、PortalSelect 等）用此值配合
 * transform: scale() 做定位缩放。注意：不要使用 CSS zoom 属性，
 * 它在 WebKit（macOS Tauri）和 Chromium（Windows WebView2）上行为不一致。
 */
export function getEditorZoom(el: HTMLElement): number {
  const editor = el.closest("[data-editor-zoom]");
  if (!editor) return 1;
  return parseFloat((editor as HTMLElement).dataset.editorZoom ?? "1") || 1;
}
