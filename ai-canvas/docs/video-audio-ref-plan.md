# 视频卡片支持「参考音频」— 完整方案

## 1. 需求与 API 能力

### Seedance 2.0 音频参考能力

| 属性 | 值 |
|------|-----|
| API role | `reference_audio` |
| 数量 | 0~3 段 |
| 格式 | wav、mp3 |
| 单段时长 | [2, 15] s |
| 总时长 | ≤ 15 s |
| 单段大小 | ≤ 15 MB |
| 传入方式 | `audio_url` content item（URL / Base64） |
| 约束 | 不可单独输入音频，至少包含 1 个参考视频或图片 |

### API content 结构示例

```json
{
  "content": [
    { "type": "text", "text": "..." },
    { "type": "image_url", "image_url": { "url": "..." }, "role": "reference_image" },
    { "type": "audio_url", "audio_url": { "url": "data:audio/wav;base64,..." }, "role": "reference_audio" }
  ]
}
```

---

## 2. 现状审计

### 2.1 当前没有任何音频相关代码

搜索 `audio` / `Audio` 关键字，仅命中：
- `VideoEditor.tsx` — `generateAudio` 布尔开关（控制输出是否有声）
- `providers/types.ts` — `VideoGenRequest.generateAudio`
- `providers/seedance/index.ts` — 将 `generateAudio` 传给 API

**结论**：音频**输入**（参考音频）是全新功能，需要从零搭建以下环节：

```
音频文件来源        存储               UI 展示           API 调用
─────────────     ─────────        ─────────         ─────────
① 画布拖放        ③ VideoData      ④ VideoEditor     ⑤ Seedance Provider
② 编辑器上传        .refAudios       音频条目展示        audio_url content
                                    播放/删除
```

### 2.2 现有基础设施可复用分析

| 基础设施 | 能否复用 | 说明 |
|----------|----------|------|
| `persistImage()` + `saveMedia()` | ✅ 可复用 | 底层 `saveMedia` 按二进制保存文件，不限格式 |
| `getBase64ForApi()` → `readMediaBase64()` | ✅ 可复用 | 底层读取任意文件为 base64 |
| `RefImageSlot` 组件 | ❌ 不适用 | 专为图片设计（img 标签、aspect-square），音频需要不同的 UI |
| `useFileDrop` hook | 🔧 需扩展 | 当前过滤器只接受 image/video，需加入 audio |
| `file-drop.ts`（Tauri） | 🔧 需扩展 | 文件扩展名过滤器不含 .wav/.mp3 |
| `refImages` / `refFrames` 模式 | 📐 参考模式 | 音频用类似的数组模式 `refAudios` |

### 2.3 关键设计决策

> **音频参考是视频卡片内部的功能，不需要新的卡片类型。**
> 
> 音频不能作为独立媒体卡片（不像图片/视频可以预览），它只作为视频生成的输入参数。
> 因此音频直接存储在 `VideoData.refAudios` 中，通过编辑器内的上传区域管理。

---

## 3. 数据模型设计

### 3.1 新增类型

```typescript
/** 音频引用条目 */
interface AudioRefEntry {
  /** 存储路径或 data URL */
  url: string;
  /** 原始文件名（用于 UI 展示） */
  filename: string;
  /** 音频时长（秒），上传时检测 */
  duration?: number;
}
```

### 3.2 VideoData 接口扩展

```typescript
interface VideoData {
  // ... 已有字段 ...

  /** 参考音频，最多 3 段 */
  refAudios?: AudioRefEntry[];
}
```

### 3.3 VideoGenRequest 接口扩展

```typescript
// providers/types.ts
interface AudioRefInput {
  url: string;
  role: string;  // "referenceAudio"
}

interface VideoGenRequest {
  // ... 已有字段 ...
  referenceAudios?: AudioRefInput[];
}
```

---

## 4. 逐步改动清单

### Step 1: `providers/types.ts` — 新增 AudioRefInput + VideoGenRequest 扩展

**文件**: `src/providers/types.ts`

在 `ImageRefInput` 旁边新增 `AudioRefInput`，在 `VideoGenRequest` 中新增 `referenceAudios` 字段。

```typescript
export interface AudioRefInput {
  url: string;
  role: string;
}

export interface VideoGenRequest {
  // ... 已有 ...
  referenceAudios?: AudioRefInput[];
}
```

**影响范围**：类型定义，零运行时副作用。

---

### Step 2: `providers/seedance/index.ts` — 构建 audio_url content items

**文件**: `src/providers/seedance/index.ts`  
**位置**: `generateVideo` 方法中构建 `content` 数组之后

```typescript
// 在 referenceImages 处理之后
if (req.referenceAudios?.length) {
  for (const ref of req.referenceAudios) {
    content.push({
      type: "audio_url",
      audio_url: { url: ref.url },
      role: "reference_audio",
    });
  }
}
```

**影响范围**：仅在 `referenceAudios` 有值时额外 push，不影响现有逻辑。

---

### Step 3: `useFileDrop.ts` — 画布拖放支持音频文件

**文件**: `src/hooks/useFileDrop.ts`

#### 3a. 新增音频文件识别

```typescript
const AUDIO_EXTENSIONS = /\.(wav|mp3)$/i;

function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/") || AUDIO_EXTENSIONS.test(file.name);
}

function isAudioPath(path: string): boolean {
  return AUDIO_EXTENSIONS.test(path);
}
```

#### 3b. 扩展文件过滤器

当前 `handleDrop` 的过滤器：

```typescript
// 修改前：
const rawFiles = Array.from(e.dataTransfer.files).filter(
  (f) => f.type.startsWith("image/") || isVideoFile(f) || isHeicFile(f),
);

// 修改后：增加 isAudioFile
const rawFiles = Array.from(e.dataTransfer.files).filter(
  (f) => f.type.startsWith("image/") || isVideoFile(f) || isHeicFile(f) || isAudioFile(f),
);
```

#### 3c. 音频拖到画布空白区域的处理

音频不创建独立卡片（没有预览意义），而是：
- 如果拖到视频卡片上 → 注入 `refAudios`
- 如果拖到画布空白 → 创建一个新的空视频卡片并注入

对于画布空白区域拖放，需要在 `createMediaCard` 之外新增处理逻辑。

#### 3d. 音频拖到视频卡片上的处理

扩展 `canCardAcceptFileDrop` 和 `handleDropOnCard`，让 `ai_video` 可以接受音频文件：

```typescript
function canCardAcceptFileDrop(cardId: string, fileType?: "image" | "audio"): boolean {
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return false;
  if (useUIStore.getState().generatingCards.has(cardId)) return false;
  // ... 现有 image/tryon 逻辑 ...
  if (card.type === "ai_video" && fileType === "audio") {
    const d = card.data as { refAudios?: unknown[] };
    return (d.refAudios?.length ?? 0) < 3;
  }
  return false;
}
```

---

### Step 4: `platform/file-drop.ts` — Tauri 拖放扩展文件名过滤器

**文件**: `src/platform/file-drop.ts`

```typescript
// 修改前：
/\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?|mp4|webm|mov|avi|mkv)$/i

// 修改后：增加 wav|mp3
/\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?|mp4|webm|mov|avi|mkv|wav|mp3)$/i
```

---

### Step 5: `VideoEditor.tsx` — 音频管理 UI

**文件**: `src/features/editor/VideoEditor.tsx`

#### 5a. VideoData 新增 `refAudios`

```typescript
interface AudioRefEntry {
  url: string;
  filename: string;
  duration?: number;
}

interface VideoData {
  // ... 已有 ...
  refAudios?: AudioRefEntry[];
}
```

#### 5b. 新增 AudioRefBar 内联组件

在提示词输入区域之前，当存在音频时展示：

```
┌─────────────────────────────────────────────────┐
│  [图片模式切换区域]                                │  ← 已有
├─────────────────────────────────────────────────┤
│  🔊 参考音频 (1/3)                                │  ← 新增
│  ┌─────────────────────────────────────────┐    │
│  │ ♪ voice_sample.wav  0:05  [▶] [×]       │    │
│  └─────────────────────────────────────────┘    │
│  [+ 添加音频]                                    │
├─────────────────────────────────────────────────┤
│  [上游文字区域]                                    │
│  [prompt textarea]                               │
│                                     [✨ 生成]     │
└─────────────────────────────────────────────────┘
```

每条音频条目展示：
- 文件名（截断）
- 时长（如果已知）
- 播放按钮（用原生 `<audio>` 播放预览）
- 删除按钮

#### 5c. 上传音频的交互方式

1. **文件选择器**：点击 `[+ 添加音频]` 按钮打开文件选择器（accept=".wav,.mp3"）
2. **拖放到卡片**：从系统拖放 .wav/.mp3 到视频卡片
3. **拖放到编辑器**：在编辑器音频区域拖放

```typescript
const addAudio = useCallback(async (file: File) => {
  const dataUrl = await readFileAsDataUrl(file);
  const saved = await persistImage(dataUrl, undefined, projectId);
  const duration = await getAudioDuration(file);

  const refAudios = [...(data.refAudios ?? [])];
  if (refAudios.length >= 3) return; // max 3
  refAudios.push({ url: saved.localPath, filename: file.name, duration });

  updateCard(card.id, { data: { ...data, refAudios } });
  autoSave.markDirty(card.id);
}, [data, card.id, updateCard, projectId]);
```

#### 5d. 音频时长检测

```typescript
function getAudioDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    audio.preload = "metadata";
    const cleanup = () => { audio.onloadedmetadata = null; audio.onerror = null; URL.revokeObjectURL(url); };
    const timer = setTimeout(() => { cleanup(); resolve(undefined); }, 3000);
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      const dur = audio.duration;
      cleanup();
      resolve(Number.isFinite(dur) ? Math.round(dur) : undefined);
    };
    audio.onerror = () => { clearTimeout(timer); cleanup(); resolve(undefined); };
    audio.src = url;
  });
}
```

#### 5e. handleGenerate — 传入参考音频

```typescript
// 在构建 referenceImages 之后
const referenceAudios: Array<{ url: string; role: string }> = [];
if (data.refAudios?.length) {
  for (const audio of data.refAudios) {
    const dataUrl = await getBase64ForApi(audio.url);
    referenceAudios.push({ url: dataUrl, role: "referenceAudio" });
  }
}

const result = await provider.generateVideo({
  prompt,
  model: currentModel || undefined,
  size: currentSize,
  referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
  referenceAudios: referenceAudios.length > 0 ? referenceAudios : undefined,
  onProgress: (p) => { ... },
});
```

---

## 5. 不需要修改的文件

| 文件 | 原因 |
|------|------|
| `dataFlow.ts` | 音频不通过卡片连线传递，只在编辑器内部管理 |
| `connectionRecovery.ts` | 音频无 sourceCardId，不涉及连接恢复 |
| `useConnectionSync.ts` | 音频不建立连接，无需清理 |
| `model-ref-images.ts` | 音频与图片参考槽位体系无关 |
| `CardShell.tsx` | 音频不通过卡片间连线传递 |

---

## 6. 改动影响矩阵

```
文件                                        改动类型   行数估算   风险
───────────────────────────────────────────────────────────────────
src/providers/types.ts                      修改       ~8行      低
  └─ 新增 AudioRefInput + VideoGenRequest.referenceAudios

src/providers/seedance/index.ts             修改       ~10行     低
  └─ 构建 audio_url content items

src/features/editor/VideoEditor.tsx         修改       ~120行    中
  ├─ VideoData 新增 refAudios
  ├─ AudioRefBar 内联组件
  ├─ addAudio / removeAudio 回调
  ├─ handleGenerate 传入 referenceAudios
  └─ getAudioDuration 工具函数

src/hooks/useFileDrop.ts                    修改       ~30行     低
  ├─ 音频文件识别
  ├─ 文件过滤器扩展
  └─ 音频拖到视频卡片的处理

src/platform/file-drop.ts                   修改       ~2行      低
  └─ Tauri 拖放文件名过滤器
```

**总计**: 修改 5 个文件，新增约 170 行。

---

## 7. 数据流追踪

### 7.1 编辑器内上传

```
点击 [+ 添加音频]
  → input[type=file] accept=".wav,.mp3"
  → readFileAsDataUrl(file)
  → persistImage(dataUrl)                    ← 复用现有存储
  → getAudioDuration(file)                   ← 新增
  → data.refAudios.push({ url, filename, duration })
  → updateCard()
```

### 7.2 画布拖放

```
拖入 .wav/.mp3 文件到画布
  → useFileDrop.handleDrop
  → isAudioFile(file) === true
  → 找到下方视频卡片？
    ├─ 是 → persistImage() → 注入 target.data.refAudios
    └─ 否 → 创建空视频卡片 → 注入 refAudios
```

### 7.3 生成时发送

```
handleGenerate()
  → data.refAudios → getBase64ForApi(url) → referenceAudios
  → provider.generateVideo({ ..., referenceAudios })
  → SeedanceProvider.generateVideo()
  → content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" })
  → POST /seedance/v3/contents/generations/tasks
```

---

## 8. 边界情况与验证

| 场景 | 处理方式 |
|------|----------|
| 上传超过 3 段音频 | `addAudio` 检查 `length >= 3`，拒绝并 toast |
| 单段音频 > 15MB | 上传前检查文件大小，超限 toast 警告 |
| 单段音频 > 15s | `getAudioDuration` 检测后 toast 警告（但不阻止，API 会报错） |
| 无图片/视频只传音频 | API 不允许，`handleGenerate` 可以在 UI 上提示 |
| 非 wav/mp3 格式 | 文件选择器和拖放过滤器限制，不会进入 |
| 旧项目无 `refAudios` | `?? []` fallback，区域不显示，行为不变 |
| 非 Seedance 模型 | 其他 Provider 忽略 `referenceAudios`（接口可选字段） |

---

## 9. 测试验证清单

- [ ] 点击 [+ 添加音频] → 文件选择器弹出，只显示 .wav/.mp3
- [ ] 选择 .wav 文件 → 音频条目出现，显示文件名和时长
- [ ] 播放按钮 → 可以预览音频
- [ ] 删除按钮 → 音频条目移除
- [ ] 添加 3 段后再添加 → 被拒绝，显示 toast
- [ ] 从系统拖放 .mp3 到视频卡片 → 注入 refAudios
- [ ] 拖放 .wav 到画布空白 → 创建视频卡片 + 注入音频
- [ ] 生成视频 → API 请求 content 包含 audio_url items
- [ ] Tauri 环境拖放 .wav → 正常处理
- [ ] 旧项目打开 → 无音频区域，行为不变
