# AI 无限画布 - 个人本地版优化计划

> 定位：纯本地个人工具，不需要后端/管理端/VIP/注册码/云同步。
> 原则：只做自己用得到的功能，砍掉一切花架子。

---

## 砍掉的东西

以下设计文档中规划的功能**全部不做**，理由统一：个人本地使用不需要。

| 砍掉 | 理由 |
|------|------|
| Spring Boot 后端 | 没有用户，不需要服务器 |
| 管理后台 | 没有用户要管理 |
| VIP 等级 / 注册码 | 只有自己用 |
| 云端同步 | 本地 SQLite 够了 |
| JWT 认证 / 登录注册 | 没有用户系统 |
| PixiJS 双层渲染 | 个人用不可能有 500+ 卡片，DOM 方案够用 |
| R-tree 空间索引 | 同上，JS 遍历足够 |
| LOD 分级渲染 | 同上 |
| 视频卡片 | 复杂度极高，ROI 低，视频用专业工具 |
| 小地图 Minimap | 个人画布不至于迷路 |
| 演示模式 | 不给别人演示 |
| 画布书签 / 导航 | 过度设计 |
| 卡片连接线 | 不是工作流工具 |
| 画框 / 卡片分组 | 暂不需要 |
| 多标签页画布 | 复杂度高，收益低 |
| 卡片模板系统 | 过度设计 |
| 快速笔记弹窗 | 直接在画布上建便签就行 |
| 性能监控面板 | 开发调试用浏览器 DevTools |
| 项目导出/导入 (.aicvs) | 直接备份 SQLite 文件 |
| 多 Tab 侧边栏 (书签/大纲/搜索) | 先做好项目面板就够 |
| 自动更新 | 自己编译自己装 |
| Sentry 崩溃上报 | 看控制台 |
| AES-256 加密 API Key | 自己电脑不需要加密，安全威胁不成立 |

---

## 当前已完成的功能

以下已经在代码里实现了，不需要重做：

| 功能 | 文件 | 状态 |
|------|------|------|
| 画布平移/缩放/点阵背景 | `CanvasContainer.tsx`, `useViewport.ts` | ✅ 完整 |
| 视口裁剪 | `CanvasContainer.tsx` visibleCards | ✅ JS 遍历够用 |
| 卡片拖拽/缩放/层级/选中 | `CardShell.tsx` | ✅ 完整 |
| 项目 CRUD + 侧边栏 | `ProjectPanel.tsx`, `project.rs` | ✅ 完整 |
| 自动保存 (增量) | `autoSave.ts` | ✅ 完整 |
| SQLite 持久化 + 迁移 | `migrations.rs`, `project.rs` | ✅ 完整 |
| 右键菜单 (画布/卡片/多选) | `ContextMenu.tsx` | ✅ 完整 |
| API 设置对话框 | `SettingsDialog.tsx` | ✅ 完整 |
| Toast 通知 | `Toast.tsx` | ✅ 完整 |
| Rust AI HTTP 代理 | `ai.rs` | ✅ 支持 OpenAI/Anthropic |
| 模型列表拉取 + 连通测试 | `gateway.rs` | ✅ 完整 |
| 媒体文件下载/保存 | `ai.rs` save_media | ✅ URL/Base64/本地文件 |
| Agent 运行时 (Tool Calling) | `runtime.ts` | ✅ 完整循环 |
| OpenAI Provider | `openai.ts` | ✅ Chat + 生图 |
| AI 工具集 (4 个) | `tools/` | ✅ 生图/分析图/生文本/画布操作 |
| ChatEditor (输入+发送+选模型) | `ChatEditor.tsx` | ✅ 完整 |
| FloatingEditor (卡片下方浮层) | `FloatingEditor.tsx` | ✅ 完整 |
| 双击画布快速创建 | `QuickCreateMenu.tsx` | ✅ 完整 |
| 主题切换 (浅/深/系统) | `settingsStore.ts` | ✅ 完整 |
| 框选多选 | `useSelection.ts` | ✅ 完整 |
| Ctrl+S 手动保存 | `App.tsx` | ✅ 完整 |

---

## 要做的事

分两轮：第一轮修好核心体验，第二轮补缺。

### 第一轮：修好核心体验（预估 5-7 天）

这些是"能正常用"的基本要求。

#### 1. AI 对话流式输出

**现状**：`ChatEditor.tsx` 调用 `provider.chat()` 是非流式的，用户点发送后要等整个回复生成完才能看到，几秒到几十秒的白等。

**改法**：
- Rust 侧 `ai.rs` 新增 `ai_proxy_stream` Command，用 reqwest SSE 流读取，通过 Tauri Event 逐 chunk 推送给前端
- 前端 `ChatEditor.tsx` 监听 `ai-stream-{id}` 事件，逐 token 追加到 assistant 消息
- 显示打字机效果
- 加"停止生成"按钮（前端发 abort 事件，Rust 取消 tokio task）

**涉及文件**：
- `src-tauri/src/commands/ai.rs` — 新增 stream command
- `src-tauri/src/lib.rs` — 注册新 command
- `src/features/editor/ChatEditor.tsx` — 改为流式接收
- `src/agent/providers/openai.ts` — 可选：Agent 也改流式

**优先级**：P0 — 这是对话体验的生死线

#### 2. Markdown 渲染

**现状**：`ChatEditor.tsx` 和 `AIChatCard.tsx` 都是 `<p className="whitespace-pre-wrap">{msg.content}</p>`，AI 回复的代码块、列表、表格全是纯文本显示。

**改法**：
- 安装 `react-markdown` + `rehype-highlight`（或 `remark-gfm`）
- 封装一个 `<MarkdownContent content={text} />` 组件
- 替换 ChatEditor 和 AIChatCard 中的纯文本渲染
- 加代码块复制按钮

**涉及文件**：
- 新建 `src/shared/MarkdownContent.tsx`
- `src/features/editor/ChatEditor.tsx` — 用 MarkdownContent 替换纯文本
- `src/features/cards/AIChatCard.tsx` — 同上

**优先级**：P0 — AI 回复没有 Markdown 渲染基本不能看

#### 3. 卡片内容组件补全

**现状**：
- `AIChatCard.tsx` — 只展示消息列表的缩略预览，OK
- `TextCard.tsx` / `StickyNoteCard.tsx` — 需要确认实际实现
- `CardContent.tsx` — 负责按 card.type 分发，需确认

**改法**：
- `TextCard` — 纯文本显示 `card.data.content`，点击后 FloatingEditor 里用 TextEditor 编辑
- `StickyNoteCard` — 直接在卡片内显示彩色便签文本
- `AIChatCard` — 保持当前缩略预览即可（详细交互走 FloatingEditor）
- 确认 `EditorSwitch.tsx` 能按 card.type 正确路由到对应 Editor

**涉及文件**：
- `src/features/cards/TextCard.tsx`
- `src/features/cards/StickyNoteCard.tsx`
- `src/features/cards/CardContent.tsx`
- `src/features/editor/TextEditor.tsx`
- `src/features/editor/EditorSwitch.tsx`

**优先级**：P0 — 卡片不显示内容等于空壳

#### 4. 快捷键补全

**现状**：只有 `Ctrl+S` 保存。

**改法**：
- `Delete` / `Backspace` — 删除选中卡片
- `Ctrl+Z` — 撤销（第一轮先做简易版，见下文）
- `Ctrl+C` / `Ctrl+V` — 复制粘贴卡片（右键菜单里已有逻辑，挂到全局快捷键）
- `Ctrl+A` — 全选当前项目卡片
- `Space + 拖拽` — 画布平移（检查 useViewport 是否已支持）
- `Esc` — 取消选中 / 关闭浮层

在 `App.tsx` 或单独的 `useKeyboardShortcuts` Hook 里统一管理。

**涉及文件**：
- `src/App.tsx` 或新建 `src/features/canvas/hooks/useKeyboardShortcuts.ts`

**优先级**：P1 — 没有 Delete 键删卡片太蠢了

#### 5. 简易撤销/重做

**现状**：完全没有。

**改法**：
- **不搞设计文档里那套 Command 模式+持久化**，太重了
- 用最简单的"状态快照"方式：每次卡片变更前，把变更前的状态 push 到 undo 栈
- 只记录卡片级操作：创建、删除、移动、缩放、内容修改
- 内存中保留最近 50 步，不持久化到 SQLite
- 切换项目时清空

实现方式：
```typescript
// undoStack: Array<{ type: string, data: any }>
// 例如删除卡片时：push({ type: 'delete', card: 完整卡片数据 })
// 撤销时：重新 addCard(card)
```

**涉及文件**：
- 新建 `src/lib/history.ts` — 简易 undo/redo 管理器
- `src/features/overlays/ContextMenu.tsx` — 删除操作集成 undo
- `src/features/cards/CardShell.tsx` — 移动/缩放集成 undo

**优先级**：P1 — 误删卡片无法恢复很痛苦

#### 6. 进入画布的路径优化

**现状**：
- 主页 (HomePage) → 侧边栏选项目 → 进入画布
- `appView` 状态控制 "home" / "canvas" 切换
- 需确认：选项目后是否自动跳转到画布视图

**改法**：
- 确保 `setCurrentProjectId` 后自动 `setAppView("canvas")`
- 确保从画布回主页有明确入口
- 画布里无项目时显示引导："双击创建卡片" 或 "右键新建"

**涉及文件**：
- `src/stores/projectStore.ts` 或 `src/App.tsx`

**优先级**：P1

---

### 第二轮：补缺提升（预估 4-5 天）

这些是"用得舒服"的提升。

#### 7. AI 图片卡片完善

**现状**：Agent 工具 `generate_image` 可以生图并创建卡片，但 `AIImageCard` 组件（如果存在的话）和图片展示需要确认。

**改法**：
- 卡片内显示图片缩略图 + prompt 文字
- FloatingEditor 里的 MediaEditor 支持查看大图、重新生成、修改 prompt
- 图片用 `convertFileSrc()` 把本地路径转为 Tauri asset URL 显示

**涉及文件**：
- `src/features/editor/MediaEditor.tsx`
- `src/features/cards/CardContent.tsx` — 图片卡片渲染

**优先级**：P1

#### 8. 卡片颜色标记

**现状**：右键菜单里没有颜色标记选项，但 `CardShell` 已经读取 `card.color` 并用作边框渐变色。

**改法**：
- 在右键菜单（单卡片）中加"颜色标记"子菜单
- 6-8 种预设颜色 + "无色"选项
- 点击后 `updateCard(id, { color })` + `autoSave.markDirty()`

**涉及文件**：
- `src/features/overlays/ContextMenu.tsx`
- `src/shared/constants.ts` — 预设色板

**优先级**：P2

#### 9. 卡片搜索

**现状**：没有搜索功能。

**改法**：
- `Ctrl+F` 打开搜索浮层
- 前端内存搜索（卡片标题 + card.data.content），不搞 FTS5
- 搜索结果列表，点击后画布飞行定位到目标卡片
- 飞行定位：计算目标卡片中心坐标，`setViewport` 让画布滚动到该位置

**涉及文件**：
- 新建 `src/features/overlays/SearchDialog.tsx`
- `src/App.tsx` — Ctrl+F 快捷键

**优先级**：P2

#### 10. 拖拽导入图片

**现状**：不支持外部文件拖入画布。

**改法**：
- 在 `CanvasContainer.tsx` 加 `onDragOver` + `onDrop` 事件
- 检测拖入文件类型，图片文件 → 调 `save_media` 保存到本地 → 创建 `ai_image` 卡片
- 文本文件 → 读取内容 → 创建 `text` 卡片

**涉及文件**：
- `src/features/canvas/CanvasContainer.tsx`

**优先级**：P2

#### 11. 对话上下文附图（Vision）

**现状**：Agent 的 `ContentPart` 类型已支持 image，OpenAI provider 的 `contentToOpenAI` 也能处理 `image_url`。但 ChatEditor UI 没有附图入口。

**改法**：
- ChatEditor 输入框旁加一个"附图"按钮
- 点击后打开文件选择器（Tauri dialog），选图片
- 图片存到 media/ 目录，消息 content 加 image part
- 发送时 provider 自动带上图片

**涉及文件**：
- `src/features/editor/ChatEditor.tsx`

**优先级**：P2 — Vision 能力是很实用的个人功能

#### 12. 多 Provider 支持

**现状**：只有 OpenAI provider，但 Rust 侧 `ai.rs` 已经按 provider 名称区分了 Anthropic 头部格式。

**改法**：
- 设置对话框改为支持多个 Provider 配置（OpenAI / Anthropic / 自定义 OpenAI 兼容）
- settings 表存 `{provider}_api_key` 和 `{provider}_base_url`（已有此模式）
- 模型选择器按 Provider 分组显示
- 不搞 Provider 管理 UI 的过度设计，就一个设置页面列出几个主流平台的 Key 输入框

**涉及文件**：
- `src/features/overlays/SettingsDialog.tsx` — 改为多 Provider 配置
- `src/agent/providers/` — 按需加 Anthropic provider（如果与 OpenAI 兼容可能不需要）

**优先级**：P2 — 按实际使用的 AI 平台决定

---

## 不做但保留架构能力的东西

这些**当前不实现**，但代码架构不要堵死：

| 功能 | 保留什么 |
|------|---------|
| 更多 AI Provider | `ProviderManager` 的 register 模式已经支持，随时加 |
| 更多卡片类型 | `CardContent` + `EditorSwitch` 的分发模式已支持，随时加 |
| 更多 Agent 工具 | `ToolRegistry.register()` 模式已支持，随时加 |
| 导出 PNG | 未来可加，不影响当前架构 |
| 数据备份 | 直接复制 `%APPDATA%/ai-canvas/data.db` 就是完整备份 |

---

## 开发顺序建议

```
第一轮（优先级 P0 + P1，5-7 天）
  ├─ 1. 流式输出          3天 (Rust SSE + 前端监听 + 停止按钮)
  ├─ 2. Markdown 渲染     0.5天
  ├─ 3. 卡片内容补全      1天 (TextCard + StickyNote + EditorSwitch 路由)
  ├─ 4. 快捷键补全        0.5天
  ├─ 5. 简易撤销/重做     1天
  └─ 6. 路径优化          0.5天

第二轮（优先级 P2，按需做，4-5 天）
  ├─ 7. 图片卡片完善      1天
  ├─ 8. 卡片颜色标记      0.5天
  ├─ 9. 搜索              1天
  ├─ 10. 拖拽导入         0.5天
  ├─ 11. 对话附图         1天
  └─ 12. 多 Provider      1天
```

---

## 总结

这个项目的架构和基础设施**已经很扎实了**。SQLite 持久化、自动保存、Agent 系统、卡片系统的骨架都已经到位。

当前最大的问题不是缺功能，而是**核心功能的最后一公里没走完**：
- AI 对话没有流式输出 → 体验差
- AI 回复没有 Markdown 渲染 → 看不了
- 卡片内容组件没有补全 → 空壳子
- 没有快捷键和撤销 → 操作别扭

把第一轮 6 件事做完，这个工具就**能正式自用**了。
