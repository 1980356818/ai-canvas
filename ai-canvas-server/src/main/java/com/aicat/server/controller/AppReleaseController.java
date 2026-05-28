package com.aicat.server.controller;

import com.aicat.server.common.Result;
import com.aicat.server.entity.AppRelease;
import com.aicat.server.service.AppReleaseService;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.servlet.http.HttpServletRequest;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * 客户端自动更新 / 版本切换公开端点。无需 token。
 *
 * 关键端点的响应体不走 R<T> 信封 ——Tauri updater 直接解析 JSON 顶层字段
 * (version / pub_date / url / signature / notes),套了 envelope 就解不出来。
 * 自定义端点 (list) 仍走 R<T> 信封,前端 Rust 自己解。
 */
@RestController
@RequestMapping("/api/update")
@RequiredArgsConstructor
public class AppReleaseController {

    private final AppReleaseService service;

    // ── 1. Tauri updater 检查 ────────────────────────────────────────
    // 没有更新返回 204;有更新返回 Tauri manifest JSON
    @GetMapping("/check/{target}/{arch}/{currentVersion}")
    public ResponseEntity<TauriManifest> check(
            @PathVariable String target,
            @PathVariable String arch,
            @PathVariable String currentVersion,
            HttpServletRequest req) {
        AppRelease latest = service.findLatestUpdate(target, arch, currentVersion);
        if (latest == null) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.ok(toManifest(latest, resolveBaseUrl(req), currentVersion));
    }

    // ── 2. 列出该平台所有"启用中"版本 ────────────────────────────────
    // 用于客户端"自由切换版本"UI。停用版本不会出现在这里。
    @GetMapping("/list/{target}/{arch}")
    public Result<List<VersionItem>> listEnabled(
            @PathVariable String target,
            @PathVariable String arch,
            HttpServletRequest req) {
        String base = resolveBaseUrl(req);
        List<VersionItem> items = service.listEnabled(target, arch).stream()
                .map(r -> VersionItem.from(r, base))
                .toList();
        return Result.ok(items);
    }

    // ── 3. 拿指定 id 的 Tauri manifest(用于版本切换) ──────────────────
    // Rust 端把 UpdaterBuilder 指到这个 URL,即可下载并安装指定版本。
    // 停用版本会被拒绝。
    @GetMapping("/manifest/{id}")
    public ResponseEntity<TauriManifest> manifest(
            @PathVariable Long id,
            HttpServletRequest req) {
        AppRelease rel = service.getActiveById(id);
        return ResponseEntity.ok(toManifest(rel, resolveBaseUrl(req), null));
    }

    // ── 4. 二进制下载 ────────────────────────────────────────────────
    @GetMapping("/download/{id}")
    public ResponseEntity<FileSystemResource> download(@PathVariable Long id) {
        AppRelease rel = service.getActiveById(id);
        FileSystemResource res = service.openReleaseFile(rel);
        String encoded = URLEncoder.encode(rel.getFileName(), StandardCharsets.UTF_8)
                .replace("+", "%20");
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .contentLength(rel.getFileSize())
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"" + rel.getFileName() + "\"; filename*=UTF-8''" + encoded)
                .body(res);
    }

    // ─────────────────────────────────────────────────────────────────

    private TauriManifest toManifest(AppRelease rel, String baseUrl, String currentVersion) {
        TauriManifest m = new TauriManifest();
        m.version = rel.getVersion();
        m.pubDate = AppReleaseService.formatPubDate(rel.getPubDate());
        m.url = baseUrl + "/api/update/download/" + rel.getId();
        m.signature = rel.getSignature();
        m.format = AppReleaseService.inferFormat(rel.getFileName());
        // 强更标记:client 当前版本低于 min_version 时,前端不能让用户 skip。
        // 沿用 JiJing 的做法,在 notes 尾巴塞一段 HTML 注释作为 meta。
        boolean forceUpdate = currentVersion != null
                && rel.getMinVersion() != null
                && !rel.getMinVersion().isBlank()
                && AppReleaseService.encodeVersion(currentVersion)
                        < AppReleaseService.encodeVersion(rel.getMinVersion());
        StringBuilder notes = new StringBuilder();
        if (rel.getReleaseNotes() != null) notes.append(rel.getReleaseNotes());
        notes.append("\n<!--UPDATE_META:{\"forceUpdate\":")
                .append(forceUpdate)
                .append(",\"id\":").append(rel.getId())
                .append("}-->");
        m.notes = notes.toString();
        return m;
    }

    private String resolveBaseUrl(HttpServletRequest req) {
        String configured = service.getConfiguredBaseUrl();
        if (configured != null && !configured.isBlank()) {
            return configured.replaceAll("/+$", "");
        }
        String scheme = req.getHeader("X-Forwarded-Proto");
        if (scheme == null || scheme.isBlank()) scheme = req.getScheme();
        String host = req.getHeader("X-Forwarded-Host");
        if (host == null || host.isBlank()) host = req.getHeader("Host");
        if (host == null || host.isBlank()) {
            int port = req.getServerPort();
            host = req.getServerName();
            if (port != 80 && port != 443) host = host + ":" + port;
        }
        return scheme + "://" + host;
    }

    /** Tauri 2 updater manifest 格式 —— 字段名严格按 Tauri 规范,不能改驼峰。 */
    @Data
    @NoArgsConstructor
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static class TauriManifest {
        public String version;
        @JsonProperty("pub_date")
        public String pubDate;
        public String url;
        public String signature;
        public String notes;
        /** nsis / msi / app / appimage. Tauri 用它选 install 路径。 */
        public String format;
    }

    /** 自定义 list 端点的元素 —— 给 client/admin UI 自己读的,走我们 R<T> 信封。 */
    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class VersionItem {
        public Long id;
        public String version;
        public Long versionCode;
        public String target;
        public String arch;
        public Long fileSize;
        public String releaseNotes;
        public String minVersion;
        public String pubDate;
        public String downloadUrl;

        static VersionItem from(AppRelease r, String baseUrl) {
            return new VersionItem(
                    r.getId(), r.getVersion(), r.getVersionCode(),
                    r.getTarget(), r.getArch(),
                    r.getFileSize(), r.getReleaseNotes(), r.getMinVersion(),
                    r.getPubDate() == null ? null : r.getPubDate().toString(),
                    baseUrl + "/api/update/download/" + r.getId());
        }
    }
}
