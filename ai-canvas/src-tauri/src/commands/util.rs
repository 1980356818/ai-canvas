//! 通用辅助 —— 不依赖具体业务命令,跨命令复用。
//!
//! ## 为什么独立成 module
//!
//! `run_blocking` 在 ai.rs / project.rs / backup.rs 多处使用,放在任何一个
//! 业务模块都让其他模块产生奇怪依赖。独立到 util 模块后,业务模块只通过
//! `super::util::run_blocking` 拿到它,语义清晰且可独立测试。

/// 把同步阻塞闭包(典型 `std::fs::*` / rusqlite / base64 decode 等)扔到
/// tokio 的 blocking thread pool 上跑,避免占住主 runtime worker。
///
/// **使用规则**:任何 `async fn` 内调用同步 IO(`std::fs::*` / 大量 `serde_json`
/// 序列化 / base64 encode 大文件等)必须走这里。
///
/// **历史踩坑**:同步 IO 在 async fn 内直接跑会拖慢其他 IPC,极端情况下
/// runtime worker 被独占够久(几十 MB base64 写盘)就触发 Tauri IPC 超时
/// → 渲染端 WebView2 被杀,日志干净无线索。
/// 详见 `docs/性能与IPC规范.md` §3 异步阻塞章节 与 v3/v8 修复记录。
pub async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("blocking task join failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn run_blocking_returns_ok() {
        let r: Result<i32, String> = run_blocking(|| Ok(42)).await;
        assert_eq!(r, Ok(42));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn run_blocking_propagates_err() {
        let r: Result<i32, String> = run_blocking(|| Err("oops".into())).await;
        assert_eq!(r, Err("oops".to_string()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn run_blocking_does_not_block_runtime() {
        // 在 blocking pool 上 sleep 200ms,期间主 runtime 应当能调度其他 future
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let other_ran = Arc::new(AtomicBool::new(false));
        let flag = other_ran.clone();
        let bg = tokio::spawn(async move {
            run_blocking(move || {
                std::thread::sleep(std::time::Duration::from_millis(200));
                flag.store(true, Ordering::Relaxed);
                Ok::<_, String>(())
            })
            .await
        });
        // 等 50ms 后看主 runtime 是否还活着 —— 能 yield 就说明没被 blocking 闭包独占
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // 此时 bg 还没完成,但 runtime tick 正常
        assert!(!other_ran.load(Ordering::Relaxed));
        bg.await.unwrap().unwrap();
        assert!(other_ran.load(Ordering::Relaxed));
    }
}
