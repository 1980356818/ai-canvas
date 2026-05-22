import { useCallback, useRef } from "react";
import { Paperclip, X, ImageIcon } from "lucide-react";
import type { ContentPart } from "@/agent/types";
import { persistImage, getDisplayUrl } from "@/lib/media";
import { ensureDisplayableImage } from "@/lib/heicConverter";

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

interface AttachmentPickerProps {
  attachments: ContentPart[];
  onAdd: (part: ContentPart) => void;
  onRemove: (index: number) => void;
  /** 附件归属的项目 ID；由父组件传入，避免该组件直接依赖全局 store。 */
  projectId?: string;
}

export default function AttachmentPicker({
  attachments,
  onAdd,
  onRemove,
  projectId,
}: AttachmentPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePick = useCallback(async () => {
    if (isTauri) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [
            {
              name: "Images",
              extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"],
            },
          ],
        });

        if (!selected) return;
        const filePath =
          typeof selected === "string" ? selected : (selected as { path: string }).path;

        const { localPath: relativePath } = await persistImage(filePath, undefined, projectId);
        onAdd({ type: "image", url: relativePath, mimeType: "image/png" });
      } catch (err) {
        console.error("Failed to pick file:", err);
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [onAdd, projectId]);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.files?.[0];
      if (!raw) return;
      const file = await ensureDisplayableImage(raw);
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      const { localPath: relativePath } = await persistImage(dataUrl, undefined, projectId);
      onAdd({
        type: "image",
        url: relativePath,
        mimeType: file.type || "image/png",
      });
      e.target.value = "";
    },
    [onAdd, projectId],
  );

  const imageAttachments = attachments.filter((a) => a.type === "image");

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handlePick}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="添加图片"
      >
        <Paperclip className="h-4 w-4" />
      </button>

      {!isTauri && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.heic,.heif"
          className="hidden"
          onChange={handleFileChange}
        />
      )}

      {imageAttachments.length > 0 && (
        <div className="flex gap-1.5">
          {attachments.map((att, i) =>
            att.type === "image" ? (
              <div key={i} className="group relative">
                <img
                  src={getDisplayUrl(att.url)}
                  alt=""
                  className="h-10 w-10 rounded-md border border-border object-cover"
                  loading="lazy"
                  decoding="async"
                />
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground group-hover:flex"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ) : (
              <div
                key={i}
                className="flex h-10 items-center gap-1 rounded-md border border-border bg-muted px-2 text-xs text-muted-foreground"
              >
                <ImageIcon className="h-3 w-3" />
                附件
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
