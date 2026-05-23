#!/usr/bin/env bash
# check-ipc-guards.sh — POSIX 版静态检查 (Mac/Linux CI 用),逻辑与 .ps1 对齐。
# 详见 scripts/check-ipc-guards.ps1 头部注释。

set -euo pipefail

cd "$(dirname "$0")/.."

ai="src-tauri/src/commands/ai.rs"
mod_file="src-tauri/src/commands/mod.rs"
ipc_guard="src-tauri/src/commands/ipc_guard.rs"
ipc_limits="src-tauri/src/commands/ipc_limits.rs"
util_file="src-tauri/src/commands/util.rs"
upload_file="src-tauri/src/commands/upload.rs"
http_util_file="src-tauri/src/commands/http_util.rs"
lib_file="src-tauri/src/lib.rs"

errors=()
checks=0
fail_if() {
    checks=$((checks + 1))
    if [ "$1" = "true" ]; then
        errors+=("$2")
    fi
}

for f in "$ai" "$mod_file" "$ipc_guard" "$ipc_limits" "$util_file" "$upload_file" "$http_util_file" "$lib_file"; do
    if [ ! -f "$f" ]; then
        echo "[check-ipc-guards] FAIL: missing $f"
        exit 1
    fi
done

# 1. mod.rs export
grep -qE '^pub mod ipc_limits;' "$mod_file" || errors+=("commands/mod.rs MUST export ipc_limits")
grep -qE '^pub mod ipc_guard;' "$mod_file"  || errors+=("commands/mod.rs MUST export ipc_guard")
grep -qE '^pub mod util;' "$mod_file"       || errors+=("commands/mod.rs MUST export util")
grep -qE '^pub mod upload;' "$mod_file"     || errors+=("commands/mod.rs MUST export upload (chunked media upload)")
checks=$((checks + 4))

# 2. ai.rs imports + calls (non-commented). grep -E with negative lookahead is
# not portable; use a two-step strategy:
#   a) strip `/* ... */` block comments (perl -0777 reads whole file, /s makes
#      . span newlines). Without this, a comment block containing guard names
#      would fool the line-based check.
#   b) on the stripped content, filter out lines beginning with `//`, then grep.
ai_stripped="$(perl -0777 -pe 's{/\*.*?\*/}{}gs' "$ai")"
non_comment_grep() {
    # $1 = pattern; reads stripped content from stdin via the caller
    grep -E '^[[:space:]]*[^/[:space:]]' | grep -q "$1"
}
grep -q 'use super::ipc_guard::' "$ai" || errors+=("ai.rs MUST import super::ipc_guard")
grep -q 'use super::util::run_blocking' "$ai" || errors+=("ai.rs MUST import super::util::run_blocking")
printf '%s' "$ai_stripped" | non_comment_grep 'guard_response_body'      || errors+=("ai.rs MUST call guard_response_body() (non-commented, non-block-commented)")
printf '%s' "$ai_stripped" | non_comment_grep 'check_stream_chunk'       || errors+=("ai.rs MUST call check_stream_chunk() (non-commented, non-block-commented)")
printf '%s' "$ai_stripped" | non_comment_grep 'check_stream_buffer'      || errors+=("ai.rs MUST call check_stream_buffer() (non-commented, non-block-commented)")
printf '%s' "$ai_stripped" | non_comment_grep 'check_inline_total_bytes' || errors+=("ai.rs MUST call check_inline_total_bytes() in inline_local_files")
printf '%s' "$ai_stripped" | non_comment_grep 'read_body_bounded'        || errors+=("ai.rs MUST use read_body_bounded()/read_body_bounded_bytes() (never resp.text()/resp.bytes())")
if printf '%s' "$ai_stripped" | grep -qE '^[[:space:]]*[^/[:space:]].*\bresp[[:space:]]*\.[[:space:]]*text[[:space:]]*\([[:space:]]*\)[[:space:]]*\.[[:space:]]*await'; then
    errors+=("ai.rs uses raw 'resp.text().await' — replace with read_body_bounded() (OOM safety)")
fi
if printf '%s' "$ai_stripped" | grep -qE '^[[:space:]]*[^/[:space:]].*\bresp[[:space:]]*\.[[:space:]]*bytes[[:space:]]*\([[:space:]]*\)[[:space:]]*\.[[:space:]]*await'; then
    errors+=("ai.rs uses raw 'resp.bytes().await' — replace with read_body_bounded_bytes() (OOM safety)")
fi
checks=$((checks + 9))

# 3a. http_util.rs has the bounded readers (block-comment stripped)
http_util_stripped="$(perl -0777 -pe 's{/\*.*?\*/}{}gs' "$http_util_file")"
printf '%s' "$http_util_stripped" | non_comment_grep 'fn read_body_bounded\b'       || errors+=("http_util.rs MUST define read_body_bounded")
printf '%s' "$http_util_stripped" | non_comment_grep 'fn read_body_bounded_bytes\b' || errors+=("http_util.rs MUST define read_body_bounded_bytes")
checks=$((checks + 2))

# 3. ban O(n^2) buffer anti-pattern (run against stripped content so a
#    historical-note block comment containing the pattern doesn't false-positive)
if printf '%s' "$ai_stripped" | grep -qE 'let mut buffer[[:space:]]*=[[:space:]]*String::new\(\)'; then
    errors+=("ai.rs uses 'let mut buffer = String::new()' — O(n^2) anti-pattern in stream path!")
fi
if printf '%s' "$ai_stripped" | grep -qE 'buffer[[:space:]]*=[[:space:]]*buffer\[[^]]+\]\.to_string\(\)'; then
    errors+=("ai.rs reassigns buffer via .to_string() — O(n^2) anti-pattern!")
fi
checks=$((checks + 2))

# 4. lib.rs sanity check (non-commented, non-block-commented)
lib_stripped="$(perl -0777 -pe 's{/\*.*?\*/}{}gs' "$lib_file")"
printf '%s' "$lib_stripped" | non_comment_grep 'ipc_guard::sanity_check_limits' || \
    errors+=("lib.rs MUST call commands::ipc_guard::sanity_check_limits() (non-commented) in setup")
checks=$((checks + 1))

# 5. ipc_limits constants
for c in IPC_RESPONSE_BODY_HARD_LIMIT_BYTES \
         IPC_STREAM_CHUNK_HARD_LIMIT_BYTES \
         STREAM_LINE_BUFFER_HARD_LIMIT_BYTES \
         INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES \
         HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES \
         MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES \
         MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES; do
    grep -q "pub const $c" "$ipc_limits" || errors+=("ipc_limits.rs MUST define const $c")
    checks=$((checks + 1))
done

if [ ${#errors[@]} -eq 0 ]; then
    echo "[check-ipc-guards] OK: $checks checks passed"
    exit 0
fi

echo ""
echo "[check-ipc-guards] FAIL: ${#errors[@]}/$checks checks failed"
echo ""
for e in "${errors[@]}"; do
    echo "  X $e"
done
echo ""
echo "See: src-tauri/src/commands/ipc_guard.rs (top), docs/RUST_REFACTOR_CHECKLIST.md"
exit 1
