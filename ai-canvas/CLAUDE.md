# ai-canvas — 项目约定

AI 无限画布,Tauri (Rust) + React/TS 前端。卡片是富交互 DOM,画布用 CSS transform 平移/缩放(非 canvas/WebGL)。

> 本文件目前聚焦**画布视口/缩放渲染契约**——这是最容易踩坑、且会直接导致缩放/平移卡顿的部分。改 `src/features/canvas/**`、`src/stores/canvasStore.ts`、`src/main.css` 的画布相关样式前必须遵守。其余领域约定可后续补充。

## 画布视口渲染契约(硬规则)

缩放/平移卡顿的根因是「`transform: scale()` 作用在含大量 DOM 的层上 → 每帧按新 scale 重栅格化整棵树」。下列规则把它从根上消除,**新增/修改画布渲染代码必须全部满足**,否则卡顿会复发。

1. **双层变换,禁止退回单层。** 视口变换分两层(见 `CanvasContainer` 的 `showDom` 块):
   - 外层 `.vp-pan-layer`:`translate3d(var(--vp-x),var(--vp-y),0) scale(var(--vp-gpu))` —— 平移 + GPU 视觉缩放。
   - 内层 `.vp-render-layer`:`scale(var(--vp-render))` —— 内容栅格化基准。
   - 实际缩放 = `--vp-gpu × --vp-render`(数学上等价单层 `scale(zoom)`,卡片像素位置不变)。
   - 内容(GroupLayer/CardLayer/ConnectionLayer)只能挂在内层里。**不要**给内容层直接写 `scale(zoom)`,**不要**新增依赖单层结构的代码。

2. **手势中冻结 `--vp-render`。** `useViewport` 的缩放路径只改 `--vp-gpu`(= zoom/renderZoom),让浏览器 GPU 缩放已栅格化的内层纹理,**不重栅格化**;停手 ~180ms 后才提交 `render=zoom, gpu=1` 重栅格化一次恢复清晰;缩放偏离基准 >2× 时中途重基准一次(限制模糊 ≤2×)。
   - 关键不变量:**手势进行中绝不写 `--vp-render`** —— 包括 store 每 80ms commit 经过的 `useLayoutEffect`(它按 `gestureRenderZoom` 分流)。改 `useViewport` 时务必维持这条。

3. **高频视口更新只走 imperative,禁止触发 React 重渲染。** 缩放/平移/拖拽期间的实时坐标走 `liveViewport`(共享对象)+ `subscribeViewport(cb)`。回调**必须 rAF 节流**(`scheduled` flag + `requestAnimationFrame(sync)`),sync 内直接写 `el.style`。浮层(`ImageToolbar`/`VideoToolbar`/`FloatingEditor`)的跟随定位全部照此,新浮层也必须照此,不得用 React state 跟随 60fps 更新。

4. **store `viewport` 是低频的。** 它只在节流提交时变(≤ 每 80ms),且**只有 `useViewport` 订阅整个 `viewport` 对象**。新增组件**禁止** `useCanvasStore(s => s.viewport)` 订阅整对象;需要某字段就单独取,或走 `liveViewport`。

5. **渲染过滤与视口剔除解耦。** 子层订版本号(`layoutVersion`/`connectionsVersion`/`groupVersion`),**禁止订阅整个 `cards`/`connections` Map**。路径/几何只随内容版本重算;视口剔除是单独的廉价 bbox filter(见 `ConnectionLayer` 的 `allConns` → `projectConns`)——**不要**把 path 计算和 cull 写进同一个依赖 viewport 的 `useMemo`,否则缩放时全量重算。`GroupLayer` 不依赖 viewport,不要给它传 `viewport` prop(会打破它的 `memo`)。

6. **画布内容层不要放「必须持续运行」的动画。** 手势中 `.canvas-interacting .vp-pan-layer *` 会暂停内层子树的一切动画(@keyframes 与 Tailwind `animate-spin`/`animate-pulse`),让纹理可缓存。新增动画**无需登记**,自动纳管。需要在缩放中也持续的动画(如全局 spinner)请放到变换层**之外**的浮层(与 `.vp-pan-layer` 平级,如 toolbar 区)。

7. **单卡渲染走订阅,不 prop-drill。** 展开卡经 `CardSlot` 内部 `useCardStore(s => s.cards.get(id))` 订阅(data 改只刷该卡);`CardLayer` 只负责「哪些 id 当前可见」的几何过滤(订 `layoutVersion` + spatial index)。`updateCardData` 只 bump `dataVersion`、不动 `layoutVersion`。

8. **缩放手势中绝不提交 store viewport(实测根治缩放卡顿的关键)。** `useViewport.onWheel` 的缩放分支(`isZoom`)**不调用** `scheduleWheelCommit`;缩放全程只走 imperative DOM(`--vp-gpu`),React 零重渲染。最终态由 `markInteracting` 停手 ~180ms 后 flush **一次** `setViewport`(重栅一次恢复清晰)。**原因**:手势中每次 `setViewport` 都会让 `CardLayer`/`ConnectionLayer` 重算可视集,在冻结的 `vp-render-layer` 里增删 DOM → 合成纹理作废、整屏重栅 → 周期性卡顿尖峰(真机对照实测:保留提交 p99≈50ms 有尖峰,去掉后 p99≈33ms 零尖峰)。平移(trackpad / 中键拖拽)需边移边露出新卡,**保留**节流提交,不适用本条。改 `onWheel` / 提交节流时务必维持「缩放路径不提交」这条不变量。

### 自查清单(改完画布渲染后)
- [ ] 缩放/平移时有没有新增的 React 重渲染或 60fps store 写入?(应为零)
- [ ] 新增的画布内动画是否在 `.vp-pan-layer` 子树内?(是 → 自动被暂停,OK)
- [ ] 有没有读 DOM transform / `--vp-*` 反推 zoom?(禁止,用 `liveViewport`/`screenToCanvas`)
- [ ] 有没有 `useMemo` 把几何计算和 viewport 剔除耦合在一起?
- [ ] 缩放手势中有没有提交 store viewport?(必须为零,只在停手 flush 一次。见契约 #8)
