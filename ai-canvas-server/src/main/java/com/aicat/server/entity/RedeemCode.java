package com.aicat.server.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("redeem_code")
public class RedeemCode {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String code;
    private Integer days;
    private String status;
    private Long usedBy;
    private LocalDateTime usedAt;
    private String batchNo;
    private LocalDateTime expireAt;
    private String remark;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
