package com.aicat.server.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("app_release")
public class AppRelease {
    @TableId(type = IdType.AUTO)
    private Long id;

    private String version;
    private Long versionCode;
    private String target;
    private String arch;
    private String fileName;
    private String filePath;
    private Long fileSize;
    private String signature;
    private String sha256;
    private String releaseNotes;
    private String minVersion;
    /** 1=启用 0=停用 (停用版本客户端不可切换、不在列表里) */
    private Integer isActive;
    private LocalDateTime pubDate;

    @TableLogic
    private Integer deleted;

    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}
