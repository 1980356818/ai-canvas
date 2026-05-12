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
    `before_expire_at` DATETIME    DEFAULT NULL,
    `after_expire_at`  DATETIME    NOT NULL,
    `created_at`       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='兑换日志';

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

INSERT IGNORE INTO `sys_config` (`config_key`, `config_val`, `remark`) VALUES
('unbind_limit_per_month', '1', '每月允许解绑次数'),
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
