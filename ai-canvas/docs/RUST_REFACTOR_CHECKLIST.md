# Rust 后端重构 / 瘦身 检查清单

> 改 `src-tauri/src/commands/ai.rs` / `lib.rs` / `commands/mod.rs` 之前**必读**。
>
> 这份清单的存在是因为 2026-05-23 commit [`664c74a`](git log) "Rust 瘦身重构" 把
> 8 天前 v3 修复的 IPC 安全护栏一刀切删掉,当晚用户报"进项目/点生成/生成等待中"
> 三场景频繁闪退。v8 全部恢复并加多层防御 —— 本清单是其中一层。

## 改之前(打开编辑器之前)

1. **跑一次验证基线**:
   ```pwsh
   pwsh scripts/check-ipc-guards.ps1
   cargo test --manifest-path src-tauri/Cargo.toml --lib commands::
   ```
   全绿才能开始改 —— 不要在已经红的基础上叠 patch。

2. **读三处顶部注释**:
   - `src-tauri/src/commands/ipc_guard.rs` 第 1-30 行(三道闸门定义)
   - `src-tauri/src/commands/ipc_limits.rs` 第 1-20 行(常量历史)
   - `src-tauri/src/commands/ai.rs` 第 1-15 行(强制约束)

3. **看 `memory/project_ai_canvas_crash_fixes.md`** v3 / v8 章节 —— 知道哪些
   代码是用户实际崩溃换来的。

## 改之中

### ✅ 允许

- 改 `ai_proxy` / `do_stream` 的业务逻辑(provider 适配 / 重试 / key 轮转)
- 加新的 `#[tauri::command]`,**前提**是返回 String body 时调用 `guard_response_body`
- 加新的 SSE chunk 处理,**前提**是 emit 前调 `check_stream_chunk`
- 改 IO 错误信息(只要不删 `?` 或 `match` 错误分支)
- 调常量(`IPC_*_HARD_LIMIT_BYTES`)**只能调小**,不能调大。改完跑 `cargo test`。

### ❌ 禁止 (build 会失败 / 测试会红)

| 改动 | 后果 |
|------|------|
| 删 `pub mod ipc_guard;` / `pub mod ipc_limits;` / `pub mod util;` | ai.rs 编译失败 + `check-ipc-guards.ps1` 失败 |
| 删 ai.rs 里 `guard_response_body(...)` 调用 | `check-ipc-guards.ps1` 失败 |
| 删 ai.rs 里 `check_stream_chunk(...)` / `check_stream_buffer(...)` 调用 | `check-ipc-guards.ps1` 失败 |
| 删 lib.rs 里 `ipc_guard::sanity_check_limits()` 调用 | `check-ipc-guards.ps1` 失败 |
| `do_stream` 里改回 `let mut buffer = String::new()` | `check-ipc-guards.ps1` 拒;O(n²) 已被验证 |
| `buffer = buffer[..].to_string()` 重赋值 | `check-ipc-guards.ps1` 拒 |
| async fn 内裸跑 `std::fs::read`/`write`/`copy`/`create_dir_all` 大文件 | 测试可能不红但 review 必拒 |
| 把 `IPC_RESPONSE_BODY_HARD_LIMIT_BYTES` 调成 0 / > 16MB | `sanity_check_limits` panic + 测试红 |

### ⚠️ 危险信号 (review 重点关注)

- 一次改动同时碰 ai.rs + ipc_limits.rs + mod.rs → 可能是"瘦身"
- diff 里出现 `- pub mod ipc_*` → 立刻警觉
- diff 里 `ai.rs` 减少超过 100 行 → 大概率删了护栏
- commit message 含 "瘦身" / "重构" / "简化" 但 diff 里有删守门 → 拒

## 改之后(commit 之前)

```pwsh
# 1. 静态检查(必须 OK)
pwsh scripts/check-ipc-guards.ps1

# 2. 单元测试(必须全绿)
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::

# 3. clippy(新增 warning 必须修)
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets

# 4. release build(验证 panic_unwind 配置 OK)
cargo build --manifest-path src-tauri/Cargo.toml --release
```

## CI / 自动化

| 时机 | 命令 | 失败后果 |
|------|------|----------|
| 启动 (dev/prod) | `ipc_guard::sanity_check_limits()` | panic + startup.log |
| `npm run dev` | `npm run check:ipc-guards` | dev 服务器拒启 |
| `npm run build` | `prebuild` → `check:ipc-guards` | vite build 失败 |
| `tauri build` | `beforeBuildCommand` → `check:ipc-guards` | tauri 不编译 |
| 单测 | `cargo test` | 6 个守门测试任一红就失败 |

## 多层防御总览

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: 文档警告 (本文件 + 三处顶部 banner)            │
│   人眼 review,最弱但能教育新人。                       │
├─────────────────────────────────────────────────────────┤
│ Layer 2: 函数封装 (ipc_guard.rs 三函数)                 │
│   守门逻辑不在 ai.rs 内联,重构者看不到具体实现就不敢删 │
├─────────────────────────────────────────────────────────┤
│ Layer 3: 编译期 (mod.rs 必须 export → ai.rs 必须 import)│
│   删模块 = ai.rs 编译失败                              │
├─────────────────────────────────────────────────────────┤
│ Layer 4: 单元测试 (cargo test commands::ipc_guard::)    │
│   守门函数行为有合约,改坏立刻红                       │
├─────────────────────────────────────────────────────────┤
│ Layer 5: 静态检查脚本 (check-ipc-guards.ps1/sh)         │
│   grep 验证 ai.rs 仍在调用 + 禁 O(n²) 反模式           │
│   prebuild / beforeBuildCommand 自动跑                  │
├─────────────────────────────────────────────────────────┤
│ Layer 6: 启动 sanity (sanity_check_limits 在 lib.rs)    │
│   常量被改成非法值 → 启动 panic + 日志                 │
└─────────────────────────────────────────────────────────┘
```

任何一层单独存在都可能被绕过。**六层叠加** = 想"瘦身"删护栏的人必须同时绕过文档、
编译器、6 个测试、2 个静态脚本和 1 个启动断言 —— 物理上做不到不留痕迹。

## 历史教训

- **2025-Q1**: SOFT/HARD 双层守门 → 4-8MB 区间放行 → WebView2 偶发崩溃半年。
  教训:不要分层放行,单一 HARD 上限。
- **2026-05-22 (v3)**: 统一改成单一 3MB HARD,加 spill_oversize_response。
  教训:跨 IPC 必须落盘 fallback,不能直接 reject。
- **2026-05-23 (664c74a)**: 一刀切删 v3 守门,当晚用户报闪退。
  教训:仅靠注释 "// 别删"不够,必须用类型系统 / CI / 测试封死。
- **2026-05-23 (v8)**: 本套多层防御方案上线。
