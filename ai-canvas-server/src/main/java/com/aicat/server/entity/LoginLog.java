package com.aicat.server.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("login_log")
public class LoginLog {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String ip;
    private String device;
    private String result;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
