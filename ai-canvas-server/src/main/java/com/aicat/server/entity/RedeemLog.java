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
    /** 兑换前等级 */
    private String beforeTier;
    /** 兑换后等级 */
    private String afterTier;
    /** upgrade=升级覆盖 / renew=同级续费 */
    private String action;
    private LocalDateTime beforeExpireAt;
    private LocalDateTime afterExpireAt;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
