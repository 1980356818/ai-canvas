# AI 聊天面板方案

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
| 多会话 | 支持新建、切换、删除会话，会话列表 |
| 持久化 | 会话和消息持久化到 SQLite |
| 聊天能力 | 文本对话 + 图片理解 + 图片生成 |
| 模型选择 | 复用已有 modelService，可切换 Chat/Image 模型 |
| 复杂度 | 企业级架构但实现精简，不引入新依赖 |

---

## 架构设计

```
┌─────────────────────────────────────────┐
│              ChatPanel (UI)             │
│  ┌──────────┐  ┌──────────────────────┐ │
│  │ 会话列表  │  │     消息区域         │ │
│  │ - 新建    │  │  文本 / 图片 / 加载  │ │
│  │ - 历史    │  │                      │ │
│  │ - 删除    │  ├──────────────────────┤ │
│  │           │  │     输入区域         │ │
│  │           │  │  文本 + 图片上传     │ │
│  │           │  │  模型选择 + 发送     │ │
│  └──────────┘  └──────────────────────┘ │
└─────────────────────────────────────────┘
         │                    │
    chatStore            chatService
    (Zustand)          (业务逻辑层)
         │                    │
    ┌────┴────┐       ┌───────┴───────┐
    │ SQLite  │       │ aiProxy       │
    │ 持久化   │       │ (已有API层)   │
    └─────────┘       └───────────────┘
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
    model TEXT NOT NULL,       -- 当前使用的模型
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 消息表
CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,        -- 'user' | 'assistant'
    content TEXT NOT NULL,     -- JSON: ContentPart[]
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
    model: string;
    createdAt: string;
    updatedAt: string;
}

type ChatContentPart =
    | { type: "text"; text: string }
    | { type: "image"; url: string };

interface ChatMessage {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    content: ChatContentPart[];
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
│       ├── ChatMessage.tsx        # 单条消息气泡
│       ├── ChatInput.tsx          # 输入区（文本+图片+模型选择+发送）
│       └── ChatModelPicker.tsx    # 内联模型切换器
├── lib/
│   └── chatService.ts            # 新建 - 聊天业务逻辑（调API、流式、图片生成）
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
    
    // 输入状态
    generating: boolean;
    streamingText: string;       // 流式输出的临时文本
    
    // Actions
    loadSessions: () => Promise<void>;
    createSession: (model?: string) => Promise<string>;
    switchSession: (id: string) => Promise<void>;
    deleteSession: (id: string) => Promise<void>;
    renameSession: (id: string, title: string) => Promise<void>;
    
    sendMessage: (content: ChatContentPart[]) => Promise<void>;
    clearMessages: () => Promise<void>;
}
```

### 2. chatService（业务逻辑）

职责：
- **文本聊天**：调用 `aiProxy` → Chat 模型，支持流式输出
- **图片理解**：用户上传图片 → 作为 Vision 输入发给 Chat 模型
- **图片生成**：检测用户意图或提供按钮 → 调用 Image 模型生成

```typescript
// 核心方法
async function chat(
    messages: ChatMessage[],
    model: string,
    onChunk: (text: string) => void,    // 流式回调
): Promise<ChatContentPart[]>

async function generateImage(
    prompt: string,
    model: string,
): Promise<string>    // 返回图片 URL
```

**图片生成策略**：
- 方案 A（推荐）：用户在输入框旁点「生成图片」按钮，用 Image 模型生成
- 方案 B：Chat 模型自动判断是否需要生成图片（需 function calling，更复杂）

→ **选择方案 A**：简单可靠，一个按钮切换「聊天 / 生图」模式

### 3. ChatPanel（UI 组件）

**布局**：
- 与现有 `AgentPanel` 相同位置（画布右侧 `absolute right-3`）
- 宽度 400px，可折叠
- 两栏模式：左侧窄栏会话列表（可收起） + 右侧消息区

**交互**：
- 顶栏：会话标题 + 模型切换 + 新建按钮 + 关闭按钮
- 消息区：用户消息靠右，AI 消息靠左，图片内联显示
- 输入区：文本框 + 图片上传 + 聊天/生图 模式切换 + 发送按钮

---

## 实施步骤

### Phase 1：后端基础（~1h）
1. `migrations.rs` 添加 v6 迁移，创建 `chat_sessions` + `chat_messages` 表
2. `chat.rs` 实现 Tauri 命令：
   - `list_chat_sessions` / `create_chat_session` / `delete_chat_session` / `rename_chat_session`
   - `load_chat_messages` / `save_chat_message` / `clear_chat_messages`
3. `lib.rs` 注册命令
4. `tauri.ts` 添加前端 API 封装

### Phase 2：状态管理（~30min）
1. 创建 `chatStore.ts`
2. 实现会话 CRUD + 消息加载/保存
3. `chatService.ts` 封装 `aiProxy` 调用

### Phase 3：UI 组件（~2h）
1. `ChatPanel.tsx` — 主容器 + 动画
2. `ChatSessionList.tsx` — 会话列表 + 新建/删除
3. `ChatMessageList.tsx` + `ChatMessage.tsx` — 消息展示（文本+图片+流式打字效果）
4. `ChatInput.tsx` — 输入区 + 模式切换（聊天/生图）
5. `ChatModelPicker.tsx` — 内联模型选择下拉

### Phase 4：集成（~30min）
1. `uiStore.ts` 添加 `chatPanelVisible` 状态
2. 画布中添加打开入口（侧边栏按钮或悬浮按钮）
3. 处理与现有 `AgentPanel` 的共存/替换

---

## 与现有 AgentPanel 的关系

| 对比项 | AgentPanel（现有） | ChatPanel（新建） |
|--------|-------------------|------------------|
| 定位 | 画布操作 Agent，工具调用 | 通用 AI 聊天助手 |
| 会话 | 单会话，不持久化 | 多会话，SQLite 持久化 |
| 能力 | 文本 + 工具（生图/分析/画布操作） | 文本 + 图片理解 + 图片生成 |
| 复杂度 | 高（runtime loop + tool registry） | 低（直接调 API） |

**建议**：保留 AgentPanel 不动，新建 ChatPanel 独立实现。两者入口分开：
- 侧边栏底部保留「AI 助手」按钮 → AgentPanel
- 画布右下角新增悬浮按钮 → ChatPanel

后续可考虑合并，但当前分离更安全。

---

## 技术要点

### 流式输出
```typescript
// 利用已有的 aiProxy fetch 层，改为流式读取
const response = await fetch(url, { ...options, stream: true });
const reader = response.body.getReader();
// 逐 chunk 解析 SSE data 并回调
```

### 自动标题
- 第一条消息发送后，用 Chat 模型生成 ≤10 字的会话标题
- 异步执行，不阻塞对话

### 图片生成集成
- 输入区有「聊天」和「生图」两个模式 tab
- 生图模式下：输入框变为 prompt，发送后调用 Image 模型
- 生成的图片作为 assistant 消息插入聊天记录

### 图片可操作
- 聊天中生成的图片可以：
  - 点击放大预览
  - 拖拽到画布变成卡片
  - 保存到本地
