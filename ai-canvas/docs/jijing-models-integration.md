# JiJing 模型接入 — 完整实施计划 v2

## 一、现状问题

### 1.1 死代码：`providers/openai/` 整个目录

`providers/openai/` 包含 `index.ts`、`models.ts`、`formatter.ts` 三个文件，
是重构前的旧 Provider。重构后其功能已被 `openai-compat/base.ts` + `comfly/` 完全替代：

- `openai/formatter.ts` → 已复制到 `openai-compat/formatter.ts`
- `openai/models.ts` → 已复制到 `comfly/models.ts`
- `openai/index.ts` (OpenAIProvider) → 已被 `OpenAICompatProvider` + `ComflyProvider` 替代

**唯一外部引用**：`chatStore.ts` 引用的是 `openai-compat/formatter.ts`（新位置），不是旧的。

**结论：可安全删除 `providers/openai/` 整个目录。**

### 1.2 `resolveImageModelId` 是 Comfly 专用但被全局使用

`services/models.ts` 直接从 `comfly/models.ts` 导入 `resolveImageModelId` 并 re-export，
`MediaEditor.tsx` 调用时**不知道当前模型属于哪个平台**。

Comfly 规则：2K 加 `-2k`，4K 加 `-4k`。
JiJing 规则：2K **不加后缀**，4K 加 `-4k`。

`nano-banana-pro` 两个平台都有。JiJing 用户选它生成 2K 图 →
当前代码返回 `nano-banana-pro-2k`（Comfly 格式）→ **JiJing 400 错误**。

### 1.3 `getDisplayName` 只认识 Comfly 模型 + 有 bug

```typescript
// services/models.ts — 只查 Comfly
getDisplayName(modelId: string): string {
  const comflyName = getComflyDisplayName(modelId);
  if (comflyName) return comflyName;
  for (const p of registry.getAll()) {
    p.listModels().then(models => {      // ← bug: 同步函数里的异步结果被忽略
      const found = models.find(m => m.id === modelId);
      if (found) return found.display_name ?? found.id;  // ← return 的是 .then 回调
    });
  }
  return modelId;  // 永远走这里
}
```

### 1.4 编辑器始终用 Comfly 发请求（4 处）

| 文件 | 行 | 代码 |
|------|-----|------|
| `MediaEditor.tsx` | 339 | `providerManager.getDefault()` → 永远 Comfly |
| `VideoEditor.tsx` | 201 | `providerManager.getDefault()` → 永远 Comfly |
| `TryOnEditor.tsx` | 128 | `providerManager.getDefault()` → 永远 Comfly |
| `ChatEditor.tsx` | — | 不使用 providerManager（走 chatStore/chatService） |

### 1.5 `ModelSelector` 丢失 Provider 归属

`modelService.getByCapability()` 返回 `ModelOption[]`（含 `providerId`），
但 `ModelSelector.onChange` 只传出 `modelId`，**providerId 被丢弃**。

`ModelSelector` 被 5 处使用：

| 使用处 | capability | 是否需要 providerId |
|--------|-----------|-------------------|
| `MediaEditor.tsx` | IMAGE | ✅ 需要（路由到正确平台 + resolveImageModelId） |
| `VideoEditor.tsx` | VIDEO | ✅ 需要（路由到正确平台） |
| `TryOnEditor.tsx` | IMAGE | ✅ 需要（路由到正确平台 + resolveImageModelId） |
| `ChatEditor.tsx` | CHAT | ✅ 需要（路由到正确平台） |
| `AIPromptInput.tsx` | CHAT/IMAGE | ⚠️ 暂不需要（model 写入 card data，生成在 chatStore 处理） |

---

## 二、设计原则

1. **每个 Provider 自治**：模型列表、分辨率解析、显示名 → 都是 Provider 自己的职责
2. **modelService 是纯聚合层**：跨 Provider 聚合/路由，不包含任何 Provider 特定逻辑
3. **Provider 归属静默传递**：用户在设置里管平台，编辑器里只选模型，providerId 内部自动流转
4. **向后兼容**：旧 card data 没有 `provider` 字段时，默认回退 `"comfly"`

---

## 三、实施计划（7 Phase）

### Phase 1：清理死代码

| 操作 | 文件 |
|------|------|
| 删除 | `providers/openai/index.ts` |
| 删除 | `providers/openai/models.ts` |
| 删除 | `providers/openai/formatter.ts` |

验证：`tsc --noEmit` 通过。

---

### Phase 2：Provider 接口扩展 + 基类默认实现

**`providers/types.ts`** — `AIProvider` 接口新增两个可选方法：

```typescript
export interface AIProvider {
  // ... 现有方法不变

  /** 根据分辨率解析最终发给 API 的模型 ID（如 nano-banana-pro → nano-banana-pro-4k） */
  resolveImageModelId?(baseId: string, resolution: string): string;

  /** 同步获取模型的人类可读名称 */
  getDisplayName?(modelId: string): string | undefined;
}
```

**`providers/openai-compat/base.ts`** — 基类默认实现：

```typescript
resolveImageModelId(baseId: string, _resolution: string): string {
  return baseId;  // 默认透传
}

getDisplayName(modelId: string): string | undefined {
  const m = this.staticModels().find(m => m.id === modelId);
  return m ? (m.display_name ?? m.id) : undefined;
}
```

这样每个子类自动获得基于 `staticModels()` 的 `getDisplayName`，
`resolveImageModelId` 默认不变换，子类按需 override。

---

### Phase 3：新建 `providers/jijing/models.ts`

```typescript
import type { ModelInfo } from "@/types";

export const JIJING_CHAT_MODELS: ModelInfo[] = [
  { id: "gemini-3.1-pro-preview", display_name: "Gemini 3.1 Pro", capability: "CHAT" },
];

export const JIJING_IMAGE_MODELS: ModelInfo[] = [
  { id: "nano-banana-2",   display_name: "Nanobanana 2",   capability: "IMAGE" },
  { id: "nano-banana-pro", display_name: "Nanobanana Pro", capability: "IMAGE" },
];

export const ALL_JIJING_MODELS: ModelInfo[] = [
  ...JIJING_CHAT_MODELS,
  ...JIJING_IMAGE_MODELS,
];
```

---

### Phase 4：更新两个 Provider 子类

**`providers/comfly/index.ts`** — 新增 override：

```typescript
resolveImageModelId(baseId: string, resolution: string): string {
  return resolveComflyImageModelId(baseId, resolution);
}

getDisplayName(modelId: string): string | undefined {
  return getComflyDisplayName(modelId);  // 含 LEGACY_DISPLAY 兜底
}
```

`comfly/models.ts` 中已有 `resolveImageModelId`（函数名需重命名避免冲突）
→ 重命名为 `resolveComflyImageModelId`，只改函数名，逻辑不变。

**`providers/jijing/index.ts`** — 完善模型 + override：

```typescript
protected staticModels() { return ALL_JIJING_MODELS; }
protected defaultImageModel() { return "nano-banana-2"; }

resolveImageModelId(baseId: string, resolution: string): string {
  if (baseId === "nano-banana-2")
    return resolution === "4K" ? "nano-banana-2-4k" : "nano-banana-2";
  if (baseId === "nano-banana-pro")
    return resolution === "4K" ? "nano-banana-pro-4k" : "nano-banana-pro";
  return baseId;
}

// capabilities 移除 video_gen（本次不接入视频）
// 删除 videoEndpoint() override
```

---

### Phase 5：改造 `services/models.ts`（去除 Comfly 硬编码）

**目标**：modelService 不再引用任何 Provider 特定模块，纯聚合路由。

```typescript
// 删除: import { resolveImageModelId, getComflyDisplayName } from "comfly/models"

resolveImageModelId(baseId: string, resolution: string, providerId?: string): string {
  const provider = providerId ? registry.tryGet(providerId) : undefined;
  return provider?.resolveImageModelId?.(baseId, resolution) ?? baseId;
},

getDisplayName(modelId: string, providerId?: string): string {
  if (providerId) {
    const name = registry.tryGet(providerId)?.getDisplayName?.(modelId);
    if (name) return name;
  }
  for (const p of registry.getAll()) {
    const name = p.getDisplayName?.(modelId);
    if (name) return name;
  }
  return modelId;
},
```

---

### Phase 6：`ModelSelector` 静默传递 Provider

**核心改动**：`onChange` 签名从 `(modelId) => void` 变为 `(modelId, providerId) => void`。
**UI 不变**：不加平台选择器。同名模型冲突时加小后缀区分。

```typescript
interface ModelSelectorProps {
  capability: "CHAT" | "IMAGE" | "VIDEO";
  value: string;
  onChange: (modelId: string, providerId: string) => void;
  className?: string;
}
```

内部 `models` state 从 `ModelInfo[]` 改为 `ModelOption[]`（已含 `providerId`）。
select value 使用 `providerId:modelId` 复合键，onChange 拆分后传出。

平台标注逻辑：

```typescript
// 当列表中存在多个平台的模型时，所有模型都加平台前缀
const providerIds = new Set(models.map(m => m.providerId));
const multiProvider = providerIds.size > 1;

const label = multiProvider
  ? `[${m.providerName}] ${displayName}`
  : displayName;
```

- 多平台模型共存 → **所有模型**都加 `[平台名]` 前缀
- 只有单平台 → 不加前缀（无歧义）

**5 个调用方适配**：

| 文件 | 改动 |
|------|------|
| `MediaEditor.tsx` | `handleModelChange(modelId, providerId)` → 存 `data.provider` |
| `VideoEditor.tsx` | `handleModelChange(modelId, providerId)` → 存 `data.provider` |
| `TryOnEditor.tsx` | `handleModelChange(modelId, providerId)` → 存 `data.provider` |
| `ChatEditor.tsx` | `handleModelChange(modelId, providerId)` → 存 `data.provider` |
| `AIPromptInput.tsx` | `(modelId, _providerId) => setSelectedModel(modelId)` → 暂忽略 providerId |

---

### Phase 7：编辑器 Provider 路由修复（3 处）

**`MediaEditor.tsx`**：
```typescript
// 改前
const provider = providerManager.getDefault();
const resolvedModel = modelService.resolveImageModelId(currentModel, currentResolution);

// 改后
const pid = (data as MediaData).provider || "comfly";
const provider = providerManager.get(pid) ?? providerManager.getDefault();
const resolvedModel = modelService.resolveImageModelId(currentModel, currentResolution, pid);
```

**`VideoEditor.tsx`**：
```typescript
// 改前
const provider = providerManager.getDefault();

// 改后
const pid = data.provider || "comfly";
const provider = providerManager.get(pid) ?? providerManager.getDefault();
```

**`TryOnEditor.tsx`**：
```typescript
// 改前
const provider = providerManager.getDefault();

// 改后
const pid = data.provider || "comfly";
const provider = providerManager.get(pid) ?? providerManager.getDefault();
```

---

## 四、完整改动文件清单

| Phase | 文件 | 操作 | 说明 |
|-------|------|------|------|
| 1 | `providers/openai/` | **删除** (3 文件) | 死代码清理 |
| 2 | `providers/types.ts` | 修改 | AIProvider 接口加 2 个可选方法 |
| 2 | `providers/openai-compat/base.ts` | 修改 | 基类默认实现 |
| 3 | `providers/jijing/models.ts` | **新建** | JiJing 静态模型列表 |
| 4 | `providers/comfly/models.ts` | 修改 | 函数重命名 `resolveImageModelId` → `resolveComflyImageModelId` |
| 4 | `providers/comfly/index.ts` | 修改 | override resolveImageModelId + getDisplayName |
| 4 | `providers/jijing/index.ts` | 修改 | staticModels + resolveImageModelId + 移除 video |
| 5 | `services/models.ts` | 修改 | 去 Comfly 硬编码，改为 Provider 路由 |
| 6 | `features/editor/ModelSelector.tsx` | 修改 | onChange 静默传 providerId |
| 6 | `features/editor/MediaEditor.tsx` | 修改 | handleModelChange 存 provider |
| 6 | `features/editor/VideoEditor.tsx` | 修改 | handleModelChange 存 provider |
| 6 | `features/editor/TryOnEditor.tsx` | 修改 | handleModelChange 存 provider |
| 6 | `features/editor/ChatEditor.tsx` | 修改 | handleModelChange 存 provider |
| 6 | `features/home/AIPromptInput.tsx` | 修改 | onChange 适配新签名 |
| 7 | `features/editor/MediaEditor.tsx` | 修改 | 生成时按 provider 路由 |
| 7 | `features/editor/VideoEditor.tsx` | 修改 | 生成时按 provider 路由 |
| 7 | `features/editor/TryOnEditor.tsx` | 修改 | 生成时按 provider 路由 |

**总计**：删除 3 文件，新建 1 文件，修改 13 文件（部分文件在多个 Phase 出现，实际去重后 12 文件）。

**不需要改**：
- `openai-compat/formatter.ts` — 协议层，与模型无关
- `registry.ts` — 已完善
- `vite.config.ts` / `storage.ts` — 代理层已就绪
- `config.rs` / `gateway.rs` — Rust 端已就绪
- `SettingsDialog.tsx` — 已有 JiJing 平台卡片 + 启用/禁用

---

## 五、用户体验流程（最终效果）

```
[设置页面]
  Comfly    ✅ 启用   (配好 API Key)
  JiJing    ✅ 启用   (配好 API Key)

[画布 → 图片编辑器 → 模型下拉]（两个平台都启用时）
  [Comfly] Gemini 3.1 Pro (Thinking)
  [Comfly] Nanobanana 2
  [Comfly] Nanobanana Pro
  [极境] Gemini 3.1 Pro
  [极境] Nanobanana 2
  [极境] Nanobanana Pro

  用户选「[极境] Nanobanana 2」
  → 内部自动记住 providerId = "jijing"
  → 生成时请求自动发到 JiJing 的 /v1/images/generations
  → 分辨率 2K 时模型 ID 就是 "nano-banana-2"（不加后缀，JiJing 规则）

[只启用了一个平台时]
  Gemini 3.1 Pro (Thinking)
  Nanobanana 2
  Nanobanana Pro
  → 不加 [平台] 后缀（无歧义）
```

---

## 六、风险控制

| 风险 | 影响 | 缓解 |
|------|------|------|
| 旧 card data 无 `provider` 字段 | 模型归属未知 | 回退 `"comfly"`，与现有行为一致 |
| `ModelSelector` onChange 签名变更 | 5 处调用方都要适配 | Phase 6 统一改，`tsc` 检查遗漏 |
| 删除 `providers/openai/` | 可能有遗漏引用 | Phase 1 先删再编译，失败立刻回退 |
| 两平台同名模型 | 用户分不清 | 多平台共存时所有模型加 `[平台名]` 前缀 |
