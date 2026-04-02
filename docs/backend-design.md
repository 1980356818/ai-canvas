# AI 无限画布 - 后端系统设计

## 1. 技术选型

| 组件       | 选型                          | 理由                                  |
| ---------- | ----------------------------- | ------------------------------------- |
| Runtime    | Java 21 + Spring Boot 3.x    | 企业级生态，长期维护稳定              |
| 安全框架   | Spring Security + JWT         | 开箱即用的认证鉴权                    |
| 数据库     | PostgreSQL 16                 | JSONB 支持画布数据，性能强            |
| 持久层     | MyBatis-Plus                  | 灵活 SQL + 便捷 CRUD，国内生态成熟   |
| 缓存       | Redis + Spring Cache          | Session / 限流 / 注册码校验           |
| 数据库迁移 | Flyway                        | 版本化管理 Schema 变更                |
| 对象存储   | MinIO / 阿里云 OSS            | 图片视频等大文件存储                  |
| API 文档   | SpringDoc (OpenAPI 3)         | 自动生成接口文档                      |
| 部署       | Docker Compose + Nginx        | 标准化交付                            |

---

## 2. 工程结构

```
ai-canvas-server/
├── src/main/java/com/aicavas/
│   ├── AiCanvasApplication.java
│   ├── common/                  # 通用层
│   │   ├── config/              # SecurityConfig, RedisConfig, CorsConfig
│   │   ├── exception/           # GlobalExceptionHandler, BizException
│   │   ├── response/            # R<T> 统一响应包装
│   │   └── util/                # JwtUtil, SnowflakeIdGenerator
│   ├── module/
│   │   ├── auth/                # 认证模块
│   │   │   ├── controller/
│   │   │   ├── service/
│   │   │   ├── dto/
│   │   │   └── security/        # JwtFilter, UserDetailsServiceImpl
│   │   ├── user/                # 用户模块
│   │   │   ├── controller/
│   │   │   ├── service/
│   │   │   ├── mapper/
│   │   │   └── entity/
│   │   ├── vip/                 # VIP 模块
│   │   │   ├── controller/
│   │   │   ├── service/
│   │   │   ├── mapper/
│   │   │   └── entity/
│   │   ├── canvas/              # 画布模块
│   │   │   ├── controller/
│   │   │   ├── service/
│   │   │   ├── mapper/
│   │   │   └── entity/
│   │   └── admin/               # 管理后台
│   │       ├── controller/
│   │       └── service/
│   └── infrastructure/          # 基础设施
│       ├── storage/             # OSS 文件上传
│       └── redis/               # Redis 操作封装
├── src/main/resources/
│   ├── application.yml
│   ├── application-dev.yml
│   ├── application-prod.yml
│   └── db/migration/           # Flyway SQL
└── pom.xml
```

---

## 3. 认证系统

### 3.1 Spring Security 配置

```
请求 → JwtAuthenticationFilter → SecurityContext
         │
         ├─ /api/auth/**        → permitAll
         ├─ /api/admin/**       → hasRole('ADMIN')
         └─ /api/**             → authenticated
```

### 3.2 注册流程

```
POST /api/auth/register
Body: { username, password, registrationCode }
      │
      ▼
校验注册码 (Redis 分布式锁防并发) ──(无效)──> 400
      │
    (有效)
      ▼
BCrypt 加密密码 → 创建用户 → 注册码标记已使用
      │
      ▼
若注册码携带 VIP → 创建 VIP 记录
      │
      ▼
签发 JWT Token 对 → 返回
```

### 3.3 登录流程

```
POST /api/auth/login
Body: { username, password }
      │
      ▼
BCrypt 校验 → 签发 Access Token (30min) + Refresh Token (7d)
               Refresh Token 存 Redis (支持踢下线)
```

### 3.4 Token 策略

| Token          | 有效期  | 签名算法 | 存储位置             |
| -------------- | ------- | -------- | -------------------- |
| Access Token   | 30 min  | RS256    | 前端 Memory          |
| Refresh Token  | 7 天    | RS256    | HttpOnly Cookie      |

---

## 4. 注册码系统

### 4.1 数据模型

| 字段             | 类型            | 说明                             |
| ---------------- | --------------- | -------------------------------- |
| id               | BIGINT          | 雪花ID                          |
| code             | VARCHAR(32)     | 唯一注册码 `AIC-XXXX-XXXX-XXXX` |
| type             | VARCHAR(16)     | `normal` / `vip`                 |
| grant_vip_level  | TINYINT         | 注册后赋予的 VIP 等级 (0=无)    |
| grant_vip_days   | INT             | 赋予 VIP 天数                    |
| max_uses         | INT             | 最大使用次数 (默认1)             |
| used_count       | INT             | 已使用次数                       |
| batch_no         | VARCHAR(32)     | 批次号，便于管理                 |
| expires_at       | TIMESTAMP       | 过期时间 (NULL=永不过期)         |
| created_by       | BIGINT          | 创建者ID                        |

### 4.2 核心逻辑

```java
@Transactional
public void useRegistrationCode(String code, Long userId) {
    // Redis 分布式锁: lock:reg_code:{code}
    // 1. 查询注册码，校验有效性
    // 2. used_count + 1 (乐观锁 WHERE used_count < max_uses)
    // 3. 写入使用记录
    // 4. 若携带 VIP，创建 VIP 记录
}
```

---

## 5. VIP 等级体系

### 5.1 等级定义

| 等级   | 名称       | 定位                 | 月费(参考) |
| ------ | ---------- | -------------------- | ---------- |
| VIP 0  | 免费用户   | 基础体验             | ¥0         |
| VIP 1  | 基础会员   | 个人轻度使用         | ¥29        |
| VIP 2  | 标准会员   | 个人日常使用         | ¥59        |
| VIP 3  | 高级会员   | 个人重度 / 工作室    | ¥99        |
| VIP 4  | 专业会员   | 小团队 / 专业创作    | ¥199       |
| VIP 5  | 旗舰会员   | 企业 / 无限制        | ¥399       |

### 5.2 权益矩阵

| 权益项               | VIP0 | VIP1 | VIP2 | VIP3 | VIP4  | VIP5  |
| -------------------- | ---- | ---- | ---- | ---- | ----- | ----- |
| 画布项目数           | 3    | 10   | 30   | 100  | 500   | 无限  |
| 单画布节点上限       | 50   | 200  | 500  | 2000 | 5000  | 无限  |
| 云端存储空间         | 100MB| 1GB  | 5GB  | 20GB | 100GB | 500GB |
| 历史版本保留         | 3天  | 7天  | 30天 | 90天 | 1年   | 永久  |
| 画布导出(PNG/PDF)    | ✗    | ✓    | ✓    | ✓    | ✓     | ✓     |
| 自定义 API 配置组数  | 1    | 3    | 5    | 10   | 20    | 无限  |
| API 并发调用数       | 1    | 2    | 3    | 5    | 10    | 20    |
| 优先级客服           | ✗    | ✗    | ✗    | ✓    | ✓     | ✓     |

> AI 生成消耗由用户自己的 API Key 承担，VIP 控制的是平台功能上限。

### 5.3 等级计算

```java
// 用户当前等级 = 所有未过期 VIP 记录中的最高等级
@Cacheable(value = "user:vip", key = "#userId")
public int getCurrentVipLevel(Long userId) {
    return vipRecordMapper.selectMaxActiveLevelByUserId(userId);
}
```

- 定时任务每小时刷新过期用户的缓存等级
- VIP 变更时主动清除缓存

---

## 6. 画布持久化

### 6.1 存储分层

```
前端画布数据 (JSON)
      │
      ▼
  REST API ──> PostgreSQL (JSONB 存画布结构)
      │
  媒体文件 ──> MinIO / OSS (图片、视频)
                数据库只存引用 URL
```

### 6.2 大画布优化

对于成百上千节点的画布，直接存整个 JSON 会导致：
- 上传/下载耗时长
- 频繁保存浪费带宽

**解决方案：增量保存**

```java
// 前端发送 JSON Patch (RFC 6902)
PUT /api/canvas/{id}/patch
Body: [
  { "op": "replace", "path": "/nodes/node_123/position", "value": {"x":100,"y":200} },
  { "op": "add", "path": "/nodes/node_456", "value": {...} }
]
```

- 前端维护操作日志，定期批量提交 Patch
- 后端应用 Patch 到 JSONB 字段
- 每 N 次 Patch 后做一次全量快照作为版本

---

## 7. 数据库 Schema

```sql
-- 用户表
CREATE TABLE t_user (
    id              BIGINT PRIMARY KEY,
    username        VARCHAR(32) UNIQUE NOT NULL,
    password_hash   VARCHAR(128) NOT NULL,
    role            VARCHAR(16) DEFAULT 'USER',
    current_vip     SMALLINT DEFAULT 0,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);

-- 注册码表
CREATE TABLE t_registration_code (
    id              BIGINT PRIMARY KEY,
    code            VARCHAR(32) UNIQUE NOT NULL,
    type            VARCHAR(16) DEFAULT 'normal',
    grant_vip_level SMALLINT DEFAULT 0,
    grant_vip_days  INT DEFAULT 0,
    max_uses        INT DEFAULT 1,
    used_count      INT DEFAULT 0,
    batch_no        VARCHAR(32),
    expires_at      TIMESTAMP,
    created_by      BIGINT REFERENCES t_user(id),
    created_at      TIMESTAMP DEFAULT NOW()
);

-- 注册码使用记录
CREATE TABLE t_code_usage_log (
    id              BIGINT PRIMARY KEY,
    code_id         BIGINT REFERENCES t_registration_code(id),
    user_id         BIGINT REFERENCES t_user(id),
    used_at         TIMESTAMP DEFAULT NOW()
);

-- VIP 记录表
CREATE TABLE t_user_vip_record (
    id              BIGINT PRIMARY KEY,
    user_id         BIGINT REFERENCES t_user(id),
    vip_level       SMALLINT NOT NULL CHECK (vip_level BETWEEN 1 AND 5),
    source          VARCHAR(32) NOT NULL,
    starts_at       TIMESTAMP NOT NULL,
    expires_at      TIMESTAMP NOT NULL,
    created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_vip_user_active ON t_user_vip_record(user_id, expires_at);

-- 画布项目表
CREATE TABLE t_canvas_project (
    id              BIGINT PRIMARY KEY,
    user_id         BIGINT REFERENCES t_user(id),
    title           VARCHAR(128) NOT NULL,
    canvas_data     JSONB,
    thumbnail_url   VARCHAR(512),
    node_count      INT DEFAULT 0,
    version         INT DEFAULT 1,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_canvas_user ON t_canvas_project(user_id, updated_at DESC);

-- 画布版本历史
CREATE TABLE t_canvas_version (
    id              BIGINT PRIMARY KEY,
    project_id      BIGINT REFERENCES t_canvas_project(id) ON DELETE CASCADE,
    version         INT NOT NULL,
    canvas_data     JSONB,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- 注册码批次表
CREATE TABLE t_code_batch (
    id              BIGINT PRIMARY KEY,
    batch_no        VARCHAR(32) UNIQUE NOT NULL,
    total_count     INT NOT NULL,
    used_count      INT DEFAULT 0,
    type            VARCHAR(16) DEFAULT 'normal',
    grant_vip_level SMALLINT DEFAULT 0,
    grant_vip_days  INT DEFAULT 0,
    remark          VARCHAR(256),
    created_by      BIGINT REFERENCES t_user(id),
    created_at      TIMESTAMP DEFAULT NOW()
);

-- 系统设置表 (Key-Value)
CREATE TABLE t_system_setting (
    key             VARCHAR(64) PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TIMESTAMP DEFAULT NOW()
);

-- 管理操作日志
CREATE TABLE t_admin_audit_log (
    id              BIGINT PRIMARY KEY,
    admin_id        BIGINT REFERENCES t_user(id),
    action          VARCHAR(64) NOT NULL,
    target_type     VARCHAR(32),
    target_id       BIGINT,
    detail          JSONB,
    ip              VARCHAR(64),
    created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_audit_admin ON t_admin_audit_log(admin_id, created_at DESC);
```

---

## 8. API 设计

### 8.1 认证

| 方法 | 路径                    | 说明            | 鉴权 |
| ---- | ----------------------- | --------------- | ---- |
| POST | `/api/auth/register`    | 注册(需注册码)  | ✗    |
| POST | `/api/auth/login`       | 登录            | ✗    |
| POST | `/api/auth/refresh`     | 刷新 Token      | ✗    |
| POST | `/api/auth/logout`      | 登出            | ✓    |

### 8.2 用户

| 方法 | 路径                    | 说明           | 鉴权 |
| ---- | ----------------------- | -------------- | ---- |
| GET  | `/api/user/profile`     | 获取个人信息   | ✓    |
| PUT  | `/api/user/password`    | 修改密码       | ✓    |
| GET  | `/api/user/vip`         | 查询 VIP 状态  | ✓    |

### 8.3 画布

| 方法   | 路径                              | 说明           | 鉴权 |
| ------ | --------------------------------- | -------------- | ---- |
| GET    | `/api/canvas`                     | 画布列表       | ✓    |
| POST   | `/api/canvas`                     | 创建画布       | ✓    |
| GET    | `/api/canvas/{id}`                | 获取画布       | ✓    |
| PUT    | `/api/canvas/{id}`                | 全量保存       | ✓    |
| PUT    | `/api/canvas/{id}/patch`          | 增量保存       | ✓    |
| DELETE | `/api/canvas/{id}`                | 删除画布       | ✓    |
| GET    | `/api/canvas/{id}/versions`       | 版本历史       | ✓    |

### 8.4 管理后台 - 仪表盘

| 方法 | 路径                          | 说明                         | 鉴权  |
| ---- | ----------------------------- | ---------------------------- | ----- |
| GET  | `/api/admin/stats/overview`   | 总用户/今日新增/活跃/VIP率   | ADMIN |
| GET  | `/api/admin/stats/growth`     | 用户增长趋势 (按天)          | ADMIN |
| GET  | `/api/admin/stats/vip-dist`   | VIP 等级分布                 | ADMIN |
| GET  | `/api/admin/stats/code-usage` | 注册码各批次使用率           | ADMIN |

### 8.5 管理后台 - 用户管理

| 方法 | 路径                              | 说明                      | 鉴权  |
| ---- | --------------------------------- | ------------------------- | ----- |
| GET  | `/api/admin/users`                | 用户列表(分页/筛选/搜索)  | ADMIN |
| GET  | `/api/admin/users/{id}`           | 用户详情                  | ADMIN |
| PUT  | `/api/admin/users/{id}/status`    | 禁用/启用                 | ADMIN |
| PUT  | `/api/admin/users/{id}/password`  | 重置密码                  | ADMIN |
| PUT  | `/api/admin/users/{id}/vip`       | 手动设置 VIP              | ADMIN |
| GET  | `/api/admin/users/{id}/vip-logs`  | VIP 变更历史              | ADMIN |

### 8.6 管理后台 - 注册码管理

| 方法 | 路径                               | 说明                   | 鉴权  |
| ---- | ---------------------------------- | ---------------------- | ----- |
| POST | `/api/admin/codes/generate`        | 批量生成注册码         | ADMIN |
| GET  | `/api/admin/codes`                 | 注册码列表(分页/筛选)  | ADMIN |
| GET  | `/api/admin/codes/{id}`            | 注册码详情(含使用记录) | ADMIN |
| PUT  | `/api/admin/codes/{id}/disable`    | 禁用某个注册码         | ADMIN |
| GET  | `/api/admin/codes/batches`         | 批次列表及统计         | ADMIN |
| GET  | `/api/admin/codes/export`          | 导出 CSV              | ADMIN |

### 8.7 管理后台 - 系统设置

| 方法   | 路径                         | 说明             | 鉴权  |
| ------ | ---------------------------- | ---------------- | ----- |
| GET    | `/api/admin/settings`        | 获取系统设置     | ADMIN |
| PUT    | `/api/admin/settings`        | 更新系统设置     | ADMIN |
| GET    | `/api/admin/admins`          | 管理员列表       | ADMIN |
| POST   | `/api/admin/admins`          | 添加管理员       | ADMIN |
| DELETE | `/api/admin/admins/{id}`     | 移除管理员       | ADMIN |

---

## 9. 部署架构

```
                    ┌──────────────┐
                    │    Nginx     │
                    │  (SSL/反代)   │
                    └──────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
   ┌──────┴──────┐ ┌──────┴──────┐ ┌───────┴───────┐
   │ Tauri 客户端 │ │  管理后台    │ │ Spring Boot   │
   │ (桌面安装包) │ │ admin.xxx   │ │   :8080       │
   │ 自动更新资源 │ │ /dist 静态  │ │  (统一 API)    │
   └─────────────┘ └─────────────┘ └───────┬───────┘
                                           │
                          ┌────────────────┼────────────────┐
                          │                │                │
                   ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐
                   │ PostgreSQL  │ │    Redis     │ │ MinIO/OSS   │
                   │  :5432      │ │    :6379     │ │  文件存储    │
                   └─────────────┘ └─────────────┘ └─────────────┘
```

管理后台与 Tauri 客户端共用同一个 Spring Boot 实例，无需额外后端部署。

---

## 10. 安全要点

- 密码 BCrypt (strength=12) 加密存储
- JWT RS256 签名，Access/Refresh 双 Token
- 注册码校验使用 Redis 分布式锁防并发超卖
- API 全局限流: Bucket4j + Redis（令牌桶）
- 管理接口 `@PreAuthorize("hasRole('ADMIN')")`
- 用户 AI API Key 不经过后端，仅存客户端本地
- 敏感操作日志审计

---

## 11. 不做的事

| 不做           | 理由                                   |
| -------------- | -------------------------------------- |
| 第三方登录     | 注册码控制增长，初期不需要             |
| 支付系统       | 先手动发码，跑通再接支付               |
| 实时协作编辑   | CRDT 复杂度极高，初期只做个人画布      |
| AI 调用代理    | Tauri 桌面端无 CORS 限制，直连即可     |
| 细粒度权限     | 只分 USER / ADMIN 两种角色             |
| WebSocket 推送 | 桌面单用户场景不需要实时推送           |
