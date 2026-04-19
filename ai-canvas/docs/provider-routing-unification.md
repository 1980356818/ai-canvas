# Provider 路由统一重构计划

> 创建时间：2026-04-19
> 状态：**已完成**

## 1. 问题背景

重构前代码存在 **三套独立的 Provider 路由体系**，互相不打通：

### 路由体系 A：`providerManager`（卡片编辑器）

- 位于 `stores/agentStore.ts`，是 registry 的薄壳包装
- `getDefault()` 写死返回 Comfly，`setDefault()` 是 no-op
- **已删除**

### 路由体系 B：`providerStore` + `providerService`（首页聊天）

- 存储 `providerId:modelId` composite key，有 localStorage 持久化
- 设计最合理，保留

### 路由体系 C：ChatEditor 硬编码

- `providerService.chat("comfly", ...)` 完全无视 `data.provider`
- **已修复**

## 2. 问题清单与解决状态

| # | 问题 | 解决 |
|---|------|------|
| P1 | `providerManager` 无意义包装，硬编码 Comfly | ✅ 已删除 |
| P2 | `ChatEditor` 硬编码 `providerService.chat("comfly", ...)` | ✅ 已改用 `resolveProvider` |
| P3 | `modelService.getDefault*()` 只返回 modelId | ✅ 现返回 `ModelRef { modelId, providerId }` |
| P4 | `parseCompositeKey` fallback 硬编码 Comfly | ✅ 已改为 `tryResolveProvider` 反查 |
| P5 | 编辑器双重 Comfly 兜底 | ✅ 已改用 `resolveProvider` 单一入口 |
| P6 | `providerService.getModels` 与 `modelService` 重复 | ✅ 已删除重复逻辑 |

## 3. 架构设计

### 核心：`modelService.resolveProvider(modelId, providerId?)`

```
所有场景 → modelService.resolveProvider(modelId, providerId)
         ├── providerId 有效且已注册 → 直接返回
         ├── providerId 缺失/无效 → 按 modelId 在 listModelsSync() 中反查
         └── 都找不到 → 抛错（不静默降级）
```

### 安全变体：`modelService.tryResolveProvider(modelId, providerId?)`

- 找不到时返回 `undefined` 而非抛错
- 用于 `useEffect` 初始化等不应阻塞的场景

### 默认值：`ModelRef` 类型

```ts
export interface ModelRef {
  modelId: string;
  providerId: string;
}
```

`getDefaultChatModel()` / `getDefaultImageModel()` / `getDefaultVideoModel()` 全部返回 `ModelRef`，确保新卡片创建时 `model` 和 `provider` 同时设置。

### 旧卡片兼容

编辑器 `useEffect` 三段式初始化：
1. `model + provider` 都有 → 直接用
2. 只有 `model` → 用 `tryResolveProvider` 反查补齐 provider
3. 都没有 → 用 `getDefault*Model()` 同时设置 model + provider

## 4. 实施记录

### Phase 1：`services/models.ts`
- 新增 `ModelRef` 类型
- 新增 `resolveProvider()` 和 `tryResolveProvider()`
- 改 `getDefault*Model()` 返回值为 `ModelRef`

### Phase 2：`stores/agentStore.ts` + `agent/context.ts`
- 删除 `providerManager` 对象（约 20 行）
- 删除 `AgentProviderManager` 类型定义
- `createAgentContext` 签名简化（移除 providerManager 参数）
- `callProvider` 改用 `modelService.resolveProvider`
- `sendMessage` 改用 `resolveProvider`
- `stores/index.ts` 移除 `providerManager` 导出

### Phase 3：5 个卡片编辑器
- `MediaEditor.tsx`：删 `providerManager`，用 `resolveProvider`，修 `useEffect` 三段式
- `VideoEditor.tsx`：同上
- `TryOnEditor.tsx`：同上，补充 `provider` 字段到 `TryOnData` 接口
- `ChatEditor.tsx`：删硬编码 `"comfly"`，补充 `provider` 字段到 `ChatData` 接口，用 `resolveProvider`
- `MultiangleEditor.tsx`：删 `providerManager`，用 `resolveProvider(MODEL_ID)`

### Phase 4：`ModelSelector.tsx`
- `parseCompositeKey` fallback 改为 `tryResolveProvider` 反查

### Phase 5：`services/provider.service.ts`
- 删除重复的 `getModels()` 方法和 `matchCapability()` 函数

### Phase 6：调用方适配
- `AIPromptInput.tsx`：适配 `ModelRef` 返回值 `.modelId`
- `chatStore.ts`：两处默认值加载适配 `ModelRef`

### Phase 7：类型增强
- `providers/types.ts`：`AIProvider` 接口新增可选 `listModelsSync?()`
- `providers/openai-compat/base.ts`：基类实现 `listModelsSync()` 返回 `staticModels()`

## 5. 改动文件总览

| 文件 | 操作 |
|------|------|
| `services/models.ts` | **改**：新增 ModelRef + resolveProvider + 改默认值返回类型 |
| `stores/agentStore.ts` | **改**：删除 providerManager，重构 sendMessage |
| `agent/context.ts` | **改**：删除 AgentProviderManager，简化 createAgentContext |
| `stores/index.ts` | **改**：移除 providerManager 导出 |
| `features/editor/MediaEditor.tsx` | **改**：resolveProvider + useEffect 三段式 |
| `features/editor/VideoEditor.tsx` | **改**：同上 |
| `features/editor/TryOnEditor.tsx` | **改**：同上 + 补 provider 字段 |
| `features/editor/ChatEditor.tsx` | **改**：删硬编码 comfly + 补 provider 字段 |
| `features/editor/MultiangleEditor.tsx` | **改**：resolveProvider(MODEL_ID) |
| `features/editor/ModelSelector.tsx` | **改**：parseCompositeKey fallback 反查 |
| `services/provider.service.ts` | **改**：删重复 getModels + matchCapability |
| `features/home/AIPromptInput.tsx` | **改**：适配 ModelRef |
| `stores/chatStore.ts` | **改**：适配 ModelRef |
| `providers/types.ts` | **改**：新增 listModelsSync 可选方法 |
| `providers/openai-compat/base.ts` | **改**：实现 listModelsSync |

## 6. 未动的文件

| 文件 | 理由 |
|------|------|
| `providers/registry.ts` | 底层基础设施，逻辑正确 |
| `providers/comfly/` | Provider 子类正确 |
| `providers/jijing/` | Provider 子类正确 |
| `providers/index.ts` | 注册逻辑正确 |
| `stores/providerStore.ts` | 首页聊天 ref 管理合理 |

## 7. 验证结果

- `npx tsc --noEmit`：✅ 零错误
- `ReadLints` 全部改动文件：✅ 零错误
