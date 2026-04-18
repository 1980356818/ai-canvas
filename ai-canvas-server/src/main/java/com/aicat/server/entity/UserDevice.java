package com.aicat.server.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("user_device")
public class UserDevice {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String machineCode;
    private String deviceInfo;
    private LocalDateTime boundAt;
    private String boundIp;
}
