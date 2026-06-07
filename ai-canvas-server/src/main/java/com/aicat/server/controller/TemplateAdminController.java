package com.aicat.server.controller;

import com.aicat.server.common.BizException;
import com.aicat.server.common.ErrorCode;
import com.aicat.server.common.Result;
import com.aicat.server.entity.Template;
import com.aicat.server.service.AdminService;
import com.aicat.server.service.TemplateService;
import com.aicat.server.util.IpUtil;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * 管理端模板管理。路径在 /api/admin/template/* 下,走 JwtAuthInterceptor 鉴权
 * (已配置 /api/admin/**)。操作写 admin_operation_log,target_type = "template"。
 *
 * 注:模板 id 是业务字符串(如 wf-white-bg),而 admin_operation_log.target_id 是 BIGINT,
 * 故 logOp 的 targetId 传 null,把模板 id 放 detail。
 */
@RestController
@RequestMapping("/api/admin/template")
@RequiredArgsConstructor
public class TemplateAdminController {

    private final TemplateService service;
    private final AdminService adminService;
    private final ObjectMapper objectMapper;

    @GetMapping("/list")
    public Result<List<Template>> list() {
        return Result.ok(service.listAll());
    }

    /** 拖拽重排:body.ids = 拖完后的完整有序模板 id 列表,服务端赋 sort=0..N。 */
    @PostMapping("/reorder")
    public Result<?> reorder(@RequestBody ReorderReq body, HttpServletRequest req) {
        service.reorder(body.getIds());
        log(req, "template_reorder", "n=" + (body.getIds() == null ? 0 : body.getIds().size()));
        return Result.ok(null, "排序已保存");
    }

    @PostMapping("/upsert")
    public Result<?> upsert(@RequestBody UpsertReq body, HttpServletRequest req) {
        if (body.getId() == null || body.getId().isBlank()) {
            throw new BizException(ErrorCode.INVALID_PARAM, "id 必填");
        }
        if (body.getDefinition() == null || body.getDefinition().isNull()) {
            throw new BizException(ErrorCode.INVALID_PARAM, "definition 必填");
        }
        Template t = new Template();
        t.setId(body.getId());
        t.setName(body.getName());
        t.setDescription(body.getDescription());
        t.setIcon(body.getIcon());
        t.setCategory(body.getCategory());
        t.setCoverUrl(body.getCoverUrl());
        t.setMinAppVersion(body.getMinAppVersion());
        t.setSort(body.getSort() == null ? 0 : body.getSort());
        t.setIsActive(body.getIsActive() == null ? 1 : body.getIsActive());
        try {
            t.setDefinition(objectMapper.writeValueAsString(body.getDefinition()));
        } catch (Exception e) {
            throw new BizException(ErrorCode.INVALID_PARAM, "definition 序列化失败");
        }
        service.upsert(t);
        log(req, "template_upsert", "id=" + t.getId());
        return Result.ok(null, "已保存");
    }

    @PutMapping("/{id}/meta")
    public Result<?> updateMeta(@PathVariable String id, @RequestBody MetaReq body, HttpServletRequest req) {
        service.updateMeta(id, body.getName(), body.getDescription(), body.getCategory(),
                body.getMinAppVersion(), body.getSort());
        log(req, "template_update_meta", "id=" + id);
        return Result.ok(null, "已保存");
    }

    @PostMapping("/{id}/activate")
    public Result<?> activate(@PathVariable String id, HttpServletRequest req) {
        service.setActive(id, true);
        log(req, "template_activate", "id=" + id);
        return Result.ok(null, "已上架");
    }

    @PostMapping("/{id}/deactivate")
    public Result<?> deactivate(@PathVariable String id, HttpServletRequest req) {
        service.setActive(id, false);
        log(req, "template_deactivate", "id=" + id);
        return Result.ok(null, "已下架");
    }

    @DeleteMapping("/{id}")
    public Result<?> delete(@PathVariable String id, HttpServletRequest req) {
        service.delete(id);
        log(req, "template_delete", "id=" + id);
        return Result.ok(null, "已删除");
    }

    private void log(HttpServletRequest req, String action, String detail) {
        Long adminId = (Long) req.getAttribute("userId");
        String adminName = (String) req.getAttribute("username");
        adminService.logOp(adminId, adminName, action, "template", null, detail, IpUtil.getClientIp(req));
    }

    @Data
    public static class MetaReq {
        private String name;
        private String description;
        private String category;
        private String minAppVersion;
        private Integer sort;
    }

    @Data
    public static class UpsertReq {
        private String id;
        private String name;
        private String description;
        private String icon;
        private String category;
        private String coverUrl;
        private String minAppVersion;
        private Integer sort;
        private Integer isActive;
        /** 整个 WorkflowTemplate JSON(图为极境 URL)。 */
        private JsonNode definition;
    }

    @Data
    public static class ReorderReq {
        private List<String> ids;
    }
}
