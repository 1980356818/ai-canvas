import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";

export async function clipboardWriteText(text: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("clipboard_write", { text });
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function clipboardReadText(): Promise<string> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<string>("clipboard_read");
  }
  return navigator.clipboard.readText();
}
