# r2v 参考视频像素压缩 — 设计与施工图

> 状态:**已实施(前端/Rust 编码 + 单测全绿,未发版)**。
> 目标:Seedance 2.0 参考生视频(r2v)在提交前,自动把**过大的参考视频**等比缩到上游像素上限以下,**不过度压缩**(已达标的原样放行)。
>
> 实施落点(对照 §7 清单):
> - Rust:`src-tauri/src/commands/frame_extract.rs` 新增 `compress_reference_video` 命令 + `compute_target_dims` / `parse_video_dimensions_line` / `probe_video_dimensions` 助手 + 3 个纯函数单测;`src-tauri/src/lib.rs` 注册命令。
> - 前端:`src/lib/videoCompress.ts`(`MAX_REF_VIDEO_PIXELS` + `shrinkReferenceVideoForSeedance` + 纯函数 `describeCompressError`);`src/services/generation/buildVideoRequest.ts` refVideos 上传前按族缩放;`src/lib/__tests__/videoCompress.test.ts` 9 例。
> - 验证:`vitest run` 113/113、`tsc -b` 0 err、`eslint` 0;Rust `cargo test ... -- target_dims parse_video_dimensions`。

---

## 1. 背景与根因

用户在画布连一段参考视频 → 选「Seedance 2.0(火山原生 / VIP)」→ 生成,上游报:

```
火山方舟视频生成失败: The parameter `content[2]` specified in the request is not valid:
the parameter video pixel count specified in the request must be less than or equal to
2086876 for model doubao-seedance-2-0 in r2v.
```

- `content[2]` = 提交 body 里 `content[]` 数组的第 3 项,即那条 `{ type:"video_url", role:"reference_video" }`(见 [`buildSeedanceBody`](../src/providers/shared/video.ts) 与 [`JiJingProvider.buildSeedanceV2Body`](../src/providers/jijing/index.ts))。
- **根因**:参考视频**单帧像素数 `宽 × 高` 超过上游硬上限**。上游对 r2v 的参考视频限制单帧 `W×H ≤ 2,086,876`(≈ 1080p)。用户素材(手机直拍 / 2K / 4K)超了就被拒。
- 现状:前端**完全不碰参考视频尺寸**,`refVideos[].url` 原样 [`uploadMediaBatch`](../src/platform/media.ts) 上传 → 塞 body → 被上游拒。

### 上限数字的两个口径(重要)

| 口径 | 单帧像素上限 | 来源 |
|---|---|---|
| **运行时硬上限**(本次报错) | `2,086,876`(≈1080p) | API 报错,**权威、当前实际强校验** |
| 文档推荐区间 | `[409,600, 927,408]`(640×640 ~ 834×1112,720p 档) | [seedance2.0.txt:211](seedance2.0.txt) 的"传入单个视频要求" |

两者冲突:`comfly` 中转 / 火山 `doubao-seedance-2-0-260128` 新版放宽到了 ~2.08M,而文档表格还停在 720p 档。**以报错为准**:按用户要求"就在临界点以下",目标取 ≈1080p。预算值做成**单一可调常量**,若未来某 SKU 回退到 927,408 档,一行改掉即可。

---

## 2. 设计原则

1. **不过度压缩**(用户硬要求)。先探尺寸:`W×H ≤ 预算` → **原样放行,零再编码、零质损**;只有超了才等比缩。
2. **缩到临界点正下方**,不是缩到 720p。缩放因子 `s = sqrt(预算 / (W×H))`,几乎贴着上限。
3. **复用已有 ffmpeg 基建**。本仓已有成熟的 [`frame_extract.rs`](../src-tauri/src/commands/frame_extract.rs):`ensure_ffmpeg`(优先复用 / 按需下载 + SHA 校验)、`resolve_video_path`(`local://` / 绝对 / 相对 data_dir + SSRF 防越权)、`FfmpegCommand` 调用范式、按 sha 分目录缓存。**新命令直接复用这套**,不另起炉灶。
4. **提交前、上传前**做。改在唯一翻译层 [`buildVideoRequest.ts`](../src/services/generation/buildVideoRequest.ts),手点 / 组跑 / agent 三路同时受益。
5. **幂等 + 缓存**。压缩产物按 `(源 sha, 预算)` 命中缓存,同一视频多次生成不重复编码。

---

## 3. 关键事实:参考视频在提交前是**本地文件**

| 来源 | `refVideos[].url` 形态 | ffmpeg 能否直接处理 |
|---|---|---|
| 用户拖入视频(r2v 主场景) | `local://media/videos/xxx.mp4`([useFileDrop.ts:221](../src/hooks/useFileDrop.ts) `d.videoUrl = saved.localPath`) | ✅ 直接处理 |
| 上游视频卡输出([extractOutput](../src/lib/dataFlow.ts) 取 `d.videoUrl`) | 多数已本地化为 `local://…`;Windows 显示 URL 可能是 `http://asset.localhost/<enc-abs>` | ✅(asset URL 先用 `tauriAssetUrlToLocalPath` 反解回绝对路径) |
| 远端 COS / 模板 `https://…/xxx.mp4` | 真远端 URL | ❌ 当前 Rust 命令明确拒 `http(s)://`(留作后续:下载后再压) |

> 结论:**r2v 的绝大多数参考视频在提交前就是 data_dir 内的本地文件**,ffmpeg 能直接读。远端 URL 是少数派,本期降级处理(原样透传,可能仍被拒),后续迭代补"先下载再压"。

---

## 4. 架构与数据流

```
buildVideoRequest()                         [src/services/generation/buildVideoRequest.ts]
  └─ imageMode==="reference" 且 (isSeedanceV2 || isSeedanceVip) 且 refVideos 非空
       └─ 对每条 refVideo.url:
            shrinkReferenceVideoForSeedance(url)   ← 新增 [src/lib/videoCompress.ts]
              ├─ asset.localhost 显示URL → 反解绝对路径 (复用 tauriAssetUrlToLocalPath)
              ├─ 真远端 http(s):// / data: / blob: → 原样返回 (本期不压)
              └─ 本地路径 → invoke("compress_reference_video", {videoPath, maxPixels})
                    ↓ Rust [src-tauri/src/commands/frame_extract.rs 内新增]
                    1. resolve_video_path() 安全解析
                    2. ensure_ffmpeg()
                    3. 探源尺寸 W×H  (ffmpeg -i 解析 stderr 的 Video 流行)
                    4. W×H ≤ maxPixels?  → 是: 原样返回源相对路径 (不编码)
                                          → 否: 算偶数目标尺寸 → ffmpeg scale 再编码
                    5. 产物落 media/compressed/{sha16}_{maxPixels}.mp4 (命中缓存即跳过)
                    ← 返回相对路径 "media/compressed/…"
       └─ uploadMediaBatch(缩放后的 url 们)  → 上传压缩版 → 塞 body.videos/content[]
```

---

## 5. Rust 命令规格

新增 Tauri 命令(放在 [`frame_extract.rs`](../src-tauri/src/commands/frame_extract.rs),复用同文件的 `resolve_video_path` / `ensure_ffmpeg` / `compute_sha256`):

```rust
/// 把参考视频等比缩到「单帧像素 ≤ max_pixels」以下。
/// 已达标 → 原样返回源相对路径(不再编码);超标 → 缩放再编码,产物落 media/compressed/。
/// 返回值:可被 mediaToApiRef 消费的相对路径(media/...)或源路径。
#[tauri::command]
pub async fn compress_reference_video(
    state: State<'_, AppState>,
    video_path: String,
    max_pixels: u64,          // 前端传(SSOT 在 TS),Rust 兜底默认 2_073_600
) -> Result<String, String>;
```

### 5.1 探尺寸(无 ffprobe,沿用 frame_extract 的文本解析范式)

`probe_video_duration` 已用 `ffmpeg -hide_banner -i <file>` + 解析 stderr 拿 Duration。这里同一次调用顺手解析视频流尺寸:

```
Stream #0:0[0x1](und): Video: h264 (High) ..., yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 30 fps, ...
                                                          ^^^^^^^^^ 取第一个 \d+x\d+
```

- 正则 `(\d{2,5})x(\d{2,5})`,取 `Video:` 行里**第一个** `WxH` token(`[SAR 1:1 DAR 16:9]` 里是 `:` 不是 `x`,不会误匹配)。
- 失败兜底:返错"无法解析视频分辨率",上层降级(不压,原样上传)。
- ffmpeg-sidecar v2 若有 `FfmpegEvent` 的 stream 尺寸字段亦可用;文本解析更稳、与既有 `parse_duration_line` 同构,**优先文本解析**。

### 5.2 目标尺寸算法

```
P = max_pixels
若 W*H <= P:  返回源路径(不编码)              // 原则 #1 不过度压缩
否则:
  s  = sqrt(P / (W*H))
  tw = floor(W*s) ; tw -= tw % 2              // H.264 要求偶数边
  th = floor(H*s) ; th -= th % 2
  while tw*th > P:                            // 修偶数取整带来的溢出(罕见)
     缩较长边 2 像素
  tw = max(tw, 2) ; th = max(th, 2)           // 防 0(源已是本地真视频,不会触发)
  // AR 天然保持 → [0.4,2.5] 不破;不放大(s<1 保证)
```

举例(P=2,073,600):
- `1920×1088`(2,088,960,刚超)→ s≈0.9963 → **1912×1084**(2,072,608 ✓),肉眼无差。
- `3840×2160`(4K,8,294,400)→ s≈0.5001 → **1920×1080**(2,073,600 ✓)。
- `1080×1920`(竖屏1080p,2,073,600)→ **不压,原样**。

### 5.3 编码参数

```
ffmpeg -y -i <src> -vf scale=tw:th \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
  -an -movflags +faststart <out.mp4>
```

- `-crf 20`:参考视频要的是运动/结构,不是像素级保真,20 视觉接近无损且文件小。可调。
- `-an`:**丢音轨**。reference_video 角色只取视觉;音频走独立 `audio_url` 输入。丢音轨也帮着压到"单视频 ≤ 50MB"。
- `-movflags +faststart`:moov 前置,利于上游(及 COS)边下边解。
- `-pix_fmt yuv420p`:最大兼容,顺带把奇异编码/色彩格式归一化。

### 5.4 缓存与落盘

- 输出目录 `data_dir/media/compressed/`,文件名 `{源sha前16}_{max_pixels}.mp4`。
- 命中即返(`out.is_file()` → 直接返相对路径),不重复编码。与 keyframes 的按 sha 分目录同范式。
- 返回相对路径 `media/compressed/{name}`,`mediaToApiRef` 的 `upload_to_server` 能解析(与 keyframes 图返回 `media/keyframes/…` 被当 imageUrl 上传同理)。

---

## 6. 前端集成

### 6.1 新增 [`src/lib/videoCompress.ts`](../src/lib/videoCompress.ts)

```ts
/** Seedance r2v 参考视频单帧像素上限。硬上限 2,086,876(API 报错),
 *  取 1080p 等效留 ~0.6% 余量,吸收上游对偶数/倍数的再取整。SSOT。 */
export const MAX_REF_VIDEO_PIXELS = 2_073_600;

/** 若参考视频超像素预算则等比缩并返回新本地路径;已达标 / 远端 / 无法处理 → 原样返回。 */
export async function shrinkReferenceVideoForSeedance(
  url: string,
  maxPixels = MAX_REF_VIDEO_PIXELS,
): Promise<string> {
  // 1. asset.localhost 显示 URL → 绝对路径(复用 platform/media 的 tauriAssetUrlToLocalPath)
  // 2. 真远端 http(s):// / data: / blob: → 原样返回(本期不压;远端留待"下载后再压")
  // 3. 本地路径(local:// / media/ / 绝对)→ invoke("compress_reference_video", { videoPath, maxPixels })
  //    成功返新相对路径;失败(已探出"需要压"却编码失败)→ throw 友好错误,
  //    由 buildVideoRequest 的既有 try/catch 呈现(编辑器 setError / cardRunner failed)。
}
```

错误策略:**只有"判定需要压缩但压缩失败"才 throw**(让用户知道原因);"不需要压/远端/非本地"一律静默原样返回,绝不挡住生成。

### 6.2 改 [`buildVideoRequest.ts`](../src/services/generation/buildVideoRequest.ts) 的 refVideos 上传段

当前(约 271–278 行):
```ts
if (data.refVideos?.length) {
  const uploadedVideos = await uploadMediaBatch(data.refVideos.map(e => e.url), {...});
  ...
}
```

改为:**先按族缩放,再上传**。
```ts
if (data.refVideos?.length) {
  const needShrink = isSeedanceV2 || isSeedanceVip;       // 仅 → doubao-seedance-2-0 r2v 的两族
  let urls = data.refVideos.map(e => e.url);
  if (needShrink) {
    urls = await Promise.all(urls.map(u => shrinkReferenceVideoForSeedance(u)));
  }
  const uploadedVideos = await uploadMediaBatch(urls, { onProgress: reportUpload("参考视频") });
  ...
}
```

- **门控** `isSeedanceV2 || isSeedanceVip`:这两族最终都打到火山 `doubao-seedance-2-0`(V161 火山原生 / V145 Nexus),共享同一像素上限。
- **暂不含 `isOmni`**(Veo Omni / DSF 甜甜圈,上游不同、像素上限未知);待确认 omni-edit 源视频上限后再纳入同一管线。
- `isSeedance`(Dale)/ `isGrok` 本就在上游拒绝参考视频(现有逻辑,不动)。

### 6.3 进度提示(可选,推荐)

压一段 4K 视频要几秒。`buildVideoRequest` 已有 `opts.onUploadProgress(kind, …)` 通道。在缩放前 emit 一句 `reportUpload("压缩参考视频")` 让编辑器进度条显示"正在压缩参考视频…",避免"卡住"错觉。

---

## 7. 改动清单(逐文件)

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands/frame_extract.rs` | **新增** `compress_reference_video` 命令 + 尺寸解析 helper(复用 `resolve_video_path`/`ensure_ffmpeg`/`compute_sha256`) |
| `src-tauri/src/lib.rs` | `invoke_handler![]` 注册 `commands::frame_extract::compress_reference_video`(紧挨现有 3 个视频命令,~965 行) |
| `src/lib/videoCompress.ts` | **新增**:`MAX_REF_VIDEO_PIXELS` + `shrinkReferenceVideoForSeedance()` |
| `src/services/generation/buildVideoRequest.ts` | refVideos 上传前插入按族缩放;import `shrinkReferenceVideoForSeedance` |
| `src/services/generation/__tests__/buildRequests.test.ts` | 加用例:V2/VIP + 超大 refVideo → 走缩放;Dale/Grok/omni / 已达标 → 不缩 |

> commands/mod.rs 无需改(`frame_extract` 已 `pub mod`)。

---

## 8. 测试计划

**Rust 单测**(`frame_extract.rs` 内,`#[ignore]` 跑真 ffmpeg,与现有 `end_to_end_bundled_ffmpeg_can_extract_frame` 同范式):
- `testsrc` 造 `3840×2160` 2s 视频 → `compress_reference_video(P=2_073_600)` → 产物存在且 `W×H ≤ P` 且为偶数边、AR 保持。
- 造 `1280×720` 视频(720p,921,600 < P)→ **返回源路径、产物目录无新文件**(验"不过度压缩")。
- 纯函数 `target_dims(W,H,P)` 抽出来做无 ffmpeg 单测:边界(刚好等于 P / 刚超 1 像素 / 4K / 极端宽高比)均 `≤ P` 且偶数。

**前端单测**(`buildRequests.test.ts`,mock `invoke`):
- seedance-v2 + refVideos → 断言 `invoke("compress_reference_video", …)` 被调、上传的是返回路径。
- seedance(Dale)/grok → refVideos 早被拒,不触发缩放。
- omni → **不**触发缩放(本期门控外)。

**端到端**(参 [`reference_ai_canvas_browser_e2e.md`] 思路 / 真机):拖一段 4K 视频 → seedance-v2 r2v 生成 → 不再报 2086876,出片。

---

## 9. 不在本期范围(已知,留 backlog)

1. **远端 URL 参考视频**:Rust 命令仍拒 `http(s)://`。需"先下载到 data_dir 再压"。本期降级为原样透传(可能仍被拒)。
2. **相邻约束**:文档对参考视频还有 fps `[24,60]`、单视频时长 `[2,15]s`、`≤50MB`、宽高比 `[0.4,2.5]`。本期只治像素数(再编码已顺带归一化编码格式 + 丢音轨减体积)。fps>60 / 时长>15s 仍可能触发**别的**报错 —— 可在同一 ffmpeg pass 加 `-r 60`(钳帧率)/ `-t 15`(截断)兜底,但会改内容,留作可选开关。
3. **omni-edit 源视频**:确认上游像素上限后并入同一管线。

---

## 10. 待决策(实施前确认)

| # | 决策点 | 默认/推荐 |
|---|---|---|
| A | 像素预算取值 | **2,073,600(1080p 等效)**,硬上限 2,086,876 留余量;一行常量可调 |
| B | 是否顺带钳 fps / 截时长 | 否(只治像素,最小改动);按需开 `-r 60` / `-t 15` |
| C | omni 是否纳入 | 否(上游/上限不同);确认后再加 |
| D | 压缩失败的兜底 | "需压却失败"→ 报错挡生成(让用户知情);"无需压/远端"→ 静默放行 |
