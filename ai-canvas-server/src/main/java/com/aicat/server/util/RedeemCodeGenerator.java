package com.aicat.server.util;

import java.security.SecureRandom;

public final class RedeemCodeGenerator {

    private static final char[] POOL = "ABCDEFGHJKMNPQRSTUVWXYZ23456789".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    private RedeemCodeGenerator() {}

    public static String generate() {
        StringBuilder sb = new StringBuilder("AICAT-");
        for (int i = 0; i < 12; i++) {
            if (i > 0 && i % 4 == 0) sb.append('-');
            sb.append(POOL[RANDOM.nextInt(POOL.length)]);
        }
        return sb.toString();
    }
}
