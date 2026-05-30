# ai-canvas 性能 & IPC 规范

> 适用范围：本仓库前端 React + Zustand + Tauri 代码。每条规范都有"踩过的坑"作为支撑——
> **任何新增 / 重构 / Code Review 必须对照本文件**。规范缺失或例外要先更新本文档再写代码。

历史治理见：
- v1 (2026-05-15)：IPC 阈值首次落地
- v2 (2026-05-22)：[`project_ai_canvas_crash_fixes.md`](../../../../Users/Administrator/.claude/projects/D--Project/memory/project_ai_canvas_crash_fixes.md) v3 — 异步阻塞 + 内存累积 + 拖拽性能
- v3 (2026-05-22)：性能精细化 + 规范化（本文档 v1）
- v5 (2026-05-23)：data 派生订阅根治 + 共享 tick + ESLint 兜底
- v6 (2026-05-23)：Rust `std::sync::Mutex` 二次 lock 死锁根治 + lock-acquiring helper 类型签名重构
- v7 (2026-05-23)：Mac 跨平台一致性（TLS / panic / Info.plist）
- **v9 (2026-05-25)**：Provider API key 读取统一为单一 async 入口 `platform/auth.ts`，
  删除全部同步 `getProviderAuthHeaders` / `getBrowserFirstKey` / `getAuthHeaders` /
  `getBrowserApiConfig` —— 它们只读 localStorage，Tauri 模式 SettingsDialog 把 key 存
  sqlite 后所有 fetch 路径 401。新增 `check-ipc-guards` 静态扫描防回归。详见 §12。

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

---

## 10. Rust `std::sync::Mutex` 二次 lock —— 同线程死锁

> v6 (2026-05-23) 新增。**踩过的坑**：双击 tab 改项目名 + 回车，整个程序卡死 ——
> [`rename_project`](../src-tauri/src/commands/project.rs) 在持着 `state.db.lock()` guard
> 时调用 [`candidate_save_dirs(&state)`](../src-tauri/src/commands/ai.rs)，后者内部
> `state.db.lock()` 又来一次，**同线程递归 lock `std::sync::Mutex` = 永久死锁**。
> 接着 autosave / 切 tab / 任何 DB 操作全部跟着阻塞，UI 表现为"程序冻住"。

### 10.1 std::sync::Mutex 二次 lock 不会 panic / 不返回 Err —— 直接死锁

不要被 `state.db.lock().ok()` 的写法骗了。`std::sync::Mutex::lock()` 的 `Err` 只代表
**Poison**（持锁线程 panic 留下的）。**同线程二次 lock 不会 Err、不会 panic，直接
block 等自己**。意味着：

```rust
// ❌ 死锁陷阱（外层已持锁）
let db = state.db.lock()?;
let dirs = candidate_save_dirs(&state); // 内部又 lock —— 永久 hang

// ❌ .ok() 不能救你 —— 二次 lock 不返回 Err
if let Ok(db2) = state.db.lock() { ... } // 这行直接 hang，永远到不了 if
```

`parking_lot::Mutex` 同理（默认不可重入）；要可重入得显式用 `ReentrantMutex` —— 项目
没用。

### 10.2 单一规则：辅助函数不取锁，调用方负责持锁

所有"会读 DB 设置 / 配置"的 helper 一律改成显式接 `&rusqlite::Connection`：

```rust
// ✅ 正确：函数签名暴露"我需要 db"，调用方持锁
pub(crate) fn resolve_save_dir(
    data_dir: &Path,
    db: &Connection,
) -> PathBuf { ... }

// ❌ 错误：函数签名里看不出会取锁，调用方不知道自己不能持锁就调
pub(crate) fn resolve_save_dir(state: &AppState) -> PathBuf {
    state.db.lock()...; // 隐式取锁
}
```

调用方必须显式 `let db = state.db.lock()?;` 才能拿到 `&Connection`，所以**在已持锁的
scope 里再调辅助函数变成编译期 borrow checker 直接报"can't borrow db twice"**——
死锁从运行时不可见的偶发崩溃变成编译错误，本质消除。

已按此模式重构的辅助（v6）：

| 辅助 | 签名（新） | 调用点（已更新）|
|------|-----------|----------------|
| [`resolve_save_dir`](../src-tauri/src/commands/ai.rs) | `(data_dir: &Path, db: &Connection) -> PathBuf` | save_media / open_in_explorer |
| [`resolve_export_dir`](../src-tauri/src/commands/ai.rs) | `(data_dir: &Path, db: &Connection) -> PathBuf` | export_file |
| [`candidate_save_dirs`](../src-tauri/src/commands/ai.rs) | `(data_dir: &Path, db: &Connection) -> Vec<PathBuf>` | resolve_user_media_path / rename_project |
| [`resolve_endpoint`/`_with_tag`](../src-tauri/src/commands/gateway.rs) | `(db: &Connection, provider, [key_tag]) -> Result<(String, String)>` | list_models / poll_task / validate_connection |
| [`resolve_base_url`](../src-tauri/src/commands/gateway.rs) | `(db: &Connection, provider) -> Result<String>` | validate_connection |

例外：[`resolve_user_media_path`](../src-tauri/src/commands/ai.rs) 内部要先 lock 读
title + candidate_dirs，再 **释放锁** 做 FS 搜索，把 `&Connection` 提到外层反而强迫
锁覆盖 FS I/O。该函数保留 `&AppState` 签名，**doc 注释明确"调用方不得已持锁"**，
是受控例外。

### 10.3 持锁期间一律不做 FS I/O / 网络 / 跨 IPC

把锁的持续时间压到只覆盖 SQL，scope 包起来确保提前 drop：

```rust
// ✅ 正确：SQL 一个 scope，FS 在 scope 外
let (info, bases) = {
    let db = state.db.lock()?;
    let info = db.query_row(...)?;
    let bases = candidate_save_dirs(&state.data_dir, &db);
    (info, bases)
};
// 此处 db guard 已 drop —— 后面随便阻塞
run_blocking(move || std::fs::rename(...)).await?;
```

`std::fs::*` / `reqwest` / `await` 在持锁期间出现 = 把全局 DB 锁的尾巴拖到秒级，
其他所有 DB 操作排队，体感是"程序卡了一下"。

### 10.4 同步 `pub fn` 命令做 IO 也算阻塞

Tauri 2 的 sync `pub fn` 命令跑在 async runtime worker 上。一个 worker 卡住相当于
减少一个并发槽位 —— 不一定 freeze UI，但会让其他 IPC 排队。**任何命令体里**有
`std::fs::*` / 慢 SQL（VACUUM / 跨表 join） / 网络的，都应该是 `pub async fn` +
`super::ai::run_blocking(...)`。`rename_project` 是这次踩坑后改的样板。

---

## 11. 跨平台一致性（v7 新增 — 2026-05-23）

> **踩过的坑**：用户报告 Mac 上点击"生成"(文字/图片/视频节点)必闪退，Win 上不复现。
> 根因不是逻辑 bug，而是 **同一份代码在两端走了不同的 native 实现**，Mac 端的实现
> 又恰好在某些边界条件下 panic，又因 `panic = "abort"` 直接 SIGABRT。"Win 跑得通"
> 不代表"Mac 跑得通"——任何"native-*"依赖都要明确假设。

### 11.1 TLS 后端必须用 `rustls`，禁用 `native-tls`

`reqwest` / `hyper` 配 `native-tls` feature 时：

| 平台 | 实际后端 | 状态 |
|------|---------|------|
| Windows | SChannel | 微软维护，稳定 |
| macOS | **SecureTransport** | Apple 自 macOS 10.15 已 deprecated；ARM Mac + HTTP/2 + 某些上游证书链上有已知 panic |
| Linux | OpenSSL | 依赖系统 libssl 版本 |

→ 同一份代码 Mac/Win 行为不一致是**必然**的，不是巧合。

**规则**：[Cargo.toml](../src-tauri/Cargo.toml) 的 `reqwest` 一律用：

```toml
reqwest = { version = "0.12", default-features = false,
            features = ["json", "rustls-tls-native-roots", "stream", "http2"] }
```

- `rustls-tls-native-roots`：纯 Rust TLS + 复用系统 CA 信任链(企业 MITM/自签证书也能用)
- **禁用** `native-tls` / `default-tls`(隐式打开 native-tls)
- 任何新增的 HTTP 客户端 crate(grpc / websocket / s3 等)同样要明确 rustls feature

### 11.2 Release `panic = "unwind"`，不能 `"abort"`

`panic = "abort"` 让任何漏网的 `unwrap` / `expect` / `panic!` 直接 SIGABRT，
**panic hook 完全不走**，stderr 也吃不到 — Mac 用户从 Finder 启动连日志都没有。

**规则**：[Cargo.toml](../src-tauri/Cargo.toml) `[profile.release]` 必须：

```toml
strip = "debuginfo"   # 保留 symbol，backtrace 能看见函数名
panic = "unwind"      # 让 panic hook 能抓到现场
```

配套：[`lib.rs::run()`](../src-tauri/src/lib.rs) 入口的 panic hook 必须：
- `std::env::set_var("RUST_BACKTRACE", "1")`
- 抓 `location` / `payload` / `Backtrace::force_capture()`
- 落到 `startup.log`(boot_log) + `eprintln!`(双保险)
- 带平台 / 架构 / 版本 / 线程名

新增 unsafe / FFI / `expect()` 时**先检查 panic hook 是否覆盖该路径**，否则要么改成
`unwrap_or_else(|e| { tracing::error!(...); fallback })`，要么确认 panic 走 hook 后
还能给前端一个友好错误而不是闪退。

### 11.3 macOS Info.plist 必须存在

[`src-tauri/Info.plist`](../src-tauri/Info.plist) Tauri 构建时自动合并到最终 `.app`。
缺失 / 字段不全会出现：

- `NSAppTransportSecurity / NSAllowsArbitraryLoads = true`：放行 WKWebView 内的
  HTTP 资源 + 非系统信任证书的 HTTPS。生成路径不依赖它(走 reqwest)，但媒体预览
  `<img>` / `<video>` 受 ATS 管控，缺失会让预览空白甚至 WebContent 进程被 jetsam 杀。
- `LSMinimumSystemVersion`：与 `tauri.conf.json` 的 `bundle.macOS.minimumSystemVersion` 对齐
- `NSHighResolutionCapable = true`：否则 Retina 屏字体糊
- `CFBundleDisplayName` / `NSHumanReadableCopyright`：原生工具(Finder/About)显示

**改动这个文件需要重新 build**(不会热重载)。Tauri 自动合并 = `Info.plist` 中的字段
+ Tauri 生成的字段(CFBundleIdentifier 等)合成 `.app/Contents/Info.plist`。

### 11.4 `#[cfg(target_os = "...")]` 分支三平台必须对称

每加一处 `#[cfg(target_os = "windows")]`，立刻问自己：

- macOS 分支是什么？ → 写 `#[cfg(target_os = "macos")]`
- Linux 分支是什么？ → 写 `#[cfg(all(unix, not(target_os = "macos")))]` 或 `#[cfg(target_os = "linux")]`
- 其他平台默认行为是什么？ → 至少要有一个 fallback 分支或编译期阻止

**反例**：[`reveal_path`](../src-tauri/src/commands/ai.rs) 三平台齐全(好)；
某次 v6 之前的 `auto_save_default_dir` 漏了 Linux 分支 — 在 Linux 上 silently fall 
through 到 `data_dir`，没人报因为没 Linux 用户，但是规范上不许。

**反例 2**：Windows 独占的 `MIN_WEBVIEW2_MAJOR` 版本检测在 Mac 上没对应物 —— 这是
对的(WKWebView 跟随系统)，但**新增**这种平台独占检查时必须文档说明"为什么其他平台不需要"。

### 11.5 别再犯（v7 增补）

11. **`native-*` 依赖 = 跨平台分裂源**：选 crate features 时，"native-tls" / "native-ssl" /
    "system-deps" 这类名字一出现，立刻问"Mac/Win 各走什么实现，是否一致"。
12. **release `panic = "abort"` 在排查阶段是禁区**：bundle 体积小那 1MB 远抵不上
    "用户反馈崩溃 + 一无所获" 的诊断成本。等连续 1 个月零 panic 报告再考虑切回。
13. **"我 Win 上没复现"不等于"代码没问题"**：跨平台桌面项目，bug 报告先看是否
    平台特定，再决定排查范围；交叉验证两个平台是默认动作而不是选择题。
14. **每个 `expect()` 都是 release 里的潜在闪退**：在 panic = "unwind" + 强 hook 下
    最坏也只是 thread panic + 日志(不 abort)，但仍可能让一个 IPC command 永远不返回。
    优先 `unwrap_or_else(|e| { log; fallback })`，逼不得已再 expect 且必须有 hook 覆盖。

---

## 12. Provider API Key 读取规范（v9，2026-05-25 根治）

### 12.1 唯一入口：[`src/platform/auth.ts`](../src/platform/auth.ts)

所有 API key / Authorization header 读取**必须**走该模块的 async 接口：

```ts
import { resolveAuthHeaders, readProviderKeys, readProviderFirstKey } from "@/platform";

// 单 key + Header 构造（最常用）
const headers = await resolveAuthHeaders("jijing");
// → { Authorization: "Bearer sk-..." } 或 {} (无 key 时)

// 取 key 列表（rotation 场景）
const keys = await readProviderKeys("comfly", "gemini_premium");

// 仅取 key 字符串
const k = await readProviderFirstKey("jijing");
```

后端透明：
- **Tauri 模式** → `settings.api::getSetting` → `invoke('get_setting')` → Rust sqlite
- **Web 模式**   → `settings.api::getSetting` → `lsGet(...)` → localStorage

`SettingsDialog` 通过 `setSetting()` 写 key，**同样**通过后端透明层落地到 sqlite / localStorage —
读写双端对称。

### 12.2 禁用清单

任何引入下列形态的 PR 必须被拒（`scripts/check-ipc-guards.{ps1,sh}` 静态扫描会失败）：

```ts
// ❌ 同步、只读 localStorage —— Tauri 模式 key 在 sqlite，永远拿不到 -> 401
getProviderAuthHeaders(provider)
getBrowserFirstKey(provider)
getBrowserKeys(provider, keyTag)
getAuthHeaders()
getBrowserApiConfig()

// ❌ 直接绕过抽象去读 localStorage
lsGet("setting_jijing_api_keys", null)
lsGet("setting_comfly_api_key", null)
```

### 12.3 踩过的坑（2026-05-25）

用户报告 `ChatEditor` 调 `gemini-3.1-pro-preview` "卡住"。排查链路：
- 服务端正常（curl 测 4.8s 200）
- ai-canvas Rust 端 `ai_proxy` 完全没收到请求（启动后零 `tracing::info!` 痕迹）
- WebView Console 暴露：`POST /v1-jijing/v1/files/upload 401 (Unauthorized)` → `Missing API Key`

**根因**：`uploadViaFetch` 在 `platform/media.ts:161` 调同步 `getProviderAuthHeaders("jijing")`，
该函数只读 `localStorage["setting_jijing_api_keys"]`。Tauri 模式下 `SettingsDialog`
通过 `invoke('set_setting')` 把 key 写到 sqlite (`data.db`)，**完全没写 localStorage**。
fetch 因此带空 Authorization 头，服务端 401。UI 把 reject 当 "loading 中" 显示，
看起来像 chat completions 本身卡死。

为什么 `ai_proxy`（主聊天）不踩这个坑？因为它走 `invoke('ai_proxy')`，Rust 端直接从
sqlite 读 key。**只有"先把 dataURL/blob 上传成 server URL"这条 fetch 子流程**会撞上。

### 12.4 别再犯

15. **新增任何"我直接 fetch 调一下后端"的代码**，先想清楚 key 怎么注入 —— 答案永远是
    `await resolveAuthHeaders(provider)`，不许同步、不许走 localStorage 直读。
16. **同步 / 异步分裂是 bug 的温床**：当某个数据源有"快路径同步 + 慢路径异步"两个版本时
    （sqlite 必须 async，localStorage 可 sync），快慢路径行为不一致 → 调用方按"上次能用"
    选了快路径就出错。本模块的做法是**取消快路径**，让所有调用方一致 await。
17. **看到 `// @deprecated, use X instead` 别只是加一个新函数 X 就走**，老函数还在的话
    迟早会有人用。直接删，或者改成 `throw new Error(...)` 让运行时炸出来。
18. **设置面板写到哪 / 业务代码读自哪必须对账**：每个 storage 后端（sqlite / localStorage /
    cookies / IndexedDB）的 reader 和 writer 都列在一起，PR 改了 writer 必须扫一遍所有 reader。

---

## 13. 前端上行 HTTP 规范（v11，2026-05-30 根治）

### 13.1 唯一出口：[`src/platform/httpAdapter.ts`](../src/platform/httpAdapter.ts)

ai-canvas 是 Tauri 桌面应用，**WebView 永远不允许直接发上行 HTTP 请求**。所有出站
请求一律走 Rust invoke，前端 API 收口于 [`platform/httpAdapter.ts`](../src/platform/httpAdapter.ts)：

```ts
import { httpJson, httpJsonRequest, httpUploadBytes } from "@/platform/httpAdapter";

// 通用 JSON 调用（auth / update / 任意 REST），拿到原始 status + body + headers
const resp = await httpJson({
  url: "http://101.37.80.236/api/auth/login",
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: { username, password },
});

// 200 校验 + JSON 自动解的便捷版
const data = await httpJsonRequest<MyShape>({ url, method: "POST", body });

// 媒体 bytes 上传（data: / blob: / vite asset），复用 sha256 缓存 + 单飞 + semaphore
const { url: serverUrl } = await httpUploadBytes(input, { provider: "jijing", prewarm: false });
```

AI provider 调用走 [`platform/ai.api.ts`](../src/platform/ai.api.ts) 的
`aiProxy` / `aiProxyStream`（内部 invoke `ai_proxy` / `ai_proxy_stream`），
本地文件上传走 [`platform/media.ts::mediaToApiRef`](../src/platform/media.ts)
（内部 invoke `upload_to_server`）。**没有任何场景需要 `fetch("https://...")`**。

### 13.2 Rust 后端四个上行入口（契约）

| Command | 用途 | 入参形态 | 是否带 sha256 缓存 |
|---|---|---|---|
| `ai_proxy` / `ai_proxy_stream` | AI provider 调用 | provider + endpoint + body | 否（上游有自己的幂等） |
| `upload_to_server` | 本地文件路径上传 | path + provider + prewarm | **是**，in-flight 单飞 + sqlite 缓存 |
| `upload_bytes_to_server` | bytes 上传（data:/blob:/vite asset） | bytes + filename + contentType + provider + prewarm | **是**，共享同一份缓存 |
| `http_request` | 通用上行（auth / update / 任意非 AI） | url + method + body + headers | 否 |

`upload_to_server` 和 `upload_bytes_to_server` **共享缓存**：同一字节内容无论
从 path 还是 bytes 入口进来，sha256 一致就命中同一条 `uploaded_files` 记录，
不会重复上传。详见 `commands/upload_remote.rs::run_upload_pipeline`。

### 13.3 禁用清单（ESLint + check-ipc-guards 静态扫描）

```ts
// ❌ 任何字面量绝对 URL fetch
fetch("https://api.example.com/foo");
fetch(`${BASE}/api/bar`);  // 模板字符串拼绝对 URL

// ❌ WebView 不该用的 HTTP 构造器
new XMLHttpRequest();
new EventSource(url);
new WebSocket(url);

// ❌ 已删除的"Web 模式"工具 import（CORS 事件根源）
import { buildProxyUrl } from "@/platform/storage";
import { resolveProviderEndpoint } from "@/platform/storage";
import { getJiJingDevProxyPrefix } from "@/providers/jijing/baseUrl";
```

唯一合规的 `fetch` 用法：**WebView 内部资源**（data: / blob: / 同源 vite asset），
样板见 [`httpAdapter.ts::resolveToBlob`](../src/platform/httpAdapter.ts)。
ESLint 规则只拦截绝对 URL，不影响这条合规路径。

### 13.4 踩过的坑（2026-05-30 CORS 事件）

用户首次 `npm run tauri dev` 后，模板创建 → ChatEditor 自动初始同步 → 大量
`/v1/files/upload` 调用全部失败：

```
Access to fetch at 'https://api.snoworangekeji.cn/v1/files/upload'
from origin 'http://127.0.0.1:1620' has been blocked by CORS policy:
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

**根因链：**
1. `media.ts::uploadViaFetch` 在 WebView-only URL 分支用浏览器原生 `fetch`
2. `resolveProviderEndpoint` 在 `isTauri=true` 时返绝对 URL 而非相对路径
3. Tauri **dev** 模式下 WebView origin 是 `http://127.0.0.1:1620`（vite），
   不是 prod 的 `tauri://localhost`
4. 服务端 CORS allowlist 不放行 vite origin → preflight 失败 → 所有上传挂掉

prod 模式凑巧能跑是因为 `tauri://localhost` 在服务端 allowlist 里 ——
**这种"凑巧"是脆弱的**，任何上游 CORS 策略变化或换 BaseUrl 都会复现。

### 13.5 别再犯

19. **"我直接发个 fetch 调外部 API"是错的**，无论看起来多简单。Tauri 桌面应用
    的 WebView origin 在 dev / prod / Web 三个环境下完全不同，CORS / cookie /
    mixed-content 行为不一致 —— 唯一"任何环境都一致"的做法是走 Rust HTTP 客户端。
20. **"反正生产能跑"不是放过的理由**。CORS 在桌面端是个**架构性错误**，不是
    某个端点的配置问题。修一个端点的 CORS allowlist 不解决任何问题，迟早会
    在第 N 个端点踩到。
21. **"按 isTauri 二选一"是双语义函数，bug 工厂**。`buildProxyUrl` /
    `resolveProviderEndpoint` 这种"Tauri 走 A，Web 走 B"的函数，看起来对称
    但永远会有一边的语义被忽视（尤其是 dev 模式这个第三象限）。直接砍掉一边
    才能根治。
22. **删除 `vite.config.ts::server.proxy`** 不是顺手清理，是约束 —— 留着 proxy
    就有人会"暂时用一下"，然后这个"暂时"就永远不会消失。删干净才能让 ESLint
    规则有意义。
