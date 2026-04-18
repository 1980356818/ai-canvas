# AI猫 — 会员 & 兑换码系统设计

> 版本 v1.0 · 2026-04-18

---

## 1. 项目总览

| 子项目 | 目录 | 技术栈 | 说明 |
|---|---|---|---|
| 客户端 | `ai-canvas/` | React + Tauri | 已有，桌面应用 |
| 后端服务 | `ai-canvas-server/` | Java 17 + Spring Boot 3 + MyBatis-Plus + MySQL 8 | 新建 |
| 管理后台 | `ai-canvas-admin/` | HTML + Vue 3 CDN + Element Plus CDN | 新建，轻量单页 |

---

## 2. 核心功能模块

### 2.1 用户注册 & 登录

#### 注册

| 字段 | 规则 |
|---|---|
| 用户名 | 4-20 位字母/数字/下划线，唯一 |
| 密码 | 6-32 位，BCrypt 加密存储 |
| 邮箱（可选） | 格式校验，唯一，预留字段，后续可用于通知或找回密码 |

- 注册成功后自动登录，返回受限 JWT Token（需兑换激活后才能使用完整功能）
- 新注册用户无会员时长，需通过兑换码获取
- 同一 IP 每小时最多注册 5 个账号（防刷）

#### 登录

| 步骤 | 描述 |
|---|---|
| 1. 验证身份 | 用户名 + 密码校验 |
| 2. 检查会员状态 | 判断会员是否有效 |
| 3. 签发令牌 | 有效 → 完整 Token；无效 → 受限 Token（仅可兑换和查看状态） |
| 4. 记录登录日志 | 写入 IP、设备信息、登录时间、结果 |

#### 会员状态分类与登录行为

| 状态 | 判断条件 | 登录行为 | 返回内容 |
|---|---|---|---|
| 正常会员 | `member_expire_at > NOW()` | 正常登录 | 完整 Token + 用户信息 |
| 未激活 | `member_expire_at IS NULL` | 登录成功但进入受限状态 | 受限 Token + `status: "inactive"` |
| 已过期 | `member_expire_at < NOW()` | 登录成功但进入受限状态 | 受限 Token + `status: "expired"` |
| 账号禁用 | `status = 0` | 拒绝登录 | 错误码 `40302` |
| 密码错误 | — | 拒绝登录 | 错误码 `40101` |

**受限 Token 机制**：

受限 Token 在 JWT payload 中包含 `"restricted": true` 标记，后端拦截器对该标记的 Token **仅放行以下接口**：
- `POST /api/user/redeem` — 兑换码兑换
- `GET /api/user/status` — 查看会员状态
- `GET /api/user/redeem-logs` — 兑换记录
- `GET /api/user/device-info` — 查看设备绑定信息
- `POST /api/user/unbind-device` — 解绑设备

其余所有业务接口返回 `403 MEMBERSHIP_REQUIRED`。

```
登录流程：
                    用户名 + 密码
                         │
                         ▼
                   密码校验通过？
                  ┌──NO──┤──YES──┐
                  ▼               ▼
            返回密码错误      账号是否禁用？
                          ┌──YES──┤──NO──┐
                          ▼               ▼
                    返回账号禁用      会员是否有效？
                                  ┌──YES──┤──NO──┐
                                  ▼               ▼
                            签发完整Token    签发受限Token
                            进入主界面       进入兑换/激活页
```

#### 使用中途会员过期策略

| 场景 | 处理方式 |
|---|---|
| 到期前 1 小时 | 客户端弹窗提醒"会员即将到期，请及时续费" |
| 到期后 5 分钟内（宽限期） | 允许保存当前工作，禁止新建/生成等操作 |
| 宽限期结束 | 自动跳转到兑换续费页面 |

客户端通过 `/api/user/status` 接口定时校验（建议间隔 5 分钟），获取 `memberExpireAt` 与服务器时间做对比。

#### 设备限制策略（方案 C：机器码绑定 + 限次解绑 + IP 辅助监控）

##### 机器码采集

客户端启动时采集以下硬件信息，拼接后做 SHA-256 哈希生成机器码：

```
机器码 = SHA-256(CPU_ID + 主硬盘序列号 + 主板序列号)
```

> Tauri 中通过 Rust 调用系统 API 采集，不依赖第三方库。仅采集不可变硬件信息，不采集 MAC 地址（虚拟网卡会变）。

##### 绑定与登录流程

```
用户登录（用户名 + 密码 + 机器码）
    │
    ▼
密码校验通过
    │
    ▼
检查机器码绑定状态
    ├── 账号未绑定任何机器码（新用户/已解绑）
    │   └── 自动绑定当前机器码 → 正常登录
    │
    ├── 账号已绑定 且 机器码匹配
    │   └── 正常登录
    │
    └── 账号已绑定 但 机器码不匹配
        └── 拒绝登录，返回 DEVICE_MISMATCH
            客户端提示：「当前设备与绑定设备不同」
            ├── [解绑并绑定新设备]（本月剩余 N 次）
            └── [取消]
```

##### 解绑规则

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `unbind_limit_per_month` | 每月允许解绑次数 | 1 次 |
| `unbind_cooldown_days` | 两次解绑之间的最短间隔天数 | 0（不额外限制） |

> 以上参数在管理后台「系统配置」中动态设置，修改后即时生效，无需重启服务。

##### 解绑流程

```
用户点击「解绑并绑定新设备」
    │
    ▼
服务端校验
    ├── 本月解绑次数 < unbind_limit_per_month？
    │   ├── 否 → 返回「本月解绑次数已用完，请下月再试」
    │   └── 是 ↓
    ├── 距上次解绑 >= unbind_cooldown_days？
    │   ├── 否 → 返回「解绑操作过于频繁，请 N 天后再试」
    │   └── 是 ↓
    ▼
执行解绑
    ├── 清除旧机器码绑定
    ├── 绑定新机器码
    ├── 解绑次数 +1
    ├── 写入解绑日志（含旧机器码、新机器码、IP）
    └── 返回成功，签发新 Token
```

##### IP 辅助监控（仅记录，不阻断）

| 检测项 | 处理 |
|---|---|
| IP 与上次一致 | 正常 |
| IP 变了但同城市 | 正常（记录日志） |
| IP 变了且跨省/跨国 | 标记告警，管理后台高亮（不封禁） |
| 同一账号 24h 内出现 ≥ 3 个不同城市的 IP | 标记为「疑似共享」，管理后台重点关注 |

> IP 地理位置解析使用离线库（如 ip2region），不依赖外部服务。

##### 管理后台 — 设备管理操作

| 操作 | 说明 |
|---|---|
| 查看用户绑定设备 | 显示机器码（脱敏）、绑定时间 |
| 强制解绑 | 管理员可以帮用户解绑，不受次数限制 |
| 调整解绑次数 | 修改全局 `unbind_limit_per_month` 参数 |
| 查看解绑日志 | 谁解绑的、什么时候、旧机器码 → 新机器码 |
| IP 异常看板 | 查看被标记「疑似共享」的账号列表 |

---

### 2.2 兑换码系统

#### 2.2.1 兑换码规则

| 属性 | 说明 |
|---|---|
| 格式 | `AICAT-XXXX-XXXX-XXXX`（16 位大写字母+数字，分组显示） |
| 唯一性 | 数据库 UNIQUE 索引 |
| 状态 | `unused`（未使用）/ `used`（已使用）/ `disabled`（禁用）/ `expired`（已过期） |
| 会员时长 | 创建时指定，单位为天数（支持自定义任意天数） |
| 有效期 | 兑换码自身的使用期限，默认生成后 180 天内有效，超期自动失效 |
| 备注 | 管理员填写，标记用途/分发渠道（如"淘宝客户A-100张30天卡"） |

#### 2.2.2 预设时长模板

| 标签 | 天数 | 备注 |
|---|---|---|
| 1 天体验 | 1 | 试用场景 |
| 3 天体验 | 3 | 短期推广 |
| 7 天周卡 | 7 | 常用 |
| 30 天月卡 | 30 | 主力产品 |
| 90 天季卡 | 90 | 优惠套餐 |
| 365 天年卡 | 365 | 高级套餐 |
| 自定义 | N | 管理员输入任意天数 |

#### 2.2.3 兑换流程

```
用户输入兑换码
    │
    ▼
后端校验兑换码
    ├── 不存在 → 返回「兑换码无效」
    ├── 已使用 → 返回「兑换码已被使用」
    ├── 已禁用 → 返回「兑换码已失效」
    ├── 已过期（超过兑换码有效期）→ 返回「兑换码已过期」
    └── 有效 ──┐
               ▼
        计算新的到期时间
        ├── 当前已过期 → expire = NOW() + days
        └── 当前未过期 → expire = memberExpireAt + days （叠加）
               │
               ▼
        更新用户 member_expire_at
        标记兑换码为 used，记录使用者和时间
               │
               ▼
        返回「兑换成功，会员有效期至 YYYY-MM-DD HH:mm」
```

**关键细节**：
- 会员时长**可叠加**，多次兑换的天数会累加到现有到期时间上
- 兑换操作需要加**分布式锁**（或数据库行锁），防止同一兑换码被并发使用
- 兑换成功后写入 `redeem_log` 日志表

---

### 2.3 管理后台功能

#### 2.3.1 登录

- 管理员独立账号体系（`admin` 表），与用户表隔离
- 首次启动时自动创建超级管理员 `admin`，密码随机生成并打印到控制台日志（不使用固定默认密码）
- 管理员首次登录后强制修改密码

#### 2.3.2 用户管理

| 操作 | 说明 |
|---|---|
| 用户列表 | 分页查看，搜索（用户名/邮箱） |
| 查看详情 | 注册时间、会员到期时间、兑换记录 |
| 调整会员时间 | 手动增加/减少天数，或设置具体到期时间 |
| 禁用/启用用户 | 封号/解封 |

#### 2.3.3 兑换码管理

| 操作 | 说明 |
|---|---|
| 批量生成 | 输入数量（1-1000）+ 选择时长 + 有效期天数（默认180天）+ 备注 → 一键生成 |
| 兑换码列表 | 分页查看，按状态/时长/批次/备注筛选 |
| 导出 | 一键复制或导出为 TXT/CSV |
| 禁用 | 对未使用的兑换码进行禁用 |
| 查看使用记录 | 谁用的、什么时候用的 |
| 编辑备注 | 修改兑换码的备注信息（便于运营追踪渠道） |

#### 2.3.4 数据统计（仪表盘）

| 指标 | 说明 |
|---|---|
| 总用户数 | 注册用户总量 |
| 活跃会员数 | 会员未过期的用户 |
| 今日新增用户 | 今日注册量 |
| 即将过期会员 | 7 天内会员到期的用户数 |
| 兑换码概览 | 总量 / 已使用 / 未使用 / 已禁用 / 已过期 |
| 今日/本周/本月兑换量 | 兑换趋势折线图 |
| 各时长使用率 | 各天数类型兑换码的已用/总量占比（饼图） |
| 渠道兑换统计 | 按备注（渠道）分组的兑换量（了解哪个渠道转化最好） |

---

## 3. 数据库设计

### 3.1 用户表 `user`

```sql
CREATE TABLE `user` (
    `id`               BIGINT       NOT NULL AUTO_INCREMENT,
    `username`         VARCHAR(32)  NOT NULL COMMENT '用户名',
    `password`         VARCHAR(128) NOT NULL COMMENT 'BCrypt 加密密码',
    `email`            VARCHAR(128) DEFAULT NULL COMMENT '邮箱（可选）',
    `member_expire_at` DATETIME     DEFAULT NULL COMMENT '会员到期时间，NULL 表示从未获得会员',
    `status`           TINYINT      NOT NULL DEFAULT 1 COMMENT '状态: 1=正常, 0=禁用',
    `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_username` (`username`),
    UNIQUE KEY `uk_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';
```

### 3.2 兑换码表 `redeem_code`

```sql
CREATE TABLE `redeem_code` (
    `id`            BIGINT       NOT NULL AUTO_INCREMENT,
    `code`          VARCHAR(32)  NOT NULL COMMENT '兑换码（AICAT-XXXX-XXXX-XXXX）',
    `days`          INT          NOT NULL COMMENT '会员天数',
    `status`        VARCHAR(16)  NOT NULL DEFAULT 'unused' COMMENT 'unused/used/disabled/expired',
    `used_by`       BIGINT       DEFAULT NULL COMMENT '使用者用户ID',
    `used_at`       DATETIME     DEFAULT NULL COMMENT '使用时间',
    `batch_no`      VARCHAR(32)  DEFAULT NULL COMMENT '批次号，同一批生成的同一个批次',
    `expire_at`     DATETIME     DEFAULT NULL COMMENT '兑换码有效期（超过此时间未使用则自动失效）',
    `remark`        VARCHAR(256) DEFAULT NULL COMMENT '备注（分发渠道/用途）',
    `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_code` (`code`),
    KEY `idx_status` (`status`),
    KEY `idx_batch_no` (`batch_no`),
    KEY `idx_expire_at` (`expire_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='兑换码表';
```

### 3.3 兑换日志表 `redeem_log`

```sql
CREATE TABLE `redeem_log` (
    `id`                  BIGINT      NOT NULL AUTO_INCREMENT,
    `user_id`             BIGINT      NOT NULL COMMENT '用户ID',
    `redeem_code_id`      BIGINT      NOT NULL COMMENT '兑换码ID',
    `code`                VARCHAR(32) NOT NULL COMMENT '兑换码（冗余方便查询）',
    `days`                INT         NOT NULL COMMENT '兑换天数',
    `before_expire_at`    DATETIME    DEFAULT NULL COMMENT '兑换前到期时间',
    `after_expire_at`     DATETIME    NOT NULL COMMENT '兑换后到期时间',
    `created_at`          DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='兑换日志';
```

### 3.4 管理员表 `admin`

```sql
CREATE TABLE `admin` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT,
    `username`   VARCHAR(32)  NOT NULL,
    `password`   VARCHAR(128) NOT NULL COMMENT 'BCrypt 加密',
    `role`       VARCHAR(16)  NOT NULL DEFAULT 'admin' COMMENT 'super_admin/admin',
    `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员表';
```

### 3.5 用户设备绑定表 `user_device`

```sql
CREATE TABLE `user_device` (
    `id`              BIGINT       NOT NULL AUTO_INCREMENT,
    `user_id`         BIGINT       NOT NULL COMMENT '用户ID',
    `machine_code`    VARCHAR(64)  NOT NULL COMMENT '机器码（SHA-256 哈希）',
    `device_info`     VARCHAR(256) DEFAULT NULL COMMENT '设备描述信息（OS、主机名等，仅展示用）',
    `bound_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '绑定时间',
    `bound_ip`        VARCHAR(64)  DEFAULT NULL COMMENT '绑定时的 IP',
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_user_id` (`user_id`),
    KEY `idx_machine_code` (`machine_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户设备绑定（一人一机）';
```

### 3.6 解绑日志表 `unbind_log`

```sql
CREATE TABLE `unbind_log` (
    `id`                BIGINT       NOT NULL AUTO_INCREMENT,
    `user_id`           BIGINT       NOT NULL COMMENT '用户ID',
    `old_machine_code`  VARCHAR(64)  NOT NULL COMMENT '旧机器码',
    `new_machine_code`  VARCHAR(64)  NOT NULL COMMENT '新机器码',
    `ip`                VARCHAR(64)  DEFAULT NULL,
    `operator`          VARCHAR(16)  NOT NULL DEFAULT 'user' COMMENT 'user=用户自助 / admin=管理员操作',
    `created_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='设备解绑日志';
```

### 3.7 系统配置表 `sys_config`

```sql
CREATE TABLE `sys_config` (
    `id`          BIGINT       NOT NULL AUTO_INCREMENT,
    `config_key`  VARCHAR(64)  NOT NULL COMMENT '配置键',
    `config_val`  VARCHAR(256) NOT NULL COMMENT '配置值',
    `remark`      VARCHAR(256) DEFAULT NULL COMMENT '说明',
    `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_key` (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统配置（动态参数）';

-- 初始数据
INSERT INTO `sys_config` (`config_key`, `config_val`, `remark`) VALUES
('unbind_limit_per_month', '1', '每月允许解绑次数'),
('unbind_cooldown_days', '0', '两次解绑最短间隔天数');
```

### 3.8 登录日志表 `login_log`

```sql
CREATE TABLE `login_log` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT,
    `user_id`    BIGINT       NOT NULL,
    `ip`         VARCHAR(64)  DEFAULT NULL,
    `device`     VARCHAR(256) DEFAULT NULL COMMENT '设备/UA信息',
    `result`     VARCHAR(16)  NOT NULL COMMENT 'success/expired/wrong_password/disabled',
    `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='登录日志';
```

### 3.9 管理员操作日志表 `admin_operation_log`

```sql
CREATE TABLE `admin_operation_log` (
    `id`           BIGINT       NOT NULL AUTO_INCREMENT,
    `admin_id`     BIGINT       NOT NULL COMMENT '操作管理员ID',
    `admin_name`   VARCHAR(32)  NOT NULL COMMENT '管理员用户名（冗余）',
    `action`       VARCHAR(64)  NOT NULL COMMENT '操作类型：generate_codes/disable_code/adjust_membership/ban_user/unban_user',
    `target_type`  VARCHAR(32)  DEFAULT NULL COMMENT '目标类型：user/redeem_code',
    `target_id`    BIGINT       DEFAULT NULL COMMENT '目标ID',
    `detail`       TEXT         DEFAULT NULL COMMENT '操作详情（JSON 格式）',
    `ip`           VARCHAR(64)  DEFAULT NULL,
    `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_admin_id` (`admin_id`),
    KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员操作审计日志';
```

---

## 4. API 设计

### 4.1 用户端 API

| 方法 | 路径 | 说明 | 认证 |
|---|---|---|---|
| POST | `/api/auth/register` | 注册 | 无 |
| POST | `/api/auth/login` | 登录（需携带机器码） | 无 |
| GET | `/api/user/status` | 获取当前用户信息和会员状态 | JWT |
| POST | `/api/user/redeem` | 兑换码兑换 | JWT |
| GET | `/api/user/redeem-logs` | 我的兑换记录 | JWT |
| POST | `/api/user/unbind-device` | 解绑当前设备并绑定新设备 | JWT |
| GET | `/api/user/device-info` | 查看当前绑定设备信息和本月剩余解绑次数 | JWT |

#### 请求/响应示例

**注册** `POST /api/auth/register`
```json
// Request
{ "username": "test01", "password": "123456", "email": "test@example.com" }

// Response - 成功
{ "code": 0, "data": { "token": "eyJ...", "user": { "id": 1, "username": "test01", "memberExpireAt": null } } }
```

**登录** `POST /api/auth/login`
```json
// Request
{ "username": "test01", "password": "123456", "machineCode": "a1b2c3d4e5...（SHA-256）", "deviceInfo": "Windows 10 - DESKTOP-ABC" }

// Response - 会员有效（完整 Token）
{ "code": 0, "data": { "token": "eyJ...", "restricted": false, "user": { "id": 1, "username": "test01", "memberExpireAt": "2026-05-18 16:00:00", "status": "active" } } }

// Response - 未激活（受限 Token，从未拥有过会员）
{ "code": 0, "data": { "token": "eyJ...restricted...", "restricted": true, "user": { "id": 1, "username": "test01", "memberExpireAt": null, "status": "inactive" } }, "msg": "请兑换会员码激活账号" }

// Response - 已过期（受限 Token）
{ "code": 0, "data": { "token": "eyJ...restricted...", "restricted": true, "user": { "id": 1, "username": "test01", "memberExpireAt": "2026-04-10 16:00:00", "status": "expired" } }, "msg": "会员已过期，请兑换续费" }

// Response - 账号禁用
{ "code": 40302, "msg": "账号已被禁用，请联系管理员" }

// Response - 设备不匹配
{ "code": 40303, "msg": "当前设备与绑定设备不同", "data": { "unbindRemaining": 1 } }

// Response - 密码错误
{ "code": 40101, "msg": "用户名或密码错误" }
```

**兑换** `POST /api/user/redeem`
```json
// Request
{ "code": "AICAT-AB3F-K9X2-M7PQ" }

// Response - 成功
{ "code": 0, "data": { "days": 30, "memberExpireAt": "2026-06-17 16:00:00" }, "msg": "兑换成功，会员有效期至 2026-06-17 16:00" }

// Response - 失败
{ "code": 40001, "msg": "兑换码无效" }
{ "code": 40002, "msg": "兑换码已被使用" }
{ "code": 40003, "msg": "兑换码已被禁用" }
{ "code": 40004, "msg": "兑换码已过期" }
```

### 4.2 管理端 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/login` | 管理员登录 |
| GET | `/api/admin/dashboard` | 仪表盘统计数据 |
| GET | `/api/admin/users` | 用户列表（分页+搜索） |
| PUT | `/api/admin/users/{id}/membership` | 调整用户会员时间 |
| PUT | `/api/admin/users/{id}/status` | 禁用/启用用户 |
| POST | `/api/admin/redeem-codes/generate` | 批量生成兑换码 |
| GET | `/api/admin/redeem-codes` | 兑换码列表（分页+筛选） |
| PUT | `/api/admin/redeem-codes/{id}/disable` | 禁用兑换码 |
| GET | `/api/admin/redeem-codes/export` | 导出兑换码（CSV） |
| POST | `/api/admin/users/{id}/unbind` | 管理员强制解绑用户设备（不受次数限制） |
| GET | `/api/admin/unbind-logs` | 解绑日志列表 |
| GET | `/api/admin/suspicious-users` | 疑似共享账号列表（IP 异常标记） |
| GET | `/api/admin/operation-logs` | 管理员操作审计日志（分页） |
| GET | `/api/admin/sys-config` | 获取系统配置列表 |
| PUT | `/api/admin/sys-config/{key}` | 修改系统配置（如解绑次数） |
| PUT | `/api/admin/change-password` | 修改管理员密码 |

#### 批量生成示例

**批量生成** `POST /api/admin/redeem-codes/generate`
```json
// Request
{ "count": 100, "days": 30, "validDays": 180, "remark": "淘宝渠道-首批月卡" }

// Response
{
    "code": 0,
    "data": {
        "batchNo": "B20260418163000",
        "count": 100,
        "days": 30,
        "codes": ["AICAT-AB3F-K9X2-M7PQ", "AICAT-...", ...]
    },
    "msg": "成功生成 100 个兑换码（30天会员）"
}
```

---

## 5. 后端工程结构

```
ai-canvas-server/
├── pom.xml
├── src/main/java/com/aicat/server/
│   ├── AiCatServerApplication.java          # 启动类
│   ├── config/
│   │   ├── SecurityConfig.java              # Spring Security / JWT 配置
│   │   ├── CorsConfig.java                  # 跨域配置
│   │   └── MyBatisPlusConfig.java           # 分页插件等
│   ├── security/
│   │   ├── JwtAuthInterceptor.java          # JWT 认证拦截器（含受限 Token 校验）
│   │   ├── RateLimitInterceptor.java        # 接口限流拦截器
│   │   ├── RequestSignVerifier.java         # 请求签名校验
│   │   └── SecurityHeaderFilter.java        # 安全响应头过滤器
│   ├── common/
│   │   ├── Result.java                      # 统一响应包装
│   │   ├── BusinessException.java           # 业务异常
│   │   └── ErrorCode.java                   # 错误码枚举
│   ├── entity/
│   │   ├── User.java
│   │   ├── RedeemCode.java
│   │   ├── RedeemLog.java
│   │   ├── Admin.java
│   │   ├── LoginLog.java
│   │   ├── UserDevice.java
│   │   ├── UnbindLog.java
│   │   ├── SysConfig.java
│   │   └── AdminOperationLog.java
│   ├── mapper/
│   │   ├── UserMapper.java
│   │   ├── RedeemCodeMapper.java
│   │   ├── RedeemLogMapper.java
│   │   ├── AdminMapper.java
│   │   ├── LoginLogMapper.java
│   │   ├── UserDeviceMapper.java
│   │   ├── UnbindLogMapper.java
│   │   ├── SysConfigMapper.java
│   │   └── AdminOperationLogMapper.java
│   ├── service/
│   │   ├── AuthService.java                 # 注册 & 登录 & 受限Token
│   │   ├── UserService.java                 # 用户信息 & 会员
│   │   ├── RedeemService.java               # 兑换码生成 & 兑换
│   │   ├── DeviceBindService.java            # 机器码绑定 & 解绑
│   │   ├── SysConfigService.java            # 系统配置（缓存+动态刷新）
│   │   └── AdminService.java                # 管理端业务 & 审计日志
│   ├── controller/
│   │   ├── AuthController.java              # /api/auth/*
│   │   ├── UserController.java              # /api/user/*
│   │   └── AdminController.java             # /api/admin/*
│   └── util/
│       ├── JwtUtil.java                     # JWT 工具
│       └── RedeemCodeGenerator.java         # 兑换码生成器
├── src/main/resources/
│   ├── application.yml                      # 配置文件
│   └── db/
│       └── schema.sql                       # 建表 SQL
└── src/test/
```

---

## 6. 管理后台工程结构

```
ai-canvas-admin/
├── index.html            # 入口（Vue3 + Element Plus CDN 引入）
├── css/
│   └── style.css
├── js/
│   ├── app.js            # Vue 应用主逻辑
│   ├── api.js            # 封装后端 API 调用
│   └── utils.js          # 工具函数
└── pages/                # 各页面组件（写在 JS 中）
```

> 管理后台采用**纯 CDN 引入方式**（Vue 3 + Element Plus），不需要 Node.js 环境和构建工具，双击 `index.html` 或用任意 HTTP 服务器打开即可使用。

---

## 7. 安全设计

### 7.1 威胁模型总览

```
                          攻击面
    ┌──────────────────────────────────────────┐
    │                                          │
    │   ┌─────────┐    ┌─────────┐    ┌──────┐ │
    │   │ 客户端   │    │ 网络层   │    │ 服务端│ │
    │   │         │    │         │    │      │ │
    │   │ 逆向破解 │    │ 中间人   │    │ 注入  │ │
    │   │ 本地篡改 │    │ 重放攻击 │    │ 越权  │ │
    │   │ Token伪造│    │ 嗅探     │    │ 爆破  │ │
    │   └─────────┘    └─────────┘    └──────┘ │
    │                                          │
    │   ┌─────────┐    ┌─────────┐    ┌──────┐ │
    │   │ 兑换码   │    │ 账号体系 │    │ 管理端│ │
    │   │         │    │         │    │      │ │
    │   │ 暴力猜解 │    │ 撞库     │    │ 越权  │ │
    │   │ 批量泄露 │    │ 共享滥用 │    │ CSRF │ │
    │   │ 重复使用 │    │ 批量注册 │    │ 弱密码│ │
    │   └─────────┘    └─────────┘    └──────┘ │
    └──────────────────────────────────────────┘
```

### 7.2 认证与授权安全

#### 7.2.1 密码安全

| 措施 | 实现方式 |
|---|---|
| 加密存储 | BCrypt（cost factor = 12），不可逆 |
| 密码强度 | 最少 6 位，建议包含字母和数字（客户端提示，不强制） |
| 传输安全 | 密码在客户端做一次 SHA-256 哈希后传输，服务端再 BCrypt |
| 撞库防护 | 登录失败不提示"用户名不存在"还是"密码错误"，统一返回"用户名或密码错误" |

#### 7.2.2 JWT Token 安全

| 措施 | 说明 |
|---|---|
| 签名算法 | HS256，密钥长度 ≥ 256 位 |
| 密钥管理 | 开发环境写在 `application.yml`，生产环境通过环境变量 `JWT_SECRET` 注入 |
| Token 有效期 | 完整 Token 7 天，受限 Token 24 小时 |
| Token 刷新 | 不使用 Refresh Token（桌面端），每次启动重新登录或验证 |
| Token 黑名单 | 设备被踢出时，将其 `token_hash` 标记为失效（查 `device_session` 表） |
| Payload 最小化 | 仅含 `userId`、`username`、`restricted`、`iat`、`exp`，不放敏感信息 |

#### 7.2.3 受限 Token 隔离

```java
// 拦截器伪代码
@Override
public boolean preHandle(request, response, handler) {
    Claims claims = jwtUtil.parse(token);
    boolean restricted = claims.get("restricted", Boolean.class);

    if (restricted) {
        String path = request.getRequestURI();
        Set<String> allowed = Set.of(
            "/api/user/redeem",
            "/api/user/status",
            "/api/user/redeem-logs"
        );
        if (!allowed.contains(path)) {
            return reject(response, 403, "MEMBERSHIP_REQUIRED");
        }
    }
    return true;
}
```

### 7.3 接口级防护

#### 7.3.1 全局限流策略

| 接口 | 限流规则 | 触发后行为 |
|---|---|---|
| `POST /api/auth/login` | 同一 IP：5 次/5分钟 | 锁定该 IP 15 分钟，返回 `429` |
| `POST /api/auth/register` | 同一 IP：5 次/小时 | 拒绝注册，返回 `429` |
| `POST /api/user/redeem` | 同一用户：5 次/分钟 | 拒绝兑换，返回 `429` |
| 所有 API | 同一 IP：200 次/分钟 | 全局熔断，返回 `429` |
| 管理端 API | 同一 IP：3 次登录失败/5分钟 | 锁定 30 分钟 |

实现方式：Spring Boot 拦截器 + 内存计数（`ConcurrentHashMap` + 定时清理），单机足够，无需 Redis。

#### 7.3.2 请求校验

| 检查项 | 规则 |
|---|---|
| Content-Type | 必须为 `application/json` |
| 请求体大小 | 最大 1MB（Spring Boot 默认即可） |
| 参数校验 | 使用 `@Valid` + `@NotBlank` / `@Size` / `@Pattern` 注解 |
| 路径遍历 | 不接受任何文件路径参数 |
| 空值处理 | 统一返回格式，不暴露堆栈信息 |

#### 7.3.3 响应安全头

```yaml
# Nginx 或 Spring Boot 配置
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cache-Control: no-store          # 对含敏感数据的 API 响应
```

### 7.4 兑换码安全（重点）

#### 7.4.1 防暴力猜解

兑换码空间分析：

```
字符池 31 个字符 × 12 位 = 31^12 ≈ 7.87 × 10^17 种组合
假设系统中存在 10000 个有效兑换码
命中概率 = 10000 / 7.87×10^17 ≈ 1.27 × 10^-14
每秒尝试 5 次，暴力猜中一个需要 ≈ 50 亿年
```

即使如此，仍需多层防护：

| 层级 | 措施 | 说明 |
|---|---|---|
| L1 - 限流 | 5 次/分钟/用户 | 限制尝试速率 |
| L2 - 锁定 | 连续 10 次失败，锁定兑换功能 30 分钟 | 限制暴力深度 |
| L3 - 告警 | 单用户 1 小时内失败 ≥ 15 次 → 触发告警 | 管理员介入 |
| L4 - 封禁 | 单 IP 累计失败 ≥ 50 次/天 → 自动封禁 IP 24 小时 | 阻断脚本攻击 |

#### 7.4.2 防批量泄露

| 场景 | 防护 |
|---|---|
| 批量生成后的传输 | 管理后台导出兑换码时，审计日志记录操作人、数量、时间 |
| 兑换码展示 | 管理后台列表页默认隐藏兑换码中间段（`AICAT-AB**-****-M7PQ`） |
| 数据库泄露 | 兑换码在数据库中明文存储（需要精确匹配），但建议部署时加密磁盘 |
| API 泄露 | 生成接口返回的码列表仅在当次请求返回，不提供"再次查看"接口 |

#### 7.4.3 防重复使用（并发控制）

```java
// 兑换核心逻辑 - 使用数据库行锁
@Transactional
public RedeemResult redeem(Long userId, String code) {
    // 1. 行锁查询兑换码
    RedeemCode rc = redeemCodeMapper.selectForUpdate(code);
    //   → SQL: SELECT * FROM redeem_code WHERE code = ? FOR UPDATE

    // 2. 状态校验
    if (rc == null) throw INVALID_CODE;
    if ("used".equals(rc.getStatus())) throw CODE_ALREADY_USED;
    if ("disabled".equals(rc.getStatus())) throw CODE_DISABLED;
    if (rc.getExpireAt() != null && rc.getExpireAt().isBefore(now)) throw CODE_EXPIRED;

    // 3. 更新兑换码状态（原子操作，行锁保护）
    rc.setStatus("used");
    rc.setUsedBy(userId);
    rc.setUsedAt(LocalDateTime.now());
    redeemCodeMapper.updateById(rc);

    // 4. 更新用户会员时间
    User user = userMapper.selectById(userId);
    LocalDateTime base = (user.getMemberExpireAt() != null
        && user.getMemberExpireAt().isAfter(now))
        ? user.getMemberExpireAt() : now;
    LocalDateTime newExpire = base.plusDays(rc.getDays());
    user.setMemberExpireAt(newExpire);
    userMapper.updateById(user);

    // 5. 写入兑换日志
    // ...

    return new RedeemResult(rc.getDays(), newExpire);
}
```

### 7.5 账号安全

#### 7.5.1 机器码绑定防共享

```
核心原则：一个账号只能绑定一台机器，切换设备需要消耗解绑次数。

登录时：
    │
    ▼
查询 user_device 表
    ├── 无绑定记录 → 自动绑定当前机器码 → 正常登录
    ├── 有绑定且机器码匹配 → 正常登录
    └── 有绑定但机器码不匹配 → 拒绝登录
         └── 客户端显示解绑选项（需输入密码二次确认）
              ├── 本月有剩余次数 → 解绑旧设备，绑定新设备
              └── 本月次数用完 → 提示下月再试，或联系管理员

防共享效果：
    ├── 两人各自的电脑机器码不同 → 无法同时使用
    ├── 互相解绑？→ 受每月次数限制（默认仅1次）
    └── 频繁解绑的账号 → 管理后台自动标记，人工审查
```

#### 7.5.2 异常登录检测

| 检测项 | 触发条件 | 处理 |
|---|---|---|
| 异地登录 | 新登录 IP 的地理位置与最近 5 次登录差异超过 500km | 记录告警日志（不阻断） |
| 频繁换设备 | 24 小时内在 ≥ 5 台不同设备登录 | 标记为可疑账号，管理后台高亮 |
| 非常规时间 | 凌晨 2-6 点登录（可配置） | 仅记录，不阻断 |

> 初期只做记录和后台展示，不自动阻断，避免误伤正常用户。

### 7.6 客户端安全（Tauri 桌面端）

#### 7.6.1 Token 本地存储

| 措施 | 说明 |
|---|---|
| 存储位置 | Tauri 的 App Data 目录（系统级隔离） |
| 加密方式 | AES-256-GCM 加密后存储，密钥绑定设备硬件指纹（CPU ID + 磁盘序列号哈希） |
| 防拷贝 | Token 绑定设备指纹，复制到其他机器解密失败 |

#### 7.6.2 心跳机制

```
客户端每 5 分钟发一次心跳：
    GET /api/user/status
    Header: Authorization: Bearer <token>

服务端响应：
    ├── 200 + memberExpireAt → 客户端更新本地会员状态
    ├── 401 DEVICE_KICKED → 弹窗 + 强制退出
    ├── 401 TOKEN_EXPIRED → 跳转登录页
    └── 403 MEMBERSHIP_REQUIRED → 跳转兑换页
```

#### 7.6.3 反调试（基础）

| 措施 | 说明 |
|---|---|
| 前端代码混淆 | Vite 生产构建默认开启 Terser 压缩混淆 |
| DevTools 检测 | 检测 `window.__TAURI_INTERNALS__` 调试标志，生产环境禁用 DevTools |
| 关键逻辑服务端化 | 会员校验、兑换逻辑全部在服务端执行，客户端只做展示 |

> 桌面端不可能完全防破解，核心思路是**所有校验逻辑都在服务端**，客户端即使被修改也只是绕过了 UI 限制，无法绕过服务端认证。

### 7.7 网络层安全

#### 7.7.1 HTTPS 强制

| 配置项 | 值 |
|---|---|
| 证书 | Let's Encrypt 免费证书，自动续期 |
| TLS 版本 | 仅允许 TLS 1.2+ |
| HTTP 跳转 | 所有 HTTP 请求 301 跳转 HTTPS |
| HSTS | `max-age=31536000; includeSubDomains` |

#### 7.7.2 CORS 配置

```java
@Configuration
public class CorsConfig implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
            .allowedOrigins(
                "tauri://localhost",     // Tauri 客户端
                "https://admin.aicat.com" // 管理后台（如果部署到独立域名）
            )
            .allowedMethods("GET", "POST", "PUT", "DELETE")
            .allowedHeaders("*")
            .allowCredentials(true)
            .maxAge(3600);
    }
}
```

#### 7.7.3 防重放攻击

| 措施 | 说明 |
|---|---|
| 请求时间戳 | 客户端每次请求附带 `X-Timestamp`，服务端校验与当前时间差 ≤ 60 秒 |
| 请求签名 | 关键接口（登录、兑换）附带 `X-Sign = HMAC-SHA256(timestamp + body, appSecret)` |
| 幂等性 | 兑换接口天然幂等（同一码只能兑换一次），无需额外处理 |

### 7.8 数据安全

#### 7.8.1 敏感数据分级

| 级别 | 数据 | 处理方式 |
|---|---|---|
| L1 - 绝密 | 用户密码、JWT 密钥 | 加密存储，不可逆/不可导出 |
| L2 - 机密 | 兑换码、Token | 传输加密（HTTPS），存储明文（需精确匹配） |
| L3 - 内部 | 用户名、邮箱、IP | 日志中脱敏（`te****@example.com`） |
| L4 - 公开 | 会员到期时间、兑换天数 | 无特殊处理 |

#### 7.8.2 日志脱敏规则

```
密码字段 → 永不记录
邮箱 → te****@example.com
IP → 完整记录（用于安全分析）
兑换码 → 仅记录前4位后4位（AICAT-AB**-****-M7PQ）
Token → 仅记录前 8 位（eyJhbGci...）
```

#### 7.8.3 数据留存与清理

| 数据 | 留存期 | 清理方式 |
|---|---|---|
| 登录日志 | 90 天 | 定时任务每日凌晨清理 |
| 管理操作日志 | 365 天 | 定时任务每月清理 |
| 已使用兑换码 | 永久 | 不清理（数据量可控） |
| 失效设备会话 | 7 天 | 定时任务每日清理 |

### 7.9 管理端安全

| 风险点 | 防护措施 |
|---|---|
| 未授权访问 | 管理后台部署在内网，或通过 Nginx 限制只允许白名单 IP 访问 `/admin/` |
| CSRF | 管理端 API 使用 JWT 认证（Header 方式），不依赖 Cookie，天然免疫 CSRF |
| 管理员弱密码 | 首次登录强制修改，密码需 ≥ 8 位 |
| 权限粒度 | `super_admin` 可管理管理员账号，普通 `admin` 只能管理用户和兑换码 |
| 敏感操作二次确认 | 批量生成 ≥ 100 个兑换码、禁用用户需二次确认 |

### 7.10 监控与告警

#### 7.10.1 告警规则

| 事件 | 阈值 | 告警方式 |
|---|---|---|
| 登录失败激增 | 全站 1 分钟内 > 50 次 | 控制台日志 WARN + 管理后台通知 |
| 兑换码尝试异常 | 单用户 1 小时 > 15 次失败 | 管理后台标记该用户 |
| 批量注册 | 同一 IP 段（/24）1 小时 > 20 个注册 | 控制台日志 WARN |
| 服务端异常 | 5 分钟内 500 错误 > 10 次 | 控制台日志 ERROR |

#### 7.10.2 安全看板（管理后台）

在仪表盘页面增加安全概览区：
- 今日登录失败次数 / 被锁定 IP 数
- 今日兑换失败次数 / 被标记的可疑用户
- 当前在线设备数 / 活跃会话数
- 最近 24 小时的异常事件列表

### 7.11 安全防护总结矩阵

| 攻击类型 | L1 防护 | L2 防护 | L3 防护 |
|---|---|---|---|
| **暴力登录** | 限流 5次/5分钟 | IP 锁定 15 分钟 | 全站告警 |
| **兑换码爆破** | 限流 5次/分钟 | 功能锁定 30 分钟 | IP 封禁 24 小时 |
| **批量注册** | 限流 5次/小时/IP | IP 段检测 | 后续可加验证码 |
| **账号共享** | 机器码一对一绑定 | 解绑次数限制（动态配置） | IP 辅助监控 + 人工审查 |
| **Token 伪造** | HS256 签名 | 机器码绑定校验 | — |
| **中间人攻击** | HTTPS 强制 | TLS 1.2+ | 请求签名 |
| **SQL 注入** | MyBatis-Plus 参数化 | 输入校验 | — |
| **客户端破解** | 服务端校验 | 代码混淆 | 心跳检测 |
| **管理端越权** | 独立 JWT | IP 白名单 | 操作审计 |
| **数据泄露** | 密码 BCrypt | 日志脱敏 | 磁盘加密 |

---

## 8. 兑换码生成算法

```java
// 格式: AICAT-XXXX-XXXX-XXXX (不含 AICAT- 前缀共 12 位)
// 字符池: 大写字母(去掉 O/I/L) + 数字(去掉 0/1)
// 有效字符: A B C D E F G H J K M N P Q R S T U V W X Y Z 2 3 4 5 6 7 8 9
// 共 31 个字符, 12 位 → 31^12 ≈ 7.87 × 10^17 种组合

public static String generate() {
    char[] pool = "ABCDEFGHJKMNPQRSTUVWXYZ23456789".toCharArray();
    SecureRandom random = new SecureRandom();
    StringBuilder sb = new StringBuilder("AICAT-");
    for (int i = 0; i < 12; i++) {
        if (i > 0 && i % 4 == 0) sb.append('-');
        sb.append(pool[random.nextInt(pool.length)]);
    }
    return sb.toString();
}
```

去掉了容易混淆的 `0/O/1/I/L`，用户手动输入时不易出错。

---

## 9. 客户端对接要点

### 9.1 登录流程修改

```
客户端启动
    │
    ▼
检查本地 Token
    ├── 无 Token → 跳转登录页
    └── 有 Token → 调用 /api/user/status
         ├── 200 且会员有效 → 进入主界面
         ├── 200 但 restricted=true → 显示兑换/激活页面
         ├── 401 DEVICE_KICKED → 提示"账号已在其他设备登录" → 跳转登录页
         └── Token 无效/过期 → 跳转登录页
```

### 9.2 客户端新增页面

| 页面 | 功能 |
|---|---|
| 登录页 | 用户名 + 密码登录 |
| 注册页 | 用户名 + 密码 + 邮箱（可选）注册 |
| 激活/兑换页 | 输入兑换码，新用户显示"激活账号"，老用户显示"续费" |
| 会员状态页 | 显示当前到期时间、兑换历史、设备管理 |
| 到期提醒弹窗 | 到期前 1 小时自动弹出提醒 |

---

## 10. 部署方案

```
                    ┌─────────────┐
                    │  Nginx      │
                    │  (反向代理)  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
     ┌────────▼──┐  ┌──────▼─────┐  ┌──▼──────────┐
     │ 管理后台   │  │ 后端 API   │  │ 客户端下载页  │
     │ /admin/   │  │ /api/      │  │ /            │
     │ 静态文件   │  │ Spring Boot│  │ 静态页面      │
     └───────────┘  └──────┬─────┘  └─────────────┘
                           │
                    ┌──────▼──────┐
                    │  MySQL 8    │
                    └─────────────┘
```

---

## 11. 开发里程碑

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | 数据库建表 + 后端骨架搭建 | 0.5 天 |
| P1 | 注册/登录 API + JWT 认证 + 受限 Token | 1.5 天 |
| P2 | 兑换码生成 & 兑换 API + 并发控制 | 1 天 |
| P3 | 设备会话管理 + 限流拦截器 | 0.5 天 |
| P4 | 管理后台（用户管理 + 兑换码管理 + 审计日志 + 安全看板） | 1.5 天 |
| P5 | 客户端登录/注册/兑换页面 + 心跳 + Token 加密存储 | 1.5 天 |
| P6 | 安全加固（请求签名 + 安全头 + 日志脱敏 + 告警规则）+ 联调测试 | 1.5 天 |
| **合计** | | **8 天** |
