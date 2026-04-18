package com.aicat.server.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("unbind_log")
public class UnbindLog {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String oldMachineCode;
    private String newMachineCode;
    private String ip;
    private String operator;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
