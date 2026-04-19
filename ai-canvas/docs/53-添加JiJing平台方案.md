# 53 - 添加 JiJing 平台方案

## 1. 背景

当前 AI 画布应用只接入了一个后端平台 **Comfly**（`https://ai.comfly.chat`），通过 `OpenAIProvider` 调用。现需新增 **JiJing** 平台（`https://ai.snoworangekeji.cn`），两个平台 API 协议完全一致（均为 OpenAI 兼容 + 异步 Task 轮询），可共享格式化/解析逻辑。

## 2. 现有架构分析

### 2.1 调用链路

```
┌─ 前端 Provider ─┐      ┌─ 平台层 ──────────┐      ┌─ 后端 ──────────────┐
│ OpenAIProvider   │─────▶│ aiProxy(provider,  │─────▶│ Tauri: read_api_    │
│ SeedanceProvider │      │   endpoint, body)  │      │   config(db, provider)│
└──────────────────┘      └────────────────────┘      │ → {provider}_api_key │
                                                      │ → {provider}_base_url│
                                                      └──────────────────────┘
```

### 2.2 双模式差异

| 模式 | 代理方式 | provider 参数 | Base URL 来源 |
|------|----------|---------------|---------------|
| **Tauri（生产）** | `invoke("ai_proxy", { provider, endpoint, body })` | ✅ 使用 | SQLite `settings` 表：`{provider}_api_key`、`{provider}_base_url` |
| **Browser（开发）** | `fetch("/v1-proxy" + endpoint)` | ❌ 忽略 | Vite proxy 硬编码 → `https://ai.comfly.chat` |

### 2.3 关键发现

1. **Tauri Rust 端已支持多 Provider** — `read_api_config(db, &provider)` 按 provider 名称读取独立的 key/url 配置，只需补充默认 base_url
2. **Browser 模式不支持多 Provider** — `buildProxyUrl()` 忽略 provider 参数，所有请求走同一个 `/v1-proxy`
3. **OpenAIProvider 模型列表硬编码** — 不从服务端拉取，无法感知不同平台的模型差异
4. **两个平台 API 协议相同** — 均为 JiJing Server 部署，OpenAI 兼容格式

## 3. 方案设计

### 3.1 方案选择

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A. 克隆 Provider** | 复制 OpenAIProvider 创建 JiJingProvider | 简单直接 | 大量重复代码，后续维护双份 |
| **B. 参数化复用** ⭐ | 抽取 `OpenAICompatProvider` 基类，Comfly 和 JiJing 各为实例 | 零重复，扩展容易 | 需小幅重构 OpenAIProvider |
| **C. 纯配置化** | 用 CustomProvider + 设置界面动态添加 | 最灵活 | 用户体验差，需手动填全部配置 |

**推荐方案 B** — 工作量适中，代码干净，未来再加第三个平台几乎零成本。

### 3.2 整体架构

```
providers/
├── openai-compat/          ← 新增：共享的 OpenAI 兼容逻辑
│   ├── base.ts             ← OpenAICompatProvider 基类
│   ├── formatter.ts        ← 现有 formatter.ts 移入
│   └── models.ts           ← 静态模型定义（可选覆盖）
├── comfly/
│   └── index.ts            ← ComflyProvider extends OpenAICompatProvider
├── jijing/
│   └── index.ts            ← JiJingProvider extends OpenAICompatProvider
├── seedance/               ← 不变
├── custom/                 ← 不变
├── registry.ts             ← 注册两个 Provider
├── types.ts                ← 不变
└── index.ts                ← bootstrap
```

## 4. 具体改动

### 4.1 前端 — 抽取 OpenAICompatProvider 基类

**新建 `providers/openai-compat/base.ts`**

```typescript
export abstract class OpenAICompatProvider implements AIProvider {
  abstract readonly descriptor: ProviderDescriptor;
  
  // 子类可选覆盖，返回静态模型列表
  protected staticModels(): ModelInfo[] { return []; }

  async listModels(): Promise<ModelInfo[]> {
    const statics = this.staticModels();
    if (statics.length > 0) return statics;
    // 否则从服务端动态拉取
    const raw = await aiProxy(this.descriptor.id, "/v1/models", {});
    return parseModelList(raw);
  }

  async chat(req) { /* 复用现有 OpenAI 格式逻辑 */ }
  async streamChat(req, onEvent) { /* 复用现有逻辑 */ }
  async generateImage(req) { /* 复用现有异步 task 逻辑 */ }
  async generateVideo(req) { /* 复用现有异步 task 逻辑 */ }
}
```

**Comfly Provider（原 OpenAIProvider 重命名）：**

```typescript
export class ComflyProvider extends OpenAICompatProvider {
  readonly descriptor = {
    id: "comfly",
    name: "Comfly",
    capabilities: ["chat", "vision", "tool_calling", "image_gen", "video_gen", "streaming"],
    configSchema: [
      { key: "apiKey", label: "API Key", type: "password", required: true },
      { key: "baseUrl", label: "Base URL", type: "url", required: false, 
        default: "https://ai.comfly.chat" },
    ],
  };
  protected staticModels() { return ALL_COMFLY_MODELS; }
}
```

**JiJing Provider：**

```typescript
export class JiJingProvider extends OpenAICompatProvider {
  readonly descriptor = {
    id: "jijing",
    name: "JiJing (极境)",
    capabilities: ["chat", "vision", "tool_calling", "image_gen", "video_gen", "streaming"],
    configSchema: [
      { key: "apiKey", label: "API Key", type: "password", required: true },
      { key: "baseUrl", label: "Base URL", type: "url", required: false,
        default: "https://ai.snoworangekeji.cn" },
    ],
  };
  // 不覆盖 staticModels()，默认从服务端动态拉取
}
```

### 4.2 前端 — 浏览器模式多代理支持

**问题**：当前 `buildProxyUrl()` 忽略 provider，所有请求走 `/v1-proxy` → Comfly。

**改动 `platform/storage.ts`：**

```typescript
// 之前
export function buildProxyUrl(endpoint: string): string {
  return "/v1-proxy" + endpoint;
}

// 之后
export function buildProxyUrl(endpoint: string, provider?: string): string {
  if (provider === "jijing") return "/v1-jijing" + endpoint;
  return "/v1-proxy" + endpoint;
}
```

**改动 `platform/ai.api.ts`**：将 `provider` 传递到 `buildProxyUrl`：

```typescript
// aiProxy 和 aiProxyStream 中
const url = buildProxyUrl(endpoint, provider);
```

**改动 `vite.config.ts`**：添加 JiJing 代理：

```typescript
const COMFLY_API = "https://ai.comfly.chat";
const JIJING_API = "https://ai.snoworangekeji.cn";

proxy: {
  "/v1-proxy": {
    target: COMFLY_API,
    // ...现有配置不变
  },
  "/v1-jijing": {
    target: JIJING_API,
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/v1-jijing/, ""),
    secure: false,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.removeHeader("origin");
        proxyReq.removeHeader("referer");
      });
    },
  },
},
```

### 4.3 Tauri Rust 端

**改动 `commands/config.rs`**：添加 JiJing 默认 base URL：

```rust
fn default_base_url(provider: &str) -> String {
    match provider {
        "openai" | "comfly" => "https://ai.comfly.chat".to_string(),
        "jijing" => "https://ai.snoworangekeji.cn".to_string(),
        "anthropic" => "https://api.anthropic.com".to_string(),
        _ => String::new(),
    }
}
```

**改动 `commands/gateway.rs`**：`list_models` 和 `poll_task` 支持 provider 参数（当前硬编码 `"openai"`）：

```rust
pub async fn list_models(
    state: State<'_, AppState>,
    provider: Option<String>,        // 新增
) -> Result<serde_json::Value, String> {
    let p = provider.unwrap_or_else(|| "comfly".to_string());
    let config = read_api_config(&db, &p)?;
    // ...
}
```

### 4.4 Provider ID 迁移

当前 `OpenAIProvider` 的 `id` 是 `"openai"`，改为 `"comfly"` 后需要处理：

| 影响项 | 处理 |
|--------|------|
| Rust `read_api_config(db, "openai")` | 添加 `"openai"` → `"comfly"` 别名，或 `"comfly"` 也读 `openai_*` settings |
| `providerStore` 默认值 `"openai:model-id"` | 改为 `"comfly:model-id"` |
| `localStorage` 中已存的 `setting_openai_api_key` | Rust 端加兼容：先查 `comfly_api_key`，没有则 fallback 到 `openai_api_key` |
| 设置面板 `ProviderConfigPanel` | 自动适应（从 registry 读取 descriptor） |

### 4.5 设置 UI

设置面板 `ProviderConfigPanel` 已从 `registry.listDescriptors()` 动态渲染 Provider 列表，无需特殊修改。新增的 JiJing Provider 注册后自动出现在设置中。

### 4.6 模型选择器

`ModelSelector` 组件已按 provider 分组显示模型。JiJing 注册后自动出现在下拉列表中。动态拉取的模型需确保返回格式与 `ModelInfo` 兼容：

```typescript
interface ModelInfo {
  id: string;
  display_name?: string;
  capability?: string;    // "CHAT" | "IMAGE" | "VIDEO"
  lines?: Array<{ tag: string; name: string; type: string }>;
}
```

## 5. 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `providers/openai-compat/base.ts` | **新建** | 基类：chat/stream/image/video 共用逻辑 |
| `providers/openai-compat/formatter.ts` | **移动** | 从 `openai/formatter.ts` 移入 |
| `providers/comfly/index.ts` | **新建** | ComflyProvider（替代原 OpenAIProvider） |
| `providers/jijing/index.ts` | **新建** | JiJingProvider |
| `providers/openai/index.ts` | **删除** | 逻辑移入 comfly + openai-compat |
| `providers/openai/models.ts` | **移动** | → `providers/comfly/models.ts` |
| `providers/index.ts` | **修改** | 注册 ComflyProvider + JiJingProvider |
| `platform/storage.ts` | **修改** | `buildProxyUrl` 支持 provider 路由 |
| `platform/ai.api.ts` | **修改** | 传递 provider 到 `buildProxyUrl` |
| `vite.config.ts` | **修改** | 添加 `/v1-jijing` 代理 |
| `stores/providerStore.ts` | **修改** | 默认 ref 从 `openai:` 改为 `comfly:` |
| `src-tauri/src/commands/config.rs` | **修改** | 添加 jijing 默认 URL + comfly 别名 |
| `src-tauri/src/commands/gateway.rs` | **修改** | provider 参数化 |

## 6. 分步实施计划

| 阶段 | 内容 | 风险 |
|------|------|------|
| **Phase 1: 基础设施** | 抽取 OpenAICompatProvider 基类，重命名 openai → comfly，确保现有功能不受影响 | 中（重构） |
| **Phase 2: 代理层** | `buildProxyUrl` 支持多 provider + Vite 多代理 + Rust 默认 URL | 低 |
| **Phase 3: JiJing Provider** | 新建 JiJingProvider，注册到 registry，动态模型拉取 | 低 |
| **Phase 4: 兼容迁移** | provider ID `openai` → `comfly` 的 settings/localStorage 迁移 | 中 |

## 7. 替代简化方案

如果不想重构 Provider 继承体系，可以用**最小改动方案**：

1. **保持 OpenAIProvider 不动**（id 仍为 `"openai"`，指向 Comfly）
2. **新建 JiJingProvider** 直接复制 OpenAIProvider 代码，改 id 为 `"jijing"`，删掉硬编码模型列表改为动态拉取
3. **只改代理层**（storage.ts + vite.config.ts + Rust config.rs）
4. 改动量 ~5 个文件，30 分钟内完成

**代价**：chat/stream/image/video 逻辑重复两份，后续需同步维护。

---

**建议**：如果短期只加 JiJing 一个平台，用**替代简化方案**快速落地；如果预期后续还会加更多平台，选**方案 B** 一步到位。
