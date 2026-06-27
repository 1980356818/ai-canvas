import type { CanvasCard } from "@/types";
import TextEditor from "./TextEditor";
import ChatEditor from "./ChatEditor";
import MediaEditor from "./MediaEditor";
import MultiangleEditor from "./MultiangleEditor";
import TryOnEditor from "./TryOnEditor";
import VideoEditor from "./VideoEditor";
import ScriptEditor from "@/features/script/ScriptEditor";

export default function EditorSwitch({ card }: { card: CanvasCard }) {
  // 每张卡片必须拿到独立的编辑器实例:各编辑器把尺寸/比例/分辨率/画质/时长/档位等
  // 选择存在组件内 useState,且只在 mount 时按本卡 data 初始化(无 per-card resync effect)。
  // FloatingEditor 是全局单例,从 A 卡直接切到 B 卡时 editingCardId A→B 不经过 null,
  // React 会复用同一个 MediaEditor/VideoEditor 实例 → 上述本地状态不重新初始化,
  // B 卡编辑器会显示 A 卡刚选的参数,看起来像"改一张卡其它卡跟着变"。
  // 用 key={card.id} 强制按卡片换实例,保证每张卡的编辑器本地状态各自独立。
  return <EditorBody key={card.id} card={card} />;
}

function EditorBody({ card }: { card: CanvasCard }) {
  switch (card.type) {
    case "text":
    case "sticky_note":
      return <TextEditor card={card} />;
    case "ai_chat":
      return <ChatEditor card={card} />;
    case "ai_image":
      return <MediaEditor card={card} />;
    case "ai_video":
      return <VideoEditor card={card} />;
    case "ai_multiangle":
      return <MultiangleEditor card={card} />;
    case "ai_tryon":
      return <TryOnEditor card={card} />;
    case "ai_script":
      return <ScriptEditor card={card} />;
    case "audio":
      return (
        <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
          音频素材卡片 · 连线到视频卡片即可作为参考音频
        </div>
      );
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          暂不支持编辑此类型
        </div>
      );
  }
}
