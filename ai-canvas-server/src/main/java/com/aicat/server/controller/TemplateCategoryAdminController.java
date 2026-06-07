package com.aicat.server.controller;

import com.aicat.server.common.BizException;
import com.aicat.server.common.ErrorCode;
import com.aicat.server.common.Result;
import com.aicat.server.entity.TemplateCategory;
import com.aicat.server.service.AdminService;
import com.aicat.server.service.TemplateCategoryService;
import com.aicat.server.util.IpUtil;
import jakarta.servlet.http.HttpServletRequest;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * 管理端模板分组管理。路径在 /api/admin/template-category/* 下,走 JwtAuthInterceptor 鉴权
 * （已配置 /api/admin/**）。操作写 admin_operation_log,target_type = "template_category"。
 *
 * 注:分组 key 是业务字符串（如 flat）,而 admin_operation_log.target_id 是 BIGINT,
 * 故 logOp 的 targetId 传 null,把 key 放 detail。
 */
@RestController
@RequestMapping("/api/admin/template-category")
@RequiredArgsConstructor
public class TemplateCategoryAdminController {

    private final TemplateCategoryService service;
    private final AdminService adminService;

    @GetMapping("/list")
    public Result<List<TemplateCategory>> list() {
        return Result.ok(service.listAll());
    }

    /** 拖拽重排:body.keys = 拖完后的完整有序分组 key 列表,服务端赋 sort=0..N。 */
    @PostMapping("/reorder")
    public Result<?> reorder(@RequestBody ReorderReq body, HttpServletRequest req) {
        service.reorder(body.getKeys());
        log(req, "category_reorder", "n=" + (body.getKeys() == null ? 0 : body.getKeys().size()));
        return Result.ok(null, "排序已保存");
    }

    @PostMapping("/upsert")
    public Result<?> upsert(@RequestBody UpsertReq body, HttpServletRequest req) {
        if (body.getKey() == null || body.getKey().isBlank()) {
            throw new BizException(ErrorCode.INVALID_PARAM, "key 必填");
        }
        if (body.getLabel() == null || body.getLabel().isBlank()) {
            throw new BizException(ErrorCode.INVALID_PARAM, "label 必填");
        }
        TemplateCategory c = new TemplateCategory();
        c.setCatKey(body.getKey().trim());
        c.setLabel(body.getLabel().trim());
        c.setSort(body.getSort() == null ? 0 : body.getSort());
        c.setIsActive(body.getIsActive() == null ? 1 : body.getIsActive());
        c.setMinAppVersion(body.getMinAppVersion());
        service.upsert(c);
        log(req, "category_upsert", "key=" + c.getCatKey());
        return Result.ok(null, "已保存");
    }

    @PutMapping("/{key}/meta")
    public Result<?> updateMeta(@PathVariable String key, @RequestBody MetaReq body, HttpServletRequest req) {
        service.updateMeta(key, body.getLabel(), body.getSort(), body.getMinAppVersion());
        log(req, "category_update_meta", "key=" + key);
        return Result.ok(null, "已保存");
    }

    @PostMapping("/{key}/activate")
    public Result<?> activate(@PathVariable String key, HttpServletRequest req) {
        service.setActive(key, true);
        log(req, "category_activate", "key=" + key);
        return Result.ok(null, "已上架");
    }

    @PostMapping("/{key}/deactivate")
    public Result<?> deactivate(@PathVariable String key, HttpServletRequest req) {
        service.setActive(key, false);
        log(req, "category_deactivate", "key=" + key);
        return Result.ok(null, "已下架");
    }

    @DeleteMapping("/{key}")
    public Result<?> delete(@PathVariable String key, HttpServletRequest req) {
        service.delete(key);
        log(req, "category_delete", "key=" + key);
        return Result.ok(null, "已删除");
    }

    private void log(HttpServletRequest req, String action, String detail) {
        Long adminId = (Long) req.getAttribute("userId");
        String adminName = (String) req.getAttribute("username");
        adminService.logOp(adminId, adminName, action, "template_category", null, detail, IpUtil.getClientIp(req));
    }

    @Data
    public static class UpsertReq {
        private String key;
        private String label;
        private Integer sort;
        private Integer isActive;
        private String minAppVersion;
    }

    @Data
    public static class MetaReq {
        private String label;
        private Integer sort;
        private String minAppVersion;
    }

    @Data
    public static class ReorderReq {
        private List<String> keys;
    }
}
