package com.aicat.server.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 模板定义。图在极境(definition 内的 URL 全是 https://ai.snoworangekeji.cn/uploads/...),
 * 定义在这张表。客户端 GET /api/templates 拉全部上架模板。
 *
 * id 用业务键(与 tier_def.features.templates 里的 ID 对齐,如 wf-white-bg),非自增。
 * created_at / updated_at 由 MySQL DEFAULT / ON UPDATE 自动维护(插入时字段为 null 被 MP 略过)。
 */
@Data
@TableName("template")
public class Template {

    @TableId(type = IdType.INPUT)
    private String id;

    private String name;
    private String description;
    private String icon;
    private String category;
    private String coverUrl;

    /** 整个 WorkflowTemplate JSON(卡片/连线/prompt,图均为极境 URL)。MySQL JSON 列 ↔ Java String。 */
    private String definition;

    /** 强制版本守卫:客户端版本 < 此值则不下发该模板(防新模板打挂老客户端)。 */
    private String minAppVersion;

    private Integer sort;
    private Integer isActive;

    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}
