package com.aicat.server.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("redeem_log")
public class RedeemLog {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long redeemCodeId;
    private String code;
    private Integer days;
    private LocalDateTime beforeExpireAt;
    private LocalDateTime afterExpireAt;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
