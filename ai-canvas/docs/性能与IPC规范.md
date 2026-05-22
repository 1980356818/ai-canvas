# ai-canvas 性能 & IPC 规范

> 适用范围：本仓库前端 React + Zustand + Tauri 代码。每条规范都有"踩过的坑"作为支撑——
> **任何新增 / 重构 / Code Review 必须对照本文件**。规范缺失或例外要先更新本文档再写代码。

历史治理四波见：
- v1 (2026-05-15)：IPC 阈值首次落地
- v2 (2026-05-22)：[`project_ai_canvas_crash_fixes.md`](../../../../Users/Administrator/.claude/projects/D--Project/memory/project_ai_canvas_crash_fixes.md) v3 — 异步阻塞 + 内存累积 + 拖拽性能
- v3 (2026-05-22)：性能精细化 + 规范化（本文档 v1）
- **v5 (2026-05-23)**：data 派生订阅根治 + 共享 tick + ESLint 兜底（本文档当前版本）

---

## 1. IPC（前端 → Rust）守门

### 1.1 单次 invoke 字符串字段上限：3MB

实测 WebView2 在单次 invoke 字符串字段超过 ~3MB 时会随机抛 `ERR_CONNECTION_REFUSED` /
`"Failed to fetch"`，**直接终止渲染进程**（白屏一闪 → 窗口关闭，Rust 主进程日志干净）。

**单一来源**：[`src/lib/ipcLimits.ts`](../src/lib/ipcLimits.ts) 与
[`src-tauri/src/commands/ipc_limits.rs`](../src-tauri/src/commands/ipc_limits.rs)
对称定义 `IPC_PAYLOAD_HARD_LIMIT_BYTES = 3 * 1024 * 1024`。

**不允许**分 SOFT/HARD 两层、不允许"超限只 warn 不落盘"。

### 1.2 批量 invoke 必须走 `invokeBatched`

任何"一次性把 N 条记录传给后端"的命令（`save_cards_batch` / `save_connections_batch` /
等）**必须**经 [`@/lib/ipcBatch`](../src/lib/ipcBatch.ts) 的 `invokeBatched()` 分批，
**禁止**调用方直接 `invoke("save_xxx_batch", { items })`。

```ts
// ✅ 正确
await invokeBatched({
  command: "save_cards_batch",
  items: cards,
  buildArgs: (chunk) => ({ cards: chunk }),
});

// ❌ 错误 —— 单次 payload 可能爆 3MB
await invoke("save_cards_batch", { cards });
```

### 1.3 大 dataURL 单条上限

前端构造 dataURL 后送给 Rust 的，必须先经 `ensureIpcSafeDataUrl()`（在
[`@/lib/media`](../src/lib/media.ts)），降采样到 ≤ HARD_LIMIT。

### 1.4 大文件优先走路径而非 base64

Tauri 环境下，文件持久化的**优先路径**：

1. 拿到系统绝对路径 → `persistImage(path, ...)` → Rust 内部读文件落盘（IPC 只传几十字节路径）
2. 实在拿不到路径（粘贴板 / HTML5 DnD）才退化为 `readFileAsDataUrl → persistImage(dataUrl)`，
   且 dataURL 走 `ensureIpcSafeDataUrl` 降采样

**禁止**直接 `await fileReader.readAsDataURL(largeFile)` 然后传给 `invoke`。

---

## 2. Zustand 订阅

### 2.1 不要订阅整个 Map / Set

cardStore 的 `cards` Map 每次 mutation 都会复制出新 Map（immutable 风格），
订阅 `(s) => s.cards` 等于"任何写都重渲"。connectionStore 的 `connections`
Map 在 add/remove 时也换引用，同样不能放进 useMemo deps。

下游应订阅**精细信号**：

| 用途 | 订阅（cardStore） |
|------|------|
| 几何 / 层级 / 增减 → 重算视口 / 空间索引 / 鸟瞰图 | `layoutVersion` |
| 卡片 data 改 → 数据流派生 / 引用列表 | `dataVersion`（+ `lastMutatedDataIds` 拿 diff 集合）|
| 单卡片渲染 | 在 CardContent 内 `useCardStore((s) => s.cards.get(id))` |
| 拿全部卡片做计算 | effect 内 imperative `useCardStore.getState().cards` |

| 用途 | 订阅（connectionStore） |
|------|------|
| 连线集合派生（ImageRefSources / 一致性兜底 / 鸟瞰图）| `connectionsVersion` |
| 渲染主连线层（每个 connection 一个 path）| `s.connections`（render 阶段必需，例外）|
| 局部 UI（选中 / hover / draft）| 各自字段 |

**反例**：
```tsx
// ❌ 每次 updateCardData 都重渲整层
const cards = useCardStore((s) => s.cards);
// ❌ 每次 add/remove 连线 useMemo 都重算（Map 引用换了）
const connections = useConnectionStore((s) => s.connections);
useMemo(() => ..., [connections]);
```

ESLint `no-restricted-syntax` 规则（见 [`eslint.config.js`](../eslint.config.js)）已自动
拦截这两类反例 + `JSON.stringify(a) === JSON.stringify(b)` deep-equal + 直接 `invoke("save_*_batch")`。

### 2.2 layoutVersion / dataVersion 的语义（v5 修订）

`layoutVersion` 只在影响 **CardLayer.visibleCards 输出** 的变化时自增：
- 位置：x / y
- 尺寸：width / height
- 层级：zIndex（bringToFront / sendToBack）
- 增减：addCard / removeCard / setCards / clear

**不会**因 `updateCardData`（编辑器改 prompt、imageUrl 等）变化。

`dataVersion` 只在卡片**data 字段**真有改动时自增（updateCardData 内部
`changed` 短路之后；updateCard partial.data 引用变更；setCards / addCard
注入初始 data）。**配套** `lastMutatedDataIds: ReadonlySet<string>` 字段
原子写入"本次涉及的 cardId 集合"——dataFlow watcher 等订阅者拿到这个
集合**只对这几张卡跑下游传播**，杜绝"任意卡片改 data → 全卡 JSON.stringify
比较"的累积卡顿（v4 漏修的高频性能黑洞）。

`connectionsVersion` 只在 `connections` Map 的**集合内容**变化时自增
（add / remove / setConnections / removeConnectionsForCard / clear）。
本地 UI 字段（selected / hovered / draftWire / flowingConnectionIds）不入此 version。

### 2.3 zustand subscribe 必须在 cleanup 中调用返回的 unsub

```ts
useEffect(() => {
  const unsub = useFooStore.subscribe(...);
  return unsub;
}, []);
```

---

## 3. 高频事件 & 渲染

### 3.1 拖拽 / 缩放 / 滚动写 store 用 rAF

任何 60fps 触发的事件不要每次都 `setX`：先写 ref 暂存，`requestAnimationFrame` 一帧最多
一次 `setX`。已有 helper 在 [`CardShell.tsx`](../src/features/cards/CardShell.tsx) 的
`pendingFrame` / `latestSingleOffset` 模式可直接抄。

### 3.2 流式 scrollTo 用 `behavior:"auto"` + rAF 节流

`scrollTo({ behavior:"smooth" })` 在浏览器上被重复触发时会 cancel/restart 动画，token
每秒 50 个的话主线程被 scroll 占住。流式期间用 `auto`，非流式末态再用 smooth。

参考 [`ChatMessageList.tsx`](../src/features/chat/ChatMessageList.tsx) 的 `scrollRafRef` 模式。

### 3.3 SVG `filter:blur` 仅 active 时开

`filter:blur` 触发 GPU 合成层，500+ 连线常驻 blur 会逼近显存上限。idle 状态绝不能加 filter。

### 3.4 大列表用分页窗口，不要全量挂载

聊天 / 任务 / 历史列表只渲染最近 N 条（100 是合理默认）；顶部按钮拉更早 INCREMENT。
比 react-window 简单、行为更可控（无高度抖动）。

### 3.5 视口剔除必须做

画布上"绘制全部 X 个对象"的层（CardLayer / ConnectionLayer），必须按 viewport bbox
剔除。`spatialIndex.query(left, top, right, bottom)` 是统一入口。

### 3.6 共享全局 tick，禁止每个组件起独立 setInterval（v5 新增）

显示 elapsed 时间这种"每秒一次"的需求一律走 [`useElapsedTimer`](../src/hooks/useElapsedTimer.ts)。
旧实现里每个气泡 / 卡片 / 媒体 loading 卡都各起一个 `setInterval(1000)`，长会话
里几十个 timer + 几十次 setState/帧。useElapsedTimer 模块级共享一个 interval，
没有 listener 时自动 clearInterval。

**反例**：
```tsx
// ❌ 长会话累积 N 个独立 setInterval
useEffect(() => {
  const t = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
  return () => clearInterval(t);
}, [startedAt]);
```

**正例**：
```tsx
const elapsed = useElapsedTimer(startedAt);
```

画布上"绘制全部 X 个对象"的层（CardLayer / ConnectionLayer），必须按 viewport bbox
剔除。`spatialIndex.query(left, top, right, bottom)` 是统一入口。

---

## 4. 副作用清理

### 4.1 listen / addEventListener / setInterval / setTimeout / requestAnimationFrame / ResizeObserver / IntersectionObserver / MutationObserver / WebSocket / EventSource / AbortController

**所有**注册必须在同一组件 / hook 内的 cleanup 中释放。一律 `try` 包住释放，不能依赖
某个特定分支（done 路径）走 unlisten。

参考反例：[`ai.api.ts`](../src/platform/ai.api.ts) 老实现只在 done 分支 unlisten，
error 路径漏掉，连发几次生成就攒一堆监听器。

### 4.2 Tauri `listen()` 的"Promise 中途 cleanup"陷阱

`listen()` 返回 Promise，如果在 resolve 前 useEffect cleanup 已跑，普通写法
`return () => unlisten?.()` 拿不到值。正确模式：

```ts
let cancelled = false;
let unlisten: (() => void) | undefined;
listen(...).then((fn) => {
  if (cancelled) { try { fn(); } catch {} } else { unlisten = fn; }
});
return () => { cancelled = true; unlisten?.(); };
```

### 4.3 URL.createObjectURL 必须 revoke

`URL.createObjectURL(file)` 后必须有对称的 `URL.revokeObjectURL`，且必须在与
createObjectURL 同生命周期范围内（同 effect / 同 try-finally）。

---

## 5. 内存上限

### 5.1 任何"会累积"的 store / cache / pool 必须有上限

| 模块 | 上限 |
|------|------|
| chatStore 单会话消息 | `MESSAGES_PER_SESSION_CAP = 500` |
| chatStore 驻留会话 | `RESIDENT_SESSIONS_CAP = 8`（LRU） |
| history undo/redo 栈 | `MAX_STACK = 50` |
| `_pendingRetries`（后台保存） | 单 cardId 单条目，重试上限 5 次 |
| ChatMessageList 默认渲染窗口 | `INITIAL_VISIBLE_COUNT = 100` |

新增的"按 id 索引的 Map / 按 key 累积的 dict / 全局缓存数组"也要走相同套路。

### 5.2 Heap 监控

[`diag.ts`](../src/lib/diag.ts) 已注册：JS heap > 80% jsHeapSizeLimit 告警；
10s 内增长 > 50MB 也记一笔。新增大对象时**先用 dev console 看 diag 输出再合并**。

---

## 6. `<img>` / `<video>` 规范

继承 v2 规范：

- 所有 `<img>` 一律 `loading="lazy" decoding="async"`（唯一例外：焦点单图如登录 brand，
  只加 `decoding="async"`）
- 所有 `<video>` 一律 `preload="none"`，**例外**：有 `onLoadedMetadata` 跳帧依赖的
  （ChatEditor / VideoEditor）保留 `preload="metadata"`

---

## 7. 别再犯（高频踩坑）

1. **同一个 Set / Map 反复 `new Set/new Map(s.foo)`**：N 张卡片就 O(N) 浅拷贝；
   单卡 update 的 hot path 上要克制写入。
2. **useEffect 依赖里写整个对象 / Map 引用**：永远不相等，等于每次都跑。改订 version + ref 缓存。
3. **react-markdown 渲染整个流式文本**：流式期间永远塞进**独立** state（如 chatStore.streamingText），
   不要塞 messages[] 数组里，否则 bubble 每个 token 都重新 parse markdown。
4. **invoke 在 hot path 上**：滚轮 / 拖拽 60fps 触发的写持久化必须 debounce 到 5s+ 才落盘；
   靠 `autoSave.markDirty()` 标脏，让 AutoSaveManager 决定何时 flush。
5. **跨 IPC 字符串字段没 size guard**：一律先经过 `IPC_PAYLOAD_HARD_LIMIT_BYTES` 守门。
6. **filter:blur 常驻**：见 3.3。
7. **batchSize / 并发参数即使 UI 限了，代码侧也要 clamp**：见 [`runWithLimit`](../src/lib/concurrency.ts)。
8. **`JSON.stringify(a) === JSON.stringify(b)` 做 deep-equal**：对含 base64 / 长 prompt
   的对象是 O(2N) + 字符串比较。改用 shallow-key-equal 或 version 信号比对。v5 已被 ESLint 拦截。
9. **遍历所有卡片做 JSON.stringify 快照对比**（v4 dataFlow watcher 写法）：等于每次任意
   卡片改 data 都全卡 stringify。改成订阅 `dataVersion` + 读 `lastMutatedDataIds`，
   单卡编辑只处理单卡。
10. **每个组件自己起 `setInterval(1000)` 显示 elapsed**：长会话 N 个独立 timer。一律走
    `useElapsedTimer`（见 3.6）。

---

## 8. CI / Lint 兜底（v5 已落地）

[`eslint.config.js`](../eslint.config.js) 用 `no-restricted-syntax` 拦截四类反模式：

| 反模式 | 规则 selector | 修复方向 |
|--------|---------------|----------|
| `useCardStore((s) => s.cards)` | `CallExpression[callee.name='useCardStore'] > ArrowFunctionExpression > MemberExpression[property.name='cards']` | 订 `layoutVersion` / `dataVersion` |
| `useConnectionStore((s) => s.connections)` | `CallExpression[callee.name='useConnectionStore'] > ArrowFunctionExpression > MemberExpression[property.name='connections']` | 订 `connectionsVersion` |
| `invoke("save_*_batch", ...)` | `CallExpression[callee.name='invoke'][arguments.0.value=/^save_.+_batch$/]` | 经 `invokeBatched` 分批 |
| `JSON.stringify(a) === JSON.stringify(b)` | `BinaryExpression[operator='==='][left.callee.property.name='stringify'][right.callee.property.name='stringify']` | shallow-key-equal 或 version 信号 |

`pnpm lint` 会在 PR 检查里报红。例外（如 ConnectionLayer 主 render 必须 iterate
connections）需要写 `// eslint-disable-next-line no-restricted-syntax` 并在同一行
后面紧跟一个 `--` 注释说明理由。

---

## 9. v5 治理新增点（2026-05-23）

完成的根治：

1. **dataFlow watcher 去 stringify**：cardStore 加 `dataVersion` + `lastMutatedDataIds`
   信号，watcher 改成订阅 dataVersion → 只对变更卡跑 `propagateFromCard`。`prevSnapshots`
   全删。([src/lib/dataFlow.ts](../src/lib/dataFlow.ts))
2. **connectionStore 加 `connectionsVersion`**：所有连线集合改动的入口都 +1。
   ([src/stores/connectionStore.ts](../src/stores/connectionStore.ts))
3. **useImageRefSources 改订 version**：deps 从 `[cards, connections]` 改为
   `[dataVersion, layoutVersion, connectionsVersion]`。
   ([src/hooks/useImageRefSources.ts](../src/hooks/useImageRefSources.ts))
4. **ConnectionLayer.DraftWirePath 改订 layoutVersion**。
5. **referenceConsistency.sameData 删除**：JSON.stringify deep-equal 反模式拔掉。
6. **共享全局 tick `useElapsedTimer`**：ChatMessageBubble / ChatMessageList / CardContent
   三处独立 setInterval 合并成一个。([src/hooks/useElapsedTimer.ts](../src/hooks/useElapsedTimer.ts))
7. **ESLint 四条 `no-restricted-syntax` 规则**：把上面这些反模式从"靠人 review"升级为"自动拦截"。
