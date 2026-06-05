package com.aicat.server.util;

import io.jsonwebtoken.*;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.Date;

@Component
public class JwtUtil {

    private final SecretKey key;
    private final long fullExpireMs;
    private final long restrictedExpireMs;

    public JwtUtil(
            @Value("${aicat.jwt.secret}") String secret,
            @Value("${aicat.jwt.full-expire-hours}") long fullHours,
            @Value("${aicat.jwt.restricted-expire-hours}") long restrictedHours) {
        this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.fullExpireMs = fullHours * 3600_000;
        this.restrictedExpireMs = restrictedHours * 3600_000;
    }

    public String generate(Long userId, String username, boolean restricted) {
        return generate(userId, username, restricted, 1);
    }

    public String generate(Long userId, String username, boolean restricted, int tokenVersion) {
        return generate(userId, username, restricted, tokenVersion, null);
    }

    /** tier 签进 JWT，客户端无法本地篡改 localStorage 用户对象来伪造等级。restricted 时 tier 一般为 null。 */
    public String generate(Long userId, String username, boolean restricted, int tokenVersion, String tier) {
        long expire = restricted ? restrictedExpireMs : fullExpireMs;
        JwtBuilder builder = Jwts.builder()
                .subject(String.valueOf(userId))
                .claim("username", username)
                .claim("restricted", restricted)
                .claim("tv", tokenVersion);
        if (tier != null) builder.claim("tier", tier);
        return builder
                .issuedAt(new Date())
                .expiration(new Date(System.currentTimeMillis() + expire))
                .signWith(key)
                .compact();
    }

    public String generateAdmin(Long adminId, String username, String role) {
        return Jwts.builder()
                .subject(String.valueOf(adminId))
                .claim("username", username)
                .claim("role", role)
                .claim("admin", true)
                .issuedAt(new Date())
                .expiration(new Date(System.currentTimeMillis() + 8 * 3600_000))
                .signWith(key)
                .compact();
    }

    public Claims parse(String token) {
        try {
            return Jwts.parser().verifyWith(key).build()
                    .parseSignedClaims(token).getPayload();
        } catch (JwtException | IllegalArgumentException e) {
            return null;
        }
    }
}
