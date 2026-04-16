# AI 聊天面板方案（统一对话流）

## 核心理念

**一个聊天，所有能力。** 文本对话、图片生成、视频生成全部发生在同一个对话流中，用户无需切换 tab 或模式。AI 自动路由意图，也可通过输入区快捷指令显式指定。

---

## 现状分析

已有基础设施：
- `AgentPanel` — 画布右侧悬浮面板，单会话，支持工具调用（生成图片、分析图片、操作画布）
- `agentStore` — Zustand store，管理消息/状态/会话
- `agent/runtime` — 多轮 tool-calling 循环引擎
- `agent/providers/openai` — 统一的 OpenAI 兼容 API 调用层
- `modelService` — 管理 Chat / Image / Video 模型列表

**核心问题**：当前只有一个全局会话，无法新建/切换/持久化，且功能定位是 Agent（工具调用），不是纯聊天。

---

## 设计目标

| 维度 | 目标 |
|------|------|
| 统一体验 | 对话、生图、生视频在同一聊天流中，无 tab 切换 |
| 多会话 | 支持新建、切换、删除会话，会话列表 |
| 持久化 | 会话和消息持久化到 SQLite |
| 多模态输出 | 文本回复 / 图片生成 / 视频生成，消息混排展示 |
| 意图路由 | AI 自动识别用户意图 + 输入区快捷指令兜底 |
| 模型选择 | 复用已有 modelService，每种能力独立选模型 |
| 复杂度 | 企业级架构但实现精简，不引入新依赖 |

---

## 架构设计

```
┌──────────────────────────────────────────────┐
│                ChatPanel (UI)                │
│  ┌──────────┐  ┌───────────────────────────┐ │
│  │ 会话列表  │  │       消息区域            │ │
│  │ - 新建    │  │  文本 / 图片 / 视频 / 加载 │ │
│  │ - 历史    │  │  (混排在同一对话流中)      │ │
│  │ - 删除    │  ├───────────────────────────┤ │
│  │           │  │       输入区域            │ │
│  │           │  │  文本 + 图片上传          │ │
│  │           │  │  / 指令前缀 + 模型选择    │ │
│  └──────────┘  └───────────────────────────┘ │
└──────────────────────────────────────────────┘
         │                    │
    chatStore          chatService
    (Zustand)        (意图路由 + 调度)
         │                    │
    ┌────┴────┐       ┌──────┴──────────┐
    │ SQLite  │       │   aiProxy       │
    │ 持久化   │       │   (已有API层)   │
    └─────────┘       │                 │
                      ├─ Chat 模型  (文本对话)
                      ├─ Image 模型 (图片生成)
                      └─ Video 模型 (视频生成)
```

---

## 用户交互流程

### 统一输入，智能路由

用户始终在同一个输入框中打字，系统通过以下机制决定调用哪个模型：

```
用户输入
  │
  ├─ 以 /image 开头 ──→ 强制走 Image 模型生成图片
  ├─ 以 /video 开头 ──→ 强制走 Video 模型生成视频
  ├─ 普通文本 ─────────→ Chat 模型回复文本
  │                      (Chat 模型可通过 tool_call 触发生图/生视频)
  └─ 上传图片 + 文本 ──→ Chat 模型（Vision）理解图片并回复
```

### 对话流示例

```
用户: 帮我设计一个科幻风格的城市
AI:   好的，这是一个未来科幻城市的概念描述...（文本回复）

用户: 帮我生成这个城市的图片
AI:   [正在生成图片...]
      [🖼️ 科幻城市图片]    ← 图片内联展示在对话中

用户: 这个图片很好，帮我做成一个飞行穿越的视频
AI:   [正在生成视频...]
      [🎬 飞行穿越视频]    ← 视频内联展示在对话中

用户: /image 一只赛博朋克风格的猫
AI:   [🖼️ 赛博朋克猫]     ← 快捷指令直接生图，无需 AI 判断

用户: 你觉得这张图怎么样？
AI:   这张赛博朋克猫的图片很有特色...（文本回复，引用上文图片）
```

---

## 数据模型

### SQLite 表结构

```sql
-- 会话表
CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT,           -- 可选，关联项目
    title TEXT NOT NULL,       -- 自动生成或用户编辑
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 消息表
CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,        -- 'user' | 'assistant' | 'system'
    content TEXT NOT NULL,     -- JSON: ContentPart[]
    metadata TEXT,             -- JSON: 生成参数、模型信息等
    created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
```

### TypeScript 类型

```typescript
interface ChatSession {
    id: string;
    projectId?: string;
    title: string;
    createdAt: string;
    updatedAt: string;
}

// 统一的多模态内容块
type ChatContentPart =
    | { type: "text"; text: string }
    | { type: "image"; url: string; prompt?: string }
    | { type: "video"; url: string; prompt?: string; coverUrl?: string }
    | { type: "loading"; mediaType: "image" | "video" };  // 生成中占位

interface ChatMessageMeta {
    model?: string;           // 实际使用的模型
    intent?: "chat" | "image" | "video";  // 路由到的意图
    generationParams?: Record<string, unknown>;  // 生成参数快照
}

interface ChatMessage {
    id: string;
    sessionId: string;
    role: "user" | "assistant" | "system";
    content: ChatContentPart[];
    metadata?: ChatMessageMeta;
    createdAt: string;
}
```

---

## 文件结构

```
src/
├── stores/
│   └── chatStore.ts              # 新建 - 聊天状态管理
├── features/
│   └── chat/
│       ├── ChatPanel.tsx          # 主面板容器
│       ├── ChatSessionList.tsx    # 会话列表侧栏
│       ├── ChatMessageList.tsx    # 消息列表
│       ├── ChatMessageBubble.tsx  # 单条消息气泡（文本+图片+视频混排）
│       ├── ChatInput.tsx          # 统一输入区（文本+图片上传+发送）
│       ├── ChatModelBar.tsx       # 模型选择栏（Chat/Image/Video 各选一个）
│       ├── MediaPreview.tsx       # 图片/视频 内联预览 + 操作（放大、拖到画布、下载）
│       └── LoadingIndicator.tsx   # 生成中动画（区分图片/视频）
├── lib/
│   └── chatService.ts            # 新建 - 意图路由 + 多模型调度
src-tauri/src/
├── commands/
│   └── chat.rs                   # 新建 - 会话/消息 CRUD 命令
├── db/
│   └── migrations.rs             # 追加 v6 迁移
```

---

## 核心模块设计

### 1. chatStore（状态管理）

```typescript
interface ChatState {
    // 会话管理
    sessions: ChatSession[];
    currentSessionId: string | null;

    // 当前会话消息
    messages: ChatMessage[];

    // 生成状态（支持并行感知）
    generating: boolean;
    generatingType: "chat" | "image" | "video" | null;
    streamingText: string;       // 流式文本输出的临时缓冲

    // 模型配置（每种能力独立选模型）
    chatModel: string;
    imageModel: string;
    videoModel: string;

    // Actions - 会话
    loadSessions: () => Promise<void>;
    createSession: () => Promise<string>;
    switchSession: (id: string) => Promise<void>;
    deleteSession: (id: string) => Promise<void>;
    renameSession: (id: string, title: string) => Promise<void>;

    // Actions - 消息（统一入口）
    sendMessage: (text: string, attachments?: File[]) => Promise<void>;
    clearMessages: () => Promise<void>;

    // Actions - 模型
    setChatModel: (model: string) => void;
    setImageModel: (model: string) => void;
    setVideoModel: (model: string) => void;
}
```

### 2. chatService（意图路由 + 多模型调度）

核心职责：接收用户输入，判断意图，路由到正确的模型，将结果统一为 `ChatContentPart[]` 返回。

```typescript
type Intent = "chat" | "image" | "video";

// 意图解析
function parseIntent(input: string): { intent: Intent; prompt: string } {
    if (input.startsWith("/image ")) return { intent: "image", prompt: input.slice(7) };
    if (input.startsWith("/video ")) return { intent: "video", prompt: input.slice(7) };
    return { intent: "chat", prompt: input };
}

// 统一发送入口
async function sendMessage(
    input: string,
    history: ChatMessage[],
    models: { chat: string; image: string; video: string },
    callbacks: {
        onStreamChunk?: (text: string) => void;
        onGeneratingChange?: (type: Intent) => void;
    },
): Promise<ChatContentPart[]>

// 内部调度：
// intent === "chat"  → chatCompletion(history, models.chat, onStreamChunk)
//   → Chat 模型可能返回 tool_call: generate_image / generate_video
//   → 自动执行 tool_call，将结果追加到回复中
// intent === "image" → imageGeneration(prompt, models.image)
// intent === "video" → videoGeneration(prompt, models.video)
```

**Chat 模型 Tool Calling（自动路由）**：

```typescript
const tools = [
    {
        type: "function",
        function: {
            name: "generate_image",
            description: "当用户要求生成、绘制、画一张图片时调用",
            parameters: {
                type: "object",
                properties: {
                    prompt: { type: "string", description: "图片生成的英文 prompt" },
                },
                required: ["prompt"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "generate_video",
            description: "当用户要求生成、制作一段视频时调用",
            parameters: {
                type: "object",
                properties: {
                    prompt: { type: "string", description: "视频生成的英文 prompt" },
                },
                required: ["prompt"],
            },
        },
    },
];
```

### 3. ChatPanel（UI 组件）

**布局**：
- 与现有 `AgentPanel` 相同位置（画布右侧 `absolute right-3`）
- 宽度 420px，可折叠
- 两栏模式：左侧窄栏会话列表（可收起） + 右侧消息区

**交互**：
- 顶栏：会话标题 + 新建按钮 + 设置按钮（弹出模型选择） + 关闭按钮
- 消息区：
  - 用户消息靠右，AI 消息靠左
  - **文本**：Markdown 渲染
  - **图片**：内联卡片展示，hover 显示操作按钮
  - **视频**：内联播放器，支持播放/暂停
  - **生成中**：骨架屏 + 脉冲动画，区分图片/视频
- 输入区：
  - 统一文本框，支持 `/image`、`/video` 前缀自动补全提示
  - 图片上传按钮（用于 Vision 理解）
  - 发送按钮
  - 无 tab 切换，无模式切换

**模型选择**：
- 点击顶栏设置按钮弹出模型配置面板
- 三行分别选择：Chat 模型 / Image 模型 / Video 模型
- 选好后关闭，不影响聊天区

---

## 实施步骤

### Phase 1：后端基础（~1h）
1. `migrations.rs` 添加 v6 迁移，创建 `chat_sessions` + `chat_messages` 表
2. `chat.rs` 实现 Tauri 命令：
   - `list_chat_sessions` / `create_chat_session` / `delete_chat_session` / `rename_chat_session`
   - `load_chat_messages` / `save_chat_message` / `clear_chat_messages`
3. `lib.rs` 注册命令
4. `tauri.ts` 添加前端 API 封装

### Phase 2：状态管理 + 服务层（~1h）
1. 创建 `chatStore.ts`，包含会话 CRUD + 消息管理 + 三模型配置
2. 创建 `chatService.ts`：
   - 意图解析（`/image`、`/video` 前缀 + 默认 chat）
   - Chat 流式调用 + tool_call 处理
   - Image 生成调用
   - Video 生成调用
   - 统一结果为 `ChatContentPart[]`

### Phase 3：UI 组件（~2.5h）
1. `ChatPanel.tsx` — 主容器 + 动画
2. `ChatSessionList.tsx` — 会话列表 + 新建/删除
3. `ChatMessageList.tsx` + `ChatMessageBubble.tsx` — 消息展示（文本+图片+视频混排 + 流式打字）
4. `ChatInput.tsx` — 统一输入区 + `/` 指令提示 + 图片上传
5. `ChatModelBar.tsx` — 弹出式模型选择（Chat/Image/Video）
6. `MediaPreview.tsx` — 图片放大 / 视频播放
7. `LoadingIndicator.tsx` — 生成中动画

### Phase 4：集成（~30min）
1. `uiStore.ts` 添加 `chatPanelVisible` 状态
2. 画布中添加打开入口（侧边栏按钮或悬浮按钮）
3. 处理与现有 `AgentPanel` 的共存/替换

---

## 与现有 AgentPanel 的关系

| 对比项 | AgentPanel（现有） | ChatPanel（新建） |
|--------|-------------------|------------------|
| 定位 | 画布操作 Agent，工具调用 | 统一 AI 聊天（对话+生图+生视频） |
| 会话 | 单会话，不持久化 | 多会话，SQLite 持久化 |
| 能力 | 文本 + 工具（画布操作） | 文本 + 图片生成 + 视频生成 + 图片理解 |
| 交互 | 工具调用 loop | 意图路由 + tool_call |
| 复杂度 | 高（runtime loop + tool registry） | 中（意图解析 + 多模型调度） |

**建议**：保留 AgentPanel 不动，新建 ChatPanel 独立实现。两者入口分开：
- 侧边栏底部保留「AI 助手」按钮 → AgentPanel
- 画布右下角新增悬浮按钮 → ChatPanel

后续可考虑合并，但当前分离更安全。

---

## 技术要点

### 流式输出
```typescript
// 利用已有的 aiProxy fetch 层，流式读取 Chat 回复
const response = await fetch(url, { ...options, stream: true });
const reader = response.body.getReader();
// 逐 chunk 解析 SSE data，更新 streamingText
// 遇到 tool_call (generate_image/generate_video) 时暂停文本流，执行生成
```

### Tool Call 执行流程
```
Chat 模型返回 tool_call: generate_image({ prompt: "..." })
  → 先将文本部分作为消息展示
  → 插入 { type: "loading", mediaType: "image" } 占位
  → 调用 Image 模型生成
  → 替换 loading 为 { type: "image", url: "...", prompt: "..." }
  → 持久化完整消息
```

### 自动标题
- 第一条消息发送后，用 Chat 模型生成 ≤10 字的会话标题
- 异步执行，不阻塞对话

### 媒体内联展示
- **图片**：消息气泡内嵌图片卡片，最大宽度 320px，点击放大
- **视频**：消息气泡内嵌视频播放器，自动加载封面帧，点击播放
- **生成中**：骨架屏 + "正在生成图片..." / "正在生成视频..." 文案 + 脉冲动画

### 媒体可操作
- 聊天中生成的图片/视频可以：
  - 点击放大预览 / 全屏播放
  - 拖拽到画布变成卡片
  - 保存到本地
  - 复制 prompt（方便二次生成）

### `/` 指令快捷提示
- 用户输入 `/` 时，浮出指令菜单：
  - `/image <prompt>` — 直接生成图片
  - `/video <prompt>` — 直接生成视频
- 选择后自动填入前缀，用户只需补 prompt 即可发送
