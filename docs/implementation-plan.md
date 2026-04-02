# AI 无限画布 - 实施计划

> 原则：先做纯本地桌面端，验证核心画布 + AI 体验；后端/管理端延后到有真实用户需求时再启动。

---

## 技术选型

| 层级 | 组件 | 选型 | 理由 |
|------|------|------|------|
| 桌面框架 | Shell | Tauri 2.x | 无 CORS、包体小(~10MB)、Rust 原生性能 |
| 原生层 | 系统能力 | Rust | AI 代理、数据库、图片处理、空间索引、加密 |
| 前端框架 | UI | React 19 + TypeScript | 画布生态最强，PixiJS/Konva 均有 React 绑定 |
| 构建工具 | 打包 | Vite 6 | 快速 HMR，Tauri 官方推荐 |
| 状态管理 | Store | Zustand | 轻量、性能好、适合画布高频更新 |
| 样式 | UI 组件 | Tailwind CSS 4 + shadcn/ui | 快速搭建现代 UI |
| 画布渲染 | WebGL | PixiJS 8 | 硬件加速，万级 Sprite 不卡顿 |
| **本地数据库** | **持久化** | **SQLite (rusqlite + WAL)** | **ACID 事务、增量写入、分页查询、崩溃安全、FTS5 全文搜索** |
| 加密 | API Key | AES-256-GCM (aes-gcm crate) | 安全隔离，独立加密文件 |
| AI 网络 | HTTP | reqwest + tokio | Rust 原生异步 HTTP + SSE 流 |

> 不使用 IndexedDB / Dexie.js。所有结构化数据走 SQLite，由 Rust 统一管理。

---

## 存储架构

```
%APPDATA%/ai-canvas/
├── data.db                 # SQLite 数据库（项目、卡片、消息、任务、设置）
├── providers.enc           # API Key 加密文件（安全隔离，不入数据库）
└── media/                  # 二进制文件（不入数据库，只存引用路径）
    ├── images/             #   AI 生成的图片 / 用户导入的图片
    ├── videos/             #   AI 生成的视频
    └── thumbnails/         #   缩略图缓存（可重新生成）
```

### SQLite 表设计（概念层）

| 表 | 存什么 | 为什么独立 |
|---|--------|-----------|
| **projects** | 项目元数据（标题、创建时间、卡片数、缩略图路径） | 项目列表查询不需要加载画布数据 |
| **cards** | 卡片主数据（类型、位置、尺寸、zIndex、锁定、折叠、颜色；非对话的内容用 JSON 字段） | 按项目过滤，增量更新单个卡片不影响其他 |
| **messages** | AI 对话消息（角色、内容、token 数、时间戳） | 与卡片一对多，支持分页加载、全文搜索 |
| **tasks** | 异步任务（视频生成等：taskId、状态、进度） | 跨项目的任务队列，应用重启后可恢复轮询 |
| **history** | 操作历史（撤销/重做用） | 可持久化，重启后仍可撤销 |
| **settings** | 全局设置（Key-Value） | 简单键值存取 |

### 什么不放 SQLite

| 数据 | 存哪 | 为什么 |
|------|------|--------|
| API Key | `providers.enc` 加密文件 | 安全隔离，避免数据库文件泄露即暴露密钥 |
| 图片/视频文件 | `media/` 文件系统 | 二进制大文件，数据库只存路径引用 |
| 缩略图 | `media/thumbnails/` | 缓存性质，可随时由 Rust image crate 重新生成 |

### 数据库版本迁移

应用升级时 Schema 可能变更，通过版本号管理迁移：
- `data.db` 内有 `PRAGMA user_version` 记录当前版本
- 应用启动时检查版本号，按序执行迁移脚本
- 迁移在事务中执行，失败则回滚，不破坏现有数据

---

## 阶段总览

```
v0.1 MVP          v0.2 多卡片        v0.3 性能与完善     v0.5 用户体系      v1.0 正式发布
 5-7 周             3-4 周              3-4 周             6-8 周             6-8 周
┌──────────┐     ┌──────────┐       ┌──────────┐       ┌──────────┐      ┌──────────┐
│ 画布核心  │────>│ 图片卡片  │─────>│ R-tree   │─────>│ 后端认证  │────>│ 管理后台  │
│ 卡片系统  │     │ 文本便签  │      │ LOD 渲染  │      │ VIP 体系  │     │ 云端同步  │
│ AI 对话   │     │ 图片资源  │      │ 视频卡片  │      │ 注册码    │     │ 自动更新  │
│ API 配置  │     │ 更多适配器│      │ 框选多选  │      │ 云端存储  │     │ 公测发布  │
│ SQLite    │     │ Inspector │      │ 小地图    │      │           │     │           │
│ 撤销重做  │     │           │      │ 导出 PNG  │      │           │     │           │
└──────────┘     └──────────┘       └──────────┘       └──────────┘      └──────────┘
 纯本地，零服务器    纯本地              纯本地            引入后端            三端齐全
```

---

## v0.1 MVP — 能用（5-7 周）

目标：跑通"在画布上和 AI 对话"这个核心循环，纯本地，零服务器依赖。

### Phase 0: 工程脚手架（3天）

| # | 任务 | 产出 | 说明 |
|---|------|------|------|
| 0.1 | Tauri 2 + React 19 + Vite 6 项目初始化 | 可运行的空窗口 | `npm create tauri-app` |
| 0.2 | TypeScript + ESLint + Prettier 配置 | 统一代码规范 | strict 模式 |
| 0.3 | Tailwind CSS 4 + shadcn/ui 接入 | 基础 UI 组件可用 | |
| 0.4 | Zustand Store 骨架 | `canvasStore` / `cardStore` / `aiStore` / `projectStore` / `settingsStore` | 空 store，定义好类型 |
| 0.5 | Tauri 自定义标题栏 + 窗口状态持久化 | 无系统标题栏，记住窗口大小/位置/最大化状态 | `decorations: false` |
| 0.6 | 目录结构搭建 | 按架构文档组织 `src/` 和 `src-tauri/` | |
| 0.7 | Rust 依赖初始化 | Cargo.toml 配好所有基础依赖 | `rusqlite`, `reqwest`, `serde`, `aes-gcm`, `uuid`, `image`, `rstar`, `tokio` |
| 0.8 | SQLite 初始化 + 迁移系统 | 应用首次启动时创建 `data.db`，建表；启动时检查版本号执行迁移 | WAL 模式 |
| 0.9 | Rust 侧数据库访问层 | 封装 CRUD 操作：projects / cards / messages / settings | 统一错误处理 |

### Phase 1: 无限画布核心（8-10天）

这是整个项目最高风险点，必须先攻克。

| # | 任务 | 产出 | 说明 |
|---|------|------|------|
| 1.1 | PixiJS 底层画布初始化 | WebGL 渲染的网格/点阵背景 | PixiJS 8，`@pixi/react` 或手动初始化 |
| 1.2 | 画布平移（Pan） | 中键拖拽 / 空格+左键拖拽移动画布 | CSS transform + PixiJS 同步 |
| 1.3 | 画布缩放（Zoom） | Ctrl+滚轮缩放，触控板双指缩放 | 以鼠标位置为中心缩放 |
| 1.4 | `useViewport` Hook | 管理 viewport 状态（x, y, zoom） | throttle 16ms |
| 1.5 | DOM Overlay 层搭建 | 一个 div 层叠在 PixiJS Canvas 之上 | CSS `pointer-events` 穿透管理 |
| 1.6 | DOM 层与 PixiJS 层同步 | 平移缩放时 DOM 和 Canvas 保持一致 | CSS transform 跟随 viewport |
| 1.7 | 画布上放置 DOM 卡片（原型） | 一个可见的矩形 DOM 元素出现在画布上 | 验证双层方案可行性 |
| 1.8 | JS 侧简易视口裁剪 | 视口外的卡片不渲染 DOM | 遍历判断 `isInViewport()`，v0.3 替换为 Rust R-tree |

> **里程碑 1**：能平移缩放的双层画布，上面有一个静态 DOM 卡片，视口外不渲染。
>
> **风险判断点**：如果 PixiJS + DOM 同步方案不可接受（帧率/复杂度），则降级为纯 DOM + CSS transform 虚拟化方案，在此处做 Go/No-Go 决策。

### Phase 2: 卡片系统（5-7天）

| # | 任务 | 产出 | 说明 |
|---|------|------|------|
| 2.1 | `CanvasCard` 数据模型 | TypeScript 类型定义 | 所有卡片类型的联合类型 |
| 2.2 | `CardShell` 通用外壳组件 | 标题栏 + 内容区 + 边框 + 缩放手柄 | 所有卡片的公共容器，React 组合模式 |
| 2.3 | `useDragCard` 拖拽 Hook | 标题栏拖拽移动卡片 | 拖拽中只更新 CSS transform，释放后写 store + DB |
| 2.4 | `useResizeCard` 缩放 Hook | 右下角手柄调整卡片大小 | 最小尺寸限制 |
| 2.5 | `cardStore` 实现 | 卡片 CRUD、位置/尺寸更新 | Zustand 内存状态 + 写穿到 SQLite |
| 2.6 | 卡片持久化 | `addCard` / `updateCard` / `removeCard` 同步写 SQLite | Rust Command 封装 |
| 2.7 | 卡片层级管理 | `zIndex` 排序 + 点击置顶 | |
| 2.8 | 卡片右键菜单 | 删除 / 置顶 / 置底 / 锁定 / 折叠 | shadcn `ContextMenu` |
| 2.9 | 卡片折叠/展开 | 双击标题栏折叠为标题条 | |
| 2.10 | 快捷键系统骨架 | Delete / Ctrl+C / Ctrl+V | 全局快捷键管理器，避免与卡片内编辑冲突 |
| 2.11 | 卡片创建位置 | 工具栏创建 → 视口中心；右键创建 → 鼠标位置 | 自动避让已有卡片 |
| 2.12 | 工具栏（Toolbar）基础版 | 选择模式 + 添加 AI 对话卡片按钮 | 后续版本逐步加按钮 |

> **里程碑 2**：能在画布上创建、拖拽、缩放、删除、折叠卡片，数据持久化到 SQLite。

### Phase 3: API 配置 + AI 对话卡片（10-12天）

API 配置与 AI 对话同步开发，API 配置先行。

| # | 任务 | 产出 | 说明 |
|---|------|------|------|
| | **API 配置** | | |
| 3.1 | Rust 侧 AES-256-GCM 加密模块 | `encrypt` / `decrypt` Command | 加密后存入 `providers.enc` |
| 3.2 | `AIProviderConfig` 数据模型 | 类型定义 + `aiStore` | Provider / Key / BaseURL / Models / Capabilities |
| 3.3 | API 配置 UI | 添加/编辑/删除 AI 平台配置 | 右侧面板或独立 Modal |
| 3.4 | 自定义 Base URL | 兼容 API 中转站 / OneAPI | |
| 3.5 | 连通性测试 + 模型列表拉取 | 添加后测试可用性，自动获取模型列表 | Rust 侧 GET `/v1/models` |
| | **AI 对话** | | |
| 3.6 | AI 适配层类型定义 | `AIAdapter` 接口 + `ChatParams` / `ChatChunk` | |
| 3.7 | Rust 侧 `ai_chat_stream` Command | reqwest POST + SSE 流，通过 Tauri Event 转发到前端 | tokio::spawn 异步 |
| 3.8 | OpenAI 协议适配 (Rust) | 构建请求体、解析 SSE chunk | 兼容所有 OpenAI 协议兼容平台 |
| 3.9 | 前端 IPC 封装层 | `adapters/openai.ts` = IPC wrapper，调 Tauri Command | 不是 HTTP 客户端 |
| 3.10 | 前端 Event 监听 | `listen('ai-stream-{id}', ...)` | Tauri Event API |
| 3.11 | `AIChatCard` 组件 | 消息列表 + 输入框 + 发送 + 模型选择 | |
| 3.12 | 流式输出渲染 | 打字机效果，逐 token 追加 | DOM 直接操作，不触发全局 re-render |
| 3.13 | Markdown 渲染 | 代码块、列表、表格 | `react-markdown` + `rehype-highlight` |
| 3.14 | 消息持久化 (SQLite) | 每条消息独立写入 `messages` 表 | 支持分页查询、全文搜索 |
| 3.15 | 对话加载 | 打开卡片时从 DB 加载最近 N 条，滚动加载更多 | `SELECT ... ORDER BY created_at DESC LIMIT 30` |
| | **健壮性** | | |
| 3.16 | 停止生成按钮 | 中断正在输出的 AI 回复 | 前端发 abort，Rust 取消 tokio task |
| 3.17 | AI 错误处理 | Key 无效 / 余额不足 / 超时 / Rate Limit | 卡片内显示错误 + 重试按钮 |
| 3.18 | Claude 协议适配 (Rust) | Anthropic Messages API 格式差异 | |
| 3.19 | 适配器路由 | Rust 侧根据 `provider` 路由到对应处理逻辑 | match 分支，新增 provider 只加一个分支 |

> **里程碑 3**：能配置 API Key，和 GPT/Claude 流式对话，消息持久化到 SQLite，能分页加载历史，能停止生成，错误有提示。

### Phase 4: 项目管理 + 撤销重做（5-7天）

| # | 任务 | 产出 | 说明 |
|---|------|------|------|
| | **项目管理** | | |
| 4.1 | 项目 CRUD (SQLite) | 创建/重命名/删除项目，存 `projects` 表 | |
| 4.2 | 项目切换 | 切换时卸载当前项目卡片，加载目标项目 | 从 SQLite `cards` 表按 `project_id` 查询 |
| 4.3 | 项目列表侧边栏 | 左侧 Sidebar，显示所有项目 | 按最近更新排序 |
| 4.4 | 启动时加载上次项目 | `settings` 表存 `last_project_id` | |
| 4.5 | 自动保存 | 卡片变更即增量写 DB（SQLite 天然支持） | 不需要定时全量序列化，状态栏显示"已保存" |
| | **撤销重做** | | |
| 4.6 | 撤销/重做引擎 | Command 模式操作栈 | 每个操作记录 do/undo 的逆操作 |
| 4.7 | 集成到卡片操作 | 创建/删除/移动/缩放/编辑均可撤销 | Ctrl+Z / Ctrl+Shift+Z |
| 4.8 | 操作历史持久化 (可选) | 写入 `history` 表 | 重启后仍可撤销最近操作 |
| | **完善** | | |
| 4.9 | 状态栏（Status Bar） | 底部：卡片数 / 保存状态 | |
| 4.10 | 全局设置 | 主题(浅色/深色)、语言、默认模型 | `settings` 表 Key-Value |
| 4.11 | 媒体文件管理 | 图片存到 `media/images/`，DB 只存路径 | Rust 侧管理文件生命周期 |

> **里程碑 4 = v0.1 发布**：
> - 完整的本地 AI 画布工具
> - 多项目管理，数据持久化到 SQLite
> - 和 GPT/Claude 流式对话，消息分页加载
> - 自动保存（增量写 DB），可撤销
> - 崩溃安全（SQLite WAL 模式）

---

## v0.2 多卡片 — 好用（3-4 周）

目标：补齐图片和文本类卡片，增加更多 AI 平台。

> 视频卡片推迟到 v0.3。视频涉及异步任务管理、轮询、大文件下载、播放器集成，复杂度独立成章。

### Phase 5: 图片 + 文本卡片（8-10天）

| # | 任务 | 产出 | 说明 |
|---|------|------|------|
| | **文本类** | | |
| 5.1 | `TextCard` 文本卡片 | Markdown 编辑 + 实时预览 | 双击空白处快捷创建 |
| 5.2 | `StickyNoteCard` 便签卡片 | 彩色便签，纯文本 | 多种预设颜色 |
| | **图片类** | | |
| 5.3 | Rust 侧 `ai_generate_image` | 调 DALL-E API，下载图片到 `media/images/` | 返回本地路径 |
| 5.4 | Rust 侧 `generate_thumbnail` | `image` crate 缩放 | 存到 `media/thumbnails/` |
| 5.5 | `AIImageCard` 组件 | Prompt + 参数 + 图片网格展示 | 支持一次生成多张 |
| 5.6 | 图片放大查看 | 点击弹出 Lightbox 大图预览 | |
| 5.7 | `ImageAssetCard` 组件 | 独立图片卡片 | 从 AIImageCard 拖出 或 从系统拖入 |
| 5.8 | 系统文件拖入 | 拖入图片到画布 → 创建 ImageAssetCard | Tauri file drop |
| 5.9 | 图片拖出为独立卡片 | AIImageCard 网格 → 拖出单张 | |
| 5.10 | 图片数据持久化 | 生成记录 + 文件路径存 SQLite `cards` 表 JSON 字段 | |

### Phase 6: 更多适配器 + 交互完善（5-7天）

| # | 任务 | 产出 | 说明 |
|---|------|------|------|
| 6.1 | Gemini 协议适配 (Rust) | 对话 | Google AI API |
| 6.2 | DeepSeek 协议适配 (Rust) | 对话 | OpenAI 兼容，endpoint 差异 |
| 6.3 | Stability AI 适配 (Rust) | 生图 | |
| 6.4 | 卡片颜色标记 | 右键选颜色 | 6-8 种预设色 |
| 6.5 | 工具栏完善 | 全部卡片类型按钮 + 快捷键 (C / I / T) | |
| 6.6 | 右侧 Inspector 面板 | 选中：属性/模型/参数；未选中：API 配置入口 | |
| 6.7 | 卡片搜索 | Ctrl+F 搜索标题/内容 | SQLite FTS5 全文搜索 |

> **v0.2 发布**：支持对话/图片/文本/便签 + 图片资源，4 个 AI 平台，Inspector，全文搜索。

---

## v0.3 性能与完善 — 流畅（3-4 周）

目标：画布 500+ 卡片流畅，补齐视频卡片和高级交互。

### Phase 7: 渲染性能（7-10天）

| # | 任务 | 产出 | 说明 |
|---|------|------|------|
| 7.1 | Rust 侧 R-tree 空间索引 | `rstar` crate | 替换 JS 简易裁剪 |
| 7.2 | `query_viewport` Command | 返回可见卡片 + LOD 级别 | |
| 7.3 | `update_spatial_index` Command | 卡片增删改时更新 R-tree | 集成到写操作流程 |
| 7.4 | `useSpatialQuery` Hook | 替换 JS 遍历 | throttle 16ms |
| 7.5 | LOD 三级渲染 | zoom > 0.5 DOM / 0.2~0.5 Sprite / < 0.2 色块 | `useLOD` Hook |
| 7.6 | PixiJS 中/远景渲染 | 中景：标题+图标+缩略图；远景：纯色方块 | Sprite 批量渲染 |
| 7.7 | PixiJS 纹理池 + LRU | 缩略图 Texture 缓存 | 防内存无限增长 |
| 7.8 | 视口外资源释放 | 视频暂停+释放 Video 元素，图片 DOM 销毁 | |

### Phase 8: 视频卡片 + 高级交互（7-10天）

| # | 任务 | 产出 | 说明 |
|---|------|------|------|
| | **视频卡片** | | |
| 8.1 | Rust 侧 `ai_generate_video` | 提交任务到 Runway/Kling | 返回 taskId |
| 8.2 | 任务持久化 | 写入 SQLite `tasks` 表 | 应用重启后从 DB 恢复未完成任务 |
| 8.3 | Rust 侧状态轮询 | 定时查询，Event 推送前端 | `ai-video-status-{id}` |
| 8.4 | 应用重启恢复 | 启动时查 `tasks` 表 `status='generating'`，恢复轮询 | |
| 8.5 | Rust 侧视频下载 | 完成后下载到 `media/videos/` | |
| 8.6 | `AIVideoCard` 组件 | Prompt + 进度 + 播放器 | 状态机 idle→queued→generating→done/error |
| 8.7 | 图生视频 | 从 ImageAssetCard 拖入参考图 | |
| | **高级交互** | | |
| 8.8 | 框选 `SelectionBox` | 空白处拖拽框选 | PixiJS 层矩形相交 |
| 8.9 | `useSelection` Hook | 多选 + Ctrl+点击 + Ctrl+A | |
| 8.10 | 批量操作 | 批量移动/删除 | |
| 8.11 | 小地图 `Minimap` | 右下角全局缩略 | PixiJS 离屏渲染 |
| 8.12 | 缩放控件 + 适应全部 | 底部百分比 + Ctrl+Shift+1 | |
| 8.13 | 导出 PNG | 选区或全画布 | PixiJS extract 或 html-to-image |

> **v0.3 发布**：500+ 卡片流畅，视频卡片（任务可跨重启恢复），框选、小地图、导出。

---

## v0.5 用户体系 — 上线（6-8 周）

目标：引入后端，支持注册登录、VIP、云端同步。

### Phase 9: 后端核心（10-14天）

| # | 任务 | 产出 |
|---|------|------|
| 9.1 | Spring Boot 3 + Java 21 初始化 | Docker Compose (PostgreSQL + Redis + MinIO) |
| 9.2 | Flyway 数据迁移 | 按 `backend-design.md` Schema 建表 |
| 9.3 | 通用层 | R\<T\> 响应 / GlobalExceptionHandler / JwtUtil / SnowflakeId |
| 9.4 | 认证模块 | Spring Security + JWT RS256 双 Token |
| 9.5 | 注册码模块 | 批量生成 / Redis 分布式锁校验 / 使用记录 |
| 9.6 | VIP 模块 | 等级计算(缓存) / 权益校验 / 到期定时任务 |
| 9.7 | 画布 API | 全量保存 + 增量 Patch + 版本历史 |
| 9.8 | 文件存储 | MinIO/OSS 上传下载 |
| 9.9 | API 限流 | Bucket4j + Redis |
| 9.10 | SpringDoc | OpenAPI 3 文档 |

### Phase 10: 客户端对接后端（7-10天）

| # | 任务 | 产出 |
|---|------|------|
| 10.1 | 登录/注册 UI | 注册码 + 用户名 + 密码 |
| 10.2 | Rust 侧 HTTP 客户端 | 调后端 API，JWT Token 生命周期管理 |
| 10.3 | Token 自动刷新 | Access Token 过期前刷新 |
| 10.4 | 本地 → 云端数据迁移 | SQLite 数据导出上传到服务器 |
| 10.5 | 双向同步 | 本地编辑 → 增量同步到云端；云端 → 拉取到本地 |
| 10.6 | 离线模式 | 断网本地编辑，联网后同步 |
| 10.7 | VIP 权益限制 | 前端按等级限制功能 |
| 10.8 | 媒体上传 | 图片/视频上传 OSS，本地缓存 + 远端备份 |
| 10.9 | 冲突处理 | 离线编辑后上线，云端已变更时的合并策略 |

> **v0.5 发布**：注册登录、VIP、云端同步。

---

## v1.0 正式发布（6-8 周）

### Phase 11: 管理后台（10-14天）

按 `admin-design.md`，React 19 + Ant Design 5：

| # | 任务 |
|---|------|
| 11.1 | 脚手架 (Vite + React + AntD) |
| 11.2 | 管理员登录 |
| 11.3 | 仪表盘（统计 + 图表） |
| 11.4 | 用户管理 |
| 11.5 | 注册码管理 |
| 11.6 | VIP 管理 |
| 11.7 | 系统设置 |

### Phase 12: 发布准备（10-14天）

| # | 任务 |
|---|------|
| 12.1 | Tauri updater 自动更新 |
| 12.2 | Windows / macOS / Linux 打包签名 |
| 12.3 | 官网落地页 |
| 12.4 | 崩溃上报 (Sentry) |
| 12.5 | 基础埋点（功能使用率、性能） |
| 12.6 | 全面测试 + Bug 修复 |
| 12.7 | Nginx 部署（管理后台 + API 反代） |

---

## 技术风险与应对

| 风险 | 概率 | 影响 | 应对 | 判断时机 |
|------|------|------|------|----------|
| PixiJS + DOM 双层同步困难 | 中 | 高 | Phase 1 Go/No-Go，备选纯 DOM 虚拟化 | Phase 1 末 |
| Tauri IPC 高频调用瓶颈 | 低 | 高 | throttle 16ms + 批量；v0.1 先 JS 裁剪 | Phase 7 |
| SSE 流在 Tauri Event 中不稳定 | 中 | 中 | 充分测试断流/超时/并发/网络切换 | Phase 3 |
| R-tree IPC 开销 > JS 遍历 | 低 | 中 | benchmark 对比，< 200 卡片时用 JS | Phase 7 |
| SQLite 并发写入瓶颈 | 低 | 低 | 单线程写 + WAL 模式，桌面单用户够用 | Phase 2 |
| 多 AI 协议差异大 | 中 | 低 | OpenAI 兼容走统一路径，非兼容按 provider 分支 | Phase 3/6 |

---

## 可维护性设计

| 维度 | 策略 |
|------|------|
| **数据库升级** | `PRAGMA user_version` 版本号 + 迁移脚本链，事务执行，失败回滚 |
| **AI 适配器扩展** | Rust 侧 match provider 分支，新增 provider 只加一个分支 + 一个请求构建函数 |
| **卡片类型扩展** | `CardShell` 组合模式，新卡片只实现内容区组件 + 对应的 `CardData` 类型 |
| **React 错误隔离** | 每个卡片包 `ErrorBoundary`，单卡片崩溃不影响画布 |
| **Rust 模块划分** | `commands/` 按领域分文件（ai_proxy / spatial / project / crypto / media） |
| **日志** | Rust 侧 `tracing` 结构化日志，前端 `console` 分级日志 |

---

## 不做清单

| 不做 | 理由 |
|------|------|
| 新手引导 | 不需要 |
| 实时协作 | CRDT 复杂度极高，个人工具 |
| 第三方登录 | 注册码控制增长 |
| 支付系统 | 先手动发码验证 |
| WebSocket 推送 | 桌面单用户不需要 |
| 移动端 | 画布交互不适合触屏 |
| IndexedDB / Dexie.js | 已被 SQLite 完全替代 |
| 更多 AI 适配器 | 按用户反馈按需添加 |
