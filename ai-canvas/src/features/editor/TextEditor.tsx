import { useRef, useCallback } from "react";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";

interface TextEditorProps {
  card: CanvasCard;
}

export default function TextEditor({ card }: TextEditorProps) {
  const updateCard = useCardStore((s) => s.updateCard);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const data = card.data as { content?: string };

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const content = e.target.value;
      updateCard(card.id, { data: { ...data, content } });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => autoSave.markDirty(card.id), 300);
    },
    [card.id, data, updateCard],
  );

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
        autoFocus
      />
    </div>
  );
}
