// ai-canvas 媒体送上游 AI API 的**唯一**入口。
//
// 历史:之前各业务模块直接调 `lib/media.ts::getBase64ForApi(url)`,该函数在
// Tauri 模式下返回 `local://` 占位符,Rust 端再 `inline_local_files` 展开为
// base64 塞进 JSON。这条链路有 4 道墙:
//   - WebView2 IPC 3MB 单次
//   - Rust ipc_guard 64MB 累计  ← 用户撞过
//   - nginx 100MB                ← 用户撞过
//   - MySQL request_params       ← 2026-04 P0 事故
//
// 根治方案:**二进制不进 JSON**。所有送上游的引用必须先经 mediaToApiRef
// 转成 HTTP URL,JSON body 只放 URL。详见
// [docs/media-upload-refactor.md](../../docs/media-upload-refactor.md)。
//
// **规范**:任何要送给 generateImage / generateVideo / chat / agent 等
// 上游 API 的本地媒体引用,都走 mediaToApiRef,不允许直接调 getBase64ForApi
// 或自行构造 base64 dataURL 塞进请求体。eslint 规则会拦截误用。
//
// ## 2026-05-30 根治: 砍掉 Web 模式,统一走 httpAdapter
//
// 历史 `uploadViaFetch` 在 Tauri dev 模式下用浏览器原生 fetch 调
// `https://api.snoworangekeji.cn/v1/files/upload`, dev 模式 origin 是 vite
// 的 `http://127.0.0.1:1620` → 服务端 CORS allowlist 不放行 → preflight 失败,
// 上传全挂。根治结论: WebView 永远不直接发上行请求, 一切走 Rust HTTP 客户端。
//
// 现在分两条路:
//   1. 本地存储路径 (`local://media/...` / `media/...` / 绝对路径)
//        → invoke `upload_to_server` (Rust 直接读文件 + multipart)
//   2. WebView-only URL (`data:` / `blob:` / `/src/...` / `/assets/...`)
//        → `httpUploadBytes()` (httpAdapter): 先 WebView fetch 成 Blob,
//          再 invoke `upload_bytes_to_server` (<2.5MB) 或走 chunked pipeline
//          (大文件)。两条路径共享 sha256 缓存 + in-flight 单飞 + semaphore 治理。

import { ensureTauriAPIs, getInvoke, isTauri } from "./runtime";
import {
  httpUploadBytes,
  type UploadResult as HttpUploadResult,
} from "./httpAdapter";

/**
 * Rust 端 `upload_to_server` / `upload_bytes_to_server` 返回结构。跟
 * `src-tauri/src/commands/upload_remote.rs::UploadResult` 对齐。
 */
export type UploadResult = HttpUploadResult;

export interface MediaToApiRefOptions {
  /** 哪个 provider 的 base_url 走上传 (默认 jijing) */
  provider?: string;
  /**
   * 预热模式 —— 用户拖入/粘贴后台静默上传时设 true,
   * Rust 端占独立 PREWARM_SEMAPHORE(2), 不挤占主路径 MAIN_SEMAPHORE(4)。
   * 主动触发 (点生成 / 送 ref 图) 走 false (默认)。
   *
   * 跟主路径**共享 in-flight 单飞**:预热和主路径撞同一 sha256 时,
   * 后到的 follower 直接 await 先到的 broadcast, 不重复发 HTTP。
   */
  prewarm?: boolean;
}

/**
 * 把任意本地媒体引用转成上游 AI API 可消费的 HTTP URL。
 *
 * 接受输入:
 * - `http://` / `https://` URL — 原样返回 (已是远端)
 * - `local://<rel>` / `media/<rel>` / 绝对路径 — invoke `upload_to_server` 主路径
 * - `data:` / `blob:` / `/src/...` / `/assets/...` WebView-only URL — 走
 *   `httpUploadBytes` 把 bytes 喂给 Rust `upload_bytes_to_server`,
 *   共享同一份 sha256 缓存 / semaphore 治理
 *
 * 永远返回 HTTPS URL。失败抛 Error, 调用方按错误信息决定 UX (展示 toast /
 * 切换 provider / 等)。
 *
 * @throws {Error} 上传失败 (鉴权 / 体积 / 网络 / 服务端 5xx)
 */
export async function mediaToApiRef(
  input: string,
  opts?: MediaToApiRefOptions
): Promise<string> {
  if (!input) return "";

  // 已是远端 URL — 原样直传, 不浪费上传带宽
  if (input.startsWith("http://") || input.startsWith("https://")) {
    return input;
  }

  if (!isTauri) {
    throw new Error(
      "[media] mediaToApiRef 仅支持 Tauri 环境。前端不允许直接 fetch 上游 (规约见 src/platform/httpAdapter.ts)。",
    );
  }

  const provider = opts?.provider ?? "jijing";
  const prewarm = opts?.prewarm ?? false;

  // WebView-only URL: Rust 文件系统打不开 (data: / blob: 是 WebView 内存对象;
  // vite asset `/src/` `/assets/` 是 dev/build 中间件服务的虚拟资源)。
  // 必须先在 WebView 里 fetch 成 Blob, 通过 invoke 喂给 Rust。
  if (isWebViewOnlyUrl(input)) {
    const result = await httpUploadBytes(input, { provider, prewarm });
    return result.url;
  }

  // 本地存储路径 — Rust 直接读文件, 享受流式 sha256 + sqlite 缓存 +
  // in-flight 单飞 + 双 semaphore (main / prewarm)。
  await ensureTauriAPIs();
  const result = await getInvoke()<UploadResult>("upload_to_server", {
    path: input,
    provider,
    prewarm,
  });
  return result.url;
}

/**
 * WebView 能 fetch 但 Rust 文件系统打不开的 URL 形式。
 * - `data:` / `blob:` — 内存对象, 只有 WebView 知道
 * - Vite asset — dev 下 `/src/...`, 构建后 `/assets/...`, 由 vite 中间件服务,
 *   不是真的磁盘路径
 *
 * 这类 input 走 [`httpUploadBytes`]: WebView 里 fetch 成 Blob → invoke 喂给
 * Rust → multipart 上传。跟本地路径上传**共享同一份 sqlite 缓存** (按 sha256
 * 命中),不存在"两条路径两份缓存"的问题。
 */
function isWebViewOnlyUrl(input: string): boolean {
  if (input.startsWith("data:") || input.startsWith("blob:")) return true;
  if (input.startsWith("/src/") || input.startsWith("/assets/")) return true;
  return false;
}

// ─── 批量入口 + 预热入口 ─────────────────────────────────────────────
//
// 历史:11 个上游业务点(生图/生视频/chat/promptSerializer 等)各自写
// `Promise.all(items.map(mediaToApiRef))`,进度/错误处理无法集中。
//
// 现在统一通过 `uploadMediaBatch` 走,各 UI 通过 `opts.onProgress` 拿到
// "上传 N/M" 阶段反馈,失败语义也由 `failureMode` 集中决定。
//
// **规范**:任何要批量上传多个媒体引用的业务点必须用 `uploadMediaBatch`,
// 不允许新代码再写 `Promise.all(... mediaToApiRef ...)`。eslint 规则待加。
//
// 单个引用的场景(如 chatStore 序列化历史消息时逐 part 上传)继续直接调
// `mediaToApiRef` 即可,不强求包成数组。

/** 上传过程的阶段标识。Patch C 接入 Rust event 后会更精确地区分。 */
export type MediaUploadPhase = "hashing" | "uploading" | "complete";

export interface MediaUploadProgress {
  /** 已完成的文件数 */
  uploaded: number;
  /** 总文件数 */
  total: number;
  /** 当前所处阶段 */
  phase: MediaUploadPhase;
  /** 最后一次状态变化对应的 input,UI 可用于"正在上传 xxx.mp4" */
  current?: string;
}

export interface UploadBatchOptions {
  provider?: string;
  /**
   * 进度回调。本 Patch A 阶段只在每个 promise 完成时触发(uploaded++);
   * Patch C 接入 Rust event 后会区分 hashing/uploading 阶段。
   */
  onProgress?: (progress: MediaUploadProgress) => void;
  /**
   * 单文件失败语义:
   * - "fail-fast"(默认):任一失败立即 throw,丢弃其他结果。生图/生视频等
   *   "全要齐才能跑"的场景用这个。
   * - "partial":全部跑完,失败项的位置返 ""。chat 历史序列化等"漏一两张
   *   也能凑合"的场景可用。
   */
  failureMode?: "fail-fast" | "partial";
}

/**
 * 把一组本地媒体引用批量转换为上游 API 可消费的 HTTP URL。
 *
 * 顺序与输入对齐(`result[i]` 对应 `inputs[i]`)。
 *
 * 内部由 Rust 端 `MAIN_SEMAPHORE(4)` + sha256 单飞控制并发;前端只是把
 * N 个 invoke 同时丢出去,不需要在 JS 层做 runWithLimit。
 *
 * @example
 * const urls = await uploadMediaBatch(refImages.map(r => r.url), {
 *   onProgress: ({ uploaded, total }) => setLabel(`上传 ${uploaded}/${total}`),
 * });
 */
export async function uploadMediaBatch(
  inputs: string[],
  opts?: UploadBatchOptions,
): Promise<string[]> {
  if (inputs.length === 0) return [];

  const failureMode = opts?.failureMode ?? "fail-fast";
  const provider = opts?.provider;
  const onProgress = opts?.onProgress;
  const total = inputs.length;
  let uploadedCount = 0;

  // 起手先 emit 一次,UI 可以立刻显示 0/N
  onProgress?.({ uploaded: 0, total, phase: "uploading" });

  const tickProgress = (input: string) => {
    uploadedCount += 1;
    onProgress?.({
      uploaded: uploadedCount,
      total,
      phase: uploadedCount === total ? "complete" : "uploading",
      current: input,
    });
  };

  if (failureMode === "fail-fast") {
    // Promise.all 自带"任一 reject 整体 reject"语义。每个子 promise 完成时
    // tickProgress,失败时也 tick 一下再 rethrow(UI 能看到错误发生时的进度)。
    return await Promise.all(
      inputs.map(async (input) => {
        try {
          const url = await mediaToApiRef(input, { provider });
          tickProgress(input);
          return url;
        } catch (err) {
          tickProgress(input);
          throw err;
        }
      }),
    );
  }

  // partial 模式:Promise.allSettled,失败位置返 ""
  const settled = await Promise.allSettled(
    inputs.map(async (input) => {
      const url = await mediaToApiRef(input, { provider });
      tickProgress(input);
      return url;
    }),
  );
  return settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    // partial 模式下失败也算"完成一项",但 tickProgress 不会在 catch 里被调
    // (allSettled 里子 promise reject 时 tick 不会运行),手动补一下
    tickProgress(inputs[i] ?? "");
    console.warn(`[uploadMediaBatch] partial failure at index ${i}:`, r.reason);
    return "";
  });
}

/**
 * 后台预热上传 — 不抛错, 不 await, 用户感知零延迟。
 * 拖入/粘贴/AI 输出的媒体落盘后自动走这里, 等用户真正在生成时调
 * `mediaToApiRef` 直接命中本地 sqlite 缓存返 HTTP URL, 不等。
 *
 * 失败的合理原因 (网络抖动 / 鉴权过期 / 服务端 5xx) 都不该打扰用户 —
 * 真正发请求时主路径会再试一次, 由那里的错误处理负责 UX。
 *
 * Rust 端走 PREWARM_SEMAPHORE(2), 不挤占主路径 MAIN_SEMAPHORE(4) 配额;
 * in-flight 单飞跟主路径共享, 撞同 sha256 时只发一次 HTTP。
 *
 * @param localPath 落盘后的 `local://media/...` 路径或绝对路径
 */
export function prewarmMedia(localPath: string): void {
  if (!localPath) return;
  // setTimeout(0) 切出当前微任务队列, 让 persistImage 等调用方先返回 UI,
  // 上传发生在 Tauri command 异步 task, 完全不阻塞渲染。
  setTimeout(() => {
    void mediaToApiRef(localPath, { prewarm: true }).catch((err) => {
      console.debug(
        "[media] prewarm upload failed (silent, main path will retry):",
        localPath,
        err,
      );
    });
  }, 0);
}
