package com.aicat.server.security;

import com.aicat.server.util.IpUtil;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Component
@RequiredArgsConstructor
public class RateLimitInterceptor implements HandlerInterceptor {

    private final ObjectMapper objectMapper;

    private record Bucket(int count, long windowStart) {}

    private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) return true;

        String ip = IpUtil.getClientIp(request);
        String path = request.getRequestURI();
        int limit;
        long windowMs;

        if (path.startsWith("/api/auth/login") || path.startsWith("/api/admin/login")) {
            limit = 5; windowMs = 5 * 60_000;
        } else if (path.startsWith("/api/auth/register")) {
            limit = 5; windowMs = 60 * 60_000;
        } else if (path.startsWith("/api/user/redeem")) {
            limit = 5; windowMs = 60_000;
        } else {
            limit = 200; windowMs = 60_000;
        }

        String pathSegment = path.split("/").length > 3 ? path.split("/")[2] + "/" + path.split("/")[3] : path.split("/")[2];
        String key = ip + ":" + pathSegment;
        long now = System.currentTimeMillis();

        Bucket b = buckets.compute(key, (k, old) -> {
            if (old == null || now - old.windowStart() > windowMs) {
                return new Bucket(1, now);
            }
            return new Bucket(old.count() + 1, old.windowStart());
        });

        if (b.count() > limit) {
            response.setStatus(429);
            response.setContentType("application/json;charset=UTF-8");
            objectMapper.writeValue(response.getWriter(), Map.of("code", 42900, "msg", "请求过于频繁，请稍后再试"));
            return false;
        }
        return true;
    }
}
