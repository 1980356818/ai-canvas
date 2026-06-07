package com.aicat.server.service;

import com.aicat.server.common.BizException;
import com.aicat.server.common.ErrorCode;
import com.aicat.server.entity.AppRelease;
import com.aicat.server.mapper.AppReleaseMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 客户端发布版本管理。
 *
 * 文件落盘规则: {storage-path}/{version}/{target}-{arch}/{原文件名}
 *
 * 同 (version, target, arch) 已存在时直接拒绝。要替换文件 → 先在 admin UI 删掉旧记录。
 * is_active=0 表示停用 (不在客户端列表/检查更新中返回, 但管理端仍可见, 可再启用)。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AppReleaseService {

    private static final Pattern SEMVER = Pattern.compile("^\\d+\\.\\d+\\.\\d+([-+].+)?$");
    private static final Pattern SAFE_NAME = Pattern.compile("^[A-Za-z0-9._-]+$");

    private final AppReleaseMapper mapper;

    @Value("${aicat.release.storage-path:./data/releases}")
    private String storagePath;

    @Value("${aicat.release.base-url:}")
    private String configuredBaseUrl;

    public String getConfiguredBaseUrl() {
        return configuredBaseUrl == null ? "" : configuredBaseUrl;
    }

    // ──────────────────────────────────────────────────────────────────────
    // 工具
    // ──────────────────────────────────────────────────────────────────────

    /** 把 1.2.3 编码成 1_002_003,便于 SQL 排序/比较。pre-release 后缀忽略。 */
    public static long encodeVersion(String version) {
        if (version == null) return 0L;
        String clean = version.split("[-+]", 2)[0].trim();
        String[] parts = clean.split("\\.");
        try {
            int major = parts.length > 0 ? Integer.parseInt(parts[0]) : 0;
            int minor = parts.length > 1 ? Integer.parseInt(parts[1]) : 0;
            int patch = parts.length > 2 ? Integer.parseInt(parts[2]) : 0;
            return (long) major * 1_000_000L + (long) minor * 1_000L + patch;
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    public static void validateSemver(String v) {
        if (v == null || !SEMVER.matcher(v).matches()) {
            throw new BizException(ErrorCode.RELEASE_INVALID_VERSION, v);
        }
    }

    /** RFC 3339 (Z = UTC),Tauri updater 要求的 pub_date 格式。 */
    public static String formatPubDate(LocalDateTime dt) {
        return dt.atOffset(ZoneOffset.UTC).toString();
    }

    /**
     * Tauri 2 updater 从下载 URL 的扩展名识别包格式;我们的 URL 是
     * /api/update/download/{id} 不带扩展名,所以必须显式给 format 字段。
     * 取值见 tauri-plugin-updater::UpdaterFormat (lowercase 序列化)。
     */
    public static String inferFormat(String fileName) {
        if (fileName == null) return null;
        String n = fileName.toLowerCase();
        // Tauri 2 在 createUpdaterArtifacts=true + NSIS 时直接产 *-setup.exe + .sig,
        // 不再额外打 .nsis.zip,所以 bare .exe 也算 nsis
        if (n.endsWith(".nsis.zip") || n.endsWith("-setup.exe.zip")
                || n.endsWith("-setup.exe") || n.endsWith(".exe")) return "nsis";
        if (n.endsWith(".msi.zip") || n.endsWith(".msi")) return "msi";
        if (n.endsWith(".app.tar.gz")) return "app";
        if (n.endsWith(".appimage.tar.gz")) return "appimage";
        return null;
    }

    private static String sha256Hex(Path path) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (var in = Files.newInputStream(path)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            }
            return HexFormat.of().formatHex(md.digest());
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // 客户端：检查/列表/获取
    // ──────────────────────────────────────────────────────────────────────

    /**
     * 给 Tauri updater 用：返回比 currentVersion 更高的已启用版本。
     * 返回 null = 当前已是最新（控制器层会回 204）。
     */
    public AppRelease findLatestUpdate(String target, String arch, String currentVersion) {
        long currentCode = encodeVersion(currentVersion);
        return mapper.selectOne(
                new LambdaQueryWrapper<AppRelease>()
                        .eq(AppRelease::getTarget, target)
                        .eq(AppRelease::getArch, arch)
                        .eq(AppRelease::getStatus, "stable")
                        .gt(AppRelease::getVersionCode, currentCode)
                        .orderByDesc(AppRelease::getVersionCode)
                        .last("LIMIT 1"));
    }

    public List<AppRelease> listEnabled(String target, String arch) {
        return mapper.selectList(
                new LambdaQueryWrapper<AppRelease>()
                        .eq(AppRelease::getTarget, target)
                        .eq(AppRelease::getArch, arch)
                        .eq(AppRelease::getStatus, "stable")
                        .orderByDesc(AppRelease::getVersionCode));
    }

    public AppRelease getActiveById(Long id) {
        AppRelease rel = mapper.selectById(id);
        if (rel == null) throw new BizException(ErrorCode.RELEASE_NOT_FOUND);
        if (!"stable".equals(rel.getStatus())) {
            throw new BizException(ErrorCode.RELEASE_DISABLED);
        }
        return rel;
    }

    public FileSystemResource openReleaseFile(AppRelease rel) {
        Path p = Paths.get(storagePath).resolve(rel.getFilePath()).normalize();
        // 防越权：确保解析后仍在 storagePath 下
        Path base = Paths.get(storagePath).toAbsolutePath().normalize();
        if (!p.toAbsolutePath().normalize().startsWith(base)) {
            throw new BizException(ErrorCode.RELEASE_FILE_MISSING, "path traversal");
        }
        if (!Files.exists(p)) {
            log.warn("release file missing on disk: {}", p);
            throw new BizException(ErrorCode.RELEASE_FILE_MISSING, p.toString());
        }
        return new FileSystemResource(p);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 管理端：上传 / 列表 / 修改 / 启停 / 删除
    // ──────────────────────────────────────────────────────────────────────

    /**
     * 上传一个新版本。file = 安装包 / 升级包 ; sigFile = Tauri 生成的 .sig 文件。
     */
    public AppRelease createRelease(
            String version,
            String target,
            String arch,
            MultipartFile file,
            MultipartFile sigFile,
            String releaseNotes,
            String minVersion) {
        validateSemver(version);
        if (minVersion != null && !minVersion.isBlank()) validateSemver(minVersion);

        if (target == null || target.isBlank() || arch == null || arch.isBlank()) {
            throw new BizException(ErrorCode.INVALID_PARAM, "target/arch 不能为空");
        }
        if (file == null || file.isEmpty()) {
            throw new BizException(ErrorCode.INVALID_PARAM, "file 不能为空");
        }
        if (sigFile == null || sigFile.isEmpty()) {
            throw new BizException(ErrorCode.INVALID_PARAM, "signature 文件不能为空");
        }

        // 唯一性
        Long existed = mapper.selectCount(new LambdaQueryWrapper<AppRelease>()
                .eq(AppRelease::getVersion, version)
                .eq(AppRelease::getTarget, target)
                .eq(AppRelease::getArch, arch));
        if (existed != null && existed > 0) {
            throw new BizException(ErrorCode.RELEASE_DUPLICATE,
                    version + " " + target + "/" + arch);
        }

        String originalName = file.getOriginalFilename();
        if (originalName == null || originalName.isBlank() || !SAFE_NAME.matcher(originalName).matches()) {
            // 拒绝带斜杠/特殊字符的文件名，避免目录穿越
            throw new BizException(ErrorCode.INVALID_PARAM,
                    "文件名只允许字母/数字/点/下划线/连字符");
        }

        // 落盘
        Path dir = Paths.get(storagePath, version, target + "-" + arch);
        Path filePath = dir.resolve(originalName);
        try {
            Files.createDirectories(dir);
            file.transferTo(filePath.toAbsolutePath().toFile());
        } catch (IOException e) {
            log.error("save release file failed: {}", filePath, e);
            throw new BizException(ErrorCode.RELEASE_UPLOAD_FAILED, e.getMessage());
        }

        String signature;
        try {
            signature = new String(sigFile.getBytes(), java.nio.charset.StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            throw new BizException(ErrorCode.RELEASE_UPLOAD_FAILED, "读取 sig 失败");
        }

        String sha256;
        try {
            sha256 = sha256Hex(filePath);
        } catch (IOException e) {
            throw new BizException(ErrorCode.RELEASE_UPLOAD_FAILED, "计算 sha256 失败");
        }

        AppRelease rel = new AppRelease();
        rel.setVersion(version);
        rel.setVersionCode(encodeVersion(version));
        rel.setTarget(target);
        rel.setArch(arch);
        rel.setFileName(originalName);
        // 存相对路径,便于挪机迁移
        rel.setFilePath(version + "/" + target + "-" + arch + "/" + originalName);
        rel.setFileSize(file.getSize());
        rel.setSignature(signature);
        rel.setSha256(sha256);
        rel.setReleaseNotes(releaseNotes);
        rel.setMinVersion(minVersion);
        // 发布闸: 上传只落 draft,不直接下发;需 promote 才变 stable 全量。
        rel.setStatus("draft");
        rel.setIsActive(0);
        rel.setPubDate(LocalDateTime.now());
        mapper.insert(rel);

        log.info("release created: id={}, version={}, {}/{}", rel.getId(), version, target, arch);
        return rel;
    }

    public Page<AppRelease> listAll(int page, int size, String target, String arch) {
        LambdaQueryWrapper<AppRelease> qw = new LambdaQueryWrapper<>();
        if (target != null && !target.isBlank()) qw.eq(AppRelease::getTarget, target);
        if (arch != null && !arch.isBlank()) qw.eq(AppRelease::getArch, arch);
        qw.orderByDesc(AppRelease::getVersionCode)
          .orderByDesc(AppRelease::getCreatedAt);
        return mapper.selectPage(new Page<>(page, size), qw);
    }

    public void updateMeta(Long id, String releaseNotes, String minVersion) {
        AppRelease rel = mapper.selectById(id);
        if (rel == null) throw new BizException(ErrorCode.RELEASE_NOT_FOUND);
        if (minVersion != null && !minVersion.isBlank()) validateSemver(minVersion);
        rel.setReleaseNotes(releaseNotes);
        rel.setMinVersion(minVersion);
        mapper.updateById(rel);
    }

    /** promote/撤回: active=true -> stable(全量); false -> draft(撤回,不下发)。is_active 同步。 */
    public void setActive(Long id, boolean active) {
        AppRelease rel = mapper.selectById(id);
        if (rel == null) throw new BizException(ErrorCode.RELEASE_NOT_FOUND);
        rel.setStatus(active ? "stable" : "draft");
        rel.setIsActive(active ? 1 : 0);
        mapper.updateById(rel);
    }

    /** 召回一个版本: 标 blocked。客户端 check 时该版本用户会被强制升级到最新 stable。 */
    public void blockVersion(Long id) {
        AppRelease rel = mapper.selectById(id);
        if (rel == null) throw new BizException(ErrorCode.RELEASE_NOT_FOUND);
        rel.setStatus("blocked");
        rel.setIsActive(0);
        mapper.updateById(rel);
    }

    /** 给定客户端当前版本是否已被召回(status=blocked)。 */
    public boolean isVersionBlocked(String target, String arch, String version) {
        Long n = mapper.selectCount(new LambdaQueryWrapper<AppRelease>()
                .eq(AppRelease::getTarget, target)
                .eq(AppRelease::getArch, arch)
                .eq(AppRelease::getVersion, version)
                .eq(AppRelease::getStatus, "blocked"));
        return n != null && n > 0;
    }

    /** 软删:logic-delete 标记 + 删除磁盘文件。 */
    public void delete(Long id) {
        AppRelease rel = mapper.selectById(id);
        if (rel == null) throw new BizException(ErrorCode.RELEASE_NOT_FOUND);
        Path filePath = Paths.get(storagePath).resolve(rel.getFilePath()).normalize();
        Path base = Paths.get(storagePath).toAbsolutePath().normalize();
        if (filePath.toAbsolutePath().normalize().startsWith(base)) {
            try {
                Files.deleteIfExists(filePath);
                // 同时尝试清空空目录
                Path verDir = filePath.getParent();
                if (verDir != null && Files.exists(verDir)
                        && Files.list(verDir).findAny().isEmpty()) {
                    Files.delete(verDir);
                }
            } catch (IOException e) {
                log.warn("delete release file failed (db record still removed): {}", e.getMessage());
            }
        }
        mapper.deleteById(id);
    }
}
