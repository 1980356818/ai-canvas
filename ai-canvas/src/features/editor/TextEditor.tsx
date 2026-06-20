import { useRef, useCallback } from "react";
import { Lock } from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { autoSave } from "@/lib/autoSave";
import { cn } from "@/lib/utils";

const GENDER_OPTIONS: { label: string; value: string }[] = [
  { label: "女", value: "female" },
  { label: "男", value: "male" },
];

interface TextData {
  content?: string;
  _locked?: boolean;
  _label?: string;
  _description?: string;
  _promptTemplate?: string;
  _params?: Record<string, string>;
}

interface TextEditorProps {
  card: CanvasCard;
}

export default function TextEditor({ card }: TextEditorProps) {
  const updateCardData = useCardStore((s) => s.updateCardData);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const data = card.data as TextData;

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const content = e.target.value;
      updateCardData(card.id, { content });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, updateCardData],
  );

  const handleParamChange = useCallback(
    (key: string, value: string) => {
      const latest = (useCardStore.getState().getCard(card.id)?.data ?? {}) as TextData;
      const params = { ...latest._params, [key]: value };
      let content = latest.content ?? "";
      if (latest._promptTemplate) {
        content = latest._promptTemplate;
        for (const [k, v] of Object.entries(params)) {
          content = content.replaceAll(`{{${k}}}`, v);
        }
      }
      updateCardData(card.id, { _params: params, content });
      autoSave.markDirty(card.id);
    },
    [card.id, updateCardData],
  );

  if (data._locked) {
    return (
      <div className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{data._label || "模板文本"}</p>
            {data._description && (
              <p className="text-[11px] text-muted-foreground">{data._description}</p>
            )}
          </div>
        </div>

        {data._params && (
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            {Object.entries(data._params).map(([key, value]) => {
              const isGender = key === "gender";
              const opts = isGender ? GENDER_OPTIONS : [{ label: value, value }];
              return (
                <div key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{isGender ? "性别" : key}</span>
                  <div className="flex items-center rounded-md border border-input">
                    {opts.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => handleParamChange(key, opt.value)}
                        className={cn(
                          "px-3 py-1 text-xs font-medium transition-colors",
                          "first:rounded-l-[5px] last:rounded-r-[5px]",
                          value === opt.value
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex-1 overflow-y-auto rounded-lg border border-input bg-muted/20 px-3 py-2">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">
            {data.content ?? ""}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <label className="text-xs font-medium text-muted-foreground">
        {card.type === "sticky_note" ? "便签内容" : "文本内容"}
      </label>
      <textarea
        className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
        value={data.content ?? ""}
        onChange={onChange}
        placeholder="在这里输入内容..."
      />
    </div>
  );
}
