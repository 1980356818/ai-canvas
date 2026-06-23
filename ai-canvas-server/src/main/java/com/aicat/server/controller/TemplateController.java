package com.aicat.server.controller;

import com.aicat.server.common.Result;
import com.aicat.server.service.TemplateService;
import com.aicat.server.util.JwtUtil;
import com.fasterxml.jackson.databind.JsonNode;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 客户端拉模板列表。公开端点,无需 token(不在 /api/user|admin 拦截范围内)。
 *
 * 有 token 时按用户等级的 templateCategories 过滤(只下发有权分类);
 * 无 token / 解析失败 → 全量下发(向后兼容)。
 */
@RestController
@RequiredArgsConstructor
public class TemplateController {

    private final TemplateService service;
    private final JwtUtil jwtUtil;

    @GetMapping("/api/templates")
    public Result<List<JsonNode>> list(@RequestParam(required = false) String appVersion,
                                       HttpServletRequest request) {
        String tier = extractTier(request);
        return Result.ok(service.listForClient(appVersion, tier));
    }

    private String extractTier(HttpServletRequest request) {
        String auth = request.getHeader("Authorization");
        if (auth == null || !auth.startsWith("Bearer ")) return null;
        Claims claims = jwtUtil.parse(auth.substring(7));
        if (claims == null) return null;
        Object tier = claims.get("tier");
        return tier != null ? tier.toString() : null;
    }
}
