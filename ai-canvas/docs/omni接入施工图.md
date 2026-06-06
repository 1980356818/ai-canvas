# Omni / Omni-Edit 接入 ai-canvas 视频节点 — 施工图

> 目标:在视频节点(`ai_video`)接入极境网关的 **omni**(Veo Omni Flash 生成)与 **omni-edit**(视频编辑)。
> 后端已上线并验证(JiJing V188,channel 1099):`omni` 文生/首尾帧/参考、固定 10s;`omni-edit` 源视频+可选参考图、固定 10s。
> 本文每个改动点都标注了**真实 file:line**(2026-06-06 通读核实),禁止照本文猜测——施工前若文件已变动需重新核对。

---

## 0. 已确认的设计决策(用户拍板)

| # | 决策 | 落地方式 |
|---|---|---|
| D1 | **单一下拉项** "omni",连入视频自动变 omni-edit | `card.data.model` 恒存 `"omni"`;提交时 `resolveOmniModelId(hasReferenceVideos)` 分流到 `omni` / `omni-edit`。**与现有 `resolveSeedanceV2ModelId(version, hasVideos)` 同构**(shared/video.ts:593) |
| D2 | 源视频**只能连接视频节点**,不开放上传 | 复用现有 `refVideos`(连线注入),不加上传控件 |
| D3 | imageMode 默认 **参考(reference)**;首尾帧=i2v,参考=r2v,无图=t2v | omni 专属默认;`video_type` 由 imageMode 派生下发 |
| D4 | 首尾帧图数超阈值自动切参考 | **见 §5 待决**(与现状 2 帧硬上限冲突) |

---

## 1. 现状数据链路(已核实)

```
VideoEditor.tsx(选模型/模式/比例/连素材)
  → buildVideoRequest.ts(card.data → VideoGenRequest,上传素材、解析 SKU)   [编辑器手点 & cardRunner 组跑共用]
    → JiJingProvider.generateVideo(providers/jijing/index.ts:46,按模型族分流)
      → buildXxxBody → POST /v1/videos/generations
        → JiJing 后端 collectVideoParams → DsfOmniVideoAdapter(V188)
```

**已具备、无需新建的能力:**
- `refVideos → referenceVideos → body.videos`:jijing/index.ts:277、buildVideoRequest.ts:267-274、types.ts:159。后端 omni-edit 读 `videos` 取源视频。
- 连线注入:`ai_video` 输出 kind=video(dataFlow.ts:22);video→ai_video **在 reference 模式且非 Seedance 时已放行**(dataFlow.ts:106-117 + 644-668)。**omni 非 Seedance,默认 reference,故源视频连线开箱即走。**
- imageMode 编码 i2v/r2v:reference / firstLastFrame(model-ref-images.ts:128)。
- `video:${i}` @ 引用:refVideos 自动出现在提示词 @ 选单(useImageRefSources.ts:117-133)。
- 比例选择器自动降级:omni 不命中任何 `isVeo/isSeedanceV2/...` 分支 → SizeCombo 只渲染比例(VideoEditor.tsx:1046-1115)。

---

## 2. 上游网关 body 对照(canvas → /v1/videos/generations)

omni(无源视频):
```jsonc
{ "model":"omni", "prompt":"…", "aspect_ratio":"16:9|9:16",
  "video_type":"t2v|i2v|r2v",            // 由 imageMode 派生
  "images":[{"url":"…"}]                  // i2v:首/尾按序;r2v:参考图(≤7)。后端 DsfOmniVideoAdapter 塞进 messages
}
```
omni-edit(连了源视频):
```jsonc
{ "model":"omni-edit", "prompt":"…", "aspect_ratio":"16:9|9:16",
  "videos":[{"url":"<源视频>"}],          // 后端 firstSourceVideoUrl 取首个 → 顶层 video_url
  "images":[{"url":"…"}]                  // 可选参考图
}
```
**两者都不发** `duration`(后端固定 10s)、`generate_audio`、`resolution`、`seed`。omni 用单一 `images` 字段(靠 `video_type` 区分 i2v/r2v),**不做 Veo 那样的 images/referenceImages 拆分**(jijing/index.ts:252-273 是 Veo 专属,omni 不复用)。

---

## 3. 改动清单(逐文件 · 精确插入点)

### 3.1 `src/providers/shared/video.ts` — 检测器 + 解析器(新增,无现存逻辑改动)
- 新增常量 `OMNI_ALIAS_ID="omni"`、`OMNI_EDIT_ID="omni-edit"`。
- `isOmniModel(id)` = `id==="omni" || id==="omni-edit"`。
- `isOmniEditModel(id)` = `id==="omni-edit"`。
- `resolveOmniModelId(hasVideos)` = `hasVideos ? "omni-edit" : "omni"`(照 resolveSeedanceV2ModelId:593 写法)。
- `deriveOmniVideoType(imageMode, imageCount)`:`imageCount===0?"t2v":imageMode==="firstLastFrame"?"i2v":"r2v"`。
- `toOmniAspectRatio(size)`:复用 `toVeoAspectRatio` 逻辑(515),非 16:9/9:16 兜底 `"16:9"`。

### 3.2 `src/providers/jijing/models.ts`
- 顶部 re-export(对照 3-9 行现有 5 个 re-export)加:`isOmniModel as isJiJingOmniModel`、`isOmniEditModel as isJiJingOmniEditModel`。
- `JIJING_VIDEO_MODELS`(47)**在 `seedance-v2` 之后**追加:
  `{ id: "omni", display_name: "Veo Omni Flash", capability: "VIDEO" }`。
  > 顺序说明:`getDefaultVideoModel` 取聚合列表 `models[0]` 作新用户默认(models.ts:131-135),放 seedance-v2 之后不改默认。

### 3.3 `src/providers/jijing/index.ts`
- import 加 `isJiJingOmniModel, isJiJingOmniEditModel, toOmniAspectRatio`(toOmniAspectRatio 从 shared/video)。
- `generateVideo`(46):在落 `super.generateVideo` 前加
  `if (isJiJingOmniModel(model)) return this.generateOmniVideo(req);`(omni id 与其它族互斥,放哪都安全)。
- 新增 `generateOmniVideo(req)`:`executeAsyncMediaTask({ submitEndpoint: JIJING_VIDEO_ENDPOINT, body: this.buildOmniBody(req), expectedSec: PROGRESS_EXPECTED_SEC.videoVeo, kind:"video_gen", … })`(照 generateSeedanceV2Video:130 模板)。
- 新增 `buildOmniBody(req)`:见 §2;`isJiJingOmniEditModel(req.model)` 走 videos 分支,否则走 video_type 分支。

### 3.4 `src/providers/types.ts`
- `VideoGenRequest`(153)加:`/** omni 模式: t2v/i2v/r2v(由 imageMode 派生)。 */ videoType?: string;`

### 3.5 `src/services/generation/buildVideoRequest.ts`
- import 加 `isOmniModel, resolveOmniModelId, deriveOmniVideoType`。
- 191 附近加 `const isOmni = isOmniModel(modelId);`。
- effectiveModel(300-310)三元链加 omni 分支:`isOmni ? resolveOmniModelId(hasReferenceVideos) : …`。
- 组装 request(321)加:`videoType: isOmni && !hasReferenceVideos ? deriveOmniVideoType(imageMode, referenceImages.length) : undefined`。
- **核对**:effectiveDuration(318)omni 不在列 → undefined ✅;resolution(331)→ undefined ✅;generateAudio(333)→ undefined ✅;refVideos 拒绝(256)仅 seedance/grok,omni 放行 ✅。

### 3.6 `src/shared/constants.ts`
- import 加 `isOmniModel`。
- `getAllowedVideoSizesForModel`(128)开头加:`if (isOmniModel(modelId)) return ["16:9", "9:16"];`。
- `getDefaultVideoSizeForModel`(141):omni 走兜底 `DEFAULT_VIDEO_SIZE="16:9"` ✅(可不改;如显式则加一行)。

### 3.7 `src/config/model-ref-images.ts`
- import 加 `isOmniModel`(从 shared/video)。
- 新增 `OMNI_R2V_SLOTS`(7 槽,照 GROK_VIDEO_REF_SLOTS:89)。
- `getRefSlotsForVideoModel`(137):`reference` 分支里加 `if (isOmniModel(modelId)) return OMNI_R2V_SLOTS;`(firstLastFrame 仍返回 [] 走 frames 通道,i2v 帧上限由 dataFlow 控)。

### 3.8 `src/features/editor/VideoEditor.tsx`
- import + 加 `const isOmni = isOmniModel(currentModel);`(206 附近)。
- `availableModes`(214):条件加 `|| isOmni` → omni 给 `["firstLastFrame","reference"]`。
- **omni 默认 reference**:`handleModelChange`(490)切到 omni 且 `!data.imageMode` 时 `newData.imageMode="reference"`;mount 的 `applyAndSet`(322)同样兜底。(全局默认 firstLastFrame 不动,避免影响 seedance/veo。)
- 视频块(930-979):gate 已含 omni(omni 非 seedance/grok/vipEconomy);**为 omni 改文案**"源视频 · 连线的视频"且容量显示 **1**。
- **不需要**改:SizeCombo(自动只剩比例)、音频开关(omni 不在 isSeedance/isGrok/isSeedanceV2 列)、handleGenerate(全通用)。
- (D4)自动切模式 effect:见 §5。

### 3.9 `src/lib/dataFlow.ts`(轻改)
- 源视频容量:`canAcceptConnection`(114)与 `injectIntoCard`(662)的 `< 3` 对 omni 收紧为 `< 1`(单源视频)。**两处必须同步改**(文件头 14-16 行硬规则)。
- (可选)`audio → ai_video`(91):omni 无音频,加 `isOmniModel` 拦截,避免无效连线。

### 3.10 `src/services/generation/__tests__/buildRequests.test.ts`
- 加 omni 用例(照 95-136 的 seedance-v2 写法):
  - 无图 → `model "omni"`,`videoType "t2v"`。
  - `imageMode:"reference"` + refImages → `model "omni"`,`videoType "r2v"`,referenceImages role referenceImage。
  - refFrames 2 张 → `model "omni"`,`videoType "i2v"`,referenceImages firstFrame/lastFrame。
  - `imageMode:"reference"` + refVideos → `model "omni-edit"`,referenceVideos 非空(参照 125-136)。

---

## 4. 必须成对改 / 易漏点(核实过的坑)

1. **dataFlow 双写**:`canAcceptConnection` 与 `injectIntoCard` 是验证/注入同一基准,改容量/规则必须两处同步(dataFlow.ts:14-16 明文)。
2. **omni 必须默认 reference**:否则新建 omni 卡是 firstLastFrame,连视频被 "当前模式不支持参考视频" 拒(dataFlow.ts:107),D1/D2 失效。
3. **omni-edit 的源视频只在 reference 分支上传**:buildVideoRequest firstLastFrame 分支(229)不处理 refVideos;只要 omni 默认 reference 即闭合,无需改 firstLastFrame 分支。
4. **images 顺序即 i2v 首/尾**:referenceImages 已按 firstFrame→lastFrame 入序(buildVideoRequest:234),buildOmniBody 原序透传即可,omni 后端按序取首/尾。
5. **单测 refVideos 需配 `imageMode:"reference"`** 才会被 buildVideoRequest 采集(否则走 firstLastFrame 分支不读 refVideos)。

---

## 5. D4 首尾帧阈值 — ✅ 已定 A 并实施 (2026-06-06)

> **决策:A(阈值=2)。** 实现:omni 在 firstLastFrame 满 2 帧后再连第 3 张图,
> dataFlow 不再拒绝,而是自动切到 reference 模式,把 2 帧 + 新图迁到 refImages、清空 refFrames
> (canAcceptConnection 放行 + injectIntoCard 执行迁移,两处同步)。

**背景(核实):** firstLastFrame 在 dataFlow.ts:135 **硬封顶 2 帧**(`frames.length < 2`),连第 3 张原本直接被拒 "参考帧已满"。所以「超过 3 张自动切参考」按字面无法触发,两种解读:

- **(A) 推荐 · 贴合上游**:阈值=2。omni i2v 上游只吃 **首+尾 2 帧**。实现为「firstLastFrame 已有 2 帧时,再连第 3 张 → 自动切 reference 并把图都转参考」。需要 dataFlow 给 omni 特判(注入时翻 imageMode + 迁移 frames→refImages),中等复杂度。
- **(B) 按字面**:给 omni 把 firstLastFrame 上限放宽到 3,连第 4 张才切。但 omni i2v 上游仍只用 2 帧,第 3 帧会被上游忽略,有"传了不生效"的困惑。

> 建议:**核心(D1/D2/D3)先落地**——omni 默认 reference 已覆盖绝大多数场景(参考/编辑都在 reference);把 (A) 的自动切作为 §6 之后的增强项单列。请确认走 A 还是 B,以及是否随核心一起做。

---

## 6. 验证矩阵

| 层 | 手段 | 断言 |
|---|---|---|
| 纯函数 | `vitest` buildRequests.test.ts | omni t2v/i2v/r2v 的 model+videoType+referenceImages;omni-edit 的 model+referenceVideos(§3.10) |
| 类型/规约 | `tsc` + `eslint` | 全绿 |
| 浏览器 E2E | dev:1620,主世界注入驱动 zustand(见 reference_ai_canvas_browser_e2e) | 1) omni 文生出片;2) omni 参考(连图)出片;3) omni-edit(连一个已出片的视频节点当源)出片;4) 切 16:9/9:16 生效;5) 计费侧后端为 omni ¥1.52 / omni-edit ¥2.02 |

> E2E 真出片会走真实计费,确认后再跑;先过 vitest+tsc+eslint。

---

## 7. 分期

- **P1 逻辑层**:§3.1–3.6(detectors / provider body / types / buildVideoRequest / 比例约束)+ §3.10 单测 → vitest 绿。**纯 TS,可独立验。**
- **P2 配置 + 连接**:§3.7(ref 槽)、§3.9(容量/音频)。
- **P3 UI**:§3.8(模式可选项、默认 reference、源视频文案)。
- **P4 ✅ 已完成**:§5(A)首尾帧满 2 帧→第 3 张图自动切参考(dataFlow.ts canAcceptConnection + injectIntoCard)。
- **P5 验证**:§6 全套(vitest+tsc+eslint 已绿;浏览器 E2E 真出片待跑)。

---
_生成于 2026-06-06,基于当时主分支通读。施工前请重新核对引用行号。_
