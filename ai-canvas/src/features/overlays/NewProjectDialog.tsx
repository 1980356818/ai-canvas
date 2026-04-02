import { useEffect, useRef, useState } from "react";
import { createProject } from "@/lib/tauri";
import type { ProjectInfo } from "@/stores/projectStore";
import { cn } from "@/lib/utils";

const DEFAULT_TITLE = "未命名画布";

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: ProjectInfo) => void;
}

export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: NewProjectDialogProps) {
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(DEFAULT_TITLE);
    setLoading(false);
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    if (loading) return;
    const trimmed = title.trim() || DEFAULT_TITLE;
    setLoading(true);
    try {
      const project = await createProject(trimmed);
      onCreated(project);
      onClose();
    } catch {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        className={cn(
          "w-full max-w-md rounded-lg border border-border bg-card p-6 text-card-foreground shadow-lg",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="new-project-title" className="text-lg font-semibold">
          新建项目
        </h2>
        <label className="mt-4 block text-sm text-muted-foreground">
          <span className="sr-only">项目名称</span>
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            disabled={loading}
            className={cn(
              "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground",
              "outline-none ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
          />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={loading}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
