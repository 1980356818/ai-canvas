import { isTauri } from "./runtime";

export async function clipboardWriteText(text: string): Promise<void> {
  if (isTauri) {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return;
    } catch (e) {
      console.error("[clipboard.writeText] tauri plugin failed, falling back to browser API", e);
    }
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    console.error("[clipboard.writeText] browser API failed", e);
    throw e;
  }
}

export async function clipboardReadText(): Promise<string> {
  if (isTauri) {
    try {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      const text = await readText();
      return text ?? "";
    } catch (e) {
      console.error("[clipboard.readText] tauri plugin failed, falling back to browser API", e);
    }
  }
  try {
    return await navigator.clipboard.readText();
  } catch (e) {
    console.error("[clipboard.readText] browser API failed", e);
    throw e;
  }
}
