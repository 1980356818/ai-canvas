-- ============================================================
-- P1 发布生命周期 / 版本管控 (2026-06-07)
-- 目的: 把"上传即全量"改成 draft -> (promote) -> stable; 增加 blocked 召回。
--
-- 部署顺序 (零停机, 且当前 1.3.3 强更不中断):
--   1) 先在 prod 跑本迁移 —— 旧 jar 不认 status 列, 仍按 is_active 工作, 照常下发;
--   2) 回填把当前 is_active=1 的版本标为 stable (= 现在线上的 1.2.x/1.3.3);
--   3) 再部署新 jar —— 新 jar 以 status='stable' 为下发准绳。
--
-- 注意: MySQL 8 不支持 ADD COLUMN IF NOT EXISTS, 本文件只跑一次。
-- ============================================================

ALTER TABLE app_release
  ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'draft'
  COMMENT 'draft=已上传未发布, stable=全量发布, blocked=已召回' AFTER is_active;

-- 回填: 当前 is_active=1 的就是线上版本 -> stable(保住当前 1.3.3 强更不中断)
UPDATE app_release SET status = 'stable' WHERE is_active = 1 AND deleted = 0;
UPDATE app_release SET status = 'draft'  WHERE is_active = 0 AND deleted = 0;

-- 服务端取"最新 stable"用的索引
CREATE INDEX idx_status_target_arch_code
  ON app_release (status, target, arch, version_code);
