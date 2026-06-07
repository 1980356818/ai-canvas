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
    /** 1=启用 0=停用 (停用版本客户端不可切换、不在列表里)。与 status 同步: stable=1, 其余=0 */
    private Integer isActive;

    /**
     * 发布生命周期: draft=已上传未发布 / stable=全量发布 / blocked=已召回。
     * 只有 stable 会下发给客户端; blocked 会让该版本用户在 check 时被强制升级。
     */
    private String status;

    private LocalDateTime pubDate;

    @TableLogic
    private Integer deleted;

    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}
