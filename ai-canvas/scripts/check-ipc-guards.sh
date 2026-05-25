#!/usr/bin/env bash
# check-ipc-guards.sh -- POSIX static check (Mac/Linux CI). Mirrors .ps1 logic.
# See scripts/check-ipc-guards.ps1 header for full rationale.
#
# History of macOS-only failures (do NOT regress these):
#   v1.1.4/v1.1.5: used `[^/[:space:]]` style bracket negation. GNU grep
#     (Linux + Git Bash) parses it correctly; BSD grep (macOS CI default)
#     parses the embedded POSIX class differently and drops every non-blank
#     line. 5/25 checks falsely failed.
#   v1.1.6: switched to `grep -v '^[[:space:]]*//'` filter inside a pipe of
#     printf "$bigvar" | grep -v | grep -q. Fixed 2/5 but 3 still failed.
#     Suspect bash 3.2.57 (macOS default) `$(...)` capture + pipefail +
#     SIGPIPE-when-grep-q-exits-early interaction.
#   v1.1.7 (current): writes the comment-stripped content to a temp file
#     per source file, then greps the file directly. No big-variable, no
#     pipefail-vs-SIGPIPE race. Each grep is one-shot, exit code is the
#     only signal we care about.
#
# Keep this file ASCII-only (no em-dashes, no Chinese). The .ps1 sibling
# has the same rule for a different reason (PS5.1 ANSI default); aligning
# both files removes one class of CI surprise.

set -euo pipefail

cd "$(dirname "$0")/.."

ai="src-tauri/src/commands/ai.rs"
mod_file="src-tauri/src/commands/mod.rs"
ipc_guard="src-tauri/src/commands/ipc_guard.rs"
ipc_limits="src-tauri/src/commands/ipc_limits.rs"
util_file="src-tauri/src/commands/util.rs"
upload_local_file="src-tauri/src/commands/upload_local.rs"
upload_remote_file="src-tauri/src/commands/upload_remote.rs"
http_util_file="src-tauri/src/commands/http_util.rs"
lib_file="src-tauri/src/lib.rs"

errors=()
checks=0

for f in "$ai" "$mod_file" "$ipc_guard" "$ipc_limits" "$util_file" "$upload_local_file" "$upload_remote_file" "$http_util_file" "$lib_file"; do
    if [ ! -f "$f" ]; then
        echo "[check-ipc-guards] FAIL: missing $f"
        exit 1
    fi
done

# strip_to_temp <src> <dst>
#   Writes <src> with /* ... */ block comments removed AND lines that are
#   pure // comments (whitespace then //) dropped, to <dst>. Block-comment
#   strip is done in perl (multi-line non-greedy) before line filter.
strip_to_temp() {
    perl -0777 -pe 's{/\*.*?\*/}{}gs' "$1" | grep -v '^[[:space:]]*//' > "$2" || true
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

ai_clean="$tmpdir/ai.rs.clean"
http_util_clean="$tmpdir/http_util.rs.clean"
lib_clean="$tmpdir/lib.rs.clean"

strip_to_temp "$ai" "$ai_clean"
strip_to_temp "$http_util_file" "$http_util_clean"
strip_to_temp "$lib_file" "$lib_clean"

# 1. mod.rs exports
grep -qE '^pub mod ipc_limits;' "$mod_file" || errors+=("commands/mod.rs MUST export ipc_limits")
grep -qE '^pub mod ipc_guard;' "$mod_file"  || errors+=("commands/mod.rs MUST export ipc_guard")
grep -qE '^pub mod util;' "$mod_file"          || errors+=("commands/mod.rs MUST export util")
grep -qE '^pub mod upload_local;' "$mod_file"  || errors+=("commands/mod.rs MUST export upload_local (frontend -> Rust chunked write)")
grep -qE '^pub mod upload_remote;' "$mod_file" || errors+=("commands/mod.rs MUST export upload_remote (Rust -> JiJing /v1/files/upload)")
checks=$((checks + 5))

# 2. ai.rs imports + calls (against the comment-stripped temp file).
grep -q 'use super::ipc_guard::'           "$ai"       || errors+=("ai.rs MUST import super::ipc_guard")
grep -q 'use super::util::run_blocking'    "$ai"       || errors+=("ai.rs MUST import super::util::run_blocking")
grep -q 'guard_response_body'              "$ai_clean" || errors+=("ai.rs MUST call guard_response_body() (non-commented, non-block-commented)")
grep -q 'check_stream_chunk'               "$ai_clean" || errors+=("ai.rs MUST call check_stream_chunk() (non-commented, non-block-commented)")
grep -q 'check_stream_buffer'              "$ai_clean" || errors+=("ai.rs MUST call check_stream_buffer() (non-commented, non-block-commented)")
grep -q 'check_inline_total_bytes'         "$ai_clean" || errors+=("ai.rs MUST call check_inline_total_bytes() in inline_local_files")
grep -q 'read_body_bounded'                "$ai_clean" || errors+=("ai.rs MUST use read_body_bounded()/read_body_bounded_bytes() (never resp.text()/resp.bytes())")
checks=$((checks + 7))

# Raw .text()/.bytes() bans, on the comment-stripped file.
if grep -qE '\bresp[[:space:]]*\.[[:space:]]*text[[:space:]]*\([[:space:]]*\)[[:space:]]*\.[[:space:]]*await' "$ai_clean"; then
    errors+=("ai.rs uses raw 'resp.text().await' -- replace with read_body_bounded() (OOM safety)")
fi
if grep -qE '\bresp[[:space:]]*\.[[:space:]]*bytes[[:space:]]*\([[:space:]]*\)[[:space:]]*\.[[:space:]]*await' "$ai_clean"; then
    errors+=("ai.rs uses raw 'resp.bytes().await' -- replace with read_body_bounded_bytes() (OOM safety)")
fi
checks=$((checks + 2))

# 3a. http_util.rs has the bounded readers.
grep -qE 'fn[[:space:]]+read_body_bounded\b'       "$http_util_clean" || errors+=("http_util.rs MUST define read_body_bounded")
grep -qE 'fn[[:space:]]+read_body_bounded_bytes\b' "$http_util_clean" || errors+=("http_util.rs MUST define read_body_bounded_bytes")
checks=$((checks + 2))

# 4. Ban O(n^2) buffer anti-patterns (run against stripped content so the
#    historical-note comments don't false-positive).
if grep -qE 'let mut buffer[[:space:]]*=[[:space:]]*String::new\(\)' "$ai_clean"; then
    errors+=("ai.rs uses 'let mut buffer = String::new()' -- O(n^2) anti-pattern in stream path!")
fi
if grep -qE 'buffer[[:space:]]*=[[:space:]]*buffer\[[^]]+\]\.to_string\(\)' "$ai_clean"; then
    errors+=("ai.rs reassigns buffer via .to_string() -- O(n^2) anti-pattern!")
fi
checks=$((checks + 2))

# 5. lib.rs sanity check call.
grep -q 'ipc_guard::sanity_check_limits' "$lib_clean" \
    || errors+=("lib.rs MUST call commands::ipc_guard::sanity_check_limits() (non-commented) in setup")
checks=$((checks + 1))

# 6. ipc_limits constants.
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

# 7. API key reader unification (2026-05-25 root cause: sync getProviderAuthHeaders
#    only read localStorage but Tauri-mode SettingsDialog stored keys in sqlite,
#    so every fetch path got empty Authorization -> 401 "Missing API Key". User
#    saw chat hang because media upload step died silently.
#
#    Single source of truth: src/platform/auth.ts (async). Forbid:
#      - Re-introducing any sync helper named getProviderAuthHeaders /
#        getBrowserFirstKey / getAuthHeaders / getBrowserApiConfig / getBrowserKeys.
#      - Direct lsGet("setting_*_api_key*") / lsSet of api_key keys outside auth.ts.
#      - The async settings.api::getProviderFirstKey shim (replaced by
#        auth::readProviderFirstKey which supports keyTag).
auth_file="src/platform/auth.ts"
if [ ! -f "$auth_file" ]; then
    errors+=("src/platform/auth.ts MUST exist -- it is the single API key reader entry point")
fi
checks=$((checks + 1))

# Build a temp file per .ts/.tsx file with block-comments stripped + // lines removed,
# then grep for banned names with real-call regex. Skip auth.ts (its own definitions
# and history comments legitimately contain these names).
banned_sync="getProviderAuthHeaders|getBrowserFirstKey|getBrowserApiConfig|getBrowserKeys"

ts_files_clean_dir="$tmpdir/ts_clean"
mkdir -p "$ts_files_clean_dir"

# `find` is BSD/GNU portable.  -not -path keeps auth.ts out, and node_modules out.
while IFS= read -r f; do
    case "$f" in
        */auth.ts|*/auth.ts.*) continue;;
    esac
    rel="${f#./}"
    safe_name=$(echo "$rel" | tr '/' '_')
    clean="$ts_files_clean_dir/$safe_name"
    perl -0777 -pe 's{/\*.*?\*/}{}gs' "$f" | grep -v '^[[:space:]]*//' > "$clean" || true

    for name in $(echo "$banned_sync" | tr '|' ' '); do
        # Real call: contains "name(" on a non-// line.  -E for ERE.
        if grep -Eq "\\b${name}[[:space:]]*\\(" "$clean"; then
            errors+=("$rel: re-introduces banned sync key reader '$name' -- use platform/auth.ts (resolveAuthHeaders / readProviderKeys / readProviderFirstKey)")
        fi
        checks=$((checks + 1))
    done
    # Direct lsGet / lsSet against api_key storage keys. Allow optional TS generic
    # `<...>` between name and `(`, mirroring the .ps1 sibling regex.
    if grep -Eq 'ls(Get|Set)[[:space:]]*(<[^>]+>)?[[:space:]]*\([[:space:]]*[`"'"'"'][^`"'"'"']*api_key' "$clean"; then
        errors+=("$rel: direct lsGet/lsSet of 'setting_*_api_key*' -- use platform/auth.ts (Tauri mode keys live in sqlite)")
    fi
    checks=$((checks + 1))
done < <(find src -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null)

# 8. auth.ts must export the canonical async entry points.
if [ -f "$auth_file" ]; then
    auth_clean="$tmpdir/auth.ts.clean"
    perl -0777 -pe 's{/\*.*?\*/}{}gs' "$auth_file" | grep -v '^[[:space:]]*//' > "$auth_clean" || true
    for name in readProviderKeys readProviderFirstKey resolveAuthHeaders; do
        if ! grep -Eq "^[[:space:]]*export[[:space:]]+async[[:space:]]+function[[:space:]]+${name}\\b" "$auth_clean"; then
            errors+=("auth.ts MUST export async function ${name} (canonical API key entry)")
        fi
        checks=$((checks + 1))
    done
fi

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
