# check-ipc-guards.ps1 - Build-time enforcement of IPC safety layer.
#
# Why this exists:
#   On 2026-05-23 commit 664c74a "Rust slim-refactor" wiped v3 IPC guards.
#   Same night users reported repeated WebView2 renderer crashes on:
#     - opening a project
#     - clicking Generate
#     - waiting for generation to finish
#   v8 restored everything and added this script so it cannot happen again.
#
# Invocation:
#   - package.json "prebuild" hook
#   - tauri.conf.json beforeBuildCommand / beforeDevCommand
#   - Manual: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-ipc-guards.ps1
#
# ASCII-only on purpose: PowerShell 5.1 defaults to ANSI when reading .ps1
# without a BOM, and Chinese / em-dash literals fail to parse. Keep ASCII.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$ai = Join-Path $root 'src-tauri/src/commands/ai.rs'
$modFile = Join-Path $root 'src-tauri/src/commands/mod.rs'
$ipcGuard = Join-Path $root 'src-tauri/src/commands/ipc_guard.rs'
$ipcLimits = Join-Path $root 'src-tauri/src/commands/ipc_limits.rs'
$utilFile = Join-Path $root 'src-tauri/src/commands/util.rs'
$uploadFile = Join-Path $root 'src-tauri/src/commands/upload.rs'
$httpUtilFile = Join-Path $root 'src-tauri/src/commands/http_util.rs'
$libFile = Join-Path $root 'src-tauri/src/lib.rs'
$tsLimits = Join-Path $root 'src/lib/ipcLimits.ts'

$errors = New-Object System.Collections.ArrayList
$checks = 0

function AddError($msg) {
    [void]$script:errors.Add($msg)
}

# 1. Required files exist
foreach ($f in @($ai, $modFile, $ipcGuard, $ipcLimits, $utilFile, $uploadFile, $httpUtilFile, $libFile)) {
    $checks++
    if (-not (Test-Path $f)) {
        AddError "MISSING required file: $f"
    }
}

if ($errors.Count -gt 0) {
    Write-Host "[check-ipc-guards] FAIL: required files missing, cannot continue" -ForegroundColor Red
    $errors | ForEach-Object { Write-Host "  X $_" -ForegroundColor Red }
    exit 1
}

# Read raw, then strip block comments so a `/* guard_response_body() ... */` cannot
# trick the non-`//` regex into thinking the function is still being called.
# (?s) = DOTALL so . matches newlines. Non-greedy `.*?` to keep matches local.
function StripBlockComments([string]$s) {
    return [regex]::Replace($s, '/\*.*?\*/', '', [System.Text.RegularExpressions.RegexOptions]::Singleline)
}

$aiContent = StripBlockComments (Get-Content $ai -Raw -Encoding UTF8)
$modContent = StripBlockComments (Get-Content $modFile -Raw -Encoding UTF8)
$libContent = StripBlockComments (Get-Content $libFile -Raw -Encoding UTF8)
$ipcLimitsContent = StripBlockComments (Get-Content $ipcLimits -Raw -Encoding UTF8)
$httpUtilContent = StripBlockComments (Get-Content $httpUtilFile -Raw -Encoding UTF8)

# 2. mod.rs exports critical modules
$checks++
if ($modContent -notmatch '(?m)^pub mod ipc_limits;') {
    AddError "commands/mod.rs MUST export ipc_limits (otherwise ipc_limits.rs is orphaned)"
}
$checks++
if ($modContent -notmatch '(?m)^pub mod ipc_guard;') {
    AddError "commands/mod.rs MUST export ipc_guard (guard functions module, deleting = removing guards)"
}
$checks++
if ($modContent -notmatch '(?m)^pub mod util;') {
    AddError "commands/mod.rs MUST export util (run_blocking helper)"
}
$checks++
if ($modContent -notmatch '(?m)^pub mod upload;') {
    AddError "commands/mod.rs MUST export upload (chunked media upload module, blocks Win/WebView2 crash on large video drops)"
}

# 3. ai.rs imports and calls guard functions.
#    Regex `(?m)^(?!\s*//).*<name>\(` matches a real call: start of line,
#    not preceded by '//', and contains the function call. This blocks the
#    "commented-out guard" bypass. Block comments already stripped above.
$checks++
if ($aiContent -notmatch 'use super::ipc_guard::') {
    AddError "ai.rs MUST import from super::ipc_guard"
}
$checks++
if ($aiContent -notmatch 'use super::util::run_blocking') {
    AddError "ai.rs MUST import super::util::run_blocking (large file IO must go to blocking pool)"
}
$checks++
if ($aiContent -notmatch '(?m)^(?!\s*//).*guard_response_body\s*\(') {
    AddError "ai.rs MUST call guard_response_body() (non-commented) before returning ai_proxy body"
}
$checks++
if ($aiContent -notmatch '(?m)^(?!\s*//).*check_stream_chunk\s*\(') {
    AddError "ai.rs MUST call check_stream_chunk() (non-commented) before SSE chunk emit"
}
$checks++
if ($aiContent -notmatch '(?m)^(?!\s*//).*check_stream_buffer\s*\(') {
    AddError "ai.rs MUST call check_stream_buffer() (non-commented) when accumulating line buffer"
}
$checks++
if ($aiContent -notmatch '(?m)^(?!\s*//).*check_inline_total_bytes\s*\(') {
    AddError "ai.rs MUST call check_inline_total_bytes() (non-commented) in inline_local_files -- see ipc_guard"
}
$checks++
if ($aiContent -notmatch '(?m)^(?!\s*//).*read_body_bounded') {
    AddError "ai.rs MUST use read_body_bounded()/read_body_bounded_bytes() -- never resp.text()/resp.bytes() directly"
}
$checks++
if ($aiContent -match '(?m)^(?!\s*//).*\bresp\s*\.\s*text\s*\(\s*\)\s*\.\s*await') {
    AddError "ai.rs uses raw 'resp.text().await' -- replace with read_body_bounded() (OOM safety)"
}
$checks++
if ($aiContent -match '(?m)^(?!\s*//).*\bresp\s*\.\s*bytes\s*\(\s*\)\s*\.\s*await') {
    AddError "ai.rs uses raw 'resp.bytes().await' -- replace with read_body_bounded_bytes() (OOM safety)"
}

# 3b. http_util.rs has the bounded readers
$checks++
if ($httpUtilContent -notmatch '(?m)^(?!\s*//).*fn\s+read_body_bounded\b') {
    AddError "http_util.rs MUST define read_body_bounded (bounded API body reader)"
}
$checks++
if ($httpUtilContent -notmatch '(?m)^(?!\s*//).*fn\s+read_body_bounded_bytes\b') {
    AddError "http_util.rs MUST define read_body_bounded_bytes (bounded byte body reader)"
}

# 4. ai.rs bans O(n^2) buffer anti-pattern (the v8 bug)
$checks++
if ($aiContent -match 'let mut buffer\s*=\s*String::new\(\)') {
    AddError "ai.rs uses 'let mut buffer = String::new()' in a stream path -- O(n^2) regression! Use Vec<u8> + drain."
}
$checks++
if ($aiContent -match 'buffer\s*=\s*buffer\[[^\]]+\]\.to_string\(\)') {
    AddError "ai.rs reassigns buffer via .to_string() -- O(n^2) regression! Use buffer.drain(..=pos)."
}

# 5. Soft heuristic: std::fs calls vs run_blocking calls
$fsCalls = ([regex]::Matches($aiContent, 'std::fs::(?:read|write|copy|create_dir_all)\s*\(')).Count
$runBlockingCalls = ([regex]::Matches($aiContent, '\brun_blocking\s*\(')).Count
$checks++
if ($fsCalls -gt 0 -and $runBlockingCalls -lt ($fsCalls * 0.5)) {
    AddError "ai.rs has $fsCalls std::fs::* calls but only $runBlockingCalls run_blocking calls -- possible bare sync IO in async fn"
}

# 6. lib.rs runs sanity check at startup (non-commented call)
$checks++
if ($libContent -notmatch '(?m)^(?!\s*//).*ipc_guard::sanity_check_limits\s*\(\s*\)') {
    AddError "lib.rs MUST call commands::ipc_guard::sanity_check_limits() (non-commented) during setup"
}

# 7. ipc_limits.rs defines required constants
foreach ($c in @(
    'IPC_RESPONSE_BODY_HARD_LIMIT_BYTES',
    'IPC_STREAM_CHUNK_HARD_LIMIT_BYTES',
    'STREAM_LINE_BUFFER_HARD_LIMIT_BYTES',
    'INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES',
    'HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES',
    'MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES',
    'MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES'
)) {
    $checks++
    if ($ipcLimitsContent -notmatch "pub const $c") {
        AddError "ipc_limits.rs MUST define const $c"
    }
}

# 8. Frontend constant sync (soft warning only)
if (Test-Path $tsLimits) {
    $tsContent = Get-Content $tsLimits -Raw -Encoding UTF8
    if ($tsContent -notmatch 'IPC_PAYLOAD_HARD_LIMIT_BYTES') {
        Write-Host "[check-ipc-guards] WARN: $tsLimits has no IPC_PAYLOAD_HARD_LIMIT_BYTES constant" -ForegroundColor Yellow
    }
}

# Output
if ($errors.Count -eq 0) {
    Write-Host "[check-ipc-guards] OK: $checks/$checks checks passed" -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "[check-ipc-guards] FAIL: $($errors.Count) of $checks checks failed" -ForegroundColor Red
Write-Host ""
$errors | ForEach-Object { Write-Host "  X $_" -ForegroundColor Red }
Write-Host ""
Write-Host "Fix guide:" -ForegroundColor Yellow
Write-Host "  - Read top of src-tauri/src/commands/ipc_guard.rs" -ForegroundColor Yellow
Write-Host "  - Read docs/RUST_REFACTOR_CHECKLIST.md" -ForegroundColor Yellow
Write-Host "  - Read docs/performance-and-ipc-spec.md section 11" -ForegroundColor Yellow
exit 1
