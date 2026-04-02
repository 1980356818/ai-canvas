# AI 无限画布 - 前端架构设计

> 交互模式：**自由拖放白板**（类 Miro / Figma），无连接槽点，无工作流。

## 1. 技术选型

| 组件           | 选型                          | 理由                                              |
| -------------- | ----------------------------- | ------------------------------------------------- |
| 桌面框架       | Tauri 2.x                    | 无 CORS 限制，包体小(~10MB)，Rust 原生性能        |
| 原生层         | Rust                          | API 代理、图片处理、空间索引、文件 I/O             |
| 前端框架       | React 19 + TypeScript         | 画布库生态最强(PixiJS/Konva 都有 React 绑定)      |
| 构建工具       | Vite 6                        | 快速 HMR，Tauri 官方推荐                          |
| 状态管理       | Zustand                       | 轻量、性能好、适合高频画布状态更新                 |
| 样式           | Tailwind CSS 4 + shadcn/ui    | 快速搭建现代 UI                                    |
| 本地数据库     | SQLite (rusqlite + WAL)       | ACID 事务、增量写入、分页查询、崩溃安全、FTS5 全文搜索 |
| 加密           | AES-256-GCM (aes-gcm crate)  | API Key 安全隔离，独立加密文件存储                |

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Shell (Rust)                    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │                 WebView (前端)                    │    │
│  │                                                  │    │
│  │  ┌──────────────────────────────────────────┐   │    │
│  │  │            UI Layer (React)               │   │    │
│  │  │  ┌─────────┐ ┌──────────┐ ┌───────────┐ │   │    │
│  │  │  │ Sidebar  │ │ Toolbar  │ │ Settings  │ │   │    │
│  │  │  │ 项目列表 │ │ 工具栏   │ │ API配置   │ │   │    │
│  │  │  └─────────┘ └──────────┘ └───────────┘ │   │    │
│  │  ├──────────────────────────────────────────┤   │    │
│  │  │         Infinite Canvas (核心)            │   │    │
│  │  │  ┌──────────────────────────────────┐    │   │    │
│  │  │  │     Canvas Layer (PixiJS)        │    │   │    │
│  │  │  │  · 网格 · 缩略图 · 选区 · 小地图│    │   │    │
│  │  │  ├──────────────────────────────────┤    │   │    │
│  │  │  │     DOM Overlay Layer            │    │   │    │
│  │  │  │  · AI对话卡片 · 图片卡片         │    │   │    │
│  │  │  │  · 视频卡片   · 文本卡片         │    │   │    │
│  │  │  └──────────────────────────────────┘    │   │    │
│  │  ├──────────────────────────────────────────┤   │    │
│  │  │         State (Zustand)                   │   │    │
│  │  │  · 画布状态 · 节点数据 · AI配置          │   │    │
│  │  └──────────────────────────────────────────┘   │    │
│  │                      │ Tauri IPC                 │    │
│  └──────────────────────┼──────────────────────────┘    │
│                         │                               │
│  ┌──────────────────────┼──────────────────────────┐    │
│  │              Rust Core (Tauri 插件)              │    │
│  │                                                  │    │
│  │  ┌────────────┐ ┌────────────┐ ┌──────────────┐ │    │
│  │  │ AI Proxy   │ │ Image Proc │ │ Spatial Index│ │    │
│  │  │ HTTP 直连  │ │ 缩略图生成 │ │ R-tree 索引  │ │    │
│  │  │ SSE 流转发 │ │ 格式转换   │ │ 视口查询     │ │    │
│  │  └────────────┘ └────────────┘ └──────────────┘ │    │
│  │  ┌────────────┐ ┌────────────┐                   │    │
│  │  │ File I/O   │ │ Encryption │                   │    │
│  │  │ 项目存取   │ │ API Key    │                   │    │
│  │  │ 导出功能   │ │ 加密存储   │                   │    │
│  │  └────────────┘ └────────────┘                   │    │
│  └──────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## 3. 核心：无限画布渲染方案

### 3.1 为什么不能用纯 DOM

成百上千节点 + 大量图片的场景下，纯 DOM 方案（ReactFlow/tldraw 默认模式）会：
- DOM 节点过多导致重排重绘卡顿
- 内存占用随节点线性增长
- 缩放平移时掉帧严重

### 3.2 双层混合渲染架构

```
用户视角（从上到下）:
┌─────────────────────────────────┐
│       DOM Overlay (上层)         │  ← 当前视口内可交互的卡片 (React)
│   · AI 对话卡片完整 UI           │
│   · 图片预览 / 视频播放器        │
│   · 富文本编辑器                 │
├─────────────────────────────────┤
│       PixiJS Canvas (底层)       │  ← WebGL 硬件加速渲染
│   · 无限网格 / 点阵背景          │
│   · 所有卡片缩略图 / 占位框      │
│   · 框选矩形                    │
│   · 小地图 (Minimap)            │
└─────────────────────────────────┘
```

**核心思路**：PixiJS (WebGL) 负责"画全局"，DOM 只负责"画当前看到的"。
无连接线、无端口，PixiJS 层更轻量，把 GPU 算力留给大量卡片缩略图。

### 3.3 LOD (Level of Detail) 分级渲染

根据缩放等级 + 是否在视口内，每个卡片有三种渲染状态：

```
┌─────────────────────────────────────────────────────────┐
│ 缩放等级        渲染方式          内容                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ zoom > 0.5      DOM 完整渲染     完整交互 UI              │
│ (近景)          + PixiJS 底框    可以打字、点击、播放      │
│                                                         │
│ 0.2 < zoom ≤ 0.5  PixiJS 精简   标题 + 类型图标          │
│ (中景)             Sprite 渲染   缩略图预览               │
│                                                         │
│ zoom ≤ 0.2      PixiJS 极简     纯色方块 + 类型色标      │
│ (远景/鸟瞰)     批量渲染        上千个卡片也流畅          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 3.4 视口裁剪 (Viewport Culling)

```
                    ┌───────────────────────┐
                    │    Buffer Zone        │
                    │  ┌─────────────────┐  │
                    │  │   Visible Area  │  │
                    │  │   (用户看到的)   │  │
                    │  └─────────────────┘  │
                    └───────────────────────┘

· Visible Area 内的卡片 → DOM 渲染 (如果 zoom > 0.5)
· Buffer Zone 内的卡片 → 预加载，即将进入视口
· Zone 外的卡片 → 完全不渲染 DOM，仅 PixiJS 画占位
```

- 使用 Rust 侧的 **R-tree 空间索引** 进行视口查询
- 查询时间 O(log n + k)，即使 10000 个卡片也是毫秒级
- Buffer Zone = 视口外扩 50%，预加载即将进入的卡片

### 3.5 空间索引 (Rust 侧)

```rust
// Tauri Command：查询视口内卡片
#[tauri::command]
fn query_viewport(
    state: State<CanvasIndex>,
    viewport: Viewport,    // { x, y, width, height, zoom }
    buffer: f64            // 外扩比例
) -> Vec<CardRef> {
    let search_rect = viewport.expand(buffer);
    state.rtree.search(&search_rect)
        .map(|entry| CardRef {
            id: entry.id,
            bounds: entry.bounds,
            card_type: entry.card_type,
            lod: calculate_lod(viewport.zoom),
        })
        .collect()
}
```

每次视口变化（平移/缩放）时调用，返回需要渲染的卡片列表及 LOD 级别。

---

## 4. 卡片类型设计

### 4.1 基础卡片结构

画布上所有内容都是"卡片"，自由摆放、自由拖拽、自由缩放，无连接槽点。

```typescript
interface CanvasCard {
  id: string
  type: 'ai_chat' | 'ai_image' | 'ai_video' | 'text' | 'sticky_note' | 'image_asset'
  position: { x: number; y: number }
  size: { width: number; height: number }
  zIndex: number
  locked: boolean
  collapsed: boolean               // 是否折叠（只显示标题栏）
  color?: string                   // 卡片边框/标题栏颜色
  title?: string                   // 用户自定义标题
  data: ChatCardData | ImageCardData | VideoCardData | TextCardData
  createdAt: number
  updatedAt: number
}
```

### 4.2 卡片交互行为

```
┌──────────────────────────────────────────────────────┐
│  卡片通用操作                                         │
├──────────────────────────────────────────────────────┤
│                                                      │
│  拖拽移动      标题栏拖拽 → 自由移动位置              │
│  缩放大小      右下角手柄 → 自由调整宽高              │
│  折叠/展开     双击标题栏 → 只显示标题条，省空间       │
│  层级调整      右键菜单 → 置顶 / 置底                 │
│  锁定          右键菜单 → 锁定位置防误拖              │
│  复制/删除     Ctrl+C / Delete                       │
│  颜色标记      右键菜单 → 选颜色标签分类              │
│  框选多个      空白处拖拽框选 → 批量移动/删除          │
│  Ctrl+点击     多选追加                               │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 4.3 AI 对话卡片

```typescript
interface ChatCardData {
  provider: string          // "openai" | "claude" | "gemini" | ...
  model: string             // "gpt-4o" | "claude-3.5-sonnet" | ...
  messages: ChatMessage[]
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  streaming: boolean        // 当前是否在流式输出
}
```

- 卡片内嵌完整对话界面（消息列表 + 输入框）
- 支持流式输出，实时渲染
- 对话上下文独立，不同卡片可用不同模型
- 可折叠为标题条，鸟瞰时不浪费空间

### 4.4 AI 图片卡片

```typescript
interface ImageCardData {
  provider: string          // "openai" | "stability" | "flux" | ...
  prompt: string
  negativePrompt?: string
  images: GeneratedImage[]  // 生成的图片列表
  settings: {
    width: number
    height: number
    steps?: number
    seed?: number
    count?: number          // 一次生成张数
  }
}

interface GeneratedImage {
  id: string
  url: string               // 本地缓存路径
  thumbnailUrl: string       // 缩略图路径（Rust 生成）
  prompt: string
  createdAt: number
}
```

- 输入 Prompt 直接生图
- 支持图片网格展示（一次生成多张）
- 单张图片可拖出为独立 `image_asset` 卡片
- 缩略图由 Rust 侧生成并缓存
- 支持放大查看/下载原图

### 4.5 AI 视频卡片

```typescript
interface VideoCardData {
  provider: string          // "runway" | "kling" | "pika" | ...
  prompt: string
  referenceImage?: string   // 参考图（可从图片卡片拖入）
  video?: GeneratedVideo
  settings: {
    duration: number
    resolution: string
    fps?: number
  }
  status: 'idle' | 'queued' | 'generating' | 'done' | 'error'
  progress?: number         // 生成进度 0-100
  errorMessage?: string
}
```

- 支持文生视频、图生视频
- 生成状态实时展示（进度条）
- 卡片内嵌播放器（完成后）
- 视频文件缓存在本地（Rust 管理）

### 4.6 文本/便签卡片

```typescript
interface TextCardData {
  content: string           // Markdown 内容
  fontSize?: number
}
```

- 轻量富文本编辑器（Markdown）
- 用于在画布上做笔记、标注、整理思路

### 4.7 图片资源卡片

```typescript
interface ImageAssetData {
  src: string               // 本地路径
  thumbnailSrc: string
  originalWidth: number
  originalHeight: number
  alt?: string
}
```

- 从图片卡片拖出的独立图片
- 或用户从本地直接拖入的图片
- 在画布上自由摆放，用于构图、对比、参考

---

## 5. AI 适配层

### 5.1 统一接口

```typescript
interface AIAdapter {
  readonly provider: string
  
  chat(params: ChatParams): AsyncIterable<ChatChunk>
  generateImage(params: ImageParams): Promise<ImageResult>
  generateVideo(params: VideoParams): Promise<VideoResult>
  checkVideoStatus(taskId: string): Promise<VideoStatus>
}
```

### 5.2 支持的平台

| 能力   | 平台                                                |
| ------ | --------------------------------------------------- |
| 对话   | OpenAI, Claude, Gemini, DeepSeek, 通义千问, 智谱    |
| 生图   | DALL-E, Stability AI, Flux, Midjourney(第三方)       |
| 视频   | Runway, Kling(可灵), Pika, Luma                      |

### 5.3 Rust 侧 AI Proxy

所有 AI API 调用走 Rust 原生 HTTP（reqwest），绕过浏览器限制：

```rust
#[tauri::command]
async fn ai_chat_stream(
    provider: String,
    api_key: String,
    base_url: Option<String>,
    model: String,
    messages: Vec<Message>,
    app: AppHandle,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = build_url(&provider, &base_url, "/chat/completions");
    
    let response = client.post(&url)
        .bearer_auth(&api_key)
        .json(&build_request_body(&provider, &model, &messages))
        .send().await?;
    
    let stream_id = uuid::Uuid::new_v4().to_string();
    
    // SSE 流式转发到前端
    tokio::spawn(async move {
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            app.emit(&format!("ai-stream-{}", stream_id), 
                     parse_chunk(&provider, &chunk));
        }
        app.emit(&format!("ai-stream-{}", stream_id), StreamEnd);
    });
    
    Ok(stream_id)
}
```

前端通过 Tauri Event 监听流式数据，实现打字机效果。

---

## 6. 用户配置管理

### 6.1 API 配置

```typescript
interface AIProviderConfig {
  id: string
  name: string              // 用户自定义名称
  provider: AIProviderType  // "openai" | "claude" | ...
  apiKey: string            // 加密存储
  baseUrl?: string          // 自定义端点(支持中转站/OneAPI)
  models: string[]          // 可用模型列表
  defaultModel?: string
  capabilities: ('chat' | 'image' | 'video')[]
}
```

- API Key 通过 Rust 侧 AES-256 加密后存入本地文件
- 支持自定义 Base URL（兼容各种 API 中转站/One API）
- 首次添加时自动拉取可用模型列表

### 6.2 存储架构

所有结构化数据统一使用 SQLite，二进制文件走文件系统：

```
%APPDATA%/ai-canvas/
├── data.db                 # SQLite 数据库（项目、卡片、消息、任务、设置）
├── providers.enc           # API Key 加密文件（安全隔离，不入数据库）
└── media/                  # 二进制文件（数据库只存引用路径）
    ├── images/             #   AI 生成/用户导入的图片
    ├── videos/             #   AI 生成的视频
    └── thumbnails/         #   缩略图缓存（可重新生成）
```

#### SQLite 核心表

| 表 | 职责 | 说明 |
|----|------|------|
| projects | 项目元数据 | 标题、创建/更新时间、卡片数、缩略图路径 |
| cards | 卡片数据 | 类型、位置、尺寸、zIndex、颜色；非对话内容用 JSON 字段 |
| messages | AI 对话消息 | 与卡片一对多，支持分页加载（LIMIT/OFFSET）和 FTS5 全文搜索 |
| tasks | 异步任务 | 视频生成等长任务，应用重启后可恢复轮询 |
| history | 操作历史 | 撤销/重做，可跨重启 |
| settings | 全局设置 | Key-Value |

#### 数据库版本迁移

- `PRAGMA user_version` 记录 Schema 版本号
- 应用启动时检查版本，按序执行迁移脚本
- 迁移在事务中执行，失败回滚

#### 为什么不用 IndexedDB / JSON 文件

- IndexedDB：前端 WebView 内的存储，Rust 侧无法直接访问，数据割裂
- JSON 文件：AI 对话消息增长后文件膨胀，无法分页查询，自动保存需全量重写，崩溃时文件损坏风险高
- SQLite：Rust 原生访问，增量写入，ACID 事务天然崩溃安全，FTS5 支持全文搜索

---

## 7. 性能优化清单

### 7.1 渲染性能

| 优化点                   | 方案                                               |
| ------------------------ | -------------------------------------------------- |
| 卡片裁剪                 | R-tree 空间索引 + 视口查询 (Rust)                  |
| 分级渲染                 | LOD 三级：DOM 完整 / PixiJS 精简 / PixiJS 色块     |
| 图片渲染                 | 远景用缩略图 Sprite，近景懒加载原图                |
| 平移缩放                 | PixiJS 层 requestAnimationFrame，DOM 层 CSS transform |
| 批量更新                 | React 19 automatic batching                        |

### 7.2 内存管理

| 优化点                   | 方案                                               |
| ------------------------ | -------------------------------------------------- |
| 图片内存                 | 离开视口的图片 DOM 销毁，PixiJS Texture 用缩略图   |
| 纹理管理                 | PixiJS TexturePool + LRU 淘汰策略                  |
| 大画布数据               | SQLite 按需查询，非一次性全部进内存                |
| 视频卡片                 | 离开视口暂停并释放 Video 元素                       |
| AI 对话历史              | SQLite 分页查询 (LIMIT/OFFSET)，仅内存保留当前页   |

### 7.3 交互响应

| 优化点                   | 方案                                               |
| ------------------------ | -------------------------------------------------- |
| 拖拽                     | 拖拽中仅更新 CSS transform，释放后才写入 state     |
| 缩放动画                 | PixiJS 层即时响应，DOM 层 debounce 100ms 后更新    |
| AI 流式输出              | 流式 chunk 直接 append DOM，不触发全局 re-render    |
| 搜索卡片                 | Rust 侧维护文本索引，毫秒级搜索                    |
| 批量框选                 | PixiJS 层计算相交，不遍历 DOM                      |

---

## 8. 画布操作 & 快捷键

| 操作         | 方式                                    |
| ------------ | --------------------------------------- |
| 平移画布     | 鼠标中键拖拽 / 空格+左键拖拽           |
| 缩放画布     | Ctrl + 滚轮 / 触控板双指缩放           |
| 适应全部     | Ctrl + Shift + 1                        |
| 添加对话卡片 | 工具栏点击 / 快捷键 C                   |
| 添加图片卡片 | 工具栏点击 / 快捷键 I                   |
| 添加视频卡片 | 工具栏点击 / 快捷键 V                   |
| 添加文本卡片 | 工具栏点击 / 快捷键 T / 双击空白处      |
| 添加画框     | 工具栏点击 / 快捷键 F                   |
| 框选         | 空白处左键拖拽                          |
| 多选追加     | Ctrl + 点击                             |
| 全选         | Ctrl + A                                |
| 删除         | Delete / Backspace                      |
| 复制粘贴     | Ctrl + C / Ctrl + V                     |
| 撤销重做     | Ctrl + Z / Ctrl + Shift + Z             |
| 保存         | Ctrl + S                                |
| 另存为       | Ctrl + Shift + S                        |
| 锁定卡片     | Ctrl + L                                |
| 成组/取消组  | Ctrl + G / Ctrl + Shift + G             |
| 命令面板     | Ctrl + K                                |
| 全局搜索     | Ctrl + F                                |
| 添加书签     | B                                       |
| 快速笔记     | Alt + N                                 |
| 导出画布     | Ctrl + E                                |
| 自动布局     | Ctrl + Shift + A (选中多个卡片后)       |
| 演示模式     | F5                                      |
| 性能面板     | Ctrl + Shift + P (开发模式)             |
| 书签跳转     | 1-9 数字键 (跳转到对应书签)             |
| 连接卡片     | Shift + 从卡片边缘拖拽                  |

---

## 9. IPC 通信设计

Tauri IPC 是前端和 Rust 的桥梁，高频调用需要注意性能：

### 9.1 命令 (前端 → Rust)

| 命令                     | 频率     | 说明                          |
| ------------------------ | -------- | ----------------------------- |
| `query_viewport`         | 高(滚动) | 视口内卡片查询                |
| `ai_chat_stream`         | 中       | 发起 AI 对话                  |
| `ai_generate_image`      | 低       | 发起 AI 生图                  |
| `ai_generate_video`      | 低       | 发起 AI 生视频                |
| `generate_thumbnail`     | 中       | 生成图片缩略图                |
| `save_card`              | 中(编辑) | 卡片数据写入 SQLite           |
| `load_cards`             | 低       | 按项目加载卡片                |
| `save_message`           | 中(对话) | AI 消息写入 SQLite            |
| `load_messages`          | 中       | 分页加载对话历史              |
| `search_messages`        | 低       | FTS5 全文搜索                 |
| `encrypt_api_key`        | 低       | 加密 API Key                  |
| `update_spatial_index`   | 中       | 卡片位置变化后更新索引        |

### 9.2 事件 (Rust → 前端)

| 事件                     | 说明                          |
| ------------------------ | ----------------------------- |
| `ai-stream-{id}`        | AI 流式输出数据               |
| `ai-image-done-{id}`    | 图片生成完成                  |
| `ai-video-status-{id}`  | 视频生成状态更新              |
| `thumbnail-ready-{id}`  | 缩略图生成完成                |

### 9.3 高频 IPC 优化

```typescript
// 视口查询节流：平移/缩放时最多 16ms 一次 (60fps)
const queryViewport = throttle(async (viewport: Viewport) => {
  const cards = await invoke<CardRef[]>('query_viewport', {
    viewport,
    buffer: 0.5,
  })
  canvasStore.setVisibleCards(cards)
}, 16)
```

---

## 10. 页面结构

```
┌──────────────────────────────────────────────────────────────┐
│  Title Bar (Tauri 自定义标题栏, 拖拽移动窗口)                  │
│  ┌──────────┬──────────┬──────────┬───┐                      │
│  │ 项目A  ✕ │ 项目B  ✕ │ 项目C  ✕ │ + │  ← 多标签页          │
│  └──────────┴──────────┴──────────┴───┘                      │
├──────┬───────────────────────────────────────┬────────────────┤
│      │  Toolbar (顶部工具栏)                  │                │
│ 侧   │  [选择] [AI对话] [AI图片] [AI视频]     │  Inspector     │
│ 边   │  [文本] [便签] [画框] ··· [布局 ▼]     │  (右侧面板)    │
│ 栏   ├───────────────────────────────────────┤                │
│      │                                       │  选中卡片时     │
│ Tab  │   ┌──浮动工具栏──────────────┐        │  · 卡片属性     │
│ ──   │   │ 🎨 📌 📋 🔒 📐 ··· 🗑️    │        │  · AI 设置      │
│ 📁   │   └────────┬─────────────────┘        │  · 模型选择     │
│ 项   │            │                           │  · 参数调整     │
│ 目   │    Infinite Canvas (无限画布)          │                │
│ ──   │                                       │  未选中时       │
│ 🔖   │  ┌─────────┐  ┌─────────────────┐    │  · API 配置     │
│ 书   │  │AI对话卡片│  │   画框 (Frame)   │    │  · 全局设置     │
│ 签   │  │         │  │  ┌────┐ ┌────┐  │    │  · 主题设置     │
│ ──   │  └─────────┘  │  │图片│ │文本│  │    │                │
│ 📋   │               │  └────┘ └────┘  │    │                │
│ 大   │  ┌─────────┐  └─────────────────┘    │                │
│ 纲   │  │AI图片卡片│         ↕ 对齐辅助线    │                │
│ ──   │  └─────────┘                          │                │
│ 🔍   │                                       │                │
│ 搜   ├───────────────────┬───────────────────┤                │
│ 索   │  Minimap + 书签标记│  Zoom: 100%  [适应]│                │
├──────┴───────────────────┴───────────────────┴────────────────┤
│  Status Bar: 卡片数: 1,234 | ✓ 已保存 | VIP 3 | 书签: 3      │
└──────────────────────────────────────────────────────────────┘

叠加层 (Overlay):
┌────────────────────────────────────┐
│  命令面板 (Ctrl+K)                  │
│  > 输入命令或搜索...                │
│  ┌──────────────────────────────┐  │
│  │ 新建 AI 对话卡片      Ctrl+C │  │
│  │ 搜索卡片内容          Ctrl+F │  │
│  │ 导出画布为 PNG        Ctrl+E │  │
│  └──────────────────────────────┘  │
└────────────────────────────────────┘

Toast 通知 (右下角):
         ┌──────────────────────┐
         │ ✓ 项目已自动保存      │
         └──────────────────────┘
```

---

## 11. 目录结构

```
ai-canvas/
├── src-tauri/                         # Rust 层
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/                  # Tauri Commands
│   │   │   ├── ai_proxy.rs            # AI API 代理
│   │   │   ├── spatial.rs             # 空间索引
│   │   │   ├── image.rs               # 图片处理
│   │   │   ├── project.rs             # 项目/卡片/消息 CRUD
│   │   │   ├── crypto.rs              # 加密
│   │   │   ├── db.rs                  # SQLite 初始化 + 迁移
│   │   │   ├── history.rs             # 撤销/重做持久化
│   │   │   └── export.rs              # 项目导出/导入
│   │   ├── services/
│   │   │   ├── ai/                    # AI 平台适配
│   │   │   │   ├── openai.rs
│   │   │   │   ├── claude.rs
│   │   │   │   └── ...
│   │   │   ├── rtree.rs              # R-tree 实现
│   │   │   └── auto_save.rs          # 自动保存调度
│   │   └── models/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                               # 前端
│   ├── app/
│   │   ├── App.tsx
│   │   ├── routes/
│   │   └── layout/
│   ├── components/
│   │   ├── canvas/                    # 画布核心
│   │   │   ├── CanvasContainer.tsx     # 画布容器(管理双层)
│   │   │   ├── PixiLayer.tsx          # WebGL 底层渲染
│   │   │   ├── DomOverlay.tsx         # DOM 交互层
│   │   │   ├── Minimap.tsx            # 小地图(含书签标记)
│   │   │   ├── Toolbar.tsx            # 工具栏
│   │   │   ├── SelectionBox.tsx       # 框选
│   │   │   ├── SelectionToolbar.tsx   # 选中后浮动工具栏
│   │   │   ├── SnapGuides.tsx         # 对齐辅助线渲染
│   │   │   ├── ConnectionLayer.tsx    # 卡片连接线 (PixiJS)
│   │   │   ├── GridBackground.tsx     # 可自定义网格背景
│   │   │   ├── PresentationMode.tsx   # 演示模式全屏组件
│   │   │   └── hooks/
│   │   │       ├── useViewport.ts         # 视口管理(平移/缩放)
│   │   │       ├── useSpatialQuery.ts     # 视口查询(调 Rust)
│   │   │       ├── useLOD.ts              # LOD 级别计算
│   │   │       ├── useDragCard.ts         # 卡片拖拽(含吸附逻辑)
│   │   │       ├── useResizeCard.ts       # 卡片缩放
│   │   │       ├── useSelection.ts        # 选中/框选
│   │   │       ├── useSnap.ts             # 对齐吸附计算
│   │   │       ├── useAutoLayout.ts       # 自动布局算法
│   │   │       ├── useBookmarks.ts        # 书签管理
│   │   │       ├── useConnections.ts      # 卡片连线管理
│   │   │       ├── useHistory.ts          # 撤销/重做 Hook
│   │   │       └── useKeyboardShortcuts.ts # 全局快捷键
│   │   ├── cards/                     # 卡片组件
│   │   │   ├── CardShell.tsx          # 卡片外壳(标题栏/操作/缩放手柄)
│   │   │   ├── AIChatCard.tsx         # AI 对话卡片
│   │   │   ├── AIImageCard.tsx        # AI 图片卡片
│   │   │   ├── AIVideoCard.tsx        # AI 视频卡片
│   │   │   ├── TextCard.tsx           # 文本卡片
│   │   │   ├── StickyNoteCard.tsx     # 便签卡片
│   │   │   ├── ImageAssetCard.tsx     # 独立图片卡片
│   │   │   └── FrameCard.tsx          # 画框/分组卡片
│   │   ├── ai/                        # AI 适配层
│   │   │   ├── adapters/
│   │   │   │   ├── openai.ts
│   │   │   │   ├── claude.ts
│   │   │   │   ├── gemini.ts
│   │   │   │   ├── deepseek.ts
│   │   │   │   └── index.ts
│   │   │   ├── AIAdapterFactory.ts
│   │   │   └── types.ts
│   │   ├── sidebar/                   # 侧边栏多面板
│   │   │   ├── SidebarContainer.tsx   # 侧边栏容器(Tab 切换)
│   │   │   ├── ProjectPanel.tsx       # 项目列表面板
│   │   │   ├── BookmarkPanel.tsx      # 书签面板
│   │   │   ├── OutlinePanel.tsx       # 大纲面板(卡片树形列表)
│   │   │   └── SearchPanel.tsx        # 搜索面板
│   │   ├── settings/                  # 设置面板
│   │   │   ├── APISettings.tsx
│   │   │   ├── GeneralSettings.tsx
│   │   │   └── ThemeSettings.tsx      # 主题设置(深色/浅色)
│   │   ├── overlays/                  # 叠加层组件
│   │   │   ├── CommandPalette.tsx     # 命令面板 (Ctrl+K)
│   │   │   ├── ContextMenu.tsx        # 右键上下文菜单
│   │   │   ├── Toast.tsx              # Toast 通知
│   │   │   ├── QuickNote.tsx          # 快速笔记弹窗 (Alt+N)
│   │   │   ├── SaveAsDialog.tsx       # 另存为对话框
│   │   │   ├── NewProjectDialog.tsx   # 新建项目对话框
│   │   │   └── ExportDialog.tsx       # 导出对话框
│   │   └── ui/                        # shadcn 基础组件
│   ├── stores/                        # Zustand
│   │   ├── canvasStore.ts             # 视口、缩放、选中状态、书签
│   │   ├── cardStore.ts               # 所有卡片数据、连线数据
│   │   ├── aiStore.ts                 # AI 配置 & 会话状态
│   │   ├── projectStore.ts            # 项目列表 & 当前项目
│   │   ├── historyStore.ts            # 撤销/重做栈
│   │   ├── uiStore.ts                 # UI 状态(主题/面板/Toast)
│   │   └── settingsStore.ts           # 全局设置
│   ├── lib/
│   │   ├── tauri.ts                   # IPC 封装
│   │   ├── db.ts                      # SQLite 操作封装
│   │   ├── history.ts                 # 撤销/重做 Command 模式引擎
│   │   ├── autoSave.ts               # 自动保存管理器
│   │   ├── exportImport.ts           # 项目导出/导入逻辑
│   │   ├── templates.ts              # 项目模板 & 卡片模板
│   │   ├── snap.ts                   # 对齐吸附计算引擎
│   │   └── layout.ts                 # 自动布局算法
│   └── main.tsx
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.ts
```

---

## 12. 画布功能扩展

### 12.1 卡片分组 / 画框 (Frame)

画框是一种特殊卡片，用于对多个卡片进行视觉分组和批量操作。

```typescript
interface FrameData {
  label: string
  backgroundColor: string        // 半透明底色，如 "rgba(59,130,246,0.08)"
  children: string[]              // 包含的卡片 ID 列表
  autoResize: boolean             // 是否随子卡片自动调整大小
  padding: number                 // 内边距 (默认 20px)
}
```

在 `CanvasCard.type` 中新增 `'frame'` 类型。

#### 画框行为规则

```
┌───────────────────────────────────────────────┐
│  行为                     规则                  │
├───────────────────────────────────────────────┤
│  拖拽画框                 内部所有卡片跟随移动  │
│  拖拽卡片进入画框         碰撞检测自动归属      │
│  拖拽卡片离开画框         自动脱离 children     │
│  删除画框                 仅删画框，不删子卡片  │
│  折叠画框                 内部卡片全部隐藏      │
│  框选画框                 自动选中所有子卡片    │
│  画框嵌套                 画框内可放画框        │
│  autoResize 开启时        画框随子卡片自动扩缩  │
└───────────────────────────────────────────────┘
```

#### 渲染层级

- PixiJS 层：渲染半透明底色矩形 + 标签文字（任何缩放级别都可见）
- DOM 层：zoom > 0.5 时渲染标签编辑输入框 + 操作按钮
- 画框 zIndex 始终低于其子卡片

#### 碰撞检测归属算法

```typescript
function resolveFrameOwnership(card: CanvasCard, frames: CanvasCard[]): string | null {
  // 按面积从小到大排序，优先归属最小的包围画框（最内层）
  const candidates = frames
    .filter(f => f.id !== card.id && isFullyInside(card.bounds, f.bounds))
    .sort((a, b) => area(a.bounds) - area(b.bounds))
  return candidates[0]?.id ?? null
}
```

### 12.2 对齐辅助线 / 吸附 (Snap)

拖拽卡片时自动检测与周围卡片的对齐关系，到达阈值自动吸附并显示辅助线。

```typescript
interface SnapConfig {
  enabled: boolean                // 全局开关
  threshold: number               // 吸附阈值像素 (默认 8)
  snapToGrid: boolean             // 是否吸附网格
  gridSize: number                // 网格大小 (默认 20)
  showGuides: boolean             // 是否显示辅助线
}

interface SnapGuide {
  type: 'horizontal' | 'vertical'
  position: number                // 像素坐标
  sourceCardId: string            // 参考卡片 ID
  edge: 'top' | 'bottom' | 'left' | 'right' | 'centerX' | 'centerY'
}

interface SnapResult {
  snappedX: number | null         // 吸附后的 X（null 表示该轴无吸附）
  snappedY: number | null
  guides: SnapGuide[]             // 需要显示的辅助线
}
```

#### 吸附计算流程

```
拖拽中每一帧:
  1. 获取当前视口内所有卡片（排除正在拖拽的）
  2. 计算被拖拽卡片的 6 条参考线（上/下/左/右/水平中心/垂直中心）
  3. 与每个卡片的 6 条参考线比较距离
  4. 距离 < threshold 的最近一条 → 吸附到该位置
  5. 生成 SnapGuide 交给 SnapGuides.tsx 在 PixiJS 层渲染蓝色虚线
  6. 释放鼠标时辅助线消失
```

#### 性能优化

- 只检测视口内 + Buffer Zone 内的卡片（R-tree 已有索引）
- 吸附计算控制在 O(n) 单次遍历，n = 视口内卡片数
- 按住 Alt 键临时禁用吸附

### 12.3 自动布局

对选中的多个卡片执行一键整理，减少手动排版工作。

```typescript
type LayoutMode = 
  | 'grid'              // 网格排列
  | 'horizontal'        // 水平等距分布
  | 'vertical'          // 垂直等距分布
  | 'align_left'        // 左对齐
  | 'align_right'       // 右对齐
  | 'align_top'         // 上对齐
  | 'align_bottom'      // 下对齐
  | 'align_center_h'    // 水平居中对齐
  | 'align_center_v'    // 垂直居中对齐
  | 'compact'           // 紧凑排列 (瀑布流)

interface LayoutOptions {
  mode: LayoutMode
  gap: number            // 间距 (默认 20px)
  animate: boolean       // 是否过渡动画 (默认 true, 300ms ease-out)
}
```

#### 网格排列算法

```typescript
function gridLayout(cards: CanvasCard[], gap: number): Map<string, Position> {
  const sorted = [...cards].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
  const cols = Math.ceil(Math.sqrt(sorted.length))
  const origin = { x: sorted[0].position.x, y: sorted[0].position.y }
  const maxWidth = Math.max(...sorted.map(c => c.size.width))
  const maxHeight = Math.max(...sorted.map(c => c.size.height))

  const result = new Map<string, Position>()
  sorted.forEach((card, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    result.set(card.id, {
      x: origin.x + col * (maxWidth + gap),
      y: origin.y + row * (maxHeight + gap),
    })
  })
  return result
}
```

触发方式：选中多个卡片后 → 浮动工具栏的"布局"下拉菜单 / 右键菜单 / Ctrl+Shift+A。

整个布局操作作为**一条 Undo 命令**记录，可一键撤销。

### 12.4 画布书签 / 导航点

在大画布中标记关键位置，快速跳转。

```typescript
interface CanvasBookmark {
  id: string
  name: string                     // 书签名称
  viewport: {
    x: number
    y: number
    zoom: number
  }
  color: string                    // 标记颜色 (从预设色板中选)
  order: number                    // 排序序号 (对应数字键 1-9)
  createdAt: number
}
```

#### 书签存储

书签属于项目级数据，存入 SQLite `projects` 表的 `bookmarks` JSON 字段或独立的 `bookmarks` 表：

```sql
CREATE TABLE bookmarks (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    viewport_x  REAL NOT NULL,
    viewport_y  REAL NOT NULL,
    viewport_zoom REAL NOT NULL,
    color       TEXT DEFAULT '#3B82F6',
    sort_order  INTEGER DEFAULT 0,
    created_at  INTEGER NOT NULL
);
```

#### 交互设计

```
添加书签:
  按 B 键 → 保存当前视口 → 弹出内联编辑框输入名称 → 回车确认

书签面板 (侧边栏 🔖 Tab):
  ┌────────────────────────┐
  │ 🔖 书签                 │
  ├────────────────────────┤
  │  1. 🔵 首页总览         │  ← 点击平滑飞行到该位置
  │  2. 🟢 对话工作区       │  ← 按数字键 2 快速跳转
  │  3. 🟠 设计素材区       │  ← 右键可编辑/删除
  │  4. 🔴 视频脚本         │
  └────────────────────────┘

小地图标记:
  在 Minimap 组件上用对应颜色的小菱形标记书签位置
  悬停显示书签名称

飞行动画:
  当前视口 → 目标视口，使用 ease-in-out 动画
  持续 400ms，同时平移 + 缩放
```

### 12.5 卡片连接线

轻量级可选连线，用于表达卡片间的关系（非工作流）。

```typescript
interface CardConnection {
  id: string
  fromCardId: string
  toCardId: string
  fromAnchor: ConnectionAnchor     // 起点锚点位置
  toAnchor: ConnectionAnchor       // 终点锚点位置
  style: 'arrow' | 'line' | 'dashed'
  color: string
  label?: string                   // 连线上的文字标签
  curvature: number                // 弯曲度 (0=直线, 0.5=默认弯曲)
}

type ConnectionAnchor = 'top' | 'bottom' | 'left' | 'right' | 'auto'
// auto 模式：自动选择两卡片间最短路径的锚点
```

#### 渲染

- PixiJS 层使用贝塞尔曲线绘制，性能开销极低
- 连线跟随卡片位置实时更新
- 连线不影响卡片的 LOD 渲染策略
- 远景 (zoom ≤ 0.2) 时连线简化为直线

#### 操作

```
创建: 按住 Shift → 从卡片边缘拖出 → 拖到目标卡片 → 松开创建连线
删除: 点击连线选中 → Delete 删除
编辑: 双击连线 → 编辑标签文字
样式: 右键连线 → 修改样式/颜色
```

### 12.6 画布背景自定义

```typescript
interface CanvasBackground {
  type: 'dots' | 'grid' | 'lines' | 'none'
  color: string                // 画布底色 (如 "#1a1a2e" 深色 / "#ffffff" 浅色)
  patternColor: string         // 网格/点颜色
  patternSize: number          // 图案间距 (默认 20px)
  patternOpacity: number       // 图案透明度 0-1 (默认 0.15)
}
```

- 在 Inspector 右侧面板的画布设置中修改
- PixiJS 层用 TilingSprite 或 Graphics 绘制，几乎无性能开销
- 缩放时图案按比例缩放，保持视觉一致性
- 背景设置属于项目级，随项目保存

### 12.7 演示模式 (Presentation Mode)

将画布变成幻灯片演示工具，依次飞行到各书签位置。

```typescript
interface PresentationState {
  active: boolean
  bookmarkOrder: string[]          // 按演示顺序排列的书签 ID
  currentIndex: number
  autoPlayInterval: number         // 自动播放间隔秒数 (0=手动翻页)
}
```

#### 交互流程

```
进入: F5 / 工具栏"演示"按钮 / 命令面板
  → 全屏，隐藏所有 UI 面板 (Sidebar/Toolbar/Inspector/StatusBar)
  → 跳转到第一个书签位置

翻页:
  → / 右方向键 / 空格     下一个书签
  ← / 左方向键             上一个书签
  ESC                      退出演示模式
  数字键 1-9               直接跳转到对应书签

退出:
  → ESC 键
  → 恢复进入前的视口位置和 UI 状态

底部控制条 (半透明浮层):
  ┌──────────────────────────────────────────┐
  │  ◀  ▶   3 / 7     ●●●○○○○    ■ 退出     │
  └──────────────────────────────────────────┘
```

---

## 13. UI 增强设计

### 13.1 命令面板 (Command Palette)

全局快速操作入口，类似 VS Code 的 `Ctrl+K`。

```typescript
interface CommandItem {
  id: string
  label: string                    // 显示名称
  category: CommandCategory
  shortcut?: string                // 快捷键文字描述
  icon?: string                    // 图标
  action: () => void               // 执行动作
  enabled?: () => boolean          // 动态判断是否可用
  keywords?: string[]              // 搜索关键词别名
}

type CommandCategory =
  | 'card'        // 卡片操作
  | 'canvas'      // 画布操作
  | 'project'     // 项目操作
  | 'view'        // 视图操作
  | 'settings'    // 设置
  | 'navigate'    // 导航 (书签跳转)
```

#### 命令注册表

```typescript
const commands: CommandItem[] = [
  // 卡片操作
  { id: 'add_chat',    label: '新建 AI 对话卡片',   category: 'card',    shortcut: 'C',            action: () => cardStore.addCard('ai_chat') },
  { id: 'add_image',   label: '新建 AI 图片卡片',   category: 'card',    shortcut: 'I',            action: () => cardStore.addCard('ai_image') },
  { id: 'add_video',   label: '新建 AI 视频卡片',   category: 'card',    shortcut: 'V',            action: () => cardStore.addCard('ai_video') },
  { id: 'add_text',    label: '新建文本卡片',       category: 'card',    shortcut: 'T',            action: () => cardStore.addCard('text') },
  { id: 'add_sticky',  label: '新建便签',           category: 'card',    shortcut: '',             action: () => cardStore.addCard('sticky_note') },
  { id: 'add_frame',   label: '新建画框',           category: 'card',    shortcut: 'F',            action: () => cardStore.addCard('frame') },
  { id: 'delete_sel',  label: '删除选中卡片',       category: 'card',    shortcut: 'Delete',       action: () => cardStore.deleteSelected(), enabled: () => canvasStore.hasSelection },

  // 画布操作
  { id: 'fit_all',     label: '适应全部卡片',       category: 'canvas',  shortcut: 'Ctrl+Shift+1', action: () => canvasStore.fitAll() },
  { id: 'zoom_100',    label: '缩放到 100%',        category: 'canvas',  shortcut: '',             action: () => canvasStore.setZoom(1) },
  { id: 'toggle_grid', label: '切换网格显示',       category: 'canvas',  shortcut: '',             action: () => canvasStore.toggleGrid() },
  { id: 'toggle_snap', label: '切换对齐吸附',       category: 'canvas',  shortcut: '',             action: () => canvasStore.toggleSnap() },
  { id: 'present',     label: '进入演示模式',       category: 'canvas',  shortcut: 'F5',           action: () => canvasStore.startPresentation() },

  // 项目操作
  { id: 'save',        label: '保存项目',           category: 'project', shortcut: 'Ctrl+S',       action: () => projectStore.save() },
  { id: 'save_as',     label: '另存为...',          category: 'project', shortcut: 'Ctrl+Shift+S', action: () => projectStore.saveAs() },
  { id: 'export',      label: '导出画布...',        category: 'project', shortcut: 'Ctrl+E',       action: () => projectStore.showExportDialog() },
  { id: 'new_project', label: '新建项目',           category: 'project', shortcut: '',             action: () => projectStore.showNewProjectDialog() },

  // 视图操作
  { id: 'toggle_sidebar',   label: '切换侧边栏',   category: 'view',    shortcut: '',             action: () => uiStore.toggleSidebar() },
  { id: 'toggle_inspector', label: '切换右侧面板',  category: 'view',    shortcut: '',             action: () => uiStore.toggleInspector() },
  { id: 'toggle_theme',     label: '切换深色/浅色', category: 'view',    shortcut: '',             action: () => uiStore.toggleTheme() },

  // 动态命令：书签跳转 (运行时从 canvasStore.bookmarks 生成)
]
```

#### 模糊搜索

使用轻量级模糊匹配（Fuse.js 或手写），同时搜索 `label` 和 `keywords` 字段。输入时实时过滤，高亮匹配文字。

#### UI 布局

```
┌───────────────────────────────────────────────────┐
│  > [搜索命令或操作...________________________]    │
├───────────────────────────────────────────────────┤
│  卡片                                             │
│    新建 AI 对话卡片                          C     │
│    新建 AI 图片卡片                          I     │
│    新建文本卡片                              T     │
│  画布                                             │
│    适应全部卡片                      Ctrl+Shift+1 │
│    进入演示模式                              F5   │
│  项目                                             │
│    保存项目                              Ctrl+S   │
│    另存为...                        Ctrl+Shift+S  │
└───────────────────────────────────────────────────┘
```

- 按 `Ctrl+K` 打开，按 `Esc` 关闭
- 上下方向键选择条目，回车执行
- 打开时聚焦搜索框，直接输入即过滤
- 最近使用的命令置顶

### 13.2 右键上下文菜单 (Context Menu)

根据右键位置动态生成菜单项。

```typescript
interface ContextMenuItem {
  id: string
  label: string
  icon?: string
  shortcut?: string
  action: () => void
  disabled?: boolean
  divider?: boolean               // 该项前显示分割线
  children?: ContextMenuItem[]    // 子菜单
}
```

#### 菜单配置

**画布空白处右键：**

```
┌──────────────────────────┐
│  新建 AI 对话卡片      C  │
│  新建 AI 图片卡片      I  │
│  新建 AI 视频卡片      V  │
│  新建文本卡片          T  │
│  新建便签                 │
│  新建画框              F  │
├──────────────────────────┤
│  粘贴              Ctrl+V │
├──────────────────────────┤
│  添加书签              B  │
│  适应全部    Ctrl+Shift+1 │
│  重置缩放                 │
├──────────────────────────┤
│  画布背景            →   │
│    · 点阵                 │
│    · 网格                 │
│    · 线条                 │
│    · 无                   │
└──────────────────────────┘
```

**单个卡片右键：**

```
┌──────────────────────────┐
│  编辑                     │
│  复制               Ctrl+C│
│  粘贴               Ctrl+V│
├──────────────────────────┤
│  折叠/展开                │
│  锁定/解锁          Ctrl+L│
│  颜色标记            →   │
│    · 🔴 红  🟠 橙  🟡 黄  │
│    · 🟢 绿  🔵 蓝  🟣 紫  │
│    · 无色                 │
├──────────────────────────┤
│  置顶                     │
│  置底                     │
├──────────────────────────┤
│  加入画框            →   │
│    · 画框A                │
│    · 画框B                │
│    · 新建画框并加入       │
│  移出画框     (在画框内时)│
├──────────────────────────┤
│  存为卡片模板             │
├──────────────────────────┤
│  删除              Delete │
└──────────────────────────┘
```

**多选卡片右键：**

```
┌───────────────────────────────┐
│  对齐                    →   │
│    · 左对齐                   │
│    · 右对齐                   │
│    · 上对齐                   │
│    · 下对齐                   │
│    · 水平居中                 │
│    · 垂直居中                 │
│  分布                    →   │
│    · 水平等距                 │
│    · 垂直等距                 │
│  网格排列         Ctrl+Shift+A│
├───────────────────────────────┤
│  成组 (画框)          Ctrl+G │
│  全部折叠                     │
│  全部锁定                     │
├───────────────────────────────┤
│  复制                 Ctrl+C │
│  删除                 Delete │
└───────────────────────────────┘
```

### 13.3 浮动工具栏 (Selection Toolbar)

选中一个或多个卡片后，在选区正上方 8px 处显示迷你浮动操作栏。

```
                    选中单个卡片:
         ┌──────────────────────────────────┐
         │  🎨  📌  📋  🔒  📐  ···  🗑️     │
         └──────────────────────────────────┘
              ↑    ↑    ↑    ↑    ↑     ↑
           颜色  置顶  复制  锁定 连线  删除

                   选中多个卡片:
         ┌────────────────────────────────────────┐
         │  📐对齐▼  📏分布▼  📦成组  🔒全锁  🗑️删除 │
         └────────────────────────────────────────┘
```

行为规则：
- 浮动在选区上方，跟随选区移动
- 卡片折叠时也可见
- zoom < 0.3 时自动隐藏（太远看不清）
- 拖拽开始时自动隐藏，拖拽结束后重新出现
- 不遮挡标题栏（如果空间不够则移到下方）

### 13.4 深色 / 浅色主题

```typescript
interface ThemeConfig {
  mode: 'light' | 'dark' | 'system'    // system = 跟随操作系统
  accentColor: string                   // 强调色 (默认蓝色 #3B82F6)
}
```

#### 实现方式

- CSS 层：Tailwind CSS 4 的 `dark:` 变体，全局切换 `<html class="dark">`
- PixiJS 层：监听主题变化，更新画布背景色、网格颜色、辅助线颜色
- shadcn/ui 原生支持深色模式，组件无需额外处理
- 主题偏好存入 SQLite settings 表，启动时加载

#### 颜色定义

| 元素 | 浅色模式 | 深色模式 |
|------|---------|---------|
| 画布背景 | #FFFFFF | #1A1A2E |
| 网格线 | rgba(0,0,0,0.06) | rgba(255,255,255,0.06) |
| 卡片背景 | #FFFFFF | #2A2A3E |
| 卡片边框 | #E5E7EB | #3A3A4E |
| 文字主色 | #111827 | #F3F4F6 |
| 辅助线 | #3B82F6 | #60A5FA |
| 选中高亮 | rgba(59,130,246,0.15) | rgba(96,165,250,0.2) |

### 13.5 侧边栏增强

侧边栏从单一项目列表扩展为多 Tab 面板。

```typescript
type SidebarTab = 'projects' | 'bookmarks' | 'outline' | 'search'

// uiStore 中管理
interface UIState {
  sidebarVisible: boolean
  sidebarActiveTab: SidebarTab
  sidebarWidth: number              // 可拖拽调整宽度 (默认 260px, 最小 200, 最大 400)
  inspectorVisible: boolean
  // ...
}
```

#### 各面板详情

**项目面板 (📁)**

```
┌──────────────────────────────┐
│  我的项目             [+ 新建]│
├──────────────────────────────┤
│  🔍 [搜索项目...______]      │
│  排序: [最近修改 ▼]          │
├──────────────────────────────┤
│  ▸ AI 产品设计                │  ← 当前打开，加粗蓝色高亮
│    12张卡片 · 刚刚            │
│  ─────────────────────────── │
│    LOGO 创意探索              │  ← 右键: 重命名/另存为/导出/删除
│    8张卡片 · 2小时前          │
│  ─────────────────────────── │
│    视频脚本策划                │
│    23张卡片 · 昨天            │
└──────────────────────────────┘
```

**大纲面板 (📋)**

```
┌──────────────────────────────┐
│  画布大纲           [按类型 ▼]│
├──────────────────────────────┤
│  🔍 [筛选卡片...______]      │
├──────────────────────────────┤
│  💬 AI 对话 (5)               │
│    ├─ GPT-4o 架构讨论         │  ← 点击 → 飞行定位到该卡片
│    ├─ Claude 代码审查         │  ← 拖拽排序 → 改变 zIndex
│    └─ DeepSeek 数据分析       │
│  🖼️ AI 图片 (3)               │
│    ├─ Logo 设计               │
│    └─ Banner 制作             │
│  🎬 AI 视频 (1)               │
│    └─ 产品宣传片              │
│  📝 文本 (4)                  │
│    ├─ 需求文档                │
│    └─ 会议纪要                │
│  📌 便签 (2)                  │
│  🔲 画框 (2)                  │
│    ├─ 设计工作区              │
│    └─ 研发工作区              │
└──────────────────────────────┘
```

**搜索面板 (🔍)**

```
┌──────────────────────────────┐
│  搜索                        │
├──────────────────────────────┤
│  [搜索画布内容...________] 🔍│
│  范围: [全部 ▼]              │
│    · 全部                     │
│    · 卡片标题                 │
│    · 对话内容                 │
│    · 图片 Prompt              │
├──────────────────────────────┤
│  找到 12 个结果               │
│  ─────────────────────────── │
│  💬 GPT-4o 架构讨论           │
│     "...使用 React 搭建..."  │
│                    [定位] ↗  │
│  ─────────────────────────── │
│  🖼️ Logo 设计                 │
│     Prompt: "...React logo.."│
│                    [定位] ↗  │
│  ─────────────────────────── │
│  📝 需求文档                  │
│     "...React 组件库选型..."  │
│                    [定位] ↗  │
└──────────────────────────────┘
```

点击 **[定位]** 按钮：
1. 画布平滑飞行到该卡片中心
2. 卡片边框高亮闪烁 2 秒 (3 次脉冲动画)
3. 如果卡片折叠状态，自动展开

搜索实现：
- 卡片标题：前端 Zustand 内存搜索（卡片数据已在内存中）
- 对话内容 / Prompt：调用 Rust Command `search_messages`，使用 SQLite FTS5 全文搜索
- 搜索结果高亮关键词

### 13.6 Toast 通知系统

全局统一的操作反馈通知，显示在右下角。

```typescript
interface ToastItem {
  id: string
  type: 'success' | 'error' | 'info' | 'warning'
  title: string
  description?: string
  action?: {
    label: string                  // 按钮文字
    onClick: () => void
  }
  duration: number                 // 自动关闭毫秒数 (0=手动关闭)
}
```

#### 各场景 Toast

| 场景 | type | title | description | action | duration |
|------|------|-------|-------------|--------|----------|
| 手动保存 | success | 项目已保存 | - | - | 2000 |
| 自动保存 | info | 自动保存完成 | - | - | 1500 |
| AI 生图完成 | success | 图片生成完成 | "共 4 张图片" | [查看] → 定位到卡片 | 5000 |
| AI 视频完成 | success | 视频生成完成 | - | [查看] → 定位到卡片 | 5000 |
| AI 调用失败 | error | AI 请求失败 | 错误详情 | [重试] | 0 (手动) |
| 导出完成 | success | 导出成功 | 文件路径 | [打开文件夹] | 5000 |
| 撤销 | info | 已撤销: 删除3张卡片 | - | - | 1500 |
| 重做 | info | 已重做: 删除3张卡片 | - | - | 1500 |
| 复制 | info | 已复制 3 张卡片 | - | - | 1500 |
| 项目删除 | warning | 项目已删除 | "可在30秒内撤回" | [撤回] | 30000 |

#### 显示规则

- 最多同时显示 3 条 Toast，超出则替换最早的
- 从右下角向上堆叠，新的在最下方
- 入场动画：从右侧滑入 (200ms ease-out)
- 离场动画：向右滑出淡出 (150ms ease-in)
- 鼠标悬停时暂停自动关闭计时

---

## 14. 撤销 / 重做系统

### 14.1 核心架构：Command 模式

每个可撤销操作封装为一个 Command 对象，包含 `execute` 和 `undo` 方法。

```typescript
interface UndoableCommand {
  id: string
  type: string                         // 命令类型标识
  label: string                        // 人类可读描述："移动卡片"
  timestamp: number
  projectId: string                    // 所属项目

  execute(): void                      // 执行 / 重做
  undo(): void                         // 撤销
  merge?(other: UndoableCommand): UndoableCommand | null
  serialize(): SerializedCommand       // 序列化（用于持久化）
}

interface SerializedCommand {
  type: string
  label: string
  timestamp: number
  data: Record<string, unknown>        // 类型特定的序列化数据
}
```

### 14.2 操作粒度定义

| 用户操作 | 记录时机 | 撤销效果 | 可合并 |
|---------|---------|---------|-------|
| 拖拽卡片 | mouseup（释放时） | 回到拖拽前位置 | 否 |
| 缩放卡片 | mouseup（释放时） | 回到缩放前尺寸 | 否 |
| 创建卡片 | 立即 | 删除该卡片 | 否 |
| 删除卡片 | 立即（备份完整数据） | 恢复卡片 + 关联数据 | 否 |
| 修改卡片颜色 | 立即 | 恢复原颜色 | 是(同卡片连续改色) |
| 折叠/展开 | 立即 | 恢复原状态 | 否 |
| 锁定/解锁 | 立即 | 恢复原状态 | 否 |
| AI 发送消息 | 立即 | 删除消息 + AI 回复 | 否 |
| 文本编辑 | 停顿 > 1s 分段 | 恢复到上一段文字 | 是(连续输入) |
| 批量移动 | mouseup（释放时） | 整体恢复 | 否 |
| 批量删除 | 立即 | 整体恢复 | 否 |
| 自动布局 | 立即 | 恢复所有卡片原位置 | 否 |
| 创建连线 | 立即 | 删除连线 | 否 |
| 创建画框 | 立即 | 删除画框 | 否 |
| 修改标题 | 失焦时 | 恢复原标题 | 否 |

### 14.3 Command 实现

```typescript
// ── 移动卡片命令 ─────────────────────────────
class MoveCardCommand implements UndoableCommand {
  readonly type = 'move_card'

  constructor(
    readonly id: string,
    readonly projectId: string,
    readonly timestamp: number,
    private cardIds: string[],
    private fromPositions: Map<string, Position>,
    private toPositions: Map<string, Position>,
  ) {}

  get label() {
    return this.cardIds.length === 1
      ? '移动卡片'
      : `移动 ${this.cardIds.length} 张卡片`
  }

  execute() {
    for (const [id, pos] of this.toPositions) {
      cardStore.getState().updatePosition(id, pos)
    }
  }

  undo() {
    for (const [id, pos] of this.fromPositions) {
      cardStore.getState().updatePosition(id, pos)
    }
  }

  merge() { return null }

  serialize(): SerializedCommand {
    return {
      type: this.type,
      label: this.label,
      timestamp: this.timestamp,
      data: {
        cardIds: this.cardIds,
        fromPositions: Object.fromEntries(this.fromPositions),
        toPositions: Object.fromEntries(this.toPositions),
      },
    }
  }
}

// ── 删除卡片命令 ─────────────────────────────
class DeleteCardsCommand implements UndoableCommand {
  readonly type = 'delete_cards'

  constructor(
    readonly id: string,
    readonly projectId: string,
    readonly timestamp: number,
    private deletedCards: CanvasCard[],
    private deletedConnections: CardConnection[],
    private deletedMessages: ChatMessage[],    // AI 对话卡片的消息也要备份
  ) {}

  get label() {
    return this.deletedCards.length === 1
      ? '删除卡片'
      : `删除 ${this.deletedCards.length} 张卡片`
  }

  execute() {
    for (const card of this.deletedCards) {
      cardStore.getState().removeCard(card.id)
    }
    for (const conn of this.deletedConnections) {
      cardStore.getState().removeConnection(conn.id)
    }
  }

  undo() {
    for (const card of this.deletedCards) {
      cardStore.getState().addCard(card)
    }
    for (const conn of this.deletedConnections) {
      cardStore.getState().addConnection(conn)
    }
    // 恢复对话消息到 SQLite
    if (this.deletedMessages.length > 0) {
      invoke('restore_messages', { messages: this.deletedMessages })
    }
  }

  merge() { return null }

  serialize(): SerializedCommand {
    return {
      type: this.type,
      label: this.label,
      timestamp: this.timestamp,
      data: {
        deletedCards: this.deletedCards,
        deletedConnections: this.deletedConnections,
        deletedMessages: this.deletedMessages,
      },
    }
  }
}

// ── 创建卡片命令 ─────────────────────────────
class CreateCardCommand implements UndoableCommand {
  readonly type = 'create_card'

  constructor(
    readonly id: string,
    readonly projectId: string,
    readonly timestamp: number,
    private card: CanvasCard,
  ) {}

  get label() { return '创建卡片' }

  execute() { cardStore.getState().addCard(this.card) }
  undo() { cardStore.getState().removeCard(this.card.id) }
  merge() { return null }

  serialize(): SerializedCommand {
    return {
      type: this.type,
      label: this.label,
      timestamp: this.timestamp,
      data: { card: this.card },
    }
  }
}

// ── 文本编辑命令（支持合并连续输入）─────────────
class EditTextCommand implements UndoableCommand {
  readonly type = 'edit_text'

  constructor(
    readonly id: string,
    readonly projectId: string,
    readonly timestamp: number,
    private cardId: string,
    private field: string,             // 编辑的字段路径
    private oldValue: string,
    private newValue: string,
  ) {}

  get label() { return '编辑文本' }

  execute() { cardStore.getState().updateField(this.cardId, this.field, this.newValue) }
  undo() { cardStore.getState().updateField(this.cardId, this.field, this.oldValue) }

  merge(other: UndoableCommand): UndoableCommand | null {
    if (other.type !== 'edit_text') return null
    const o = other as EditTextCommand
    if (o.cardId !== this.cardId || o.field !== this.field) return null
    if (o.timestamp - this.timestamp > 1000) return null    // 停顿超过 1 秒不合并
    return new EditTextCommand(
      this.id, this.projectId, o.timestamp,
      this.cardId, this.field,
      this.oldValue,       // 保留最初的 oldValue
      o.newValue,          // 使用最新的 newValue
    )
  }

  serialize(): SerializedCommand {
    return {
      type: this.type,
      label: this.label,
      timestamp: this.timestamp,
      data: { cardId: this.cardId, field: this.field, oldValue: this.oldValue, newValue: this.newValue },
    }
  }
}

// ── 自动布局命令 ─────────────────────────────
class AutoLayoutCommand implements UndoableCommand {
  readonly type = 'auto_layout'

  constructor(
    readonly id: string,
    readonly projectId: string,
    readonly timestamp: number,
    private cardIds: string[],
    private fromPositions: Map<string, Position>,
    private toPositions: Map<string, Position>,
    private layoutMode: LayoutMode,
  ) {}

  get label() { return `自动布局 (${this.layoutMode})` }

  execute() {
    for (const [id, pos] of this.toPositions) {
      cardStore.getState().updatePosition(id, pos)
    }
  }

  undo() {
    for (const [id, pos] of this.fromPositions) {
      cardStore.getState().updatePosition(id, pos)
    }
  }

  merge() { return null }

  serialize(): SerializedCommand {
    return {
      type: this.type,
      label: this.label,
      timestamp: this.timestamp,
      data: {
        cardIds: this.cardIds,
        fromPositions: Object.fromEntries(this.fromPositions),
        toPositions: Object.fromEntries(this.toPositions),
        layoutMode: this.layoutMode,
      },
    }
  }
}
```

### 14.4 History Manager

```typescript
class HistoryManager {
  private undoStack: UndoableCommand[] = []
  private redoStack: UndoableCommand[] = []
  private maxMemorySteps = 100             // 内存中最多保留步数
  private maxPersistSteps = 20             // 持久化最多保留步数

  // ── 执行并记录命令 ────────────────────
  push(command: UndoableCommand) {
    command.execute()

    const top = this.undoStack.at(-1)
    if (top) {
      const merged = top.merge?.(command)
      if (merged) {
        this.undoStack[this.undoStack.length - 1] = merged
        this.redoStack = []
        this.schedulePersist()
        this.notifyChange()
        return
      }
    }

    this.undoStack.push(command)
    this.redoStack = []

    if (this.undoStack.length > this.maxMemorySteps) {
      this.undoStack.shift()
    }

    this.schedulePersist()
    this.notifyChange()
  }

  // ── 撤销 ────────────────────────────
  undo(): string | null {
    const cmd = this.undoStack.pop()
    if (!cmd) return null

    cmd.undo()
    this.redoStack.push(cmd)
    this.schedulePersist()
    this.notifyChange()
    return cmd.label
  }

  // ── 重做 ────────────────────────────
  redo(): string | null {
    const cmd = this.redoStack.pop()
    if (!cmd) return null

    cmd.execute()
    this.undoStack.push(cmd)
    this.schedulePersist()
    this.notifyChange()
    return cmd.label
  }

  // ── 查询状态 ─────────────────────────
  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }
  get undoLabel() { return this.undoStack.at(-1)?.label ?? null }
  get redoLabel() { return this.redoStack.at(-1)?.label ?? null }

  // ── 清空（切换项目时调用）──────────────
  clear() {
    this.undoStack = []
    this.redoStack = []
    this.notifyChange()
  }

  // ── 持久化到 SQLite ──────────────────
  private persistTimer: number | null = null

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = window.setTimeout(() => this.persist(), 500)
  }

  private async persist() {
    const entries = this.undoStack
      .slice(-this.maxPersistSteps)
      .map(cmd => cmd.serialize())
    await invoke('save_history', {
      projectId: this.undoStack[0]?.projectId,
      entries,
    })
  }

  // ── 从 SQLite 恢复（应用启动 / 切换项目时）──
  async restore(projectId: string) {
    this.clear()
    const entries = await invoke<SerializedCommand[]>('load_history', { projectId })
    for (const entry of entries) {
      const cmd = CommandFactory.deserialize(entry, projectId)
      if (cmd) this.undoStack.push(cmd)
    }
    this.notifyChange()
  }

  // ── 通知 Zustand Store 更新 UI ───────
  private notifyChange() {
    historyStore.getState().update({
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      undoLabel: this.undoLabel,
      redoLabel: this.redoLabel,
    })
  }
}

// 全局单例
export const history = new HistoryManager()
```

### 14.5 Zustand Store

```typescript
interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null         // "移动卡片" → Tooltip 显示
  redoLabel: string | null
  update: (state: Partial<HistoryState>) => void
}

export const useHistoryStore = create<HistoryState>((set) => ({
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  update: (partial) => set(partial),
}))
```

### 14.6 Hook 封装

```typescript
function useHistory() {
  const { canUndo, canRedo, undoLabel, redoLabel } = useHistoryStore()

  const undo = useCallback(() => {
    const label = history.undo()
    if (label) toastStore.getState().show(`已撤销: ${label}`, 'info', 1500)
  }, [])

  const redo = useCallback(() => {
    const label = history.redo()
    if (label) toastStore.getState().show(`已重做: ${label}`, 'info', 1500)
  }, [])

  return { canUndo, canRedo, undoLabel, redoLabel, undo, redo }
}
```

### 14.7 不可撤销的操作

以下操作不进入撤销栈，但会弹确认对话框：

| 操作 | 理由 |
|------|------|
| 删除项目 | 影响太大，走确认弹窗 + 30秒撤回 Toast |
| 清空所有卡片 | 影响太大，走确认弹窗 |
| AI 设置变更 | 非画布操作，不属于画布历史 |
| 项目设置变更 | 非画布操作 |

### 14.8 持久化 SQLite 表

```sql
CREATE TABLE history (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    label       TEXT NOT NULL,
    data        TEXT NOT NULL,       -- JSON 序列化的命令数据
    timestamp   INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_history_project ON history(project_id, timestamp DESC);
```

- 每个项目最多保留 20 条历史记录
- 超出时删除最早的记录
- 项目删除时级联删除历史

---

## 15. 项目管理

### 15.1 数据结构

```typescript
interface Project {
  id: string
  title: string
  description?: string
  thumbnailPath?: string              // 自动生成的画布缩略图路径
  canvasBackground: CanvasBackground  // 画布背景设置
  snapConfig: SnapConfig              // 吸附配置
  lastViewport: Viewport              // 上次关闭时的视口位置（下次打开自动恢复）
  cardCount: number                   // 卡片数量（冗余字段，加快列表展示）
  autoSaveEnabled: boolean            // 是否启用自动保存 (默认 true)
  autoSaveInterval: number            // 自动保存间隔秒数 (默认 30)
  createdAt: number
  updatedAt: number
}
```

### 15.2 创建项目

#### 新建项目对话框

```
┌──────────────────────────────────────────────┐
│  新建项目                                     │
├──────────────────────────────────────────────┤
│                                              │
│  项目名称: [未命名画布_________________]      │
│  描    述: [_____________________________]   │
│                                              │
│  从模板创建:                                  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐│
│  │            │ │            │ │            ││
│  │   空白     │ │  AI 对话   │ │  创意脑暴  ││
│  │   画布     │ │  工作台    │ │  模板      ││
│  │            │ │            │ │            ││
│  │  (默认选中) │ │ 预置 3 张  │ │ 预置画框 + ││
│  │            │ │ 对话卡片   │ │ 便签布局   ││
│  └────────────┘ └────────────┘ └────────────┘│
│  ┌────────────┐ ┌────────────┐               │
│  │            │ │            │               │
│  │  视频脚本  │ │  素材收集  │               │
│  │  工作台    │ │  看板      │               │
│  │            │ │            │               │
│  │ 预置视频 + │ │ 预置画框 + │               │
│  │ 图片卡片   │ │ 图片卡片   │               │
│  └────────────┘ └────────────┘               │
│                                              │
│              [取消]   [创建]                  │
└──────────────────────────────────────────────┘
```

#### 项目模板定义

```typescript
interface ProjectTemplate {
  id: string
  name: string
  description: string
  thumbnail: string                    // 模板缩略图路径
  cards: Omit<CanvasCard, 'id' | 'createdAt' | 'updatedAt'>[]
  bookmarks: Omit<CanvasBookmark, 'id'>[]
  background: CanvasBackground
}
```

内置模板以 JSON 文件存储在应用资源目录，用户不可修改。
未来可支持用户将当前画布存为自定义模板。

#### 创建流程

```
用户点击 [创建]
  → 前端调 Rust Command: create_project
  → Rust 侧:
      1. 在 SQLite projects 表插入记录
      2. 如果选了模板 → 将模板的 cards 插入 cards 表
      3. 返回新项目 ID
  → 前端:
      1. projectStore 添加新项目
      2. 切换到新项目（加载画布数据）
      3. 如果有模板数据 → fitAll() 适应全部卡片
      4. Toast: "项目创建成功"
```

### 15.3 保存机制

#### 15.3.1 数据保存分层

```
┌─────────────────────────────────────────────────────────┐
│  保存层级              内容             触发时机          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  即时保存 (实时)       AI 对话消息      每条消息收到后   │
│                        AI 生成结果      生成完成后       │
│                                                         │
│  延迟保存 (批量)       卡片位置/尺寸    自动保存周期     │
│                        卡片数据变更     或手动 Ctrl+S    │
│                        画布设置变更                      │
│                                                         │
│  低频保存              项目元数据       切换项目/关闭时  │
│                        视口位置                          │
│                        书签数据                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### 15.3.2 自动保存管理器

```typescript
class AutoSaveManager {
  private dirty = false
  private dirtyCardIds = new Set<string>()
  private timer: number | null = null
  private saving = false

  markDirty(cardId?: string) {
    this.dirty = true
    if (cardId) this.dirtyCardIds.add(cardId)

    if (!this.timer && !this.saving) {
      const interval = projectStore.getState().currentProject?.autoSaveInterval ?? 30
      this.timer = window.setTimeout(() => this.flush(), interval * 1000)
    }
  }

  async forceSave() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
  }

  private async flush() {
    if (!this.dirty || this.saving) return
    this.saving = true
    this.timer = null

    try {
      const changedCardIds = [...this.dirtyCardIds]
      this.dirty = false
      this.dirtyCardIds.clear()

      // 仅保存变更的卡片（增量写入）
      if (changedCardIds.length > 0) {
        const changedCards = changedCardIds
          .map(id => cardStore.getState().cards.get(id))
          .filter(Boolean)
        await invoke('save_cards_batch', {
          projectId: projectStore.getState().currentProjectId,
          cards: changedCards,
        })
      }

      // 更新项目元数据
      await invoke('update_project_meta', {
        id: projectStore.getState().currentProjectId,
        cardCount: cardStore.getState().cards.size,
        lastViewport: canvasStore.getState().viewport,
        updatedAt: Date.now(),
      })

      uiStore.getState().setSaveStatus('saved')
    } catch (error) {
      console.error('Auto save failed:', error)
      uiStore.getState().setSaveStatus('error')
      this.dirty = true    // 标记为脏，下次重试
    } finally {
      this.saving = false
    }
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer)
  }
}

export const autoSave = new AutoSaveManager()
```

#### 15.3.3 保存状态指示

状态栏实时显示保存状态：

```typescript
type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error'
```

```
  ✓ 已保存              ● 未保存 (有修改)         ↻ 保存中...          ✗ 保存失败
  (灰色, 2s后淡出)       (黄色圆点)                (旋转动画)           (红色, 可点击重试)
```

#### 15.3.4 自动保存触发条件

| 触发条件 | 行为 |
|---------|------|
| 卡片位置/尺寸/内容变化 | markDirty → 启动定时器 |
| 定时器到期 (默认 30s) | flush → 增量写入 |
| 手动 Ctrl+S | forceSave → 立即写入 + Toast |
| 应用失焦 (切换到其他窗口) | forceSave → 静默写入 |
| 切换项目 | forceSave → 写入当前项目 → 加载新项目 |
| 应用即将关闭 | forceSave (同步写入，Tauri 生命周期钩子) |
| AI 对话消息到达 | 立即写入消息表 (不走 autoSave) |

### 15.4 手动保存 (Ctrl+S)

```typescript
async function handleManualSave() {
  uiStore.getState().setSaveStatus('saving')
  await autoSave.forceSave()
  toastStore.getState().show('项目已保存', 'success', 2000)
}
```

### 15.5 另存为

```typescript
async function saveAs() {
  // 1. 先保存当前项目的最新状态
  await autoSave.forceSave()

  // 2. 弹出另存为对话框
  const currentTitle = projectStore.getState().currentProject?.title ?? ''
  const newTitle = await showSaveAsDialog(currentTitle + ' - 副本')
  if (!newTitle) return      // 用户取消

  // 3. Rust 侧深拷贝项目
  const newProjectId = await invoke<string>('duplicate_project', {
    sourceId: projectStore.getState().currentProjectId,
    newTitle,
  })

  // 4. 刷新项目列表
  await projectStore.getState().refreshProjects()

  // 5. 切换到新项目
  await projectStore.getState().switchProject(newProjectId)

  toastStore.getState().show(`已另存为 "${newTitle}"`, 'success', 3000)
}
```

#### 另存为对话框

```
┌──────────────────────────────────┐
│  另存为                           │
├──────────────────────────────────┤
│                                  │
│  新项目名称:                      │
│  [AI 产品设计 - 副本________]     │
│                                  │
│  □ 包含操作历史                   │
│                                  │
│          [取消]   [保存]          │
└──────────────────────────────────┘
```

#### Rust 侧 duplicate_project 实现

```rust
#[tauri::command]
async fn duplicate_project(
    db: State<'_, Database>,
    source_id: String,
    new_title: String,
    include_history: bool,
) -> Result<String, String> {
    let new_id = generate_id();

    db.transaction(|tx| {
        // 1. 复制项目记录
        tx.execute(
            "INSERT INTO projects (id, title, description, canvas_background, snap_config, ...)
             SELECT ?, ?, description, canvas_background, snap_config, ...
             FROM projects WHERE id = ?",
            params![new_id, new_title, source_id],
        )?;

        // 2. 复制所有卡片（生成新 ID，更新 project_id）
        let cards = tx.query("SELECT * FROM cards WHERE project_id = ?", [&source_id])?;
        let id_map: HashMap<String, String> = HashMap::new();
        for card in cards {
            let old_id = card.get::<String>("id");
            let new_card_id = generate_id();
            id_map.insert(old_id, new_card_id.clone());
            // INSERT 新卡片 ...
        }

        // 3. 复制所有消息（更新 card_id 引用）
        // 4. 复制书签
        // 5. 可选：复制历史记录

        // 注意：媒体文件（图片/视频）不复制实体文件
        // 新卡片引用相同的文件路径
        // 未来如需独立可加引用计数

        Ok(new_id)
    })
}
```

### 15.6 项目列表管理

#### 项目列表组件

```typescript
interface ProjectListState {
  projects: Project[]
  currentProjectId: string | null
  searchQuery: string
  sortBy: 'updatedAt' | 'createdAt' | 'title'
  sortOrder: 'asc' | 'desc'
  loading: boolean
}
```

#### 项目缩略图自动生成

每次保存时生成画布缩略图，用于项目列表展示。

```typescript
async function generateProjectThumbnail(projectId: string) {
  // 1. 获取所有卡片的包围盒
  const bounds = cardStore.getState().getAllCardsBounds()
  if (!bounds) return

  // 2. 在 PixiJS 中渲染缩略视图
  //    使用 extract.canvas() 或 extract.pixels() 导出为 PNG
  const renderer = pixiApp.renderer
  const texture = renderer.generateTexture(canvasContainer, {
    region: bounds,
    resolution: 0.25,    // 缩小到 25% 尺寸
  })

  // 3. 保存到 thumbnails 目录
  const thumbnailPath = await invoke('save_thumbnail', {
    projectId,
    imageData: extractPixels(texture),
  })

  // 4. 更新项目元数据
  await invoke('update_project_meta', {
    id: projectId,
    thumbnailPath,
  })
}
```

#### 项目列表右键菜单

```
┌────────────────────┐
│  打开                │
│  在新标签页打开       │
├────────────────────┤
│  重命名              │
│  另存为副本           │
├────────────────────┤
│  导出为文件 (.aicvs)  │
├────────────────────┤
│  删除           ⚠️   │
└────────────────────┘
```

#### 项目删除流程

```
用户点击删除
  → 确认对话框: "确定要删除项目 'XXX' 吗？此操作不可撤销。"
  → 用户确认
  → 前端调 Rust Command: delete_project
  → Rust 侧:
      1. 软删除 (标记 deleted_at)
      2. 30 天后定时任务真正删除 + 清理媒体文件
  → 前端:
      1. 从项目列表移除
      2. 如果删除的是当前项目 → 切换到最近的项目
      3. Toast: "项目已删除" + [撤回] 按钮 (30秒有效)
```

### 15.7 项目导出 / 导入

#### 导出格式

导出为 `.aicvs` 文件（实质为 ZIP 包）。

```
project.aicvs (ZIP)
├── manifest.json               # 导出元数据
├── project.json                # 项目配置
├── cards.json                  # 所有卡片数据
├── messages.json               # 所有 AI 对话消息
├── bookmarks.json              # 书签数据
├── connections.json            # 卡片连线数据
└── media/                      # 媒体文件（可选，打包时选择）
    ├── images/
    ├── videos/
    └── thumbnails/
```

#### manifest.json

```json
{
  "version": "1.0.0",
  "appVersion": "1.0.0",
  "exportedAt": 1711324800000,
  "projectTitle": "AI 产品设计",
  "cardCount": 42,
  "includesMedia": true,
  "checksum": "sha256:..."
}
```

#### 导出对话框

```
┌────────────────────────────────────────────┐
│  导出项目                                   │
├────────────────────────────────────────────┤
│                                            │
│  导出格式:                                  │
│  ● 项目文件 (.aicvs)  完整可导入             │
│  ○ PNG 图片           画布截图               │
│  ○ PDF 文档           画布导出为文档         │
│                                            │
│  导出选项 (项目文件):                        │
│  ☑ 包含媒体文件 (图片/视频)                  │
│  ☑ 包含对话历史                              │
│  □ 包含操作历史                              │
│                                            │
│  预计文件大小: ~45 MB                        │
│                                            │
│           [取消]   [导出]                    │
└────────────────────────────────────────────┘
```

#### 导出实现

```typescript
async function exportProject(options: ExportOptions) {
  // 保存文件对话框
  const savePath = await save({
    filters: [
      options.format === 'aicvs'
        ? { name: 'AI Canvas Project', extensions: ['aicvs'] }
        : options.format === 'png'
        ? { name: 'PNG Image', extensions: ['png'] }
        : { name: 'PDF Document', extensions: ['pdf'] },
    ],
    defaultPath: `${project.title}.${options.format}`,
  })
  if (!savePath) return

  uiStore.getState().setExporting(true)

  try {
    await invoke('export_project', {
      projectId: projectStore.getState().currentProjectId,
      outputPath: savePath,
      format: options.format,
      includeMedia: options.includeMedia,
      includeMessages: options.includeMessages,
      includeHistory: options.includeHistory,
    })

    toastStore.getState().show('导出成功', 'success', 5000, {
      label: '打开文件夹',
      onClick: () => invoke('open_folder', { path: dirname(savePath) }),
    })
  } catch (error) {
    toastStore.getState().show(`导出失败: ${error}`, 'error', 0)
  } finally {
    uiStore.getState().setExporting(false)
  }
}
```

#### PNG 导出

```rust
// Rust 侧调用 PixiJS 的截图能力（通过 IPC 协调）
// 或使用 headless WebGL 渲染
// 简单方案：前端 PixiJS extract 截图后传给 Rust 保存

#[tauri::command]
async fn export_canvas_png(
    image_data: Vec<u8>,           // 前端传来的 PNG 数据
    output_path: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    std::fs::write(&output_path, &image_data)?;
    Ok(())
}
```

#### 导入实现

```typescript
async function importProject() {
  const filePath = await open({
    filters: [{ name: 'AI Canvas Project', extensions: ['aicvs'] }],
    multiple: false,
  })
  if (!filePath) return

  try {
    // Rust 侧解压并验证
    const result = await invoke<ImportResult>('import_project', {
      filePath,
    })

    // 导入前检查版本兼容性
    if (result.needsMigration) {
      const proceed = await showConfirm(
        `该文件由旧版本 (${result.appVersion}) 导出，需要数据迁移。是否继续？`
      )
      if (!proceed) return

      await invoke('migrate_imported_project', { projectId: result.projectId })
    }

    // 刷新项目列表并切换
    await projectStore.getState().refreshProjects()
    await projectStore.getState().switchProject(result.projectId)

    toastStore.getState().show(`已导入项目 "${result.projectTitle}"`, 'success', 3000)
  } catch (error) {
    toastStore.getState().show(`导入失败: ${error}`, 'error', 0)
  }
}
```

### 15.8 切换项目流程

```
用户点击侧边栏另一个项目 / 打开标签页
  → autoSave.forceSave()                保存当前项目
  → history.clear()                     清空撤销栈
  → cardStore.clear()                   清空卡片数据
  → canvasStore.reset()                 重置视口
  → projectStore.setCurrentProject(id)  更新当前项目
  → invoke('load_project', { id })      加载新项目数据
  → cardStore.loadCards(cards)           填充卡片
  → history.restore(id)                 恢复撤销栈
  → canvasStore.setViewport(project.lastViewport)  恢复上次视口
  → autoSave = new AutoSaveManager()    初始化新的自动保存
```

---

## 16. 扩展功能

### 16.1 卡片模板系统

用户将常用的卡片配置保存为模板，后续一键复用。

```typescript
interface CardTemplate {
  id: string
  name: string
  type: CanvasCard['type']
  icon?: string
  defaultSize: { width: number; height: number }
  presetData: Partial<ChatCardData | ImageCardData | VideoCardData | TextCardData>
  createdAt: number
}
```

#### 内置模板示例

| 模板名称 | 类型 | 预设内容 |
|---------|------|---------|
| GPT-4o 代码助手 | ai_chat | model: gpt-4o, systemPrompt: "你是一个代码助手..." |
| Claude 翻译官 | ai_chat | model: claude-3.5-sonnet, systemPrompt: "翻译..." |
| DALL-E 海报 | ai_image | provider: openai, size: 1024x1792 |
| Flux 写实照片 | ai_image | provider: flux, steps: 30 |
| Markdown 笔记 | text | content: "# 标题\n\n" |

#### 用户自定义模板

```
卡片右键 → "存为卡片模板"
  → 弹出命名输入框
  → 保存到 SQLite card_templates 表
  → 工具栏"模板"按钮下拉菜单中出现
```

#### 模板面板

```
┌──────────────────────────────┐
│  卡片模板                     │
├──────────────────────────────┤
│  内置模板                     │
│  ┌────────┐ ┌────────┐      │
│  │ GPT-4o │ │ Claude │      │
│  │ 代码助手│ │ 翻译官 │      │
│  └────────┘ └────────┘      │
│  ┌────────┐ ┌────────┐      │
│  │ DALL-E │ │ Flux   │      │
│  │ 海报   │ │ 写实照片│      │
│  └────────┘ └────────┘      │
│                              │
│  我的模板                     │
│  ┌────────────┐              │
│  │ 架构讨论     │  ← 右键可编辑/删除
│  │ GPT-4o+预设 │              │
│  └────────────┘              │
└──────────────────────────────┘

点击模板 → 在画布当前视口中心创建对应卡片
```

#### SQLite 存储

```sql
CREATE TABLE card_templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    default_width  REAL NOT NULL,
    default_height REAL NOT NULL,
    preset_data TEXT NOT NULL,       -- JSON
    is_builtin  INTEGER DEFAULT 0,
    created_at  INTEGER NOT NULL
);
```

### 16.2 卡片间拖拽交互

卡片之间支持内容拖拽，实现跨卡片的内容流转。

| 拖拽来源 | 目标 | 行为 |
|---------|------|------|
| AI 图片卡中的单张图 | 画布空白处 | 创建独立 `image_asset` 卡片 |
| AI 图片卡中的单张图 | AI 视频卡片 | 设为视频生成的参考图 |
| AI 图片卡中的单张图 | AI 对话卡片 | 将图片作为消息中的图片发送 (vision) |
| 图片资源卡 | AI 视频卡片 | 设为视频生成的参考图 |
| 文本卡片内容 | AI 对话卡片 | 将文本粘贴到输入框 |
| AI 对话卡片的消息 | 文本卡片 | 复制消息内容到文本卡片 |
| 外部文件 → 画布 | - | 图片 → image_asset 卡片；文本 → text 卡片 |
| 外部图片 URL → 画布 | - | 下载图片并创建 image_asset 卡片 |

#### 拖拽实现

```typescript
interface DragPayload {
  type: 'image' | 'text' | 'card_ref'
  source: {
    cardId: string
    field?: string               // 如 "images[2]" 指第 3 张生成图
  }
  data: {
    imagePath?: string
    text?: string
    cardId?: string
  }
}
```

- 使用 HTML5 Drag & Drop API
- 拖拽开始时设置 `dataTransfer` 的自定义类型
- 目标卡片通过 `onDragOver` 判断是否可接受该 payload
- 可接受时卡片边框高亮 (蓝色 glow)
- 释放时触发对应的操作

#### 外部文件拖入

```typescript
// CanvasContainer.tsx
function handleExternalDrop(e: DragEvent) {
  e.preventDefault()
  const files = Array.from(e.dataTransfer?.files ?? [])

  for (const file of files) {
    const canvasPos = screenToCanvas(e.clientX, e.clientY)

    if (file.type.startsWith('image/')) {
      // 1. Rust 侧保存到 media/images/ 并生成缩略图
      // 2. 创建 image_asset 卡片
      handleImageDrop(file, canvasPos)
    } else if (file.type === 'text/plain' || file.name.endsWith('.md')) {
      // 读取文件内容，创建 text 卡片
      handleTextDrop(file, canvasPos)
    }
  }
}
```

### 16.3 多标签页画布

同时打开多个项目，类似浏览器 Tab 切换。

```typescript
interface TabState {
  id: string                       // Tab ID = 项目 ID
  projectId: string
  title: string
  dirty: boolean                   // 是否有未保存修改
  active: boolean                  // 是否当前激活
}

// uiStore 中管理
interface UIState {
  tabs: TabState[]
  activeTabId: string | null
  maxTabs: number                  // 最多打开标签数 (默认 8)
}
```

#### 标签页行为

```
┌──────────┬──────────┬──────────┬───┐
│ 项目A  ✕ │●项目B  ✕ │ 项目C  ✕ │ + │
└──────────┴──────────┴──────────┴───┘
               ↑
          蓝色下划线 = 当前激活
          ● = 有未保存修改

操作:
  点击标签         切换到该项目
  ✕ 关闭           保存后关闭 (如有修改弹确认)
  + 新建           打开新建项目对话框
  中键点击         快速关闭
  拖拽标签         调整顺序
  双击标签         重命名项目
  右键标签         关闭 / 关闭其他 / 关闭右侧
  侧边栏双击项目   在新标签页打开
```

#### 资源隔离

每个标签页拥有独立的：
- `cardStore` 实例（卡片数据）
- `canvasStore` 实例（视口状态）
- `historyStore` 实例（撤销栈）
- `AutoSaveManager` 实例

共享的：
- `projectStore`（项目列表）
- `aiStore`（AI 配置）
- `settingsStore`（全局设置）
- `uiStore`（UI 状态）

#### 性能优化

- 非活跃标签页暂停 PixiJS 渲染（`app.ticker.stop()`）
- 非活跃标签页的 DOM 卡片不渲染（`display: none` 或卸载）
- 切换标签页时恢复渲染并重建 DOM 卡片
- 内存压力大时自动回收最久未访问标签页的 PixiJS 纹理缓存

### 16.4 快速笔记 (Quick Note)

全局快捷键 `Alt+N`，在任何时候快速创建便签。

```
按下 Alt+N:
  → 在屏幕中央弹出迷你输入浮窗

  ┌────────────────────────────────────────┐
  │  快速笔记                          ✕  │
  ├────────────────────────────────────────┤
  │                                        │
  │  [输入内容，按 Enter 创建便签...___]    │
  │                                        │
  │  创建位置: ○ 视口中心  ● 鼠标位置      │
  └────────────────────────────────────────┘

按下 Enter:
  → 在选定位置创建 sticky_note 卡片
  → 内容为输入的文字
  → 浮窗关闭
  → 画布平滑滚动到新卡片位置

按下 Shift+Enter:
  → 换行（支持多行输入）

按下 Escape:
  → 取消，关闭浮窗
```

### 16.5 性能监控面板 (开发模式)

仅在开发模式下显示，帮助调试性能问题。

```typescript
interface PerfMetrics {
  fps: number                      // 当前帧率
  renderTime: number               // 上一帧渲染耗时 (ms)
  domCardCount: number             // 当前 DOM 层卡片数
  pixiSpriteCount: number          // PixiJS Sprite 数
  textureMemory: number            // PixiJS 纹理内存 (MB)
  viewportQueryTime: number        // 上一次视口查询耗时 (ms)
  ipcCallCount: number             // 近 1 秒内 IPC 调用次数
  sqliteSize: number               // 数据库文件大小 (MB)
  totalCards: number               // 项目总卡片数
}
```

```
┌─────────────────────────────────────┐
│  Performance (Ctrl+Shift+P)         │
├─────────────────────────────────────┤
│  FPS: 60 ▇▇▇▇▇▇▇▇▇▇               │
│  Render: 2.3ms                      │
│  ─────────────────────────────────  │
│  DOM Cards:    12 / 234 total       │
│  PixiJS:       222 sprites          │
│  Textures:     128 MB               │
│  ─────────────────────────────────  │
│  Viewport Q:   2.3 ms              │
│  IPC/sec:      15                   │
│  SQLite:       45 MB               │
└─────────────────────────────────────┘
```

- `Ctrl+Shift+P` 切换显示/隐藏
- 浮动在右上角，半透明背景
- 每 500ms 刷新数据
- 生产环境不打包该组件

---

## 17. 功能优先级排序

### P0 - 必做（MVP 核心功能）

不实现则产品无法使用的基础功能。

| 功能 | 章节 | 预估工时 | 理由 |
|------|------|---------|------|
| 项目创建/列表/切换 | 15.2, 15.6 | 3天 | 无项目管理就无法使用 |
| 手动保存 (Ctrl+S) | 15.4 | 1天 | 数据安全的底线 |
| 自动保存 | 15.3 | 2天 | 防止数据丢失 |
| 撤销/重做 (基础版) | 14 | 3天 | 用户心智模型中的基础预期 |
| 右键上下文菜单 | 13.2 | 2天 | 最基本的交互入口 |
| Toast 通知 | 13.6 | 1天 | 操作反馈的基础设施 |

### P1 - 重要（核心体验提升）

不实现可以用，但体验严重缺失。

| 功能 | 章节 | 预估工时 | 理由 |
|------|------|---------|------|
| 对齐辅助线/吸附 | 12.2 | 2天 | 排版体验的核心 |
| 搜索功能 | 13.5 (搜索面板) | 2天 | 卡片多了之后必须有 |
| 另存为 | 15.5 | 1天 | 项目管理基础操作 |
| 浮动工具栏 | 13.3 | 2天 | 高频操作效率 |
| 侧边栏增强 (大纲) | 13.5 | 2天 | 画布内容导航 |
| 深色/浅色主题 | 13.4 | 2天 | 用户基本期望 |
| 保存状态指示 | 15.3.3 | 0.5天 | 数据安全感知 |

### P2 - 锦上添花（体验差异化）

有了更好，没有也不影响核心使用。

| 功能 | 章节 | 预估工时 | 理由 |
|------|------|---------|------|
| 画布书签/导航 | 12.4 | 2天 | 大画布体验提升明显 |
| 命令面板 (Ctrl+K) | 13.1 | 2天 | 高级用户效率 |
| 卡片分组/画框 | 12.1 | 3天 | 组织能力 |
| 画布背景自定义 | 12.6 | 0.5天 | 个性化 |
| 项目导出/导入 | 15.7 | 3天 | 数据可移植性 |
| 快速笔记 (Alt+N) | 16.4 | 0.5天 | 便捷性 |
| 外部文件拖入 | 16.2 | 1天 | 自然交互 |
| 撤销/重做持久化 | 14.8 | 1天 | 跨重启恢复 |

### P3 - 远期规划

复杂度较高或需求不确定，待产品验证后决定。

| 功能 | 章节 | 预估工时 | 理由 |
|------|------|---------|------|
| 自动布局 | 12.3 | 2天 | 锦上添花 |
| 演示模式 | 12.7 | 2天 | 差异化亮点 |
| 多标签页 | 16.3 | 5天 | 架构复杂度高 |
| 卡片连接线 | 12.5 | 3天 | 需求不确定 |
| 卡片模板系统 | 16.1 | 2天 | 用户量起来再做 |
| 卡片间拖拽交互 | 16.2 | 3天 | 交互复杂度高 |
| 性能监控面板 | 16.5 | 1天 | 仅开发用 |
| PNG/PDF 导出 | 15.7 | 2天 | VIP 功能 |
| 项目缩略图生成 | 15.6 | 1天 | 美观性 |

### 建议开发顺序

```
Phase 1 (MVP):  P0 全部                             ~12天
Phase 2 (体验): P1 全部                             ~11.5天
Phase 3 (完善): P2 中选优先级最高的 5-6 项            ~10天
Phase 4 (远期): 根据用户反馈从 P3 中选择              持续迭代
```
