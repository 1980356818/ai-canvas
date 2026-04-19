import type { SaveMediaResult } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";

export async function saveMedia(
  source: string,
  _filename?: string,
  title?: string,
  projectId?: string,
): Promise<{ localPath: string; width?: number; height?: number }> {
  if (isTauri) {
    await ensureTauriAPIs();
    const r = await getInvoke()<SaveMediaResult>("save_media", {
      source,
      filename: _filename,
      title,
      projectId: projectId ?? null,
    });
    return {
      localPath: r.local_path,
      width: r.width ?? undefined,
      height: r.height ?? undefined,
    };
  }

  return { localPath: source };
}

export async function readMediaBase64(path: string): Promise<string> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<string>("read_media_base64", { path });
  }
  return path;
}
