package com.aicat.server.security;

import com.aicat.server.util.JwtUtil;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.io.IOException;
import java.util.Map;
import java.util.Set;

@Component
@RequiredArgsConstructor
public class JwtAuthInterceptor implements HandlerInterceptor {

    private final JwtUtil jwtUtil;
    private final ObjectMapper objectMapper;

    private static final Set<String> RESTRICTED_ALLOWED = Set.of(
            "/api/user/redeem",
            "/api/user/status",
            "/api/user/redeem-logs",
            "/api/user/device-info",
            "/api/user/unbind-device"
    );

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) return true;

        String auth = request.getHeader("Authorization");
        if (auth == null || !auth.startsWith("Bearer ")) {
            reject(response, 40102, "Token 无效或已过期");
            return false;
        }

        Claims claims = jwtUtil.parse(auth.substring(7));
        if (claims == null) {
            reject(response, 40102, "Token 无效或已过期");
            return false;
        }

        boolean isAdmin = Boolean.TRUE.equals(claims.get("admin", Boolean.class));
        boolean restricted = Boolean.TRUE.equals(claims.get("restricted", Boolean.class));
        String path = request.getRequestURI();

        if (!isAdmin && restricted && !RESTRICTED_ALLOWED.contains(path)) {
            reject(response, 40301, "会员未激活，请先兑换会员码");
            return false;
        }

        request.setAttribute("userId", Long.parseLong(claims.getSubject()));
        request.setAttribute("username", claims.get("username", String.class));
        request.setAttribute("restricted", restricted);
        request.setAttribute("isAdmin", isAdmin);
        if (isAdmin) {
            request.setAttribute("adminRole", claims.get("role", String.class));
        }
        return true;
    }

    private void reject(HttpServletResponse response, int code, String msg) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json;charset=UTF-8");
        objectMapper.writeValue(response.getWriter(), Map.of("code", code, "msg", msg));
    }
}
