import { isTauri } from "./runtime";

export async function pickDirectory(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title: "选择图片保存目录" });
    return typeof selected === "string" ? selected : null;
  }
  return null;
}
