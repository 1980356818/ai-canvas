package com.aicat.server.controller;

import com.aicat.server.common.Result;
import com.aicat.server.entity.TemplateCategory;
import com.aicat.server.service.TemplateCategoryService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 客户端拉模板分组列表。公开端点,无需 token（不在 /api/user|admin 拦截范围内）。
 *
 * 返回全部上架分组（按 sort）,桌面端用 key 分组、label 显示、sort 排序。
 */
@RestController
@RequiredArgsConstructor
public class TemplateCategoryController {

    private final TemplateCategoryService service;

    @GetMapping("/api/template-categories")
    public Result<List<TemplateCategory>> list() {
        return Result.ok(service.listActive());
    }
}
