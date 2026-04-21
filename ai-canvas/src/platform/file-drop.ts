import type { FileDropCallback } from "@/types";
import { isTauri, ensureTauriAPIs } from "./runtime";

export async function onTauriFileDrop(
  cb: FileDropCallback,
): Promise<() => void> {
  if (!isTauri) return () => {};
  try {
    await ensureTauriAPIs();
    const { getCurrentWebviewWindow } = await import(
      "@tauri-apps/api/webviewWindow"
    );
    const win = getCurrentWebviewWindow();
    const unlisten = await win.onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const pos = (event.payload as { position?: { x: number; y: number } })
          .position ?? { x: 0, y: 0 };
        const paths = (event.payload as { paths?: string[] }).paths ?? [];
        const mediaPaths = paths.filter((p: string) =>
          /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?|mp4|webm|mov|avi|mkv|wav|mp3)$/i.test(p),
        );
        if (mediaPaths.length > 0) cb(mediaPaths, pos.x, pos.y);
      }
    });
    return unlisten;
  } catch {
    return () => {};
  }
}
