import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";

// 「新建项目」命名小窗口。原本在 HomePage 和 NewProjectDialog 里各有一份完全一样的
// 实现,这里统一成单一组件,两处共用。
//
// 传入 `onImport` 时,窗口底部多出「从文件导入项目」入口 —— 命名(创建空白)与
// 导入(.aicat)两条路并列在同一个窗口里。导入忽略名称输入框,流程由调用方在
// onImport 里处理(关窗 + 导入 + 打开项目)。

export interface NameProjectDialogProps {
  open: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
  /** 提供则显示「从文件导入项目」入口;不传则只是个纯命名窗口。 */
  onImport?: () => void;
}

export function NameProjectDialog({
  open,
  onConfirm,
  onCancel,
  onImport,
}: NameProjectDialogProps) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-background p-5 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold">新建项目</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(name.trim() || "未命名项目");
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="输入项目名称..."
            className="mb-4 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-accent"
            >
              取消
            </button>
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              创建
            </button>
          </div>
        </form>

        {onImport && (
          <>
            <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-px flex-1 bg-border" />
              或
              <div className="h-px flex-1 bg-border" />
            </div>
            <button
              type="button"
              onClick={onImport}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-accent"
            >
              <Upload className="h-4 w-4" />
              从文件导入项目（.aicat）
            </button>
          </>
        )}
      </div>
    </div>
  );
}
