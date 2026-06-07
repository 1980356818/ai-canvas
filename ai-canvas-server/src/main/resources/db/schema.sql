CREATE DATABASE IF NOT EXISTS `aicat` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `aicat`;

-- 1. 用户表
CREATE TABLE IF NOT EXISTS `user` (
    `id`               BIGINT       NOT NULL AUTO_INCREMENT,
    `username`         VARCHAR(32)  NOT NULL COMMENT '用户名',
    `password`         VARCHAR(128) NOT NULL COMMENT 'BCrypt 加密密码',
    `plain_password`   VARCHAR(64)  DEFAULT NULL COMMENT '明文密码(管理员可见)',
    `email`            VARCHAR(128) DEFAULT NULL COMMENT '邮箱（可选）',
    `member_expire_at` DATETIME     DEFAULT NULL COMMENT '会员到期时间',
    `tier`             VARCHAR(32)  DEFAULT NULL COMMENT '当前会员等级 tier_key，过期惰性清空',
    `status`           TINYINT      NOT NULL DEFAULT 1 COMMENT '1=正常 0=禁用',
    `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `token_version`    INT          NOT NULL DEFAULT 1 COMMENT '登录版本号，每次登录递增，用于踢掉旧设备',
    `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_username` (`username`),
    UNIQUE KEY `uk_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';

-- 2. 兑换码表
CREATE TABLE IF NOT EXISTS `redeem_code` (
    `id`            BIGINT       NOT NULL AUTO_INCREMENT,
    `code`          VARCHAR(32)  NOT NULL COMMENT '兑换码',
    `days`          INT          NOT NULL COMMENT '会员天数',
    `tier`          VARCHAR(32)  NOT NULL DEFAULT 'vip1' COMMENT '该码激活成的等级 tier_key',
    `status`        VARCHAR(16)  NOT NULL DEFAULT 'unused' COMMENT 'unused/used/disabled/expired',
    `used_by`       BIGINT       DEFAULT NULL COMMENT '使用者用户ID',
    `used_at`       DATETIME     DEFAULT NULL COMMENT '使用时间',
    `batch_no`      VARCHAR(32)  DEFAULT NULL COMMENT '批次号',
    `expire_at`     DATETIME     DEFAULT NULL COMMENT '兑换码有效期',
    `remark`        VARCHAR(256) DEFAULT NULL COMMENT '备注',
    `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_code` (`code`),
    KEY `idx_status` (`status`),
    KEY `idx_batch_no` (`batch_no`),
    KEY `idx_expire_at` (`expire_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='兑换码表';

-- 3. 兑换日志
CREATE TABLE IF NOT EXISTS `redeem_log` (
    `id`               BIGINT      NOT NULL AUTO_INCREMENT,
    `user_id`          BIGINT      NOT NULL,
    `redeem_code_id`   BIGINT      NOT NULL,
    `code`             VARCHAR(32) NOT NULL,
    `days`             INT         NOT NULL,
    `before_tier`      VARCHAR(32) DEFAULT NULL COMMENT '兑换前等级',
    `after_tier`       VARCHAR(32) DEFAULT NULL COMMENT '兑换后等级',
    `action`           VARCHAR(16) DEFAULT NULL COMMENT 'upgrade/renew',
    `before_expire_at` DATETIME    DEFAULT NULL,
    `after_expire_at`  DATETIME    NOT NULL,
    `created_at`       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='兑换日志';

-- 3.5 会员等级定义表（数据驱动：等级、rank、每级功能 features 都在这）
CREATE TABLE IF NOT EXISTS `tier_def` (
    `id`          BIGINT       NOT NULL AUTO_INCREMENT,
    `tier_key`    VARCHAR(32)  NOT NULL COMMENT '稳定标识 trial/vip1/vip2…，激活码与用户都引用它',
    `name`        VARCHAR(32)  NOT NULL COMMENT '展示名 试用版/VIP1',
    `tier_rank`   INT          NOT NULL COMMENT '有序等级，越大越高（避开 MySQL 保留字 rank）',
    `is_official` TINYINT      NOT NULL DEFAULT 0 COMMENT '1=正式版 0=试用',
    `features`    JSON         NOT NULL COMMENT '该级能力清单 JSON，见客户端 entitlements',
    `is_active`   TINYINT      NOT NULL DEFAULT 1 COMMENT '0=停用，后台不可选/不下发',
    `sort`        INT          NOT NULL DEFAULT 0,
    `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_tier_key` (`tier_key`),
    KEY `idx_tier_rank` (`tier_rank`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会员等级定义';

INSERT IGNORE INTO `tier_def` (tier_key,name,tier_rank,is_official,features,sort) VALUES
('trial','试用版', 0, 0, '{"templates":["wf-white-bg","wf-tryon"],"allowBlank":false,"allowImport":false,"maxProjects":2}', 0),
('vip1', 'VIP1',   10,1, '{"templates":"*","allowBlank":true,"allowImport":true}', 1),
('vip2', 'VIP2',   20,1, '{"templates":"*","allowBlank":true,"allowImport":true}', 2),
('vip3', 'VIP3',   30,1, '{"templates":"*","allowBlank":true,"allowImport":true}', 3);

-- 4. 管理员表
CREATE TABLE IF NOT EXISTS `admin` (
    `id`               BIGINT       NOT NULL AUTO_INCREMENT,
    `username`         VARCHAR(32)  NOT NULL,
    `password`         VARCHAR(128) NOT NULL,
    `role`             VARCHAR(16)  NOT NULL DEFAULT 'admin',
    `force_pwd_change` TINYINT      NOT NULL DEFAULT 1 COMMENT '是否需要强制改密码',
    `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员表';

-- 5. 用户设备绑定表
CREATE TABLE IF NOT EXISTS `user_device` (
    `id`            BIGINT       NOT NULL AUTO_INCREMENT,
    `user_id`       BIGINT       NOT NULL,
    `machine_code`  VARCHAR(64)  NOT NULL COMMENT '机器码 SHA-256',
    `device_info`   VARCHAR(256) DEFAULT NULL,
    `bound_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `bound_ip`      VARCHAR(64)  DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_user_id` (`user_id`),
    KEY `idx_machine_code` (`machine_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='设备绑定';

-- 6. 解绑日志
CREATE TABLE IF NOT EXISTS `unbind_log` (
    `id`               BIGINT       NOT NULL AUTO_INCREMENT,
    `user_id`          BIGINT       NOT NULL,
    `old_machine_code` VARCHAR(64)  NOT NULL,
    `new_machine_code` VARCHAR(64)  NOT NULL,
    `ip`               VARCHAR(64)  DEFAULT NULL,
    `operator`         VARCHAR(16)  NOT NULL DEFAULT 'user',
    `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='解绑日志';

-- 7. 系统配置
CREATE TABLE IF NOT EXISTS `sys_config` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT,
    `config_key` VARCHAR(64)  NOT NULL,
    `config_val` VARCHAR(256) NOT NULL,
    `remark`     VARCHAR(256) DEFAULT NULL,
    `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_key` (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统配置';

-- 旧库迁移：解绑限额由「每月」改为「每年」，重命名已有配置键并保留管理员可能改过的值。
-- UPDATE IGNORE 在新键已存在时安全跳过，重复执行无副作用。
UPDATE IGNORE `sys_config` SET `config_key` = 'unbind_limit_per_year', `remark` = '每年允许解绑次数'
    WHERE `config_key` = 'unbind_limit_per_month';

INSERT IGNORE INTO `sys_config` (`config_key`, `config_val`, `remark`) VALUES
('unbind_limit_per_year', '1', '每年允许解绑次数'),
('unbind_cooldown_days', '0', '两次解绑最短间隔天数');

-- 8. 登录日志
CREATE TABLE IF NOT EXISTS `login_log` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT,
    `user_id`    BIGINT       NOT NULL,
    `ip`         VARCHAR(64)  DEFAULT NULL,
    `device`     VARCHAR(256) DEFAULT NULL,
    `result`     VARCHAR(16)  NOT NULL,
    `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='登录日志';

-- 9. 管理员操作日志
CREATE TABLE IF NOT EXISTS `admin_operation_log` (
    `id`          BIGINT       NOT NULL AUTO_INCREMENT,
    `admin_id`    BIGINT       NOT NULL,
    `admin_name`  VARCHAR(32)  NOT NULL,
    `action`      VARCHAR(64)  NOT NULL,
    `target_type` VARCHAR(32)  DEFAULT NULL,
    `target_id`   BIGINT       DEFAULT NULL,
    `detail`      TEXT         DEFAULT NULL,
    `ip`          VARCHAR(64)  DEFAULT NULL,
    `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_admin_id` (`admin_id`),
    KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员操作日志';

-- 10. 客户端发布版本（自动更新 / 版本切换）
-- target ∈ windows/darwin/linux，arch ∈ x86_64/aarch64
-- is_active=0 表示停用，客户端列表里不会出现也不可切换
-- min_version 用作强制升级阈值（客户端版本 < min_version 时不允许 skip）
CREATE TABLE IF NOT EXISTS `app_release` (
    `id`            BIGINT       NOT NULL AUTO_INCREMENT,
    `version`       VARCHAR(32)  NOT NULL COMMENT '语义版本号',
    `version_code`  BIGINT       NOT NULL COMMENT 'major*1e6+minor*1e3+patch 用于排序',
    `target`        VARCHAR(16)  NOT NULL,
    `arch`          VARCHAR(16)  NOT NULL,
    `file_name`     VARCHAR(256) NOT NULL,
    `file_path`     VARCHAR(512) NOT NULL COMMENT '服务器磁盘相对路径',
    `file_size`     BIGINT       NOT NULL,
    `signature`     TEXT         NOT NULL COMMENT 'Tauri minisign 签名',
    `sha256`        VARCHAR(64)  NOT NULL,
    `release_notes` TEXT         DEFAULT NULL,
    `min_version`   VARCHAR(32)  DEFAULT NULL COMMENT '强制升级阈值',
    `is_active`     TINYINT      NOT NULL DEFAULT 1 COMMENT '1=启用 0=停用',
    `pub_date`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `deleted`       TINYINT      NOT NULL DEFAULT 0,
    `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_ver_target_arch` (`version`, `target`, `arch`, `deleted`),
    KEY `idx_active_target_arch` (`is_active`, `target`, `arch`, `version_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='应用发布版本';

-- 11. 模板定义（服务端驱动:图在极境,定义在这）
-- id 用业务键（与 tier_def.features.templates 里的 ID 对齐,如 wf-white-bg）,非自增
-- definition 存整个 WorkflowTemplate JSON（卡片/连线/prompt,图均为极境 https URL）
-- min_app_version：客户端版本 < 它则不下发该模板（防新 card type 打挂老客户端）
-- is_active=0 = 下架（客户端列表里不出现）;模板由种子脚本/admin 接口写入,不在此 seed
CREATE TABLE IF NOT EXISTS `template` (
    `id`              VARCHAR(64)  NOT NULL COMMENT '业务ID,对齐 features.templates,如 wf-white-bg',
    `name`            VARCHAR(64)  NOT NULL,
    `description`     VARCHAR(255) DEFAULT NULL,
    `icon`            VARCHAR(32)  DEFAULT NULL COMMENT 'lucide 图标名',
    `category`        VARCHAR(16)  DEFAULT NULL COMMENT 'chat/image/composite',
    `cover_url`       VARCHAR(512) DEFAULT NULL COMMENT '封面图极境 URL',
    `definition`      JSON         NOT NULL COMMENT '整个 WorkflowTemplate JSON(图为极境 URL)',
    `min_app_version` VARCHAR(32)  DEFAULT NULL COMMENT '低于此版本的客户端不下发',
    `sort`            INT          NOT NULL DEFAULT 0 COMMENT '越小越靠前',
    `is_active`       TINYINT      NOT NULL DEFAULT 1 COMMENT '1=上架 0=下架',
    `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_active_sort` (`is_active`, `sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模板定义';

-- 12. 模板分组（注册表：组名 / 顺序 / 上下架 云端可配）
-- cat_key = 稳定 slug（对齐 template.category 列 与 前端 TemplateCategory.key）；
--   列名用 cat_key 是为避开 MySQL 保留字 key，Java/JSON 字段仍是 key，前端契约不变。
-- 客户端 GET /api/template-categories 拉 is_active=1 按 sort；新增/改名/排序/上下架走 admin。
CREATE TABLE IF NOT EXISTS `template_category` (
    `cat_key`         VARCHAR(32)  NOT NULL COMMENT '稳定 slug，对齐 template.category',
    `label`           VARCHAR(32)  NOT NULL COMMENT '展示名',
    `sort`            INT          NOT NULL DEFAULT 0 COMMENT '越小越靠前',
    `min_app_version` VARCHAR(32)  DEFAULT NULL COMMENT '低于此版本的客户端不下发（预留）',
    `is_active`       TINYINT      NOT NULL DEFAULT 1 COMMENT '1=启用 0=停用',
    `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`cat_key`),
    KEY `idx_active_sort` (`is_active`, `sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模板分组';

-- 初始 5 个分组（对齐原硬编码 4 个 + 新增「数字人融合模板」排最后）。INSERT IGNORE 幂等。
INSERT IGNORE INTO `template_category` (cat_key,label,sort) VALUES
('flat',          '平面模板',     0),
('video',         '视频模板',     1),
('detail',        '详情页模板',   2),
('trial',         '试用版模板',   3),
('digital-human', '数字人融合模板', 4);
