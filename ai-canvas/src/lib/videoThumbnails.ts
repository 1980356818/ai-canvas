//! 视频缩略图生成 — 给 VideoToolbar 的时间轴 scrubber 渲染缩略图条用。
//!
//! 不调 ffmpeg, 用 HTMLVideoElement + canvas drawImage 走 webview 自带的
//! 解码器, 没有"先下载 80MB ffmpeg / 起子进程 / 写盘"的开销。
//! 缺点是 CORS-tainted canvas (远程 URL 没 CORS 头) 会读不到像素 — 那种
//! 情况返回空数组, UI 退化成纯进度条。
//!
//! 模式: 短期独占一个 offscreen <video> 元素串行 seek + capture,
//! 完事就 remove(), 不残留 DOM/解码器实例。

export interface ThumbnailResult {
  /** 每段中点的 dataURL (JPEG q=0.6). 数量 = 入参 count, 失败为空数组。 */
  thumbs: string[];
  /** 视频总时长 (秒), 失败为 null。供调用方做时间刻度 / scrubber 时长用。 */
  duration: number | null;
  /** 视频原始宽高 — 调用方可用来算 thumbnail 实际显示宽高/比例。 */
  videoWidth: number;
  videoHeight: number;
  /** 失败原因 (CORS / 解码失败 / 超时), 仅诊断用; thumbs.length === 0 时填。 */
  error?: string;
}

const SEEK_TIMEOUT_MS = 2000;
const LOAD_TIMEOUT_MS = 10_000;

/**
 * 给 srcUrl 生成 `count` 张均匀分布的缩略图 (每段中点位置)。
 *
 * @param srcUrl 视频源 URL — 通常是 `asset://localhost/...` (Tauri 本地) 或 https://。
 * @param count 几张缩略图。8-12 比较合适。
 * @param opts.maxWidth 单张缩略图最大宽度 (px), 等比缩放。默认 160。
 * @param opts.quality JPEG 质量 (0-1)。默认 0.6。
 */
export async function generateVideoThumbnails(
  srcUrl: string,
  count: number,
  opts: { maxWidth?: number; quality?: number } = {},
): Promise<ThumbnailResult> {
  const maxWidth = opts.maxWidth ?? 160;
  const quality = opts.quality ?? 0.6;

  if (count <= 0) {
    return { thumbs: [], duration: null, videoWidth: 0, videoHeight: 0 };
  }

  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    v.crossOrigin = "anonymous"; // 远程视频如果有 CORS 头允许就能 draw
    // 不挂到 document 也能解码, 不挂避免阻塞渲染线程
    v.style.position = "fixed";
    v.style.top = "-99999px";
    v.style.left = "-99999px";
    v.style.width = "1px";
    v.style.height = "1px";

    let done = false;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (loadTimer) clearTimeout(loadTimer);
      v.onloadedmetadata = null;
      v.onerror = null;
      try { v.removeAttribute("src"); v.load(); } catch { /* ignore */ }
      try { v.remove(); } catch { /* ignore */ }
    };

    const finish = (result: ThumbnailResult) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    loadTimer = setTimeout(
      () => finish({ thumbs: [], duration: null, videoWidth: 0, videoHeight: 0, error: "video load timeout" }),
      LOAD_TIMEOUT_MS,
    );

    v.onloadedmetadata = async () => {
      const dur = v.duration;
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!Number.isFinite(dur) || dur <= 0 || w === 0 || h === 0) {
        finish({ thumbs: [], duration: null, videoWidth: 0, videoHeight: 0, error: "invalid metadata" });
        return;
      }

      // 等比缩放, 不超 maxWidth
      const scale = Math.min(1, maxWidth / w);
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));

      const canvas = document.createElement("canvas");
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        finish({ thumbs: [], duration: dur, videoWidth: w, videoHeight: h, error: "canvas 2d context unavailable" });
        return;
      }

      const thumbs: string[] = [];
      for (let i = 0; i < count; i++) {
        // 每段中点 — 比 [0, 1/N, 2/N, ...] 更能代表那一段画面
        const t = ((i + 0.5) * dur) / count;
        try {
          await seekVideo(v, t, SEEK_TIMEOUT_MS);
          ctx.drawImage(v, 0, 0, tw, th);
          thumbs.push(canvas.toDataURL("image/jpeg", quality));
        } catch (err) {
          // seek 超时 / draw 报 CORS taint — 不再 retry, 直接返回已抽出来的部分
          finish({
            thumbs,
            duration: dur,
            videoWidth: w,
            videoHeight: h,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }

      finish({ thumbs, duration: dur, videoWidth: w, videoHeight: h });
    };

    v.onerror = () =>
      finish({ thumbs: [], duration: null, videoWidth: 0, videoHeight: 0, error: "video element error" });

    v.src = srcUrl;
  });
}

/** Promise 化的 video.currentTime seek + seeked 等待。带超时, 避免某些 seek 永远不触发 seeked。 */
function seekVideo(video: HTMLVideoElement, ts: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const onSeeked = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", onSeeked);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", onSeeked);
      reject(new Error(`seek timeout @ ${ts.toFixed(2)}s`));
    }, timeoutMs);
    video.addEventListener("seeked", onSeeked);
    try {
      video.currentTime = Math.max(0, Math.min(video.duration - 0.01, ts));
    } catch (e) {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      reject(e);
    }
  });
}

// ── 拖动时的"光标边浮动当前帧"快照 ───────────────────────────────────
//
// 跟主缩略图 (开 scrubber 时 batch 生成) 不一样:这个是用户拖的时候,
// 用 LIVE <video> 元素的当前画面 一秒10次 capture 出 dataURL, 给浮动 tip
// 当背景。比 batch 生成的固定 N 张更精确 — 显示的就是用户当前所选那一帧。

/** 从 live HTMLVideoElement capture 当前帧。CORS taint / 不可读时返 null。 */
export function captureFrameFromVideo(
  video: HTMLVideoElement,
  maxWidth: number,
  quality: number = 0.55,
): string | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return null;
  const scale = Math.min(1, maxWidth / w);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, tw, th);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return null;
  }
}

// ── 首帧抽取 (poster 用) ──────────────────────────────────────────────
//
// 比 generateVideoThumbnails 轻:只 seek 一个小偏移抽一帧(不跑整条缩略图带)。
// 两个用途:
//   1. 文件 drop import 时当场抽 poster (useFileDrop)
//   2. AI 生成视频落卡后补 poster (videoPoster)
// 都是因为 VideoPreview 用 `<video preload="none">`,点播放前不解码视频帧,
// poster 必须事先备好,否则卡片全黑。
// 注意:**不抽 t=0**。WebView2 在 onloadeddata 时常还没把首帧呈现到表面,drawImage 会得到
// 纯黑;且 AI 视频开头常是黑场淡入。所以 seek 到 ~0.2s 起、测平均亮度,纯黑就再往后 seek。

/**
 * 抽 srcUrl 视频的一帧(从 ~0.2s 起,跳过开头纯黑/未呈现帧)→ JPEG dataUrl + 原始宽高。
 *
 * 整体失败 (解码不了 / 8s 超时 / 0 尺寸) 返回 `null` —— 调用方据此判定"视频不可用"。
 * 仅缩略图失败 (canvas 被 CORS taint, 远程无 CORS 头) 返回 `{ dataUrl: null, width, height }`
 * —— 视频本身能播, 只是没 poster。
 *
 * @param src 可传视频 URL(`asset://localhost/...` 本地、`http(s)://` 远程),或直接传
 *            drop 进来的 `File` —— 后者由本函数内部 createObjectURL,并在 <video>
 *            teardown 之后才 revokeObjectURL,调用方无需自己管 blob 生命周期。
 *            远程 `http(s)://` 会因 CORS taint 抽不出像素 → dataUrl: null。
 */
export async function extractFirstFrame(src: string | File): Promise<{
  dataUrl: string | null;
  width: number;
  height: number;
} | null> {
  // 传 File 时本函数闭环管理 blob URL。关键时序坑:抽完帧后**不能**同步 revoke。
  // preload="auto" 的 <video> 在 loadeddata(首帧就绪)后仍在后台缓冲整段 blob;finish
  // 里 removeAttribute+load() 让 WebView2 abort 这些在途 range 请求,但 abort 在 media
  // 线程异步执行、比主线程慢一拍。若主线程此刻已 revokeObjectURL,迟到的请求就找不到
  // blob → 控制台刷 `GET blob:... net::ERR_FILE_NOT_FOUND`(无害但扰人)。解法:把 revoke
  // 推迟到 load() 清空 pipeline 触发的 `emptied` 之后,再加兜底 timer。
  const srcUrl = typeof src === "string" ? src : URL.createObjectURL(src);
  const objectUrl = typeof src === "string" ? null : srcUrl;

  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";

    let done = false;

    // emptied = media pipeline 已清空、在途 blob 请求已 abort → 此刻 revoke 才安全。
    const scheduleRevoke = () => {
      if (!objectUrl) return;
      let fallback: ReturnType<typeof setTimeout> | null = null;
      const doRevoke = () => {
        video.removeEventListener("emptied", doRevoke);
        if (fallback) clearTimeout(fallback);
        URL.revokeObjectURL(objectUrl);
      };
      video.addEventListener("emptied", doRevoke, { once: true });
      fallback = setTimeout(doRevoke, 2000); // emptied 万一不来的兜底
    };

    const finish = (result: { dataUrl: string | null; width: number; height: number } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      scheduleRevoke(); // 必须在 load() 之前挂好 emptied 监听
      video.load();
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), 8000);

    // 画当前帧 → JPEG dataUrl，并尽量测一下平均亮度(供"跳过纯黑帧"判定)。
    // CORS taint(远程无 CORS 头)时 getImageData/toDataURL 抛错 → dataUrl/luma 均 null，
    // 退化成"视频能播但没 poster"，与历史行为一致。
    const captureFrame = (): { dataUrl: string | null; luma: number | null; w: number; h: number } => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w === 0 || h === 0) return { dataUrl: null, luma: null, w, h };
      // 长边压到 480px，JPEG q=0.7 —— 典型 20-60KB 一张，画布上做卡片缩略图绰绰有余
      const maxDim = 480;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return { dataUrl: null, luma: null, w, h };
      try {
        ctx.drawImage(video, 0, 0, tw, th);
        let luma: number | null = null;
        try {
          const { data } = ctx.getImageData(0, 0, tw, th);
          let sum = 0;
          let n = 0;
          // 每隔几个像素采样即可，够判黑;step=16 → 每 4 个像素取 1。
          for (let i = 0; i < data.length; i += 16) {
            sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
            n++;
          }
          luma = n > 0 ? sum / n : null;
        } catch {
          luma = null; // CORS taint:测不了亮度，直接接受这帧
        }
        return { dataUrl: canvas.toDataURL("image/jpeg", 0.7), luma, w, h };
      } catch {
        // drawImage/toDataURL 被 CORS taint 拒绝。视频本身能播，只是这卡没缩略图。
        return { dataUrl: null, luma: null, w, h };
      }
    };

    // 历史 bug:在 onloadeddata(t≈0)直接 drawImage，WebView2 此刻常还没把首帧"呈现"到
    // <video> 表面 → 抽出来是纯黑(服务端模板里就这么烤进去一批纯黑 poster)。改成 seek 到
    // 一个小偏移再抽:seek 完成的 'seeked' 才保证那一帧已解码就绪;再等一个 rAF 让合成器贴图，
    // 然后测亮度，纯黑就往后再 seek 一点。绝大多数视频用第一个偏移就拿到正常帧。
    const SEEK_TARGETS = [0.2, 0.8, 1.6, 3.0]; // 秒，依次尝试
    const DARK_LUMA = 10; // 平均亮度(0-255)低于此视作纯黑/接近纯黑
    let attempt = 0;

    const grabAt = (t: number) => {
      if (done) return;
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        // 等一个 rAF，确保 seek 后的帧已被合成器贴到表面再 drawImage。
        requestAnimationFrame(() => {
          if (done) return;
          const cap = captureFrame();
          if (cap.w === 0) {
            finish(null);
            return;
          }
          const dark = cap.luma != null && cap.luma < DARK_LUMA;
          if (!dark || attempt >= SEEK_TARGETS.length) {
            finish({ dataUrl: cap.dataUrl, width: cap.w, height: cap.h });
          } else {
            grabNext(); // 纯黑且还有偏移没试 → 再往后 seek
          }
        });
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      try {
        video.currentTime = t;
      } catch {
        finish(null);
      }
    };

    const grabNext = () => {
      const dur = video.duration;
      let t = SEEK_TARGETS[attempt] ?? 0;
      attempt++;
      if (Number.isFinite(dur) && dur > 0) t = Math.min(t, Math.max(0, dur - 0.05));
      grabAt(t);
    };

    video.onloadedmetadata = () => {
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        finish(null);
        return;
      }
      grabNext();
    };

    video.onerror = () => finish(null);
    video.src = srcUrl;
  });
}
