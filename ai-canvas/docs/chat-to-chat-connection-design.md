# 文字卡片 (ai_chat) 连接逻辑 — 实现计划

## 1. 现状审计

### 1.1 数据流架构总览

```
连接建立                  数据注入                      数据消费
─────────────          ──────────────              ──────────────
CardShell              dataFlow.ts                 各 Editor
  onPortPointerUp        injectIntoCard()            handleGenerate()
    ↓                      ↓                          ↓
  addConnection()   →   injectOnConnect()    →    读取 card.data 中
  (connectionStore)      extractOutput(source)     注入的字段来构建
                         injectIntoCard(target)    API 请求

连接删除                  数据清理
─────────────          ──────────────
useConnectionSync.ts   dataFlow.ts
  subscribe(prev→curr)   removeRefImageForSource()
  检测被删除的连接         removeUpstreamTextForSource()
    ↓                    removeVideoFrameForSource()
  调用3个清理函数

自动传播
─────────────
startDataFlowWatcher()
  subscribe cardStore → 检测 data 变化 → propagateFromCard()
  subscribe uiStore   → 检测生成结束   → propagateFromCard()
```

### 1.2 各卡片类型注入字段对照表

| target.type | text payload 写入字段 | image payload 写入字段 | 清理函数覆盖 |
|---|---|---|---|
| `text` / `sticky_note` | `upstreamText` (单值) | ❌ | ❌ 无专用清理 |
| **`ai_chat`** | **`upstreamContext` (单值)** | `refImages` | **❌ 未被清理** |
| `ai_image` / `ai_multiangle` | `upstreamTexts` (多源) | `refImages` | ✅ `removeUpstreamTextForSource` |
| `ai_video` | `upstreamTexts` (多源) | `refFrames` | ✅ 两个清理函数 |
| `ai_tryon` | ❌ | `personImageUrl` / `garmentImageUrl` | ❌ |

### 1.3 已识别的问题

| # | 问题 | 位置 | 严重程度 |
|---|------|------|----------|
| P1 | `ai_chat` 接收 text 用 `upstreamContext` (单值)，多个上游互相覆盖 | `dataFlow.ts:186-193` | 高 |
| P2 | `ChatEditor.handleGenerate()` **从未读取** `upstreamContext`，注入的数据被完全忽略 | `ChatEditor.tsx:318-460` | 高 |
| P3 | 连接删除时 `removeUpstreamTextForSource` 只清理 `upstreamTexts`，不清理 `upstreamContext` | `useConnectionSync.ts:18-20` | 中 |
| P4 | `connectionRecovery.ts` 只从 `refImages` / `refFrames` 重建连接，不恢复文本连接 | `connectionRecovery.ts:26-66` | 低 |

### 1.4 `upstreamCardId` 字段分析

`upstreamCardId` 在 `injectIntoCard` 中每次注入都会被设置为最后一个 source 的 ID。它是一个遗留的单值字段，在以下位置被读取：

- `VideoEditor.tsx:159` — 作为 `refFrames` 的兼容回退
- **其他地方未使用**

**结论**：`upstreamCardId` 在 `ai_chat` 分支中无任何消费者。改为多源模式后，源信息通过 `upstreamTexts` 的 key 追踪，`ai_chat` 分支中不再需要设置 `upstreamCardId`。但其他卡片类型仍在使用，**不删除**，仅在 `ai_chat` 的 text 注入路径中不再写入。

## 2. 改动清单

### Step 1: `dataFlow.ts` — ai_chat text 注入改为多源模式

**文件**: `src/lib/dataFlow.ts`
**行**: 186-193

```
修改前:
  case "ai_chat": {
    if (payload.kind === "text") {
      const prev = (d.upstreamContext as string) ?? "";
      if (prev !== payload.text) {
        d.upstreamContext = payload.text;
        d.upstreamCardId = sourceCardId;
        changed = true;
      }
    }

修改后:
  case "ai_chat": {
    if (payload.kind === "text") {
      const upstreamTexts = {
        ...((d.upstreamTexts as Record<string, string>) || {}),
      };
      if (upstreamTexts[sourceCardId] !== payload.text) {
        upstreamTexts[sourceCardId] = payload.text;
        d.upstreamTexts = upstreamTexts;
        changed = true;
      }
    }
```

**效果**: ai_chat 与 ai_image / ai_video 使用完全相同的多源文本注入模式。

**清理函数**: `removeUpstreamTextForSource` 已经按 `upstreamTexts[sourceCardId]` 模式工作，**无需修改**。`useConnectionSync.ts` 中的调用链也无需修改，因为它已经调用了这三个清理函数。

### Step 2: `ChatEditor.tsx` — handleGenerate 消费 upstreamTexts

**文件**: `src/features/editor/ChatEditor.tsx`

在 `handleGenerate` 中，systemPrompt 构建之前，读取 `upstreamTexts` 并拼接为上下文块：

```typescript
// 在 const systemPrompt = ... 之前插入
const upstreamTexts = (data as Record<string, unknown>).upstreamTexts as
  Record<string, string> | undefined;
const upstreamEntries = upstreamTexts ? Object.entries(upstreamTexts) : [];

let contextPrefix = "";
if (upstreamEntries.length > 0) {
  const cardStore = useCardStore.getState();
  const sections = upstreamEntries.map(([cardId, text]) => {
    const label = cardStore.getCard(cardId)?.title || "上游节点";
    return `## ${label}\n${text}`;
  });
  contextPrefix =
    "<upstream_context>\n" +
    sections.join("\n\n") +
    "\n</upstream_context>\n\n";
}

const systemPrompt = contextPrefix
  + (data._systemPrompt || "你是一个有帮助的 AI 助手，请用中文回复。请直接回答用户的问题。");
```

### Step 3: `ChatEditor.tsx` — UpstreamContextBar 组件

在 ChatEditor 内部新增一个轻量展示组件，位于 refImages 区域之后、prompt 输入区域之前：

```
┌──────────────────────────────────────────┐
│ [ref images slots]                       │  ← 已有
├──────────────────────────────────────────┤
│ 📎 引用 2 个上游输出                       │  ← 新增
│ ┌──────────────────────────────────────┐ │
│ │ ● Chat A: 春眠不觉晓…(152字) [×]     │ │
│ │ ● Chat B: The spring morn…(98字) [×] │ │
│ └──────────────────────────────────────┘ │
├──────────────────────────────────────────┤
│ [prompt textarea]                        │  ← 已有
│                              [✨ 生成]    │
└──────────────────────────────────────────┘
```

组件直接内联在 ChatEditor.tsx 中（不单独建文件，因为只在此处使用），点击 [×] 时断开对应连接。

### Step 4: `ChatEditor.tsx` — 旧字段一次性迁移

在现有的 model 初始化 useEffect 旁边，增加一个 useEffect 处理 `upstreamContext` → `upstreamTexts` 的数据迁移：

```typescript
useEffect(() => {
  const d = card.data as Record<string, unknown>;
  if (d.upstreamContext && !d.upstreamTexts) {
    const srcId = (d.upstreamCardId as string) || "legacy";
    updateCard(card.id, {
      data: {
        ...card.data,
        upstreamTexts: { [srcId]: d.upstreamContext as string },
        upstreamContext: undefined,
      },
    });
    autoSave.markDirty(card.id);
  }
}, []);
```

### Step 5: `workflows.ts` — 新增「对话链」工作流模板

```typescript
{
  id: "wf-chat-chain",
  name: "对话链",
  description: "上一个 AI 的输出作为下一个的上下文，逐步精炼内容",
  icon: "MessageSquare",
  category: "chat",
  cards: [
    { type: "ai_chat", title: "初稿", relativeX: 0, relativeY: 0, ... },
    { type: "ai_chat", title: "润色", relativeX: cardWidth + 60, relativeY: 0, ... },
  ],
  connections: [{ sourceIndex: 0, targetIndex: 1 }],
}
```

## 3. 不改动的部分（确认安全）

| 项目 | 原因 |
|------|------|
| `connectionRecovery.ts` | 只从 refImages/refFrames 恢复，文本连接没有 sourceCardId 可追踪，保持现状 |
| `ConnectionLayer.tsx` | 纯渲染层，与数据逻辑无关 |
| `connectionStore.ts` | store 层不感知具体卡片类型 |
| `useConnectionSync.ts` | 已经调用3个清理函数，`removeUpstreamTextForSource` 覆盖了新的 `upstreamTexts` |
| `AIChatCard.tsx` | 卡片缩略视图，不涉及上游文本显示 |
| `text` / `sticky_note` 的 `upstreamText` | 与 ai_chat 无关，保持单值模式 |
| `upstreamCardId` 在其他卡片类型中的使用 | VideoEditor 有兼容读取，不动 |

## 4. 改动影响矩阵

```
文件                           改动类型    影响范围
─────────────────────────────────────────────────────
src/lib/dataFlow.ts            修改       ai_chat text 注入分支 (6行)
src/features/editor/ChatEditor.tsx  修改   handleGenerate + UI (约40行新增)
src/config/workflows.ts        新增       1个工作流模板 (约20行)
```

**总计**: 修改 2 个文件 + 1 个文件新增内容，新增约 60 行，修改约 6 行。

## 5. 测试验证清单

- [ ] Chat A → Chat B 连线后，A 生成完毕，B 的 upstreamTexts 自动获得 A 的 result
- [ ] Chat B 点击生成时，system prompt 包含 A 的输出文本
- [ ] Chat A + Chat C → Chat B (多源)，B 的 system prompt 包含两者
- [ ] 删除 Chat A → Chat B 的连线，B 的 upstreamTexts 中 A 的条目被清理
- [ ] 删除 Chat A 卡片，B 的 upstreamTexts 中 A 的条目被清理
- [ ] UpstreamContextBar 正确显示上游条目，点击 × 断开连接
- [ ] 旧项目中含 upstreamContext 的卡片，打开后自动迁移为 upstreamTexts
- [ ] Image → Chat 的图片注入不受影响
- [ ] Chat → Image 的文本注入不受影响
- [ ] 「对话链」工作流模板能正常创建并自动连线
