# 卡片可编辑标签（Card Label）方案

## 1. 背景与目标

当前 `CanvasCard.title` 字段已存在，模板实例化（`templateFactory.ts`）会写入 title（如「人物图」「服装图」「白底精修图」），但 `CardShell` 未渲染。需要：

- 在卡片**正上方**显示一个可编辑标签，随卡片移动/缩放/拖拽实时跟随
- **仅模板生成的卡片**默认显示标签；普通手动创建的卡片不显示
- 标签可双击进入编辑、回车/失焦保存、ESC 取消
- 不影响现有拖拽、连线、参考图投递等交互

## 2. 数据模型

复用 `CanvasCard.title` 字段，无需新增字段。新增一个布尔标记区分「模板节点」：

```ts
// src/types/card.ts
export interface CanvasCard {
  // ...existing fields...
  title?: string;
  showLabel?: boolean; // 新增：是否在卡片上方显示可编辑标签
}
```

模板写入时默认 `showLabel: true`，普通创建走 `false`/`undefined`。

### DB 兼容
- `cards` 表无需新增列（`showLabel` 可放进 `data` JSON 内，避免改 schema）
- 推荐：直接放进 `card.data._showLabel`，保持表结构稳定

最终落地方案（推荐）：**用 `data._showLabel: boolean` 标记**，title 仍走顶层字段。

## 3. 模板侧改动

### 3.1 `templateFactory.ts`
```ts
data: { ...preset.data, _showLabel: true },
```

### 3.2 `WorkflowCardPreset`（types/card.ts）
无需改，沿用现有 `title` + `data`。

## 4. UI 组件设计

### 4.1 文件位置
新建 `src/features/cards/CardLabel.tsx`，由 `CardShell` 在卡片外层 wrapper 内渲染。

### 4.2 视觉规格
| 属性 | 值 |
|------|----|
| 位置 | 卡片顶部外侧，距离卡片 6px |
| 对齐 | 水平左对齐（`left: 0`），随卡片宽度变化 |
| 高度 | 22px |
| 字号 | 12px |
| 字色 | `text-foreground/80` |
| 背景 | `bg-background/70 backdrop-blur-sm` |
| 圆角 | `rounded-md` |
| 内边距 | `px-2 py-0.5` |
| 边框 | `border border-border/40` |
| 编辑态 | 蓝色 ring (`ring-2 ring-primary/60`) |
| 最大宽度 | 卡片宽度（超出则 `truncate`） |
| 鼠标悬停 | 出现淡淡铅笔图标（`lucide-react Pencil`） |

### 4.3 交互逻辑
| 动作 | 行为 |
|------|------|
| 单击 | 不做事（避免误触发选中卡片） |
| 双击 | 进入编辑（`<input>` 替换 `<span>`，自动 focus + 全选） |
| 回车 | 保存并退出编辑 |
| 失焦 | 保存并退出编辑 |
| ESC | 还原原值并退出编辑 |
| 空文本 | 允许保存（卡片显示空标签可被再次双击编辑） |
| 卡片锁定 | 标签只读，禁止编辑 |

### 4.4 跟随移动
- 标签作为 `CardShell` 内 `<div>` 子元素，定位 `absolute top: -28px`
- 与卡片**同处于一个 transform 容器**，因此拖拽时跟随
- 缩放时不需要单独处理（父容器的 `width` 已变）

### 4.5 防止与拖拽冲突
- `CardLabel` 根节点 `onPointerDown={(e)=>e.stopPropagation()}`，避免触发卡片拖拽
- 编辑态 `<input>` 加 `onPointerDown` 同样 stopPropagation

## 5. 组件示例（伪代码）

```tsx
// src/features/cards/CardLabel.tsx
import { memo, useState, useRef, useEffect } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";
import { recordUpdate } from "@/lib/history";
import type { CanvasCard } from "@/types";

interface Props {
  card: CanvasCard;
}

export default memo(function CardLabel({ card }: Props) {
  const updateCard = useCardStore((s) => s.updateCard);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(card.title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next !== (card.title ?? "")) {
      recordUpdate(card.id, { title: card.title });
      updateCard(card.id, { title: next });
      autoSave.markDirty(card.id);
    }
    setEditing(false);
  };

  const cancel = () => {
    setDraft(card.title ?? "");
    setEditing(false);
  };

  return (
    <div
      className="absolute -top-7 left-0 right-0 z-30 flex items-center"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
            e.stopPropagation();
          }}
          className={cn(
            "h-[22px] w-full rounded-md border border-primary/60 bg-background/95",
            "px-2 text-xs outline-none ring-2 ring-primary/30",
          )}
        />
      ) : (
        <button
          type="button"
          onDoubleClick={() => !card.locked && setEditing(true)}
          className={cn(
            "group/label inline-flex h-[22px] max-w-full items-center gap-1 truncate",
            "rounded-md border border-border/40 bg-background/70 px-2",
            "text-xs text-foreground/80 backdrop-blur-sm",
            "hover:bg-background/90",
            card.locked && "cursor-default",
          )}
          title={card.title || "双击编辑标签"}
        >
          <span className="truncate">{card.title || "未命名"}</span>
          {!card.locked && (
            <Pencil className="h-3 w-3 shrink-0 opacity-0 group-hover/label:opacity-60" />
          )}
        </button>
      )}
    </div>
  );
});
```

## 6. CardShell 集成点

```tsx
// src/features/cards/CardShell.tsx
import CardLabel from "./CardLabel";

// 在 return 的最外层 div 内、Port 渲染之前插入：
{(card.data as { _showLabel?: boolean })._showLabel && (
  <CardLabel card={card} />
)}
```

**memo 比较函数补充 title 检查**：

```tsx
prev.card.title === next.card.title &&
```

否则编辑标签时不会触发重渲染。

## 7. 历史记录与撤销

- 通过 `recordUpdate(card.id, { title: oldTitle })` 写入 history
- 已有 history 系统支持 `Partial<CanvasCard>`，不需要改造
- Ctrl+Z 可撤销 title 修改

## 8. 自动保存

- `autoSave.markDirty(card.id)` 已是现成 API
- 标签提交后调用即可

## 9. 显隐策略矩阵

| 来源 | `_showLabel` | 显示 |
|------|-------------|------|
| 模板（templateFactory） | `true` | 是 |
| 手动 + 普通卡片 | `false`/未设置 | 否 |
| 拖拽连线生成的衍生卡片 | 取决于上游/默认 false | 否 |
| 右键菜单「显示标签」 | 用户切换 | 是/否 |

### 右键菜单（可选增强）
在 `ContextMenu.tsx` 增加：「显示标签 / 隐藏标签」开关：

```ts
{
  label: card.data._showLabel ? "隐藏标签" : "显示标签",
  onClick: () => {
    updateCard(card.id, {
      data: { ...card.data, _showLabel: !card.data._showLabel },
    });
  },
}
```

## 10. 边界场景

| 场景 | 处理 |
|------|------|
| 卡片宽度 < 60px | 标签 `truncate`，仍可双击编辑 |
| 多选 + 群组拖拽 | 已被 transform 容器带走，无需处理 |
| 卡片处于编辑态（`editingCardId`） | 标签照常显示，不冲突 |
| 卡片被锁定 | 标签只读 |
| zoom < 0.5 | 标签依然按画布坐标系缩放，可读性下降但不会错位 |
| 卡片选中 | 标签可加 ring 强调（可选） |
| 卡片重叠 | 标签 `z-30` 高于 Port，但低于 selection ring（10）→ 调整为 z-40 |

## 11. 类型定义改动汇总

```ts
// src/types/card.ts —— 不改顶层，title 已存在
// data 内约定字段：
interface CardDataConventions {
  _showLabel?: boolean; // 是否显示标签
  // ...其他业务字段
}
```

## 12. 实施步骤（建议拆 4 个 PR/提交）

1. **P1 - 基础渲染**：新增 `CardLabel.tsx` + `CardShell` 集成 + 模板默认 `_showLabel: true`
2. **P2 - 编辑交互**：双击编辑、回车/ESC、autoSave、history
3. **P3 - 右键开关**：ContextMenu 增加显隐切换
4. **P4 - 视觉打磨**：选中态高亮、悬停铅笔图标、暗色模式

## 13. 测试用例

- [ ] 模板创建的换衣节点卡片，「人物图」「服装图」标签出现在对应卡片正上方
- [ ] 拖动卡片，标签同步移动无延迟
- [ ] 缩放画布，标签按比例缩放
- [ ] 双击「人物图」改成「客户人物」并回车，标签更新且 Ctrl+Z 可还原
- [ ] 普通手动创建的 ai_image 卡片，无标签
- [ ] 右键菜单「显示标签」可切换显隐
- [ ] 锁定卡片后，双击标签不进入编辑
- [ ] 编辑标签时拖动鼠标到卡片正文，不触发卡片拖拽

## 14. 不在本方案范围

- 标签颜色/图标自定义（后续版本）
- 多语言标签（后续版本）
- 标签搜索/过滤（后续版本）
