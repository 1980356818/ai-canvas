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
        long expire = restricted ? restrictedExpireMs : fullExpireMs;
        return Jwts.builder()
                .subject(String.valueOf(userId))
                .claim("username", username)
                .claim("restricted", restricted)
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
