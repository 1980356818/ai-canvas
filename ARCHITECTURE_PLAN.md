# AI 无限画布 — 万级节点架构升级计划

## 一、现状分析

### 1.1 技术栈

| 层 | 技术 | 版本 |
|----|------|------|
| 前端框架 | React | 19 |
| 构建工具 | Vite | 6 |
| 样式方案 | Tailwind CSS | 4 |
| 状态管理 | Zustand | 5 |
| 桌面壳 | Tauri 2 (Rust) | 2 |
| 本地存储 | SQLite (rusqlite) | — |
| 图标 | lucide-react | — |

### 1.2 源码结构

```
ai-canvas/src/
├── App.tsx                          # 顶层路由 (home / canvas / projects)
├── main.tsx                         # 入口
│
├── stores/                          # Zustand 状态
│   ├── canvasStore.ts               # 视口、选中、拖拽、工具模式
│   ├── cardStore.ts                 # 卡片 CRUD、层级管理
│   ├── connectionStore.ts           # 连线 CRUD、草稿连线
│   ├── projectStore.ts              # 项目列表
│   ├── uiStore.ts                   # UI 状态 (Toast、右键菜单、保存状态)
│   ├── settingsStore.ts             # 设置 (主题、API Key)
│   └── agentStore.ts                # Agent 对话
│
├── features/
│   ├── canvas/
│   │   ├── CanvasContainer.tsx      # 画布容器 + CardLayer + 输入事件
│   │   ├── ConnectionLayer.tsx      # SVG 连线层 (Wire + DraftWire)
│   │   ├── ZoomControls.tsx         # 缩放控制
│   │   ├── ImageToolbar.tsx         # 图片操作栏
│   │   ├── QuickCreateMenu.tsx      # 快速创建菜单
│   │   └── hooks/
│   │       ├── useViewport.ts       # 平移/缩放 (CSS transform)
│   │       ├── useSelection.ts      # 框选
│   │       └── useKeyboardShortcuts.ts
│   │
│   ├── cards/
│   │   ├── CardShell.tsx            # 卡片壳 (拖拽/缩放/端口/选中)
│   │   ├── CardContent.tsx          # 卡片内容路由
│   │   ├── AIChatCard.tsx           # AI 对话卡
│   │   ├── TextCard.tsx             # 文本卡
│   │   └── StickyNoteCard.tsx       # 便签卡
│   │
│   ├── editor/                      # 浮动编辑器 (FloatingEditor, ChatEditor, MediaEditor...)
│   ├── agent/                       # Agent 面板
│   ├── sidebar/                     # 侧边栏
│   ├── overlays/                    # 弹窗 (右键菜单、设置、确认框、Toast)
│   ├── home/                        # 首页
│   └── projects/                    # 项目列表页
│
├── agent/                           # Agent 运行时、工具、Provider
├── services/                        # 服务层 (模型、任务)
├── lib/
│   ├── tauri.ts                     # Tauri IPC 封装
│   ├── autoSave.ts                  # 自动保存 (脏标记 + 批量写入)
│   ├── history.ts                   # 撤销/重做
│   ├── dataFlow.ts                  # 数据流传播 (卡片间数据注入)
│   ├── media.ts                     # 媒体文件管理
│   ├── clipboard.ts                 # 剪贴板
│   ├── templateFactory.ts           # 工作流模板工厂
│   └── utils.ts                     # cn() 等工具函数
│
├── shared/
│   ├── types.ts                     # CardType 类型定义
│   ├── constants.ts                 # 卡片默认值、颜色、模板
│   └── MarkdownContent.tsx          # Markdown 渲染
│
├── config/
│   └── model-ref-images.ts          # 模型参考图插槽配置
│
└── app/
    ├── TitleBar.tsx                  # 标题栏
    └── ErrorBoundary.tsx            # 错误边界
```

### 1.3 当前渲染模型

```
                          CanvasContainer (div, CSS transform)
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
              CardLayer (div)   ConnectionLayer   UI Overlays
              全部卡片 DOM       (SVG)             (FloatingEditor,
                    │               │               ZoomControls...)
            ┌───────┼───────┐       │
        CardShell×N    CardThumbnail×M   Wire×K (每条 5-6 个 SVG 元素)
        (完整 DOM)     (简化 div)
```

**性能瓶颈定位：**

1. **CardLayer** — 视口裁剪是线性扫描 `O(N)`，无空间索引
2. **CardShell** — 每张卡含 13+ DOM 节点（边框渐变、端口、缩放手柄、拖拽句柄...）
3. **CardThumbnail** — 缩略图仍然是 DOM 元素
4. **ConnectionLayer** — 每条连线渲染 5-6 个 SVG 元素（命中区、辉光、基线、脉冲、选中高亮、删除按钮）
5. **SVG gradients** — 每条连线 2 个 `<linearGradient>` 定义

> 万级卡片 + 万级连线 = **10 万+ DOM/SVG 元素** → 浏览器主线程崩溃

---

## 二、架构方案选型

### 2.1 候选方案对比

| 方案 | 核心思路 | 万级实测 | 改动量 | 风险 |
|------|---------|---------|--------|------|
| A. 自建混合渲染 | 缩小→Canvas / 放大→DOM | 理论可行 | 中 | 中（需自建 Canvas 渲染器） |
| B. @gravity-ui/graph | React + Canvas/HTML 自动切换 | 11W 节点 60ms/帧 | 大 | 低（成熟库） |
| C. NodeFlow (@nodeflow/core) | Canvas-only 流编辑器 | 宣称千级 | 大 | 高（较新，未经验证） |
| D. G6 v5 | Canvas + WebGL | **已知严重回退** | 大 | **极高（2K 崩溃）** |

### 2.2 决策：方案 A — 自建混合渲染层

**选择理由：**

1. **改动最小，风险最低** — 不替换框架，在现有代码上增量添加
2. **完全掌控** — 你的卡片交互极为定制化（拖拽放图、参考图插槽、数据流连线），任何第三方库都无法直接支持这些
3. **@gravity-ui/graph 虽然性能最强，但它是节点图编辑器，不是无限画布** — 它的 Block 模型不支持你的卡片丰富交互（富文本编辑、图片预览、模型选择、参考图拖放等）
4. **你的现有代码质量很高** — Store 设计、数据流、自动保存、历史系统都写得好，没有必要推翻重来

**核心思路：**

```
zoom > 0.25  →  DOM 渲染（现有逻辑，只改视口裁剪为 R-tree）
zoom ≤ 0.25  →  Canvas 鸟瞰层覆盖（1 个 <canvas>，绘制全部卡片为色块 + 连线为曲线）
```

---

## 三、架构设计

### 3.1 分层架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CanvasContainer                             │
│                                                                     │
│  zoom > 0.25                            zoom ≤ 0.25                │
│  ┌───────────────────────────┐         ┌──────────────────────┐    │
│  │   DOM Layer (现有逻辑)     │         │   CanvasBirdView     │    │
│  │                           │   ←→    │   (1 个 <canvas>)     │    │
│  │   CardLayer               │  自动    │                      │    │
│  │     CardShell × visible   │  切换    │   drawCards()         │    │
│  │     CardThumbnail × lod   │         │   drawConnections()   │    │
│  │   ConnectionLayer (SVG)   │         │   drawSelection()     │    │
│  │   FloatingEditor          │         │   drawMinimap()       │    │
│  └───────────────────────────┘         └──────────────────────┘    │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     SpatialIndex (R-tree)                     │  │
│  │   插入/删除/查询可见区域内的卡片 — O(log N) 替代 O(N) 扫描    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     Zustand Stores (不变)                     │  │
│  │   canvasStore / cardStore / connectionStore / ...              │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 新增/修改文件清单

```
ai-canvas/src/
├── features/canvas/
│   ├── CanvasContainer.tsx           [修改] 增加层切换逻辑
│   ├── CardLayer.tsx                 [新增] 从 CanvasContainer 拆出，独立组件
│   ├── CanvasBirdView.tsx            [新增] Canvas 鸟瞰渲染器
│   ├── ConnectionLayer.tsx           [修改] 缩放 > 0.25 时才挂载
│   └── hooks/
│       ├── useViewport.ts            [修改] 增加 detailLevel 计算
│       └── useSpatialIndex.ts        [新增] R-tree 空间索引管理
│
├── lib/
│   ├── spatial-index.ts              [新增] R-tree 实现（基于 rbush）
│   ├── canvas-renderer.ts            [新增] Canvas 2D 绘制函数
│   └── connection-renderer.ts        [新增] Canvas 连线绘制函数
│
├── shared/
│   └── constants.ts                  [修改] 新增 LOD 阈值常量
```

**不动的文件（全部复用）：**

- `stores/*` — 全部 Store 保持不变
- `features/cards/*` — 所有卡片组件保持不变
- `features/editor/*` — 所有编辑器保持不变
- `features/agent/*` — Agent 系统不变
- `features/overlays/*` — 弹窗系统不变
- `lib/autoSave.ts` — 自动保存不变
- `lib/history.ts` — 撤销重做不变
- `lib/dataFlow.ts` — 数据流不变
- `lib/tauri.ts` — Tauri IPC 不变
- `agent/*` — Agent 运行时不变

### 3.3 代码设计

#### 3.3.1 空间索引 (`lib/spatial-index.ts`)

使用 `rbush` 库实现 R-tree：

```typescript
import RBush from "rbush";

export interface SpatialItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
}

export class SpatialIndex {
  private tree = new RBush<SpatialItem>();
  private items = new Map<string, SpatialItem>();

  upsert(id: string, x: number, y: number, w: number, h: number) {
    const prev = this.items.get(id);
    if (prev) this.tree.remove(prev);
    const item: SpatialItem = { minX: x, minY: y, maxX: x + w, maxY: y + h, id };
    this.tree.insert(item);
    this.items.set(id, item);
  }

  remove(id: string) {
    const item = this.items.get(id);
    if (item) {
      this.tree.remove(item);
      this.items.delete(id);
    }
  }

  query(left: number, top: number, right: number, bottom: number): string[] {
    return this.tree
      .search({ minX: left, minY: top, maxX: right, maxY: bottom })
      .map((item) => item.id);
  }

  clear() {
    this.tree.clear();
    this.items.clear();
  }

  get size() {
    return this.items.size;
  }
}
```

#### 3.3.2 Canvas 鸟瞰渲染器 (`features/canvas/CanvasBirdView.tsx`)

核心思路：1 个 `<canvas>` 绘制全部卡片和连线，无 DOM 开销。

```tsx
interface CanvasBirdViewProps {
  viewport: Viewport;
  onViewportChange: (partial: Partial<Viewport>) => void;
}

export default function CanvasBirdView({ viewport, onViewportChange }: CanvasBirdViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  // 从 store 获取数据（只订阅 layoutVersion 以避免无意义重绘）
  const cards = useCardStore((s) => s.cards);
  const connections = useConnectionStore((s) => s.connections);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = viewport.width * dpr;
      canvas.height = viewport.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewport.width, viewport.height);

      ctx.save();
      ctx.translate(viewport.x, viewport.y);
      ctx.scale(viewport.zoom, viewport.zoom);

      // 1. 绘制连线（先画，在卡片下方）
      drawConnections(ctx, connections, cards);

      // 2. 绘制卡片（色块 + 标题）
      drawCards(ctx, cards, selectedCardIds, viewport.zoom);

      ctx.restore();
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [viewport, cards, connections, selectedCardIds]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0"
      style={{ width: "100%", height: "100%" }}
    />
  );
}
```

#### 3.3.3 Canvas 绘制函数 (`lib/canvas-renderer.ts`)

```typescript
import type { CanvasCard } from "@/stores/cardStore";
import { TYPE_COLORS } from "@/shared/constants";

export function drawCards(
  ctx: CanvasRenderingContext2D,
  cards: Map<string, CanvasCard>,
  selectedIds: Set<string>,
  zoom: number,
) {
  const sorted = Array.from(cards.values()).sort((a, b) => a.zIndex - b.zIndex);
  const showTitle = zoom > 0.12;

  for (const card of sorted) {
    const color = card.color || TYPE_COLORS[card.type] || "#6B7280";

    // 卡片填充
    ctx.fillStyle = color + "30"; // 15% 不透明度
    ctx.strokeStyle = selectedIds.has(card.id) ? "#818cf8" : color + "60";
    ctx.lineWidth = selectedIds.has(card.id) ? 3 : 1.5;

    roundRect(ctx, card.x, card.y, card.width, card.height, 8);
    ctx.fill();
    ctx.stroke();

    // 标题文字（zoom 足够大时才绘制）
    if (showTitle && card.title) {
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "bold 13px system-ui";
      ctx.textBaseline = "top";
      ctx.fillText(
        card.title,
        card.x + 8,
        card.y + 6,
        card.width - 16,
      );
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
```

#### 3.3.4 CanvasContainer 层切换 (`CanvasContainer.tsx` 修改)

```tsx
// 新增的层切换逻辑
const BIRDVIEW_ZOOM_THRESHOLD = 0.25;
const detailLevel = viewport.zoom > BIRDVIEW_ZOOM_THRESHOLD ? "dom" : "canvas";

return (
  <div ref={containerRef} /* ...现有 props... */>
    {detailLevel === "dom" ? (
      // 现有 DOM 渲染（CardLayer + ConnectionLayer）
      <div data-canvas-background style={{ transform: `...` }}>
        <CardLayer projectId={currentProjectId} viewport={viewport} />
        {currentProjectId && <ConnectionLayer ... />}
      </div>
    ) : (
      // Canvas 鸟瞰模式
      <CanvasBirdView
        viewport={viewport}
        onViewportChange={setViewport}
      />
    )}

    {/* 以下 UI 元素始终显示（不受层切换影响） */}
    <ZoomControls zoom={viewport.zoom} />
    {detailLevel === "dom" && <FloatingEditor />}
    {detailLevel === "dom" && <ImageToolbar />}
  </div>
);
```

### 3.4 CardLayer 拆分重构

将 `CardLayer` 从 `CanvasContainer.tsx` 拆出为独立组件，并升级视口裁剪为 R-tree 查询。

**当前**（`CanvasContainer.tsx` 内嵌，线性扫描）：
```typescript
// O(N) 遍历所有卡片判断可见性
for (const c of projectCards) {
  if (c.x + c.width <= worldLeft || c.x >= worldRight || ...) continue;
  // ...
}
```

**重构后**（`CardLayer.tsx` 独立文件，R-tree 查询）：
```typescript
// O(log N + K) 查询可见区域，K = 可见卡片数
const visibleIds = spatialIndex.query(worldLeft, worldTop, worldRight, worldBottom);
const visibleCards = visibleIds
  .map((id) => cards.get(id))
  .filter(Boolean)
  .sort((a, b) => a.zIndex - b.zIndex);
```

---

## 四、实施计划

### Phase 1：空间索引 + CardLayer 拆分（1-2 天）

**目标**：DOM 模式下的视口裁剪从 O(N) 降到 O(log N)

| 步骤 | 文件 | 操作 |
|------|------|------|
| 1.1 | 安装 `rbush` | `pnpm add rbush && pnpm add -D @types/rbush` |
| 1.2 | `lib/spatial-index.ts` | 新建 R-tree 封装 |
| 1.3 | `hooks/useSpatialIndex.ts` | 新建 hook，监听 cardStore 变化自动更新索引 |
| 1.4 | `features/canvas/CardLayer.tsx` | 从 CanvasContainer 拆出，改用 R-tree 查询 |
| 1.5 | `CanvasContainer.tsx` | 引用拆出的 CardLayer |

**验证**：在 DOM 模式下，5000 张卡片仍能流畅平移/缩放

### Phase 2：Canvas 鸟瞰层（2-3 天）

**目标**：缩放 ≤ 0.25 时自动切换到 Canvas 渲染，万级卡片零延迟

| 步骤 | 文件 | 操作 |
|------|------|------|
| 2.1 | `lib/canvas-renderer.ts` | 新建卡片 Canvas 绘制 |
| 2.2 | `lib/connection-renderer.ts` | 新建连线 Canvas 绘制 |
| 2.3 | `features/canvas/CanvasBirdView.tsx` | 新建 Canvas 鸟瞰组件 |
| 2.4 | `CanvasContainer.tsx` | 增加 `detailLevel` 切换逻辑 |
| 2.5 | `shared/constants.ts` | 新增 `BIRDVIEW_ZOOM_THRESHOLD` 常量 |

**验证**：10000 张卡片 + 10000 条连线，缩放到全局视图后流畅平移/缩放

### Phase 3：Canvas 交互增强（1-2 天）

**目标**：鸟瞰模式下支持基本交互（点击选中、框选、右键菜单）

| 步骤 | 文件 | 操作 |
|------|------|------|
| 3.1 | `CanvasBirdView.tsx` | 增加点击检测（R-tree hitTest） |
| 3.2 | `CanvasBirdView.tsx` | 增加框选绘制 |
| 3.3 | `CanvasBirdView.tsx` | 增加右键菜单触发 |
| 3.4 | `CanvasBirdView.tsx` | 增加拖拽移动卡片（批量） |

### Phase 4：过渡动画 + 打磨（1 天）

| 步骤 | 文件 | 操作 |
|------|------|------|
| 4.1 | `CanvasContainer.tsx` | DOM ↔ Canvas 切换时的渐变过渡 |
| 4.2 | `CanvasBirdView.tsx` | 选中态高亮样式优化 |
| 4.3 | `CanvasBirdView.tsx` | 连线流动动画（简化版，Canvas drawDash） |
| 4.4 | 全局 | 边界情况测试 + 性能基线测量 |

### Phase 5（可选）：OffscreenCanvas + Worker

如果 Phase 2-3 后性能仍不满意（超过 5 万节点），可以将绘制逻辑移到 OffscreenCanvas + Web Worker：

```
主线程: viewport 变化 → postMessage(viewport) → Worker
Worker: drawCards/drawConnections → transferToImageBitmap
主线程: canvas.transferFromImageBitmap(bitmap)
```

---

## 五、性能预估

| 阶段 | 卡片数量 | 总览全局 FPS | 技术原理 |
|------|---------|-------------|---------|
| 当前 | 1000+ | 卡死 | 全部 DOM 渲染 |
| Phase 1 完成 | 3000+ | 30-60 | R-tree 裁剪减少 DOM 节点 |
| Phase 2 完成 | 10000+ | 60 | Canvas 绘制零 DOM |
| Phase 5 完成 | 50000+ | 60 | 离屏线程渲染 |

**关键指标**：Canvas 绘制 10000 个圆角矩形 + 10000 条贝塞尔曲线 < 5ms（远低于 16ms 帧预算）

---

## 六、依赖变更

### 新增

| 包 | 用途 | 大小 |
|----|------|------|
| `rbush` | R-tree 空间索引 | 6 KB (min+gzip) |

### 删除

无。不确定能否删除的依赖一律保留。

### 不动

所有现有依赖保持不变。

---

## 七、需要删除的代码

经全面审查，**不建议删除任何现有文件**。原因：

1. 所有现有代码都在使用中，没有废弃文件
2. DOM 渲染模式在 zoom > 0.25 时继续使用
3. Store / Agent / DataFlow / History 等全部复用
4. `dist/` 目录是构建产物，由构建工具管理

唯一的「代码移动」是将 `CardLayer` 和 `CardThumbnail` 从 `CanvasContainer.tsx` 拆到独立文件 `CardLayer.tsx`。

---

## 八、目录结构（最终态）

```
ai-canvas/src/
├── stores/                          # ✅ 全部不变
├── features/
│   ├── canvas/
│   │   ├── CanvasContainer.tsx      # 🔧 修改：增加层切换
│   │   ├── CardLayer.tsx            # ✨ 新增：从 CanvasContainer 拆出
│   │   ├── CanvasBirdView.tsx       # ✨ 新增：Canvas 鸟瞰渲染
│   │   ├── ConnectionLayer.tsx      # 🔧 修改：仅 DOM 模式挂载
│   │   ├── ZoomControls.tsx         # ✅ 不变
│   │   ├── ImageToolbar.tsx         # ✅ 不变
│   │   ├── QuickCreateMenu.tsx      # ✅ 不变
│   │   └── hooks/
│   │       ├── useViewport.ts       # 🔧 修改：增加 detailLevel
│   │       ├── useSelection.ts      # ✅ 不变
│   │       ├── useSpatialIndex.ts   # ✨ 新增：R-tree 管理
│   │       └── useKeyboardShortcuts.ts  # ✅ 不变
│   │
│   ├── cards/                       # ✅ 全部不变
│   ├── editor/                      # ✅ 全部不变
│   ├── agent/                       # ✅ 全部不变
│   ├── sidebar/                     # ✅ 全部不变
│   ├── overlays/                    # ✅ 全部不变
│   ├── home/                        # ✅ 全部不变
│   └── projects/                    # ✅ 全部不变
│
├── lib/
│   ├── spatial-index.ts             # ✨ 新增：R-tree 封装
│   ├── canvas-renderer.ts           # ✨ 新增：Canvas 卡片绘制
│   ├── connection-renderer.ts       # ✨ 新增：Canvas 连线绘制
│   ├── tauri.ts                     # ✅ 不变
│   ├── autoSave.ts                  # ✅ 不变
│   ├── history.ts                   # ✅ 不变
│   ├── dataFlow.ts                  # ✅ 不变
│   ├── media.ts                     # ✅ 不变
│   ├── clipboard.ts                 # ✅ 不变
│   ├── templateFactory.ts           # ✅ 不变
│   └── utils.ts                     # ✅ 不变
│
├── agent/                           # ✅ 全部不变
├── services/                        # ✅ 全部不变
├── shared/                          # 🔧 constants.ts 新增阈值常量
├── config/                          # ✅ 不变
└── app/                             # ✅ 不变
```

**统计：**
- ✅ 不变：67 个文件
- 🔧 修改：4 个文件（CanvasContainer, ConnectionLayer, useViewport, constants）
- ✨ 新增：6 个文件（CardLayer, CanvasBirdView, useSpatialIndex, spatial-index, canvas-renderer, connection-renderer）
- ❌ 删除：0 个文件

---

## 九、后续扩展路径

完成 Phase 1-4 后，如果未来需求继续增长，可以按需启动：

| 方向 | 触发条件 | 方案 |
|------|---------|------|
| 超大规模 (5W+) | 卡片超过 5 万 | Phase 5: OffscreenCanvas + Worker |
| WebGL 渲染 | Canvas 2D 仍不够快 | 引入 PixiJS 替换 Canvas 2D 绘制 |
| 布局引擎 | 需要自动排列卡片 | 引入 `@antv/layout` 或 `dagre` |
| 协同编辑 | 多人同时编辑画布 | CRDT (Yjs) 替换 Zustand 部分状态 |
| 迁移到 @gravity-ui/graph | 需要完整图编辑生态 | Phase 2 的 Canvas 层可直接复用为过渡方案 |

---

## 十、核心设计原则

1. **数据层不动** — Store 是整个应用的脊柱，绝不因渲染层变化而修改
2. **DOM 模式保留** — 放大查看/编辑时必须用 DOM，Canvas 无法承载富文本编辑器
3. **切换透明** — 用户感知不到 DOM ↔ Canvas 切换，只觉得「缩小后变快了」
4. **增量推进** — 每个 Phase 独立可验证，不需要全部完成才能上线
5. **不删代码** — 不确定是否废弃的代码一律保留
