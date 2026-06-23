//! 参考图体积压缩 —— 上传前把 **>10MB 的静态图片**重编码为 JPEG 压到 10MB 以内
//! (目标 ~9.75MB,"贴着 10MB,不压狠")。
//!
//! 背景:文本节点 / 图片节点的参考图走 `upload_to_server` 上传拿 HTTP URL 后
//! 直接塞给上游 AI API。>10MB 的大图会撞两道墙:
//!   - JiJing 服务端 ChatImageInliner 有 20MB size cap,超了静默保留原 URL 漏给上游;
//!   - 上游(OpenAI 等海外)拉国内 COS 的大图极易超时 → "Unable to download URL" 连败。
//!
//! 落点:`upload_remote::upload_to_server` 在算 sha256 / 进上传管线**之前**调本模块,
//! 把过大的图换成压缩产物再走后续流程 —— sha 缓存 / in-flight 单飞 / presign 全部
//! 基于压缩后的文件,预热路径与主路径自然命中同一份缓存。卡片 data 不动,本地
//! 显示仍是原图,只有送上游的字节被压。
//!
//! 策略("不过度压缩"):
//!   - 不超过 10MB / 非静态位图(gif 动图、svg 矢量、heic 解不动) → 原样放行,零改动;
//!   - 超过 10MB → mjpeg 质量档 q∈[2,31] 二分,取**能塞进目标的最高质量**(最小 q)。
//!     多数 10~30MB 源在 q=2(JPEG 最高质量档)一把过线,质损最小;
//!   - 透明 PNG/WebP 先合成到**白底**(drawbox 同尺寸白底 + overlay,免探尺寸、
//!     EXIF 自动旋转两路同源不会错位),不会出现透明区变黑;
//!   - 极端超大源(q=31 仍 >目标,如 100MP+ 扫描图)再等比降分辨率兜底;
//!   - **任何失败(ffmpeg 缺失/解码失败/压不进)一律原样上传**,绝不因压缩挡住上传。
//!
//! 与 [`frame_extract`](super::frame_extract) 的 r2v 参考视频压缩同范式:
//! ffmpeg-sidecar 子进程、产物落 `media/compressed/` 按源 sha 缓存、
//! `.partial` 写完原子改名。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::frame_extract::{compute_sha256, ensure_ffmpeg};

/// 触发阈值:严格大于 10MB 才压。≤10MB 的图原样上传,零质损。
pub(crate) const IMAGE_SHRINK_THRESHOLD_BYTES: u64 = 10 * 1024 * 1024;

/// 压缩目标:~9.75MB。比 10MB 留 256KB 余量,吸收服务端/上游对"10MB"判定的
/// 进制差(10*10^6 vs 10*2^20)与字节级抖动;同时足够贴近 10MB,符合
/// "大概压到 9-10M、不要压狠"的要求。
pub(crate) const IMAGE_SHRINK_TARGET_BYTES: u64 =
    IMAGE_SHRINK_THRESHOLD_BYTES - 256 * 1024;

/// mjpeg 质量档范围(ffmpeg `-q:v`,数字越小质量越高)。q=1 与 q=2 实测同产物,
/// 取 2 为最高档;31 是编码器下限。
const MJPEG_BEST_Q: u8 = 2;
const MJPEG_WORST_Q: u8 = 31;

/// 能安全转 JPEG 的静态位图 MIME。
/// 排除:gif(可能是动图,转 JPEG 丢动画)、svg(矢量,ffmpeg 不解)、
/// heic/heif(ffmpeg 静态构建无 libheif,解不动)。avif 留在白名单内 ——
/// 失败会被 best-effort 兜底原样放行,能解就赚。
fn is_shrinkable_image_mime(mime: &str) -> bool {
    matches!(
        mime.to_ascii_lowercase().as_str(),
        "image/jpeg" | "image/jpg" | "image/png" | "image/webp" | "image/bmp"
            | "image/tiff" | "image/avif"
    )
}

/// 串行化压缩:同源并发上传(预热+主路径 / 同图多 ref)时只让一个真编码,
/// 后到者拿锁后命中磁盘缓存。压缩是稀有重操作(>10MB 图),全局串行足够。
static SHRINK_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn shrink_lock() -> &'static tokio::sync::Mutex<()> {
    SHRINK_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 在 [MJPEG_BEST_Q, MJPEG_WORST_Q] 内找「产物 ≤ target 的最小 q(最高质量)」。
///
/// `probe(q)` 编码一次并返回产物字节数;字节数随 q 增大单调不增(JPEG 量化特性)。
/// 先试最高质量档 —— 多数 10~30MB 源直接过线,只编码一次;不行再二分。
/// 返回 `Ok(None)` = 连最低质量档都塞不进(需降分辨率兜底)。
fn find_min_quality_fitting(
    probe: &mut dyn FnMut(u8) -> Result<u64, String>,
    target: u64,
) -> Result<Option<u8>, String> {
    if probe(MJPEG_BEST_Q)? <= target {
        return Ok(Some(MJPEG_BEST_Q));
    }
    let mut lo = MJPEG_BEST_Q + 1;
    let mut hi = MJPEG_WORST_Q;
    let mut best: Option<u8> = None;
    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        if probe(mid)? <= target {
            best = Some(mid);
            hi = mid - 1; // mid ≥ 3,不会下溢
        } else {
            lo = mid + 1;
        }
    }
    Ok(best)
}

/// q=31 仍超目标时的首个等比降分辨率系数:按 `面积 ∝ 字节数` 估算再打 9 折,
/// 钳在 [0.1, 0.95]。后续尝试在此基础上 ×0.75 递减。
fn initial_downscale_factor(size_at_worst_q: u64, target: u64) -> f64 {
    if size_at_worst_q == 0 {
        return 0.95;
    }
    ((target as f64 / size_at_worst_q as f64).sqrt() * 0.9).clamp(0.1, 0.95)
}

/// 压缩滤镜链:白底合成 + (可选等比缩) + mjpeg 喂的全采样 yuvj444p。
///
/// 白底合成用 `split + drawbox(t=fill) + overlay` 而不是 `color=white:s=WxH` ——
/// 白底分支与原图同源同尺寸,免预探尺寸,且 EXIF 自动旋转对两路同时生效不会错位。
/// yuvj444p 全色度采样:本产品参考图多为含文字的设计稿,4:2:0 会让彩色文字边缘
/// 出彩边;字节预算固定的前提下保色度优先。
fn build_filter(scale_factor: Option<f64>) -> String {
    let mut f = String::from(
        "format=rgba,split[base][top];\
         [base]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill[bg];\
         [bg][top]overlay=format=auto",
    );
    if let Some(factor) = scale_factor {
        // trunc(*/2)*2 取偶,兼容任意采样布局
        f.push_str(&format!(
            ",scale=trunc(iw*{factor:.4}/2)*2:trunc(ih*{factor:.4}/2)*2"
        ));
    }
    f.push_str(",format=yuvj444p");
    f
}

/// 跑一次 ffmpeg 编码到 `tmp_path`,返回产物字节数。
fn encode_once(
    ffmpeg_bin: &Path,
    src: &Path,
    tmp_path: &Path,
    q: u8,
    scale_factor: Option<f64>,
) -> Result<u64, String> {
    use ffmpeg_sidecar::command::FfmpegCommand;

    let filter = build_filter(scale_factor);
    let q_str = q.to_string();
    let src_str = src.to_string_lossy().to_string();
    let tmp_str = tmp_path.to_string_lossy().to_string();

    let mut child = FfmpegCommand::new_with_path(ffmpeg_bin)
        .args([
            "-y",
            "-i",
            &src_str,
            "-frames:v",
            "1",
            "-vf",
            &filter,
            "-c:v",
            "mjpeg",
            "-q:v",
            &q_str,
            "-huffman",
            "optimal",
            "-update",
            "1",
            &tmp_str,
        ])
        .spawn()
        .map_err(|e| format!("ffmpeg spawn 失败: {}", e))?;
    let status = child
        .as_inner_mut()
        .wait()
        .map_err(|e| format!("ffmpeg wait 失败: {}", e))?;
    if !status.success() {
        return Err(format!("ffmpeg 退出码: {:?}", status.code()));
    }
    let meta = std::fs::metadata(tmp_path)
        .map_err(|e| format!("读压缩产物元信息失败: {}", e))?;
    if meta.len() == 0 {
        return Err("压缩产物为 0 字节".to_string());
    }
    Ok(meta.len())
}

/// 质量二分 + 降分辨率兜底的完整编码搜索。产物留在 `tmp_path`(最后一次编码即
/// 命中目标的那次 —— 二分收敛后**用 best q 再编一次**,保证 tmp 内容与返回值一致)。
fn search_and_encode(
    ffmpeg_bin: &Path,
    src: &Path,
    tmp_path: &Path,
    target: u64,
) -> Result<u64, String> {
    let mut last_size: u64 = 0;
    let mut probe = |q: u8| -> Result<u64, String> {
        let s = encode_once(ffmpeg_bin, src, tmp_path, q, None);
        if let Ok(n) = s {
            last_size = n;
        }
        s
    };

    if let Some(q) = find_min_quality_fitting(&mut probe, target)? {
        // 二分最后一次编码未必就是 best q(可能停在更差档),按 best q 重编一次定稿。
        let final_size = encode_once(ffmpeg_bin, src, tmp_path, q, None)?;
        if final_size <= target {
            return Ok(final_size);
        }
        // 理论上不该发生(同参数重编同产物);防御性继续走降分辨率。
    }

    // q=31 全质量档都塞不进 → 等比降分辨率,最多 3 次,每次系数 ×0.75。
    let mut factor = initial_downscale_factor(last_size, target);
    for _ in 0..3 {
        let size = encode_once(ffmpeg_bin, src, tmp_path, 6, Some(factor))?;
        if size <= target {
            return Ok(size);
        }
        factor *= 0.75;
        if factor < 0.05 {
            break;
        }
    }
    Err("降分辨率后仍超目标体积".to_string())
}

/// 把 >10MB 的静态图片压到 ~9.75MB 内,返回压缩产物;不满足条件 / 任何失败
/// 返回 `None`(调用方继续用原文件,**绝不因压缩挡住上传**)。
///
/// 返回 `Some((压缩产物绝对路径, 产物字节数))`。产物按源文件 sha256 落
/// `media/compressed/{sha16}_le10m.jpg` 缓存,同源第二次直接命中不再编码。
pub(crate) async fn shrink_image_for_upload(
    data_dir: &Path,
    abs_path: &Path,
    size: u64,
    content_type: &str,
) -> Option<(PathBuf, u64)> {
    if size <= IMAGE_SHRINK_THRESHOLD_BYTES || !is_shrinkable_image_mime(content_type) {
        return None;
    }

    let ffmpeg_bin = match ensure_ffmpeg(data_dir).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "image_shrink: ffmpeg 不可用, 原样上传");
            return None;
        }
    };

    // 缓存键 = 源文件 sha256(流式,~50ms/30MB)。
    let sha = {
        let p = abs_path.to_path_buf();
        match tokio::task::spawn_blocking(move || compute_sha256(&p)).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "image_shrink: 算源 sha256 失败, 原样上传");
                return None;
            }
            Err(e) => {
                tracing::warn!(error = %e, "image_shrink: sha256 线程出错, 原样上传");
                return None;
            }
        }
    };
    let short_sha = &sha[..16];

    let out_dir = data_dir.join("media").join("compressed");
    if let Err(e) = std::fs::create_dir_all(&out_dir) {
        tracing::warn!(error = %e, "image_shrink: 创建压缩目录失败, 原样上传");
        return None;
    }
    let out_name = format!("{}_le10m.jpg", short_sha);
    let out_path = out_dir.join(&out_name);

    // 全局串行 + 锁内复查缓存:并发同源只编码一次。
    let _guard = shrink_lock().lock().await;
    if let Ok(meta) = std::fs::metadata(&out_path) {
        if meta.len() > 0 {
            tracing::info!(
                path = %out_path.display(), size = meta.len(),
                "image_shrink: 命中缓存"
            );
            return Some((out_path, meta.len()));
        }
    }

    let started = std::time::Instant::now();
    // .partial 前缀放扩展名之前,保持 .jpg 结尾让 ffmpeg 正确推断 muxer。
    let tmp_path = out_dir.join(format!("{}.partial.jpg", short_sha));
    let _ = std::fs::remove_file(&tmp_path);

    let encode = {
        let ffmpeg_bin = ffmpeg_bin.clone();
        let src = abs_path.to_path_buf();
        let tmp = tmp_path.clone();
        tokio::task::spawn_blocking(move || {
            search_and_encode(&ffmpeg_bin, &src, &tmp, IMAGE_SHRINK_TARGET_BYTES)
        })
        .await
    };

    let new_size = match encode {
        Ok(Ok(n)) => n,
        Ok(Err(e)) => {
            let _ = std::fs::remove_file(&tmp_path);
            tracing::warn!(
                error = %e, src = %abs_path.display(), size,
                "image_shrink: 压缩失败, 原样上传"
            );
            return None;
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            tracing::warn!(error = %e, "image_shrink: 编码线程出错, 原样上传");
            return None;
        }
    };

    // 原子改名:Windows 上目标已存在时 rename 会 Err,先删。
    let _ = std::fs::remove_file(&out_path);
    if let Err(e) = std::fs::rename(&tmp_path, &out_path) {
        let _ = std::fs::remove_file(&tmp_path);
        tracing::warn!(error = %e, "image_shrink: 改名失败, 原样上传");
        return None;
    }

    tracing::info!(
        src = %abs_path.display(),
        from_bytes = size,
        to_bytes = new_size,
        duration_ms = started.elapsed().as_millis() as u64,
        "image_shrink: 压缩完成"
    );
    Some((out_path, new_size))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consts_sane() {
        // 目标必须低于触发阈值,否则压完仍 >10MB 形同虚设
        assert!(IMAGE_SHRINK_TARGET_BYTES < IMAGE_SHRINK_THRESHOLD_BYTES);
        // "不压狠":目标贴近 10MB(≥ 9.5MB)
        assert!(IMAGE_SHRINK_TARGET_BYTES >= 9_500_000);
    }

    #[test]
    fn shrinkable_mime_allowlist() {
        for m in ["image/jpeg", "image/jpg", "image/png", "image/webp",
                  "image/bmp", "image/tiff", "image/avif", "IMAGE/PNG"] {
            assert!(is_shrinkable_image_mime(m), "{} 应可压", m);
        }
        for m in ["image/gif", "image/svg+xml", "image/heic", "image/heif",
                  "video/mp4", "audio/mpeg", "application/octet-stream", ""] {
            assert!(!is_shrinkable_image_mime(m), "{} 不应压", m);
        }
    }

    /// 单调递减的模拟体积曲线:size(q) = base / q。
    fn mono_curve(base: u64) -> impl FnMut(u8) -> Result<u64, String> {
        move |q: u8| Ok(base / q as u64)
    }

    #[test]
    fn quality_search_best_q_fits_immediately() {
        // q=2 即 ≤ target → 一次编码搞定,返回最高质量档
        let mut probe = mono_curve(10_000_000); // q=2 → 5MB
        let q = find_min_quality_fitting(&mut probe, 9_000_000).unwrap();
        assert_eq!(q, Some(MJPEG_BEST_Q));
    }

    #[test]
    fn quality_search_finds_minimal_fitting_q() {
        // size(q) = 60MB/q:q=2→30MB, q=6→10MB, q=7→8.57MB;target 9MB → 最小命中 q=7
        let mut probe = mono_curve(60_000_000);
        let q = find_min_quality_fitting(&mut probe, 9_000_000).unwrap();
        assert_eq!(q, Some(7));
    }

    #[test]
    fn quality_search_exact_boundary_counts_as_fit() {
        // size(q) = 90MB/q:q=10 恰好 = 9MB(≤ 即命中)
        let mut probe = mono_curve(90_000_000);
        let q = find_min_quality_fitting(&mut probe, 9_000_000).unwrap();
        assert_eq!(q, Some(10));
    }

    #[test]
    fn quality_search_none_when_even_worst_q_too_big() {
        // q=31 → 32MB 仍 > 9MB → None(转降分辨率兜底)
        let mut probe = mono_curve(1_000_000_000);
        let q = find_min_quality_fitting(&mut probe, 9_000_000).unwrap();
        assert_eq!(q, None);
    }

    #[test]
    fn quality_search_propagates_probe_error() {
        let mut probe = |_q: u8| -> Result<u64, String> { Err("boom".into()) };
        assert!(find_min_quality_fitting(&mut probe, 9_000_000).is_err());
    }

    #[test]
    fn downscale_factor_in_range_and_shrinks_enough() {
        // 32MB@q31 → 目标 9.8MB:面积比 ≈ 0.30,sqrt ≈ 0.55,×0.9 ≈ 0.50
        let f = initial_downscale_factor(32 * 1024 * 1024, IMAGE_SHRINK_TARGET_BYTES);
        assert!(f > 0.4 && f < 0.6, "factor={}", f);
        // 极端大源也不会出 [0.1, 0.95] 区间
        assert!(initial_downscale_factor(u64::MAX / 2, 1) >= 0.1);
        assert!(initial_downscale_factor(1, u64::MAX / 2) <= 0.95);
        // 防 0 除
        assert!(initial_downscale_factor(0, 100) > 0.0);
    }

    #[test]
    fn filter_chain_shape() {
        let plain = build_filter(None);
        assert!(plain.starts_with("format=rgba,split"));
        assert!(plain.contains("drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill"));
        assert!(plain.contains("overlay=format=auto"));
        assert!(plain.ends_with("format=yuvj444p"));
        assert!(!plain.contains("scale="));

        let scaled = build_filter(Some(0.5));
        assert!(scaled.contains("scale=trunc(iw*0.5000/2)*2:trunc(ih*0.5000/2)*2"));
        // scale 必须在 overlay 之后、最终 format 之前
        let pos_overlay = scaled.find("overlay").unwrap();
        let pos_scale = scaled.find("scale=").unwrap();
        let pos_fmt = scaled.rfind("format=yuvj444p").unwrap();
        assert!(pos_overlay < pos_scale && pos_scale < pos_fmt);
    }

    /// 端到端:用真 ffmpeg 造一张 >10MB 噪声 PNG → shrink → 验产物 ≤10MB、
    /// 是合法 JPEG、命中缓存第二次零编码。
    ///
    /// `#[ignore]` 因为依赖本机 ffmpeg(PATH / D:\AICat / data_dir 缓存)+ 数秒编码;
    /// 手动 `cargo test -- --ignored shrink_end_to_end`。
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn shrink_end_to_end_compresses_noise_png_under_10mb() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let img_dir = data_dir.join("media").join("images");
        std::fs::create_dir_all(&img_dir).unwrap();

        // ensure_ffmpeg 解析(PATH 上的 winget / brew ffmpeg 即可命中)
        let ffmpeg = ensure_ffmpeg(&data_dir).await.expect("本机需有 ffmpeg");

        // 造 3000x3000 噪声 PNG(实测 ~23MB,> 阈值)
        let src = img_dir.join("noise.png");
        {
            use ffmpeg_sidecar::command::FfmpegCommand;
            let src_str = src.to_string_lossy().to_string();
            let status = FfmpegCommand::new_with_path(&ffmpeg)
                .args([
                    "-y", "-f", "lavfi", "-i",
                    "nullsrc=size=3000x3000,geq=r=random(1)*255:g=random(2)*255:b=random(3)*255",
                    "-frames:v", "1", &src_str,
                ])
                .spawn().unwrap()
                .as_inner_mut().wait().unwrap();
            assert!(status.success());
        }
        let src_size = std::fs::metadata(&src).unwrap().len();
        assert!(src_size > IMAGE_SHRINK_THRESHOLD_BYTES, "噪声 PNG 应 >10MB, 实际 {}", src_size);

        let (out, out_size) =
            shrink_image_for_upload(&data_dir, &src, src_size, "image/png")
                .await
                .expect("应产出压缩文件");
        assert!(out_size <= IMAGE_SHRINK_THRESHOLD_BYTES, "产物 {} 应 ≤10MB", out_size);
        assert!(out_size > 0);
        let bytes = std::fs::read(&out).unwrap();
        assert_eq!(&bytes[0..3], &[0xFF, 0xD8, 0xFF], "JPEG SOI 魔数不对");

        // 第二次:命中缓存,路径一致
        let (out2, size2) =
            shrink_image_for_upload(&data_dir, &src, src_size, "image/png")
                .await
                .expect("缓存命中也应返回 Some");
        assert_eq!(out, out2);
        assert_eq!(out_size, size2);

        // 小图 / 非图触发条件:不压
        assert!(shrink_image_for_upload(&data_dir, &src, 1024, "image/png").await.is_none());
        assert!(shrink_image_for_upload(&data_dir, &src, src_size, "video/mp4").await.is_none());
    }
}
