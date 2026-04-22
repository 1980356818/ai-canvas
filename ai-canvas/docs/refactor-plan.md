# AI 无限画布 — 架构重构计划

> **技术栈**: React 19 + Vite 6 + TypeScript + Tailwind CSS v4 + Zustand + Tauri 2
> **生成时间**: 2026-04-18
> **范围**: 仅 `src/` 前端代码，不涉及 `src-tauri/` Rust 后端

---

## 一、现状问题诊断

### 1.1 巨型文件 — `lib/tauri.ts`（933 行，12+ 职责）

这是目前最严重的架构问题。一个文件承担了：

| # | 职责 | 行数范围 |
|---|------|---------|
| 1 | Tauri API 懒加载 + 环境检测 | 1-19 |
| 2 | Browser fallback storage helpers | 21-53 |
| 3 | 类型定义（CardRow, TaskInfo, ModelInfo 等 10+ 个） | 55-111 |
| 4 | Project CRUD（7 个函数） | 112-282 |
| 5 | Card CRUD（3 个函数） | 284-330 |
| 6 | AI 代理（aiProxy, saveMedia, readMediaBase64） | 332-390 |
| 7 | SSE 流式代理（aiProxyStream, 150 行） | 395-547 |
| 8 | Gateway（listModels, pollTask, validateConnection） | 549-631 |
| 9 | Settings 存取 + API Key 迁移 | 633-676 |
| 10 | 文件选择对话框 | 678-687 |
| 11 | Tauri 原生文件拖放 | 689-722 |
| 12 | Viewport / Connection / Chat 持久化 | 724-911 |
| 13 | 剪贴板 | 913-930 |

**问题**: 修改任何一个领域都要打开这个 933 行文件，认知负担极高；无法独立测试和复用。

### 1.2 类型定义零散分布

类型分布在 **11 个不同文件** 中，没有统一的导入入口：

- `shared/types.ts` — 仅 1 行（`CardType`）
- `stores/*.ts` — 每个 Store 都内联定义自己的 interface
- `lib/tauri.ts` — CardRow, ConnectionRow, ChatSessionRow 等 DB 行类型
- `lib/chatService.ts` — ChatContentPart, Intent, ChatHistoryMessage
- `lib/dataFlow.ts` — OutputPayload
- `lib/history.ts` — UndoAction
- `agent/types.ts` — ContentPart, AgentMessage, ToolCall 等

**问题**: 找一个类型要猜在哪个文件；同一概念（如「内容片段」）在 chat 和 agent 中有不同定义，容易混淆。

### 1.3 重复代码

| 位置 | 重复内容 |
|------|---------|
| `App.tsx` 三处 | Connection → ConnectionRow 的字段映射（`c.sourceCardId → source_card_id` 等） |
| `autoSave.ts` + `App.tsx` | Card → CardRow 的字段映射 |
| `CanvasContainer.tsx` | browser file-drop 和 Tauri file-drop 逻辑 **几乎完全相同**（各 ~80 行） |
| `chatService.ts` | `generateImage` 和 `generateVideo` 的 task 轮询 + saveMedia 流程高度相似 |
| `services/tasks.ts` | `TERMINAL_STATUSES` 大小写重复（`"completed"` + `"COMPLETED"` 共 14 条） |
| `dataFlow.ts` | ai_image 和 ai_chat 的 ref image 注入逻辑重复 |

### 1.4 `App.tsx` 过重（272 行，6 个 useEffect）

根组件承担了太多「胶水逻辑」：

- 项目切换时的加载/保存/清理
- Connection 变更订阅 + 持久化
- Viewport 自动保存（debounce）
- Tauri 窗口关闭前保存
- `Ctrl+S` 快捷键
- Data flow watcher 生命周期

### 1.5 `CanvasContainer.tsx` 过重（720 行）

混合了：
- browser file-drop 处理（~110 行）
- Tauri file-drop 处理（~100 行）
- 鸟瞰模式切换逻辑
- Space 键 + 框选交互
- 右键菜单触发

### 1.6 `shared/constants.ts` 混杂（390 行）

将 **UI 常量**、**卡片默认值**、**完整的工作流模板**（包含超长 system prompt）全部塞在一个文件里。

### 1.7 其他问题

- **硬编码 API Key**：`lib/tauri.ts:665` 包含明文 `sk-V3CT...` 密钥
- **console.log 泛滥**：`aiProxyStream`、`dataFlow.ts` 中大量调试日志未清理
- **`services/` 层过薄**：仅 `models.ts` + `tasks.ts`，业务逻辑散落在 stores 和 lib 中
- **两套错误系统**：`lib/errors.ts`（friendlyError 函数）vs `agent/errors.ts`（AgentError 类），命名冲突
- **无 barrel exports**：feature 目录没有 `index.ts`，外部需要深路径导入

---

## 二、目标架构

```
src/
├── app/                        # 应用外壳（不变）
│   ├── TitleBar.tsx
│   └── ErrorBoundary.tsx
│
├── types/                      # 【新】统一类型定义层
│   ├── card.ts                 #   CanvasCard, CardType, CardRow, CardDefaults
│   ├── project.ts              #   ProjectInfo
│   ├── connection.ts           #   Connection, ConnectionRow, DraftWire, PendingDrop
│   ├── chat.ts                 #   ChatSession, ChatMessage, ChatContentPart, Intent
│   ├── agent.ts                #   AgentMessage, ToolCall, ToolDefinition, AgentContext...
│   ├── canvas.ts               #   Viewport, PickModeState, DragOffset
│   ├── ui.ts                   #   AppView, SaveStatus, ToastItem, CardGenProgress
│   ├── task.ts                 #   TaskInfo, TaskResult
│   ├── model.ts                #   ModelInfo
│   └── index.ts                #   barrel re-export
│
├── platform/                   # 【新】平台抽象层 — 拆分 tauri.ts
│   ├── runtime.ts              #   isTauri, ensureTauriAPIs()
│   ├── storage.ts              #   lsGet, lsSet, getBrowserApiConfig
│   ├── project.api.ts          #   listProjects, createProject, deleteProject...
│   ├── card.api.ts             #   loadCards, saveCardsBatch, deleteCard
│   ├── connection.api.ts       #   loadConnections, saveConnections...
│   ├── chat.api.ts             #   listChatSessions, createChatSession...
│   ├── ai.api.ts               #   aiProxy, aiProxyStream, listModels, pollTask
│   ├── media.api.ts            #   saveMedia, readMediaBase64
│   ├── settings.api.ts         #   getSetting, setSetting, hasApiKey, migrateApiConfig
│   ├── viewport.api.ts         #   saveProjectViewport, loadProjectViewport
│   ├── clipboard.api.ts        #   clipboardWriteText, clipboardReadText
│   ├── dialog.api.ts           #   pickDirectory
│   ├── file-drop.ts            #   onTauriFileDrop
│   └── index.ts                #   barrel re-export
│
├── services/                   # 【扩充】业务服务层（纯逻辑，无 UI）
│   ├── models.ts               #   （保留）模型列表 + 默认模型
│   ├── tasks.ts                #   （保留）waitForTask 轮询
│   ├── chat.service.ts         #   （从 lib/chatService.ts 迁入）
│   ├── generation.service.ts   # 【新】提取 generateImage + generateVideo 公共逻辑
│   └── index.ts
│
├── stores/                     # 状态管理（精简：只保留状态 + 简单 action）
│   ├── cardStore.ts            #   去掉内联 interface → import from types/
│   ├── canvasStore.ts
│   ├── projectStore.ts
│   ├── connectionStore.ts
│   ├── uiStore.ts
│   ├── settingsStore.ts
│   ├── chatStore.ts
│   ├── agentStore.ts
│   └── index.ts                # 【新】barrel export
│
├── hooks/                      # 【整合】全局 hooks
│   ├── useProjectLifecycle.ts  # 【新】从 App.tsx 抽出：项目切换加载/保存/清理
│   ├── useAutoSaveViewport.ts  # 【新】从 App.tsx 抽出：viewport debounce 保存
│   ├── useConnectionSync.ts    # 【新】从 App.tsx 抽出：connection 变更订阅
│   ├── useBeforeUnload.ts      # 【新】从 App.tsx 抽出：关闭前保存
│   ├── useGlobalShortcuts.ts   # 【新】从 App.tsx 抽出：Ctrl+S 等
│   ├── useImageRefSources.ts   #   （保留）
│   └── useFileDrop.ts          # 【新】从 CanvasContainer 抽出：统一 browser+Tauri 拖放
│
├── lib/                        # 纯工具函数（无业务语义）
│   ├── errors.ts               #   friendlyError（保留）
│   ├── utils.ts                #   cn()（保留）
│   ├── media.ts                #   persistImage, getDisplayUrl...（保留）
│   ├── heicConverter.ts        #   （保留）
│   ├── clipboard.ts            #   （保留）
│   ├── autoSave.ts             #   （保留，但去掉重复的 cardToRow）
│   ├── history.ts              #   （保留）
│   ├── dataFlow.ts             #   （保留，抽取 refImage 注入公共逻辑）
│   ├── connectionRecovery.ts   #   （保留）
│   ├── templateFactory.ts      #   （保留）
│   ├── promptSerializer.ts     #   （保留）
│   ├── canvas-renderer.ts      #   （保留）
│   ├── imagePreloader.ts       #   （保留）
│   ├── spatial-index.ts        #   （保留）
│   └── mappers.ts              # 【新】统一的 Row ↔ Domain 映射函数
│
├── config/                     # 配置
│   ├── model-ref-images.ts     #   （保留）
│   └── workflows.ts            # 【新】从 constants.ts 拆出工作流模板
│
├── shared/                     # 跨层共享（精简）
│   ├── constants.ts            #   只保留纯常量（CARD_MAX_EDGE, MIN_ZOOM 等）
│   └── MarkdownContent.tsx     #   （保留）
│
├── features/                   # 功能模块（结构基本不变，微调）
│   ├── home/
│   ├── projects/
│   ├── canvas/
│   │   ├── CanvasContainer.tsx  #  精简到 ~300 行
│   │   ├── hooks/               #  （保留 useViewport, useSelection 等）
│   │   └── ...
│   ├── cards/
│   ├── editor/
│   ├── chat/
│   ├── agent/
│   ├── overlays/
│   └── sidebar/
│
├── agent/                      # Agent 运行时（结构不变）
│   ├── types.ts                #  → 类型迁入 types/agent.ts，此文件改为 re-export
│   ├── errors.ts               #  → 改名 AgentError 以区分 lib/errors.ts
│   └── ...
│
├── App.tsx                     # 精简到 ~80 行
├── main.tsx
└── main.css
```

---

## 三、详细执行步骤

### Phase 1: 类型统一（低风险，高收益）

**目标**: 建立 `src/types/` 目录，集中所有类型定义，各模块改为 import from `@/types`。

#### 步骤 1.1: 创建 `types/` 目录及文件

从以下位置提取类型（**不删除原定义，先用 re-export 过渡**）：

| 新文件 | 提取来源 |
|--------|---------|
| `types/card.ts` | `shared/types.ts` → CardType<br>`stores/cardStore.ts` → CanvasCard<br>`lib/tauri.ts` → CardRow<br>`shared/constants.ts` → CardDefaults, ImageSizeOption |
| `types/project.ts` | `stores/projectStore.ts` → ProjectInfo |
| `types/connection.ts` | `stores/connectionStore.ts` → Connection, DraftWire, PendingDrop, PortSide<br>`lib/tauri.ts` → ConnectionRow |
| `types/chat.ts` | `stores/chatStore.ts` → ChatSession, ChatMessage<br>`lib/chatService.ts` → ChatContentPart, Intent, IntentResult, ChatServiceCallbacks, ChatHistoryMessage<br>`lib/tauri.ts` → ChatSessionRow, ChatMessageRow |
| `types/canvas.ts` | `stores/canvasStore.ts` → Viewport, PickModeState, DragOffset |
| `types/ui.ts` | `stores/uiStore.ts` → AppView, SaveStatus, ToastItem, CardGenProgress, CardGenSubProgress |
| `types/task.ts` | `lib/tauri.ts` → TaskInfo<br>`services/tasks.ts` → TaskResult |
| `types/model.ts` | `lib/tauri.ts` → ModelInfo |
| `types/agent.ts` | `agent/types.ts` → 全部（ContentPart, AgentMessage, ToolCall 等） |
| `types/index.ts` | barrel re-export |

#### 步骤 1.2: 渐进式迁移导入路径

旧文件改为 re-export，确保 0 breaking change：

```typescript
// stores/cardStore.ts（过渡期）
export type { CanvasCard, CardType } from "@/types";
```

#### 步骤 1.3: 全量替换导入路径

用 IDE 批量将 `import { CanvasCard } from "@/stores/cardStore"` 改为 `import type { CanvasCard } from "@/types"`。

完成后删除各旧文件中的 re-export。

---

### Phase 2: 拆分 `lib/tauri.ts`（最核心改动）

**目标**: 将 933 行拆为 12 个单职责文件，放入 `src/platform/`。

#### 步骤 2.1: 创建 `platform/runtime.ts` — 公共基础

```typescript
export const isTauri = typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

let _invoke: typeof import("@tauri-apps/api/core").invoke;
let _listen: typeof import("@tauri-apps/api/event").listen;

export async function ensureTauriAPIs() { ... }
export function getInvoke() { return _invoke; }
export function getListen() { return _listen; }
```

#### 步骤 2.2: 创建 `platform/storage.ts` — Browser fallback

```typescript
const LS_PREFIX = "ai_canvas_";
export function lsGet<T>(key: string, fallback: T): T { ... }
export function lsSet(key: string, value: unknown) { ... }
export function getBrowserApiConfig() { ... }
export function buildProxyUrl(endpoint: string) { ... }
export function getAuthHeaders() { ... }
```

#### 步骤 2.3: 按领域拆分 API 文件

| 文件 | 包含函数 |
|------|---------|
| `platform/project.api.ts` | listProjects, createProject, deleteProject, listDeletedProjects, restoreProject, permanentlyDeleteProject, renameProject, updateProjectMeta |
| `platform/card.api.ts` | loadCards, saveCardsBatch, deleteCard |
| `platform/connection.api.ts` | loadConnections, saveConnections, clearProjectConnections |
| `platform/chat.api.ts` | listChatSessions, createChatSession, renameChatSession, deleteChatSession, loadChatMessages, saveChatMessage, clearChatMessages |
| `platform/ai.api.ts` | aiProxy, aiProxyStream, listModels, pollTask, validateConnection, normalizeTaskInfo |
| `platform/media.api.ts` | saveMedia, readMediaBase64 |
| `platform/settings.api.ts` | getSetting, setSetting, hasApiKey, invalidateApiKeyCache, migrateApiConfig |
| `platform/viewport.api.ts` | saveProjectViewport, loadProjectViewport, removeProjectViewport |
| `platform/clipboard.api.ts` | clipboardWriteText, clipboardReadText |
| `platform/dialog.api.ts` | pickDirectory |
| `platform/file-drop.ts` | onTauriFileDrop |

#### 步骤 2.4: 创建 `platform/index.ts` barrel export

保持所有外部导入路径 `from "@/lib/tauri"` 可以先改为 `from "@/platform"`，逐步替换。

#### 步骤 2.5: 过渡期保留 `lib/tauri.ts` 作为 re-export

```typescript
// lib/tauri.ts（过渡期 — 最终删除）
export * from "@/platform";
```

---

### Phase 3: 提取公共映射函数 — 消除重复

**目标**: 创建 `lib/mappers.ts`，消除 Card/Connection Row 映射的重复代码。

#### 步骤 3.1: 创建 `lib/mappers.ts`

```typescript
import type { CanvasCard } from "@/types";
import type { CardRow, ConnectionRow } from "@/types";
import type { Connection } from "@/types";

export function cardToRow(card: CanvasCard): CardRow { ... }
export function rowToCard(row: CardRow): CanvasCard { ... }
export function connectionToRow(conn: Connection): ConnectionRow { ... }
export function rowToConnection(row: ConnectionRow): Connection { ... }
```

#### 步骤 3.2: 替换所有内联映射

- `App.tsx` 中 3 处 Connection 映射 → `connectionToRow()`
- `App.tsx` 中 Card 加载映射 → `rowToCard()`
- `autoSave.ts` 中 `cardToRow()` → import from mappers
- `chatStore.ts` 中 `rowToSession()` / `messageToRow()` → 可保留或迁入

---

### Phase 4: 精简 `App.tsx`（从 272 行 → ~80 行）

**目标**: 将 6 个 `useEffect` 各自抽为独立 hook。

#### 步骤 4.1: 创建 hooks

| Hook | 提取的逻辑 | 原 App.tsx 行数 |
|------|-----------|---------------|
| `useProjectLifecycle` | 项目切换时的加载/保存/清理 + data flow watcher | ~55-136 |
| `useConnectionSync` | Connection 变更订阅 + 持久化 | ~138-167 |
| `useAutoSaveViewport` | Viewport debounce 保存 | ~170-186 |
| `useBeforeUnload` | 关闭前保存（Tauri + browser） | ~190-229 |
| `useGlobalShortcuts` | Ctrl+S 保存 | ~231-246 |

#### 步骤 4.2: 精简后的 App.tsx

```tsx
export default function App() {
  const appView = useUIStore((s) => s.appView);
  const agentPanelVisible = useUIStore((s) => s.agentPanelVisible);
  const chatPanelVisible = useUIStore((s) => s.chatPanelVisible);

  useProjectLifecycle();
  useConnectionSync();
  useAutoSaveViewport();
  useBeforeUnload();
  useGlobalShortcuts();
  useKeyboardShortcuts();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TitleBar />
      <ErrorBoundary>
        {appView === "home" ? (
          <HomePage />
        ) : appView === "projects" ? (
          <ProjectsPage />
        ) : (
          <div className="relative flex flex-1 overflow-hidden">
            <CanvasContainer />
            <SidebarContainer />
            {agentPanelVisible && <AgentPanel />}
            {chatPanelVisible && <ChatPanel />}
          </div>
        )}
      </ErrorBoundary>
      <SideCapsule />
      <Toast />
      <ContextMenu />
      <SettingsDialog />
    </div>
  );
}
```

---

### Phase 5: 精简 `CanvasContainer.tsx`（从 720 行 → ~300 行）

**目标**: 将 file-drop 逻辑统一抽取到 `hooks/useFileDrop.ts`。

#### 步骤 5.1: 创建 `hooks/useFileDrop.ts`

将 browser file-drop 和 Tauri file-drop 合并为一个 hook：

```typescript
export function useFileDrop(
  containerRef: RefObject<HTMLDivElement>,
  screenToCanvas: (x: number, y: number) => { x: number; y: number },
) {
  // 统一的 file drop 逻辑
  // 返回 { handleDragOver, handleDragLeave, handleDrop }
}
```

**关键**: 两套 drop 逻辑的核心（解析文件 → persistImage → 创建 Card）完全一致，只是**输入源**不同（`File[]` vs `string[]`），可以抽出共同的 `createCardsFromMedia()` 函数。

#### 步骤 5.2: 抽取鸟瞰模式逻辑

创建 `features/canvas/hooks/useBirdView.ts`：

```typescript
export function useBirdView(zoom: number) {
  // 返回 { isBirdView, showDom, showCanvas, transitioning }
}
```

---

### Phase 6: 拆分 `shared/constants.ts`

#### 步骤 6.1: 拆分为 3 个文件

| 新文件 | 内容 |
|--------|------|
| `shared/constants.ts` | 纯数值常量：`CARD_MAX_EDGE`, `MIN_ZOOM`, `MAX_ZOOM`, `BIRDVIEW_*`, `IMAGE_SIZE_OPTIONS`, `CARD_DEFAULTS`, `TYPE_COLORS`, `CARD_COLOR_PRESETS`, `sizeFromRatio()`, `normalizeImageSize()` |
| `config/workflows.ts` | `WORKFLOW_TEMPLATES`（含超长 system prompt 的工作流模板，~220 行） |
| `config/quick-create.ts` | `QuickCreateItem` 和相关配置（如果存在引用） |

---

### Phase 7: 提取生成服务公共逻辑

**目标**: `chatService.ts` 中 `generateImage` 和 `generateVideo` 有大量相似的 taskId 轮询 + saveMedia 流程。

#### 步骤 7.1: 创建 `services/generation.service.ts`

```typescript
export async function submitAndWaitForResult(
  endpoint: string,
  body: Record<string, unknown>,
  onProgress?: (progress: number, status: string) => void,
): Promise<{ url: string }> {
  // 公共逻辑：发请求 → 解析 taskId → waitForTask → saveMedia
}
```

#### 步骤 7.2: 精简 `generateImage` / `generateVideo`

两个函数调用 `submitAndWaitForResult`，只需关注各自的参数差异。

---

### Phase 8: 清理与加固

#### 8.1 移除硬编码密钥

~~`COMFLY_API_KEY` 已从代码中移除。~~ API Key 不再打包在程序中，完全由用户在设置界面配置，存储在本地 SQLite 数据库。

#### 8.2 清理 console.log

以下文件需清理调试日志：

- `platform/ai.api.ts`（原 `tauri.ts` 的 `aiProxyStream` 部分）— 约 15 条 console.log
- `lib/dataFlow.ts` — 约 12 条 console.log

**策略**: 保留 `console.error` 和 `console.warn`，将 `console.log` 替换为条件开关：

```typescript
const DEBUG = import.meta.env.DEV;
if (DEBUG) console.log("[Stream] ...");
```

#### 8.3 统一 `TERMINAL_STATUSES`

```typescript
// before: 14 条，大小写重复
const TERMINAL_STATUSES = new Set(["completed", "COMPLETED", ...]);

// after: 标准化为小写比较
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "error", "success", "succeeded", "expired"]);

function isTerminal(status: string) {
  return TERMINAL_STATUSES.has(status.toLowerCase());
}
```

#### 8.4 统一错误系统命名

- `lib/errors.ts` → 保持 `friendlyError()`（API 错误文案转换）
- `agent/errors.ts` → 保持 `AgentError` 类（Agent 运行时错误）
- 两者职责清晰不同，**不合并**，但在 `types/` 中为 `AgentErrorCode` 建立 re-export，避免导入混乱

---

## 四、执行优先级与风险评估

| 优先级 | Phase | 改动量 | 风险 | 收益 |
|--------|-------|--------|------|------|
| P0 | Phase 8.1 移除硬编码密钥 | 极小 | 低 | **安全** |
| P1 | Phase 1 类型统一 | 中 | 低（re-export 过渡） | 高 — 开发体验 |
| P1 | Phase 3 公共映射函数 | 小 | 低 | 中 — 消除重复 |
| P2 | Phase 2 拆分 tauri.ts | 大 | 中（核心模块） | **极高** — 可维护性 |
| P2 | Phase 4 精简 App.tsx | 中 | 低 | 高 — 可读性 |
| P3 | Phase 5 精简 CanvasContainer | 中 | 中 | 高 — 可维护性 |
| P3 | Phase 6 拆分 constants.ts | 小 | 低 | 中 — 清晰度 |
| P3 | Phase 7 生成服务 | 小 | 低 | 中 — 消除重复 |
| P4 | Phase 8.2-8.4 清理 | 小 | 低 | 低 — 代码卫生 |

---

## 五、执行原则

1. **每个 Phase 可独立提交** — 不存在跨 Phase 的依赖
2. **re-export 过渡** — 拆分/迁移时先保留旧路径的 re-export，全量替换后再删除
3. **不删不确定的代码** — 如果某个函数不确定是否还有引用，保留不删
4. **不改功能** — 本次重构只改结构，不改逻辑
5. **每个 Phase 完成后运行 `tsc --noEmit` + `eslint`** 确保无类型错误

---

## 六、不改动的部分

以下部分当前结构合理，**不在本次重构范围内**：

- `features/` 内各功能模块的组件划分（已经按 feature 组织）
- `agent/` 的 provider/tool/runtime 架构（设计良好）
- `stores/` 的 Zustand 使用方式（单文件单 store，清晰）
- `src-tauri/` Rust 后端
- CSS / Tailwind 配置
- Vite / ESLint 配置
