-- ─────────────────────────────────────────────────────────────
-- 会员等级体系迁移：试用 / VIP 分级 + 激活码携带等级 + 兑换只升不降
-- 在已有 aicat 库上执行一次。列已存在会报错，可忽略对应语句。
-- ─────────────────────────────────────────────────────────────
USE `aicat`;

-- 1) user 加 tier（当前会员等级，过期惰性清空）
ALTER TABLE `user`
  ADD COLUMN `tier` VARCHAR(32) DEFAULT NULL COMMENT '当前会员等级 tier_key，过期惰性清空' AFTER `member_expire_at`;

-- 存量"有未过期会员"的用户回填为 vip1（历史发的都是正式会员码）
UPDATE `user`
   SET `tier` = 'vip1'
 WHERE `tier` IS NULL
   AND `member_expire_at` IS NOT NULL
   AND `member_expire_at` > NOW();

-- 2) redeem_code 加 tier（该码激活成的等级）
ALTER TABLE `redeem_code`
  ADD COLUMN `tier` VARCHAR(32) NOT NULL DEFAULT 'vip1' COMMENT '该码激活成的等级 tier_key' AFTER `days`;
-- 存量未使用的码视为 vip1（DEFAULT 已处理新行，这里显式兜底历史行）
UPDATE `redeem_code` SET `tier` = 'vip1' WHERE `tier` IS NULL OR `tier` = '';

-- 3) redeem_log 记录兑换前后等级 + 动作
ALTER TABLE `redeem_log`
  ADD COLUMN `before_tier` VARCHAR(32) DEFAULT NULL COMMENT '兑换前等级' AFTER `days`,
  ADD COLUMN `after_tier`  VARCHAR(32) DEFAULT NULL COMMENT '兑换后等级' AFTER `before_tier`,
  ADD COLUMN `action`      VARCHAR(16) DEFAULT NULL COMMENT 'upgrade/renew' AFTER `after_tier`;

-- 4) 会员等级定义表 + 种子（数据驱动）
CREATE TABLE IF NOT EXISTS `tier_def` (
    `id`          BIGINT       NOT NULL AUTO_INCREMENT,
    `tier_key`    VARCHAR(32)  NOT NULL COMMENT '稳定标识 trial/vip1/vip2…',
    `name`        VARCHAR(32)  NOT NULL COMMENT '展示名',
    `tier_rank`   INT          NOT NULL COMMENT '有序等级，越大越高',
    `is_official` TINYINT      NOT NULL DEFAULT 0 COMMENT '1=正式版 0=试用',
    `features`    JSON         NOT NULL COMMENT '该级能力清单 JSON',
    `is_active`   TINYINT      NOT NULL DEFAULT 1 COMMENT '0=停用',
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
