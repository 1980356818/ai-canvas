# API Key 自动轮转方案

## 一、现状分析

### 1.1 当前架构

```
┌──────────────────────────────────────────────────────────────┐
│  前端 (React)                                                │
│  ┌─────────────┐   ┌──────────────────┐  ┌───────────────┐  │
│  │ ChatEditor   │   │ MediaEditor      │  │ ChatStore     │  │
│  │ VideoEditor  │   │ TryOnEditor      │  │ (侧边栏聊天)  │  │
│  └──────┬───────┘   └───────┬──────────┘  └──────┬────────┘  │
│         │                   │                    │           │
│         ▼                   ▼                    ▼           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            providerService (统一调度层)               │   │
│  │  .chat() / .streamChat() / .generateImage/Video()    │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │    OpenAICompatProvider (Provider 基类)               │   │
│  │    调用 aiProxy() / aiProxyStream()                  │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │ IPC                                │
├─────────────────────────┼────────────────────────────────────┤
│  Rust (Tauri)           ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ai_proxy / ai_proxy_stream                          │   │
│  │  1. read_api_config(db, provider)  ← 只读一个 Key     │   │
│  │  2. 注入 Authorization Header                        │   │
│  │  3. 发送请求                                          │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 Key 存储结构 (SQLite settings 表)

| key | 说明 | 示例值 |
|-----|------|--------|
| `{provider}_api_keys` | 所有 Key 列表 (JSON) | `[{"id":"abc","name":"主力","key":"sk-xxx"},{"id":"def","name":"备用","key":"sk-yyy"}]` |
| `{provider}_active_key_id` | 当前激活的 Key ID | `"abc"` |
| `{provider}_api_key` | 当前激活 Key 的值 (冗余) | `"sk-xxx"` |
| `{provider}_base_url` | API 地址 | `"https://ai.comfly.chat"` |

**问题**：Rust 的 `read_api_config()` 只读 `{provider}_api_key`，拿到的永远是同一个 Key。

### 1.3 错误类型 (已有)

| HTTP Status | 语义 | 是否应轮转 |
|---|---|---|
| 401 | Key 无效 / 过期 | ✅ 立即轮转 |
| 402 | 余额不足 | ✅ 立即轮转 |
| 403 | 无权限 | ✅ 立即轮转 |
| 429 | 限流 | ✅ 轮转（当前 Key 限流，换一个） |
| 5xx | 服务端错误 | ❌ 不轮转（换 Key 没用） |
| 网络错误 | 连接失败/超时 | ❌ 不轮转（换 Key 没用） |

---

## 二、方案选型

### 方案对比

| 维度 | A: 前端拦截轮转 | B: Rust 端轮转 (推荐) |
|------|-----------------|----------------------|
| **原理** | 前端捕获 aiProxy 返回的错误状态，切换 DB 中的 Key 后重调 aiProxy | Rust 读取所有 Key 列表，在 Rust 内部完成重试 |
| **流式支持** | 只能在建连阶段轮转；流中途失败无法重试 | 建连失败可无缝重试，流中途失败可用新 Key 重建连接 |
| **IPC 开销** | 每次重试多一次 IPC 往返（~2ms） | 零额外 IPC，Rust 内部循环 |
| **原子性** | 前端切换 Key → 写 DB → 重调，有并发竞态风险 | Rust 单线程读取，无竞态 |
| **改动量** | 中等（新增 TS service + 改 aiProxy 返回）| 较大（改 Rust 3 个文件 + 新增 TS service） |
| **可维护性** | 中等 | ★★★★★ 最好 |
| **可观测性** | 需前端打日志 | Rust tracing 可直接观测轮转过程 |

### 结论：采用方案 B（Rust 端轮转）

理由：
1. **流式请求是主要场景**（聊天用 streamChat），前端方案在流式场景下天然受限
2. **原子性**：Rust 单线程读 Key 列表 → 逐个尝试 → 记住成功的 Key → 写回激活状态，整个过程无竞态
3. **可维护性最优**：所有重试逻辑封装在 Rust 层，前端完全无需关心轮转细节，只需展示通知
4. **日志可观测性好**：`tracing::info!` 直接记录每次轮转的原因和结果

---

## 三、详细设计

### 3.1 Rust 层改动

#### 3.1.1 `config.rs` — 新增读取全部 Key 的函数

```rust
pub struct KeyEntry {
    pub id: String,
    pub name: String,
    pub key: String,
}

pub struct FullApiConfig {
    pub keys: Vec<KeyEntry>,
    pub active_key_id: String,
    pub base_url: String,
}

/// 读取某个 provider 的所有 Key 列表（按保存顺序）
pub fn read_full_api_config(db: &Connection, provider: &str) -> Result<FullApiConfig, String>

/// 将某个 Key 设为激活状态（写回 DB）
pub fn set_active_key(db: &Connection, provider: &str, key_id: &str, key_value: &str) -> Result<(), String>
```

#### 3.1.2 `ai.rs` — ai_proxy 增加轮转逻辑

```
伪代码流程：

fn ai_proxy(provider, endpoint, body):
    config = read_full_api_config(db, provider)
    if config.keys.is_empty():
        return Error("未配置 API Key")

    // 固定按列表顺序，从第一个开始逐个尝试
    for (i, key) in config.keys.enumerate():
        response = send_request(url, key, body)

        if response.status < 400:
            // 成功：如果用的不是原来的 active，则切换激活标识
            if key.id != config.active_key_id:
                set_active_key(db, provider, key.id, key.key)
            return response

        if is_retryable(response.status):  // 401, 402, 403, 429
            log("Key {} 失败 (HTTP {}), 尝试下一个", key.name, status)
            continue  // 尝试下一个 Key
        else:
            return response  // 5xx/网络错误等不可轮转的错误，直接返回

    // 所有 Key 都失败
    return last_error
```

#### 3.1.3 `ai.rs` — ai_proxy_stream 增加轮转逻辑

流式请求的轮转发生在**建连阶段**（发送 HTTP 请求到收到第一个 chunk 之间）：

```
fn ai_proxy_stream(provider, endpoint, body, stream_id):
    config = read_full_api_config(db, provider)

    // 固定按列表顺序
    for key in config.keys:
        response = send_request(url, key, body)

        if response.status >= 400 && is_retryable(status):
            log("Stream: Key {} 失败, 尝试下一个", key.name)
            continue

        if !response.status.is_success():
            // 不可重试的错误，emit error event
            emit("ai-stream", { event: "error", data: error_body })
            return

        // 连接成功，开始流式读取
        if key.id != config.active_key_id:
            set_active_key(db, provider, key.id, key.key)
            emit("ai-stream", { event: "key_switched", data: key.name })

        stream_chunks(response, stream_id)
        return

    emit("ai-stream", { event: "error", data: "所有 Key 均不可用" })
```

#### 3.1.4 AiProxyResponse 扩展

```rust
#[derive(Serialize)]
pub struct AiProxyResponse {
    pub body: String,
    pub status: u16,
    pub rotated_key_name: Option<String>,  // 新增：如果发生了轮转，返回新 Key 的名称
    pub tried_count: u32,                  // 新增：尝试了几个 Key
}
```

### 3.2 前端层改动

#### 3.2.1 `providers/errors.ts` — 增加轮转通知处理

在 `throwIfError` 中增加对 `rotated_key_name` 的检查：

```typescript
export function checkRotation(resp: AiProxyResponse): void {
  if (resp.rotated_key_name) {
    useUIStore.getState().addToast({
      type: "warning",
      title: `API Key 已自动切换`,
      description: `切换到「${resp.rotated_key_name}」(尝试了 ${resp.tried_count} 个 Key)`,
      duration: 5000,
    });
  }
}
```

#### 3.2.2 `platform/ai.api.ts` — 透传轮转信息

`aiProxy` 返回后调用 `checkRotation()`，让用户看到 Toast 通知。

#### 3.2.3 Stream 事件扩展

监听新的 `key_switched` 事件类型，显示通知。

#### 3.2.4 Settings UI 增强

在设置面板的 Key 列表中增加以下功能：

1. **拖拽排序**：用户可拖拽调整 Key 的优先级顺序
2. **状态徽章**：每个 Key 旁显示健康状态
3. **自动轮转开关**：平台级别的开关

### 3.3 Key 调用顺序设计（用户体验）

#### 核心原则

```
优先级 = 列表中的位置顺序（第一个 = 最高优先级）
激活的 Key = 当前正在使用的 Key（用 ● 标识）
```

#### 运作逻辑

```
场景 1: 正常使用
  列表: [Key A ●, Key B, Key C]
  请求 → 用 Key A → 成功 ✅  (A 仍为激活)

场景 2: Key A 失败，B 接上
  列表: [Key A ●, Key B, Key C]
  请求 → 用 Key A → 401 ❌ → 用 Key B → 成功 ✅
  列表变为: [Key A, Key B ●, Key C]
  Toast: "Key A 不可用，已自动切换到「Key B」"

场景 3: Key A 充值后恢复
  列表: [Key A, Key B ●, Key C]
  请求 → 用 Key A → 成功 ✅  (A 重新成为激活)
  列表变为: [Key A ●, Key B, Key C]
  说明: 因为固定从头开始，A 排第一所以优先尝试，恢复后自然切回

场景 4: 全部失败
  列表: [Key A ●, Key B, Key C]
  请求 → Key A → 401 ❌ → Key B → 402 ❌ → Key C → 429 ❌
  Toast: "所有 API Key 均不可用，请检查账户状态"

场景 5: 用户调整了优先级（把 C 拖到第一位）
  列表: [Key C ●, Key A, Key B]
  请求 → 用 Key C → 成功 ✅
  说明: 列表顺序 = 优先级，拖拽即改优先级
```

#### 轮转方向：固定顺序，从头到尾

```
列表: [Key A, Key B ●, Key C, Key D]

尝试顺序: A → B → C → D（固定按列表顺序）
```

设计理由：
- **简单直观**：列表顺序 = 优先级，用户拖拽排到前面的 Key 永远先用
- **可预测**：用户明确知道"排第一的 Key 是我最想用的"，不会被当前激活状态干扰
- **自然恢复**：如果 Key A 之前余额不足但充值了，下次请求它仍然排第一，会优先被尝试
- **激活标识自动跟随**：哪个 Key 成功了，`●` 就移到哪个，但不影响下次的尝试顺序

#### 用户操作界面设计

```
┌─────────────────────────────────────────────┐
│  Comfly                    [自动切换: ✅开]  │
├─────────────────────────────────────────────┤
│                                             │
│  ⠿ 1. 主力账号          sk-ab····cd  ● 使用中  │
│      └ 状态: 正常                           │
│                                             │
│  ⠿ 2. 备用账号          sk-ef····gh         │
│      └ 状态: 正常                           │
│                                             │
│  ⠿ 3. 测试 Key          sk-ij····kl         │
│      └ 状态: 余额不足 (最后失败: 2分钟前)    │
│                                             │
│  [+ 添加 Key]                               │
│                                             │
│  💡 拖拽调整顺序 = 调整优先级               │
│     自动切换时按从上到下的顺序尝试            │
└─────────────────────────────────────────────┘
```

关键交互：
1. **拖拽 ⠿ 图标**排序：上面的 Key 优先级更高
2. **● 使用中**标识：当前正在使用的 Key
3. **状态徽标**：正常(绿) / 限流(黄) / 余额不足(橙) / 失效(红)
4. **自动切换开关**：关闭后退回手动模式，只使用选中的 Key

---

## 四、数据结构变更

### 4.1 KeyEntry 扩展

```typescript
interface KeyEntry {
  id: string;
  name: string;
  key: string;
  // ↓ 新增字段
  status: "ok" | "rate_limited" | "insufficient_balance" | "invalid" | "unknown";
  lastUsedAt: string | null;     // ISO 时间戳
  lastErrorAt: string | null;    // 最后失败时间
  lastErrorCode: number | null;  // 最后失败的 HTTP 状态码
  failCount: number;             // 连续失败次数
}
```

### 4.2 Settings 新增项

| key | 说明 | 默认值 |
|-----|------|--------|
| `{provider}_auto_rotate` | 是否启用自动轮转 | `"true"` |

---

## 五、实施计划

### Phase 1: Rust 核心轮转 (核心功能)

| # | 任务 | 文件 | 复杂度 |
|---|------|------|--------|
| 1.1 | `config.rs`: 实现 `read_full_api_config()` | `src-tauri/src/commands/config.rs` | 低 |
| 1.2 | `config.rs`: 实现 `set_active_key()` | `src-tauri/src/commands/config.rs` | 低 |
| 1.3 | `ai.rs`: `AiProxyResponse` 增加轮转字段 | `src-tauri/src/commands/ai.rs` | 低 |
| 1.4 | `ai.rs`: `ai_proxy` 增加轮转循环 | `src-tauri/src/commands/ai.rs` | 中 |
| 1.5 | `ai.rs`: `ai_proxy_stream` 增加轮转循环 | `src-tauri/src/commands/ai.rs` | 中 |
| 1.6 | `gateway.rs`: `list_models`/`poll_task` 同步支持轮转 | `src-tauri/src/commands/gateway.rs` | 低 |

### Phase 2: 前端通知 (用户感知)

| # | 任务 | 文件 | 复杂度 |
|---|------|------|--------|
| 2.1 | `AiProxyResponse` TS 类型扩展 | `src/types/` | 低 |
| 2.2 | `ai.api.ts`: aiProxy 返回后检查轮转并弹 Toast | `src/platform/ai.api.ts` | 低 |
| 2.3 | `ai.api.ts`: aiProxyStream 监听 `key_switched` 事件 | `src/platform/ai.api.ts` | 低 |

### Phase 3: Settings UI 增强 (用户操作)

| # | 任务 | 文件 | 复杂度 |
|---|------|------|--------|
| 3.1 | Key 列表拖拽排序 | `src/features/overlays/SettingsDialog.tsx` | 中 |
| 3.2 | Key 状态徽标显示 | `src/features/overlays/SettingsDialog.tsx` | 低 |
| 3.3 | 自动切换开关 | `src/features/overlays/SettingsDialog.tsx` | 低 |
| 3.4 | 保存时持久化新字段 | `src/features/overlays/SettingsDialog.tsx` | 低 |

### Phase 4: 浏览器模式兼容 (非 Tauri 环境)

| # | 任务 | 文件 | 复杂度 |
|---|------|------|--------|
| 4.1 | `keyRotation.ts`: 前端轮转 service (仅浏览器模式) | `src/services/keyRotation.ts` | 中 |
| 4.2 | `ai.api.ts`: 浏览器模式下走前端轮转 | `src/platform/ai.api.ts` | 低 |

---

## 六、边界情况处理

| 场景 | 处理方式 |
|------|----------|
| 只有 1 个 Key | 不轮转，正常报错 |
| 自动切换关闭 | 不轮转，只用激活的 Key |
| 429 限流 + 所有 Key 都 429 | 全部失败，提示"请求过于频繁，所有 Key 均被限流" |
| 轮转到新 Key 后，原 Key 恢复了 | 下次请求从当前激活的 Key 开始，原 Key 排在后面，仍有机会被使用 |
| 并发请求同时触发轮转 | Rust Mutex 保证同一时刻只有一个线程在修改 active_key_id |
| 用户在轮转过程中修改了 Key 列表 | Rust 在请求开始时读取快照，轮转期间不会被外部修改干扰 |
| 流式请求：建连成功后中途收到 401 | 不轮转（极罕见场景，通常 401 在建连阶段就返回了），按错误上报 |

---

## 七、日志与可观测性

### Rust tracing 日志

```
[INFO] [key_rotation] provider=comfly, trying key "主力账号" (1/3)
[WARN] [key_rotation] provider=comfly, key "主力账号" failed: HTTP 402 (余额不足)
[INFO] [key_rotation] provider=comfly, trying key "备用账号" (2/3)
[INFO] [key_rotation] provider=comfly, key "备用账号" succeeded, switching active key
[INFO] [key_rotation] provider=comfly, active key changed: "主力账号" → "备用账号"
```

### 前端 Toast 通知

- 成功切换: ⚠️ "API Key 已自动切换到「备用账号」(尝试了 2 个 Key)"
- 全部失败: ❌ "所有 API Key 均不可用，请检查账户状态"

---

## 八、后续扩展

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 智能冷却 | 429 的 Key 设置冷却时间，冷却期内跳过 | P2 |
| Key 健康检测 | 后台定期 validate 所有 Key | P3 |
| 用量统计 | 记录每个 Key 的调用次数和消费 | P3 |
| 权重轮转 | 按权重分配请求到不同 Key（负载均衡） | P3 |
