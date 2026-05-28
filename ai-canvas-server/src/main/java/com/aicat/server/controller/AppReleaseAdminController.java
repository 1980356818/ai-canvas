package com.aicat.server.controller;

import com.aicat.server.common.Result;
import com.aicat.server.entity.AppRelease;
import com.aicat.server.service.AdminService;
import com.aicat.server.service.AppReleaseService;
import com.aicat.server.util.IpUtil;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import jakarta.servlet.http.HttpServletRequest;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;

/**
 * 管理端版本管理。所有路径都在 /api/admin/release/* 下,
 * 走 JwtAuthInterceptor 鉴权(已配置 /api/admin/**)。
 *
 * 操作动作会写入 admin_operation_log,target_type = "release"。
 */
@RestController
@RequestMapping("/api/admin/release")
@RequiredArgsConstructor
public class AppReleaseAdminController {

    private final AppReleaseService service;
    private final AdminService adminService; // 仅用于 logOp

    @PostMapping("/upload")
    public Result<AppRelease> upload(
            @RequestParam String version,
            @RequestParam String target,
            @RequestParam String arch,
            @RequestParam(required = false) String releaseNotes,
            @RequestParam(required = false) String minVersion,
            @RequestParam("file") MultipartFile file,
            @RequestParam("signature") MultipartFile signature,
            HttpServletRequest req) {
        AppRelease rel = service.createRelease(version, target, arch, file, signature, releaseNotes, minVersion);
        log(req, "release_upload", rel.getId(),
                "version=" + version + ", " + target + "/" + arch + ", size=" + rel.getFileSize());
        return Result.ok(rel, "上传成功");
    }

    @GetMapping("/list")
    public Result<Page<AppRelease>> list(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String target,
            @RequestParam(required = false) String arch) {
        return Result.ok(service.listAll(page, size, target, arch));
    }

    @PutMapping("/{id}")
    public Result<?> updateMeta(@PathVariable Long id, @RequestBody UpdateMetaReq body, HttpServletRequest req) {
        service.updateMeta(id, body.getReleaseNotes(), body.getMinVersion());
        log(req, "release_update_meta", id,
                "minVersion=" + body.getMinVersion());
        return Result.ok(null, "已更新");
    }

    @PostMapping("/{id}/activate")
    public Result<?> activate(@PathVariable Long id, HttpServletRequest req) {
        service.setActive(id, true);
        log(req, "release_activate", id, null);
        return Result.ok(null, "已启用");
    }

    @PostMapping("/{id}/deactivate")
    public Result<?> deactivate(@PathVariable Long id, HttpServletRequest req) {
        service.setActive(id, false);
        log(req, "release_deactivate", id, null);
        return Result.ok(null, "已停用");
    }

    @DeleteMapping("/{id}")
    public Result<?> delete(@PathVariable Long id, HttpServletRequest req) {
        service.delete(id);
        log(req, "release_delete", id, null);
        return Result.ok(null, "已删除");
    }

    private void log(HttpServletRequest req, String action, Long releaseId, String detail) {
        Long adminId = (Long) req.getAttribute("userId");
        String adminName = (String) req.getAttribute("username");
        adminService.logOp(adminId, adminName, action, "release", releaseId, detail, IpUtil.getClientIp(req));
    }

    @Data
    public static class UpdateMetaReq {
        private String releaseNotes;
        private String minVersion;
    }
}
