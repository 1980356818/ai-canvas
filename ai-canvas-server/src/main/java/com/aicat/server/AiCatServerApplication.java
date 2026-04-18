package com.aicat.server;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@EnableScheduling
@SpringBootApplication
public class AiCatServerApplication {
    public static void main(String[] args) {
        SpringApplication.run(AiCatServerApplication.class, args);
    }
}
