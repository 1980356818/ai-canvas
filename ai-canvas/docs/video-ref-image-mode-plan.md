# 视频卡片支持「参考图模式」— 最终方案

## 1. 问题与目标

### 当前行为

视频卡片连入的图片始终被当作 **首尾帧**（`first_frame` / `last_frame`），最多 2 张。

### 目标行为

用户可在视频卡片上选择图片用途——**首尾帧** 或 **参考图**（`reference_image`），两种模式互斥（Seedance API 约束）。

### Seedance 2.0 支持的三种互斥图片场景

| 场景 | API `role` 值 | 数量上限 | 说明 |
|------|---------------|----------|------|
| 首帧生视频 | `first_frame` | 1 张 | 图片锁定为视频第一帧 |
| 首尾帧生视频 | `first_frame` + `last_frame` | 2 张 | 图片分别锁定为首帧和尾帧 |
| 多模态参考生视频 | `reference_image` | 1~9 张 | 图片仅作为风格/内容参考，不控制首尾帧 |

---

## 2. 架构审计 — 可复用的现有基础设施

### 2.1 系统中已存在的两套图片管理体系

| 体系 | 使用者 | 数据结构 | 核心组件 |
|------|--------|----------|----------|
| **refImages 槽位制** | `ai_image` / `ai_multiangle` / `ai_chat` | `Record<string, RefImageEntry>` | `RefImageSlot` 组件、`model-ref-images.ts` 配置、`removeRefImageForSource` 清理、`canAcceptImageConnection` 容量检查 |
| **refFrames 数组制** | `ai_video` | `VideoFrameRef[]`（最多 2） | `VideoEditor` 自行管理的 inline UI、`removeVideoFrameForSource` 清理 |

### 2.2 关键发现：refImages 体系的通用性

`refImages` 槽位制覆盖了完整的生命周期：

```
连接前             连接时              使用中              连接删除
─────────         ─────────          ─────────          ─────────
canAccept         injectIntoCard     RefImageSlot UI    removeRefImageForSource
ImageConnection   → refImages 注入   → 展示/上传/拖放   → 按 sourceCardId 清理
→ 检查槽位容量    → 填入空槽位        → 重排序            → compact 压缩
```

还包括：
- `connectionRecovery.ts` — **已经**同时扫描 `refImages` 和 `refFrames`，无需修改
- `useConnectionSync.ts` — **已经**调用 `removeRefImageForSource`，无需修改

### 2.3 核心设计决策

> **参考图模式复用 `refImages` 槽位制，首尾帧模式保留 `refFrames` 数组制。**

理由：
- 参考图模式的需求（多张、无序、可增删、可拖放上传）与 `ai_image` 的 `refImages` 完全一致
- 复用 `RefImageSlot` 组件可获得：文件上传、拖放、卡片拖入、重排序、缩略图展示、清除
- 复用 `removeRefImageForSource` 和 `canAcceptImageConnection` 无需额外写清理/容量逻辑
- 首尾帧模式有顺序语义（第 1 张=首帧、第 2 张=尾帧），不适合槽位制，保留数组

---

## 3. 数据模型设计

### 3.1 VideoData 接口变更

```typescript
interface VideoData {
  // ── 已有字段（不变） ──────────────────────────
  content?: string;
  videoUrl?: string;
  model?: string;
  provider?: string;
  size?: string;
  upstreamTexts?: Record<string, string>;
  inlineRefs?: InlineImageRef[];
  refFrames?: VideoFrameRef[];              // 首尾帧模式使用
  upstreamCardId?: string;
  _locked?: boolean;
  _label?: string;
  _description?: string;
  duration?: number;
  resolution?: string;
  generateAudio?: boolean;

  /** @deprecated use refFrames instead */
  upstreamImageUrl?: string;

  // ── 新增字段 ────────────────────────────────
  /** 图片使用模式。默认 "frame"（首尾帧），"reference"（参考图）。 */
  imageMode?: "frame" | "reference";
  /** 参考图模式下使用，复用 RefImageEntry 槽位结构。 */
  refImages?: Record<string, RefImageEntry>;
}
```

### 3.2 模式互斥约束

- `imageMode === "frame"` 时：只读写 `refFrames`，忽略 `refImages`
- `imageMode === "reference"` 时：只读写 `refImages`，忽略 `refFrames`
- 切换模式时执行数据迁移（详见 Step 4）

### 3.3 向后兼容

- 旧项目无 `imageMode` 字段 → 默认 `"frame"` → 行为与改动前完全一致
- 旧项目无 `refImages` 字段 → 参考图区域为空 → 无影响

---

## 4. 逐步改动清单

### Step 1: `model-ref-images.ts` — 新增视频模型的参考图槽位配置

**目的**：为参考图模式提供槽位定义，复用已有的槽位体系。

```typescript
// 新增：视频参考图模式的 9 个槽位
const VIDEO_REF_SLOTS: RefImageSlot[] = Array.from({ length: 9 }, (_, i) => ({
  key: `refImage${i}`,
  label: `参考图${i + 1}`,
  description: "视频参考图",
  required: false,
}));

/** 获取视频卡片在参考图模式下的槽位。首尾帧模式返回空数组。 */
export function getRefSlotsForVideoModel(
  _modelId: string,
  imageMode: "frame" | "reference" = "frame",
): RefImageSlot[] {
  return imageMode === "reference" ? VIDEO_REF_SLOTS : [];
}
```

**影响**：仅新增函数，不修改任何现有导出，零副作用。

---

### Step 2: `dataFlow.ts` — 四处修改，让 ai_video 接入 refImages 体系

#### 2a. `canAcceptImageConnection` — 增加 ai_video 容量检查

当前 `ai_video` 不在 `REF_IMAGE_TARGETS` 中，连接始终放行。需按模式分别检查容量：

```typescript
export function canAcceptImageConnection(
  targetCardId: string,
  sourceCardId: string,
): boolean {
  const cardStore = useCardStore.getState();
  const target = cardStore.getCard(targetCardId);
  if (!target) return true;

  const source = cardStore.getCard(sourceCardId);
  if (!source || !IMAGE_SOURCE_TYPES.has(source.type)) return true;

  // ── 新增: ai_video 按模式检查容量 ──
  if (target.type === "ai_video") {
    const d = target.data as Record<string, unknown>;
    const mode = (d.imageMode as string) ?? "frame";
    if (mode === "reference") {
      const slots = getRefSlotsForVideoModel((d.model as string) || "", "reference");
      const refImages = (d.refImages || {}) as Record<string, RefImageEntry>;
      for (const slot of slots) {
        if (refImages[slot.key]?.sourceCardId === sourceCardId) return true;
      }
      return slots.some((s) => !refImages[s.key]);
    }
    // frame 模式：检查 refFrames 数组容量
    type FrameRef = { url: string; sourceCardId: string };
    const frames = (d.refFrames as FrameRef[]) || [];
    if (frames.some((f) => f.sourceCardId === sourceCardId)) return true;
    return frames.length < 2;
  }

  // ── 原有逻辑（ai_image / ai_multiangle / ai_chat）不变 ──
  if (!REF_IMAGE_TARGETS.has(target.type)) return true;
  // ...
}
```

#### 2b. `removeRefImageForSource` — 扩展守卫条件

当前守卫 `!REF_IMAGE_TARGETS.has(target.type)` 排除了 `ai_video`。改为也允许 `ai_video`：

```typescript
export function removeRefImageForSource(
  targetCardId: string,
  sourceCardId: string,
): void {
  const cardStore = useCardStore.getState();
  const target = cardStore.getCard(targetCardId);
  // 修改前: if (!target || !REF_IMAGE_TARGETS.has(target.type)) return;
  // 修改后: 增加 ai_video
  if (!target || (!REF_IMAGE_TARGETS.has(target.type) && target.type !== "ai_video")) return;
  // ... 后续逻辑不变，按 sourceCardId 匹配删除 ...
}
```

**效果**：连接删除时，`useConnectionSync` 调用 `removeRefImageForSource` 可以清理 `ai_video` 卡片上的 `refImages`。无需新增清理函数。

#### 2c. `injectIntoCard` ai_video 分支 — 按 imageMode 路由注入

```typescript
case "ai_video": {
  if (payload.kind === "text") {
    // ... 不变 ...
  } else if (payload.kind === "image") {
    const imageMode = (d.imageMode as string) ?? "frame";

    if (imageMode === "reference") {
      // ── 参考图模式：复用 refImages 槽位注入（与 ai_image 同逻辑） ──
      const slots = getRefSlotsForVideoModel((d.model as string) || "", "reference");
      const refImages = {
        ...((d.refImages || {}) as Record<string, RefImageEntry>),
      };

      let found = false;
      for (const slot of slots) {
        if (refImages[slot.key]?.sourceCardId === sourceCardId) {
          if (refImages[slot.key]!.url !== payload.url) {
            refImages[slot.key] = { url: payload.url, sourceCardId, sourceType: "card" };
            d.refImages = refImages;
            changed = true;
          }
          found = true;
          break;
        }
      }

      if (!found) {
        for (const slot of slots) {
          if (!refImages[slot.key]) {
            refImages[slot.key] = { url: payload.url, sourceCardId, sourceType: "card" };
            d.refImages = refImages;
            changed = true;
            break;
          }
        }
      }
    } else {
      // ── 首尾帧模式：现有逻辑不变 ──
      const MAX_FRAMES = 2;
      type FrameRef = { url: string; sourceCardId: string };
      const frames = [...((d.refFrames as FrameRef[]) || [])];
      // ...原有代码...
    }
  }
  break;
}
```

#### 2d. 导入新函数

在文件顶部 import 中增加 `getRefSlotsForVideoModel`。

---

### Step 3: `VideoEditor.tsx` — UI 改造

#### 3a. 模式切换控件

在帧/参考图区域上方增加 segmented toggle，替代现有的固定 "参考帧" 标题：

```
┌──────────────────────────────────────────────────┐
│  图片用途:  [ 首尾帧 | 参考图 ]                    │ ← segmented toggle
├──────────────────────────────────────────────────┤
│  imageMode === "frame" 时（现有 UI 不变）:         │
│  ┌─────────┐  ┌─────────┐                        │
│  │  首帧   │  │  尾帧   │  参考帧 · 最多2帧       │
│  └─────────┘  └─────────┘                        │
│                                                  │
│  imageMode === "reference" 时（复用 RefImageSlot）:│
│  ┌────┐ ┌────┐ ┌────┐ ...  ┌────┐               │
│  │ 1  │ │ 2  │ │ 3  │      │ +  │ 参考图 · 最多9张│
│  └────┘ └────┘ └────┘      └────┘               │
├──────────────────────────────────────────────────┤
│  [prompt textarea]                               │
│                                     [✨ 生成]     │
└──────────────────────────────────────────────────┘
```

#### 3b. 参考图模式渲染

参考图模式下，复用 `RefImageSlot` 组件：

```tsx
import RefImageSlot from "./RefImageSlot";
import { getRefSlotsForVideoModel, compactRefImages, type RefImageEntry } from "@/config/model-ref-images";

// 在组件内:
const refSlots = useMemo(
  () => getRefSlotsForVideoModel(currentModel, data.imageMode ?? "frame"),
  [currentModel, data.imageMode],
);

// 渲染参考图槽位（与 MediaEditor 同模式）:
{data.imageMode === "reference" && (
  <div className="flex shrink-0 flex-wrap gap-2">
    {refSlots.map((slot) => {
      const entry = data.refImages?.[slot.key];
      if (!entry && occupiedCount >= maxVisible) return null;
      return (
        <RefImageSlot
          key={slot.key}
          label={slot.label}
          description={slot.description}
          entry={entry}
          onImage={(e) => setRefImage(slot.key, e)}
          onClear={() => clearRefImage(slot.key)}
          disabled={generating}
          targetCardId={card.id}
          slotKey={slot.key}
          index={/* 已占用项的顺序索引 */}
        />
      );
    })}
  </div>
)}
```

复用 `RefImageSlot` 自动获得的能力：
- ✅ 文件上传（点击、拖放、粘贴）
- ✅ 画布卡片拖入（canvas-card-drop 事件）
- ✅ 缩略图预览 + 序号角标
- ✅ 单项删除（× 按钮）
- ✅ 槽位间拖拽重排序

#### 3c. `handleGenerate` — 按模式构建 referenceImages

```typescript
const referenceImages: Array<{ url: string; role: string }> = [];

if (data.imageMode === "reference") {
  // 参考图模式：从 refImages 槽位读取，role 统一为 referenceImage
  const slots = getRefSlotsForVideoModel(currentModel, "reference");
  for (const slot of slots) {
    const entry = data.refImages?.[slot.key];
    if (entry) {
      const dataUrl = await getBase64ForApi(entry.url);
      referenceImages.push({ url: dataUrl, role: "referenceImage" });
    }
  }
} else {
  // 首尾帧模式：从 frames 读取（现有逻辑不变）
  for (let i = 0; i < frames.length; i++) {
    const dataUrl = await getBase64ForApi(frames[i]!.url);
    referenceImages.push({ url: dataUrl, role: i === 0 ? "firstFrame" : "lastFrame" });
  }
}
```

#### 3d. `setRefImage` / `clearRefImage` 回调

从 `MediaEditor.tsx` 提取同样的模式：

```typescript
const setRefImage = useCallback((slotKey: string, entry: RefImageEntry) => {
  const refImages = { ...data.refImages, [slotKey]: entry };
  updateCard(card.id, { data: { ...data, refImages } });
  autoSave.markDirty(card.id);
  if (entry.sourceCardId) {
    // 建立连接（如果不存在）
    // ...与 MediaEditor 相同逻辑
  }
}, [card.id, data, updateCard]);

const clearRefImage = useCallback((slotKey: string) => {
  const entry = data.refImages?.[slotKey];
  if (entry?.sourceCardId) {
    // 断开对应连接
    // ...
  }
  const refImages = { ...data.refImages };
  delete refImages[slotKey];
  const compacted = compactRefImages(refImages, refSlots);
  updateCard(card.id, { data: { ...data, refImages: compacted } });
  autoSave.markDirty(card.id);
}, [card.id, data, refSlots, updateCard]);
```

---

### Step 4: `VideoEditor.tsx` — 模式切换时的数据迁移

```typescript
const handleImageModeChange = useCallback((newMode: "frame" | "reference") => {
  const oldMode = data.imageMode ?? "frame";
  if (oldMode === newMode) return;

  const newData = { ...data, imageMode: newMode };

  if (oldMode === "frame" && newMode === "reference") {
    // frame → reference: 将 refFrames 转为 refImages 前 N 项
    const refImages: Record<string, RefImageEntry> = {};
    (frames ?? []).forEach((f, i) => {
      refImages[`refImage${i}`] = { url: f.url, sourceCardId: f.sourceCardId, sourceType: "card" };
    });
    newData.refImages = Object.keys(refImages).length > 0 ? refImages : undefined;
    newData.refFrames = undefined;
  } else {
    // reference → frame: 取 refImages 前 2 项转为 refFrames
    const entries = refSlots
      .map((s) => data.refImages?.[s.key])
      .filter((e): e is RefImageEntry => !!e);
    const newFrames = entries.slice(0, 2).map((e) => ({
      url: e.url,
      sourceCardId: e.sourceCardId ?? "",
    }));
    newData.refFrames = newFrames.length > 0 ? newFrames : undefined;
    newData.refImages = undefined;
    // 超过 2 张的连接需要断开
    const droppedEntries = entries.slice(2);
    for (const entry of droppedEntries) {
      if (entry.sourceCardId) {
        // 断开多余的连接...
      }
    }
  }

  updateCard(card.id, { data: newData });
  autoSave.markDirty(card.id);
}, [data, frames, refSlots, card.id, updateCard]);
```

---

## 5. 不需要修改的文件（确认安全）

| 文件 | 原因 |
|------|------|
| `providers/seedance/index.ts` | Provider 已支持 `reference_image` role（默认 fallback），零修改 |
| `providers/types.ts` | `ImageRefInput` 的 `role: string` 足够通用，无需新增类型 |
| `connectionRecovery.ts` | **已经同时扫描** `refImages` 和 `refFrames`，两个字段都能恢复连接 |
| `useConnectionSync.ts` | **已经调用** `removeRefImageForSource`，扩展守卫后自动覆盖 ai_video |
| `removeVideoFrameForSource` | 保留不变，清理 `refFrames`；`removeRefImageForSource` 负责清理 `refImages` |
| `ConnectionLayer.tsx` | 纯渲染层 |
| `connectionStore.ts` | 不感知卡片类型 |
| `WireDropMenu.tsx` | 创建卡片并连线，不涉及数据格式 |
| `CardShell.tsx` | 连线拖放逻辑，通过 `canAcceptImageConnection` 间接受益 |

---

## 6. 改动影响矩阵

```
文件                                     改动类型    行数估算    风险
──────────────────────────────────────────────────────────────────────
src/config/model-ref-images.ts           新增函数    ~15行       低
  └─ getRefSlotsForVideoModel()

src/lib/dataFlow.ts                      修改       ~45行       中
  ├─ canAcceptImageConnection()  增加 ai_video 分支
  ├─ removeRefImageForSource()   扩展守卫条件
  ├─ injectIntoCard() ai_video   增加 reference 分支
  └─ 新增 import

src/features/editor/VideoEditor.tsx      修改       ~120行      中
  ├─ VideoData 接口               新增 imageMode / refImages
  ├─ 模式切换 UI                  新增 segmented toggle
  ├─ 参考图渲染                   复用 RefImageSlot
  ├─ handleGenerate()            按模式构建 referenceImages
  ├─ handleImageModeChange()     新增模式切换 + 数据迁移
  └─ setRefImage / clearRefImage  新增回调（从 MediaEditor 提取模式）
```

**总计**：修改 3 个文件，新增约 180 行，修改约 15 行。

---

## 7. 数据流全生命周期追踪

### 7.1 参考图模式：图片从连接到 API 调用

```
[图片卡片] ──连线──→ [视频卡片 imageMode="reference"]

1. CardShell.onPortPointerUp
   → canAcceptImageConnection()          ← Step 2a (新增 ai_video reference 容量检查)
   → addConnection()
   → injectOnConnect()

2. injectIntoCard(target, payload, sourceCardId)
   → ai_video + reference 分支           ← Step 2c (新增参考图槽位注入)
   → d.refImages[slot.key] = { url, sourceCardId, sourceType: "card" }

3. VideoEditor 渲染
   → RefImageSlot 展示缩略图             ← Step 3b (复用现有组件)

4. handleGenerate()
   → 从 refImages 读取，role="referenceImage"  ← Step 3c
   → provider.generateVideo({ referenceImages })

5. Seedance Provider                      ← 无修改
   → role === "referenceImage" → "reference_image"
   → content.push({ type: "image_url", role: "reference_image", ... })
```

### 7.2 参考图模式：连接删除清理

```
用户删除连线 → useConnectionSync 订阅器

1. removeRefImageForSource(targetId, sourceId)
   ← Step 2b (扩展守卫条件，现在也处理 ai_video)
   → 扫描 target.data.refImages → 删除匹配 sourceCardId 的条目 → compact

2. removeUpstreamTextForSource(targetId, sourceId)
   → 照常清理 upstreamTexts（无变化）

3. removeVideoFrameForSource(targetId, sourceId)
   → 照常清理 refFrames（无变化，reference 模式下 refFrames 为空）
```

### 7.3 首尾帧模式（现有行为，不变）

```
全流程与改动前完全一致：
连接 → injectIntoCard ai_video frame 分支 → refFrames → handleGenerate firstFrame/lastFrame
```

---

## 8. 边界情况与防御

| 场景 | 处理方式 |
|------|----------|
| 旧项目无 `imageMode` | `?? "frame"` fallback，行为不变 |
| `reference → frame` 超过 2 张图 | 迁移前 2 张到 `refFrames`，超出部分断开连接，toast 提示 |
| `frame → reference` | 全部迁移到 `refImages` 前 N 个槽位，连接不变 |
| 非 Seedance 模型使用参考图模式 | 其他 Provider 可能不支持 `reference_image`，UI 上可增加模型适配检查（未来扩展点） |
| 手动上传图片到 RefImageSlot | `sourceType: "file"`，无 `sourceCardId`，不建立连接，与 ai_image 行为一致 |
| 同时存在 `refFrames` 和 `refImages` | 互斥约束由 `imageMode` 保证；切换时清空另一方 |
| 参考图模式下 `canAcceptImageConnection` 拒绝 | 显示 toast「参考图已满」，与 ai_image 行为一致 |

---

## 9. 测试验证清单

### 参考图模式

- [ ] 切换到参考图模式，连入 1 张图 → `refImages.refImage0` 有值，`refFrames` 为空
- [ ] 连入 9 张图 → 全部填入 `refImage0` ~ `refImage8`
- [ ] 连入第 10 张 → 被 `canAcceptImageConnection` 拦截，显示 toast
- [ ] 点击 RefImageSlot × 按钮 → 清除图片 + 断开对应连线
- [ ] 删除上游图片卡片 → `removeRefImageForSource` 清理 `refImages`
- [ ] 点击生成 → API 请求中图片 role 为 `reference_image`
- [ ] 手动上传图片到槽位 → 正常工作，无 `sourceCardId`

### 首尾帧模式（回归测试）

- [ ] 默认模式 = "frame"，行为与改动前完全一致
- [ ] 连入 2 张图 → 标注首帧/尾帧
- [ ] 点击生成 → API 请求中 role 为 `first_frame` / `last_frame`
- [ ] 删除连线 → `removeVideoFrameForSource` 正常清理

### 模式切换

- [ ] frame(2 张) → reference → refImages 有 2 项，refFrames 为空
- [ ] reference(5 张) → frame → refFrames 有 2 项，多余 3 张的连接已断开
- [ ] 切换后再切回 → 数据正确

### 兼容性

- [ ] 打开旧项目（无 imageMode 字段）→ 默认 frame 模式，无异常
- [ ] `connectionRecovery` 从 `refImages` 和 `refFrames` 均可恢复连线
