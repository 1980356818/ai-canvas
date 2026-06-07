package com.aicat.server.controller;

import com.aicat.server.common.Result;
import com.aicat.server.service.TemplateService;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 客户端拉模板列表。公开端点,无需 token(不在 /api/user|admin 拦截范围内)。
 *
 * 返回每个模板的整个 WorkflowTemplate JSON(图为极境 URL),桌面端直接当
 * WORKFLOW_TEMPLATES 用。`appVersion` 可选,服务端按 min_app_version 做版本守卫。
 */
@RestController
@RequiredArgsConstructor
public class TemplateController {

    private final TemplateService service;

    @GetMapping("/api/templates")
    public Result<List<JsonNode>> list(@RequestParam(required = false) String appVersion) {
        return Result.ok(service.listForClient(appVersion));
    }
}
