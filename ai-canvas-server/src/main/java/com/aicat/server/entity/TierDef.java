package com.aicat.server.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 会员等级定义。数据驱动：等级、rank、每级功能 features(JSON 字符串) 都存这。
 * features 由服务层用 Jackson 解析后下发给客户端做功能门禁。
 */
@Data
@TableName("tier_def")
public class TierDef {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String tierKey;
    private String name;
    private Integer tierRank;
    private Integer isOfficial;
    /** 能力清单 JSON 字符串，如 {"templates":["wf-tryon"],"allowBlank":false} */
    private String features;
    private Integer isActive;
    private Integer sort;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
