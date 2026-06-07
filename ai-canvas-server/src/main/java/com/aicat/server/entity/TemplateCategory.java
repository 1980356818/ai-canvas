package com.aicat.server.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 模板分组（注册表）。组名/顺序/上下架云端可配,客户端 GET /api/template-categories 拉 active。
 *
 * 稳定 slug,对齐 {@code template.category} 列 与 前端 TemplateCategory.key。
 * Java 字段叫 {@code catKey}、列 {@code cat_key}（走默认驼峰↔下划线映射,避开 MySQL 保留字 key,
 * 且不依赖 @TableId(value) 显式列名——实测该版本 MP 会忽略它而用字段名导致 `key` 语法错误）;
 * JSON 经 {@code @JsonProperty("key")} 仍是 {@code key},前端/后台契约不变。
 */
@Data
@TableName("template_category")
public class TemplateCategory {

    @JsonProperty("key")
    @TableId(type = IdType.INPUT)
    private String catKey;

    private String label;
    private Integer sort;
    private Integer isActive;

    /** 强制版本守卫（预留）：客户端版本 < 此值则不下发该分组。 */
    private String minAppVersion;

    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}
