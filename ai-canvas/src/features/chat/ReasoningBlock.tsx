import { useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 模型 thinking / reasoning 文本的统一渲染容器。
 *
 * 设计：
 * - **默认折叠**，因为 reasoning 经常是英文且对最终用户价值有限
 * - 流式过程中保持淡灰色，与正式答案视觉区隔
 * - 提供"展开/收起"按钮，长按 / hover 不影响（只能点击）
 * - 一处定义，主气泡和流式占位都用它
 */
export default function ReasoningBlock({
  text,
  streaming = false,
  defaultOpen = false,
}: {
  text: string;
  streaming?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!text) return null;

  return (
    <div
      className={cn(
        "mb-2 rounded-md border border-border/60 bg-muted/30",
        streaming && "animate-pulse-soft",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Brain className="h-3 w-3" />
        <span className="font-medium">
          {streaming ? "正在思考…" : "思考过程"}
        </span>
        {!open && (
          <span className="ml-auto text-[10px] text-muted-foreground/60">
            点击展开
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-border/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground/80 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
