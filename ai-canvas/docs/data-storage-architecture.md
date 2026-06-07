# AICat 数据存储架构

> 本文档完整梳理 AICat 桌面客户端的数据存储位置、配置体系和文件保存路径。

---

## 1. 数据存储总览

AICat 的数据分布在 **四个独立位置**：

| 存储位置 | 类型 | 内容 |
|----------|------|------|
| `{data_dir}/data.db` | SQLite 数据库 | 项目、卡片、连线、设置、聊天、Agent 会话 |
| `{data_dir}/media/` | 文件目录 | AI 生成的图片/视频（内部存储，按 UUID 命名） |
| `{auto_save_default_dir}` | 文件目录 | AI 生成的文件自动保存副本（按项目分文件夹，友好命名）。默认 `{exe_dir}/文件自动保存/`，详见 [§3.2](#32-自动保存自动无需配置) |
| `~/Documents/AICat Data/backups/` | 文件目录 | data.db 自动备份（启动 + 每 30 分钟，保留最近 10 份）。详见 [§11](#11-数据备份与恢复) |
| WebView localStorage | 浏览器存储 | 视口状态、登录 Token、认证信息、主题/模型偏好 |

### 1.1 `data_dir` 解析策略（`resolve_data_dir`）

数据目录通过 `resolve_data_dir()` **自动确定**，无需用户配置：

| 平台 | 策略 | 典型路径 |
|------|------|----------|
| **Windows release** | **exe 所在目录/data/**（便携模式） | `D:\AICat\data\`（安装在 D 盘时） |
| **Windows 回退 1** | 旧版升级：AppData 有数据而 exe/data 没有 → 继续用 AppData | `C:\Users\{用户}\AppData\Roaming\com.ai-canvas.desktop\` |
| **Windows 回退 2** | exe 在 Program Files → 跳过便携模式 | `C:\Users\{用户}\AppData\Roaming\com.ai-canvas.desktop\` |
| **Windows 回退 3** | exe 目录不可写 → 退回 AppData | `C:\Users\{用户}\AppData\Roaming\com.ai-canvas.desktop\` |
| **Windows debug** | 开发模式始终用 AppData（防止 cargo clean 删数据） | `C:\Users\{用户}\AppData\Roaming\com.ai-canvas.desktop\` |
| **macOS** | 系统 Application Support（平台规范） | `~/Library/Application Support/com.ai-canvas.desktop/` |
| **Linux** | 系统 XDG data dir | `~/.local/share/com.ai-canvas.desktop/` |

**`resolve_data_dir` 决策流程**（Windows release）：
```
exe 在 Program Files 下？ ──是──→ AppData
         │否
AppData 有 data.db 且 exe/data 没有？ ──是──→ AppData（旧版升级兼容）
         │否
能创建 exe/data/ 目录？ ──是──→ exe/data/（便携模式）
         │否
         └──→ AppData（最终回退）
```

**安全措施**：
- 启动时通过 `asset_protocol_scope().allow_directory()` 动态注册 data_dir，确保图片能正常显示
- `tauri.conf.json` 静态配置 `$APPDATA/**` 覆盖回退场景
- 便携模式下 API Key 存于 `data.db`，位置更显眼，用户分享安装目录时需注意

### 1.2 目录结构

```
{exe_dir}/                       ← Windows 便携模式：与 exe 同级
├── AICat.exe
├── 文件自动保存/                  ← 自动保存默认目录（友好命名，按项目分组）
│   ├── {项目标题}_{短ID}/
│   │   ├── 赛博猫_20260422_143021.png
│   │   ├── 风景画_20260422_143522.jpg
│   │   └── ...
│   └── {另一个项目}_{短ID}/
│       └── ...
└── data/                        ← data_dir
    ├── data.db                  ← SQLite 主数据库
    ├── data.db-wal              ← WAL 日志（Write-Ahead Logging）
    ├── data.db-shm              ← 共享内存文件
    └── media/
        ├── images/              ← AI 生成的图片/视频（内部存储）
        │   ├── {uuid}.png
        │   ├── {uuid}.jpg
        │   ├── {uuid}.webp
        │   └── {uuid}.mp4
        └── thumbnails/          ← 缩略图（预留目录）
```

> **Windows 便携模式（推荐）**：安装到 `D:\AICat\` → exe 在 `D:\AICat\AICat.exe`，
> 自动保存可见于 `D:\AICat\文件自动保存\`，数据库等内部数据在 `D:\AICat\data\`。
>
> **回退场景**（Program Files / exe 不可写 / debug）：自动保存目录会回退到 `{data_dir}/文件自动保存/`，
> 即和 `data/` 同级关系不再存在，整个自动保存目录嵌入到 `data/` 里面。具体规则见 [§3.2](#32-自动保存自动无需配置)。

---

## 2. SQLite 数据库表结构

数据库版本通过 `PRAGMA user_version` 管理，当前为 **v6**，共 7 张表。

### 2.1 `projects` — 画布项目

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| title | TEXT | 项目标题 |
| thumbnail | TEXT | 缩略图（base64 或路径） |
| node_count | INTEGER | 卡片数量（查询时动态计算） |
| deleted_at | TEXT | 软删除时间（v3 添加） |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 最后更新时间 |

### 2.2 `cards` — 画布卡片/节点

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| project_id | TEXT FK→projects | 所属项目 |
| type | TEXT | 卡片类型（text/image/video/chat 等） |
| x, y | REAL | 画布坐标 |
| width, height | REAL | 尺寸 |
| z_index | INTEGER | 层级 |
| locked | INTEGER | 是否锁定 |
| collapsed | INTEGER | 是否折叠 |
| color | TEXT | 卡片颜色 |
| title | TEXT | 卡片标题 |
| data | TEXT | **核心数据，JSON 格式**（提示词、图片路径、生成参数等） |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 最后更新时间 |

### 2.3 `connections` — 卡片连线

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| project_id | TEXT FK→projects | 所属项目 |
| source_card_id | TEXT | 起点卡片 |
| target_card_id | TEXT | 终点卡片 |
| created_at | TEXT | 创建时间 |

### 2.4 `settings` — 全局设置（含 API KEY）

| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT PK | 设置项名称 |
| value | TEXT | 设置值 |

详见 [第4节：settings 表完整 key 清单](#4-settings-表完整-key-清单)。

### 2.5 `agent_sessions` — AI Agent 会话

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| project_id | TEXT FK→projects | 所属项目 |
| messages | TEXT | 对话历史 JSON 数组 |

### 2.6 `chat_sessions` — 独立聊天会话

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| project_id | TEXT | 关联项目（可空） |
| title | TEXT | 会话标题 |

### 2.7 `chat_messages` — 聊天消息

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| session_id | TEXT FK→chat_sessions | 所属会话 |
| role | TEXT | 角色（user/assistant/system） |
| content | TEXT | 消息内容 JSON 数组 |
| metadata | TEXT | 元数据 |

---

## 3. 文件保存路径体系

AICat 采用 **三层文件保存**机制，自动保存路径无需用户配置：

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 内部存储（永远保存）                                        │
│    {data_dir}/media/images/{uuid}.{ext}                      │
│    所有 AI 生成的媒体文件都会先存到这里                           │
│    卡片 data 字段中引用此相对路径                                │
├─────────────────────────────────────────────────────────────┤
│ 2. 自动保存（自动复制一份，可配置）                              │
│    {file_auto_save_path | 默认目录}/{项目标题_短ID}/{友好文件名}   │
│    每次 AI 生成文件后自动同步一份可读副本                         │
│    默认目录 = "程序运行目录/文件自动保存"（启动时解析，见 §3.2.1）   │
├─────────────────────────────────────────────────────────────┤
│ 3. 手动导出（可选，用户触发）                                    │
│    settings key: file_export_path                             │
│    用户手动点击「下载/导出」时，从内部存储复制到此路径               │
│    回退：如果未设置，使用自动保存目录                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 内部存储

- **位置**：`{data_dir}/media/images/`
- **命名**：`{uuid}.{ext}`（如 `a1b2c3d4-e5f6-7890-abcd-ef1234567890.png`）
- **触发**：每次 AI 生成图片/视频时自动保存
- **引用**：卡片 `data` 字段中存储相对路径 `media/images/{uuid}.{ext}`
- **显示**：通过 Tauri asset protocol 转换为可显示的 URL

### 3.2 自动保存

- **位置**：用户在「设置 → 通用 → 自动保存路径」可配置；未配置则使用 [§3.2.1](#321-默认目录解析) 中解析的默认目录。
- **工作方式**：每次 AI 生成文件后，在写入内部存储的**同时**，自动复制一份到此目录。复制失败仅打 warning，不影响内部存储和卡片显示。
- **目录结构**：

```
{auto_save_base}/
├── {项目标题}_{项目ID前8位}/        ← 按项目分文件夹
│   ├── 赛博猫_20260422_143021.png
│   ├── 风景画_20260422_143522.jpg
│   └── ...
└── {另一个项目}_{ID前8位}/
    └── ...
```

- **文件命名**：`{prompt|卡片标题}_{YYYYMMDD_HHMMSS}.{ext}`，标题超过 40 个字符会被截断。
- **回退命名**：无 title 时使用 `{UUID前8位}_{YYYYMMDD_HHMMSS}.{ext}`。

#### 3.2.1 默认目录解析

`AppState::auto_save_default_dir` 在启动时一次性解析，所有"用户没设路径"的回退都用它（保证全代码路径一致，不会因为读 setting 时机不同而产生分歧）：

| 平台 / 场景 | 默认目录 | 备注 |
|------------|---------|------|
| Windows release，exe 同级目录可写 | `{exe_dir}/文件自动保存/` | **便携模式推荐**：用户能在安装目录里直接看到文件 |
| Windows release，exe 在 Program Files | `{data_dir}/文件自动保存/` | exe 同级不可写，落到 AppData |
| Windows release，exe 同级不可写 | `{data_dir}/文件自动保存/` | 任何其它 IO 错误也回退 |
| Windows debug | `{data_dir}/文件自动保存/` | 防止 cargo clean 误删 |
| Linux release | `{exe_dir}/文件自动保存/`（可写时） | 不可写时回退 `{data_dir}/文件自动保存/` |
| macOS release | `{data_dir}/文件自动保存/` | exe 在 .app/Contents/MacOS/，不适合放用户文件 |

旧版本使用的 `{data_dir}/auto-save/` 目录会在启动时自动迁移到新位置（仅当新目录不存在或为空时；冲突时保留两份并打日志）。

### 3.3 手动导出

- **设置入口**：设置 → 通用 → 导出路径
- **存储 key**：`file_export_path`
- **工作方式**：用户手动点击「下载/导出」按钮时，从内部存储复制到此路径
- **回退优先级**：`file_export_path` → `file_auto_save_path` → §3.2.1 默认目录
- **提示**：导出路径和自动保存路径的文件夹结构一致（按项目分组）

### 3.4 路径解析规则（Rust 侧）

**save_media（AI 生成时自动保存）**：
```
1. 写入内部存储 → {data_dir}/media/images/{uuid}.{ext}
2. 自动复制到  → resolve_auto_save_base() / {项目文件夹} / {友好文件名}

resolve_auto_save_base():
    settings.file_auto_save_path （非空） → 用户路径
    否则                                  → state.auto_save_default_dir
```

**export_file（手动导出）**：
```
file_export_path → file_auto_save_path → state.auto_save_default_dir
```

**open_in_explorer（打开文件所在位置）**：
```
1. 优先在 file_export_path 中查找用户友好的副本
2. 回退到 file_auto_save_path 中查找
3. 回退到 state.auto_save_default_dir 中查找
4. 兼容回退到 {data_dir}/auto-save/（旧版数据未迁移的兜底）
5. 最终回退到 {data_dir}/media/ 内部存储
```

**rename_project（项目改名时同步重命名子目录）**：
```
对每个候选基目录（settings.file_auto_save_path + state.auto_save_default_dir）：
  rename {base}/{旧标题_短ID}/ → {base}/{新标题_短ID}/
失败仅 warn，不影响数据库 rename。
```

---

## 4. settings 表完整 key 清单

### 4.1 API KEY 相关

| key | 说明 | 写入来源 |
|-----|------|----------|
| `openai_api_key` | 当前活跃的 Comfly API Key | 迁移 v4 / 前端设置 / migrateApiConfig |
| `openai_base_url` | Comfly Base URL | 迁移 v4 / 前端设置 |
| `comfly_api_key` | Comfly 当前活跃 key（同 openai_api_key） | 前端设置保存 |
| `comfly_base_url` | Comfly Base URL | 前端设置保存 |
| `comfly_api_keys` | 所有 Comfly key 列表（JSON 数组） | 前端设置保存 |
| `comfly_active_key_id` | 当前选中的 key ID | 前端设置保存 |
| `comfly_enabled` | 是否启用 Comfly | 前端设置保存 |
| `jijing_api_key` | 极境 API Key | 前端设置保存 |
| `jijing_base_url` | 极境 Base URL | 前端设置保存 |
| `jijing_api_keys` | 所有极境 key 列表（JSON 数组） | 前端设置保存 |
| `jijing_active_key_id` | 当前选中的极境 key ID | 前端设置保存 |
| `jijing_enabled` | 是否启用极境 | 前端设置保存 |
| `jijing_overseas` | 极境「海外用户」开关（`"true"` / `"false"`）。开启后所有极境请求改走 `global.snoworangekeji.cn` 香港线路；前端 `buildProxyUrl` 与 Rust `resolve_base_url` 都从此 key 读取。真相源:`src/providers/jijing/baseUrl.ts` | 前端设置保存 |

### 4.2 文件路径相关

| key | 说明 | 状态 |
|-----|------|------|
| `file_auto_save_path` | 用户自定义的自动保存根目录；为空时回退到 [§3.2.1](#321-默认目录解析) 中解析的默认目录 | **当前使用** |
| `file_export_path` | 手动导出路径；为空时按 [§3.3](#33-手动导出) 的回退链 | **当前使用** |

> **已废弃的 key**（旧数据库中可能存在，代码不再读写）：
> - `image_auto_save_path`（早期兼容 key）
> - `image_export_path`（早期兼容 key）

### 4.3 `api_keys` JSON 格式

```json
[
  { "id": "a1b2c3d4", "name": "生产环境", "key": "sk-xxxx..." },
  { "id": "e5f6g7h8", "name": "测试环境", "key": "sk-yyyy..." }
]
```

---

## 5. API KEY 生命周期

```
┌─ 首次启动（数据库迁移 v4）──────────────────────────────────┐
│  Rust: INSERT OR IGNORE INTO settings                     │
│        openai_base_url = "https://ai.comfly.org"          │
│  → 只写入默认 base_url，不写入 API Key                      │
│  → API Key 完全由用户在设置界面配置，不打包在程序中             │
└──────────────────────────────────────────────────────────┘
                          ↓
┌─ 每次启动（migrateApiConfig）───────────────────────────────┐
│  JS: 检查 openai_base_url 是否已存在                        │
│  → 如果不存在（新用户），写入默认 base_url                     │
│  → 如果已存在，跳过                                         │
│  → 不涉及任何 API Key 操作                                  │
└──────────────────────────────────────────────────────────┘
                          ↓
┌─ 用户配置 API Key ─────────────────────────────────────────┐
│  用户在设置界面输入 API Key → 存入 SQLite settings 表         │
│  完全本地存储，不随程序分发                                    │
└──────────────────────────────────────────────────────────┘
                          ↓
┌─ AI 请求时 ──────────────────────────────────────────────┐
│  前端: invoke("ai_proxy", { provider, endpoint, body })   │
│  Rust: read_api_config(&db, &provider)                    │
│        → SELECT value FROM settings                       │
│          WHERE key = '{provider}_api_key'                  │
│        → 拼接 base_url + endpoint，附带 Authorization 头    │
│        → 代理请求到 AI API                                 │
└──────────────────────────────────────────────────────────┘
```

---

## 6. WebView localStorage 存储

以 `ai_canvas_` 为前缀存储在 WebView 的 localStorage 中：

| key | 说明 | 敏感 |
|-----|------|------|
| `ai_canvas_auth_token` | 用户登录 JWT Token | 是 |
| `ai_canvas_auth_user` | 用户信息 JSON（id, username, email, status） | 否 |
| `ai_canvas_saved_credentials` | 保存的登录凭证 `{username, password}`（明文） | 是 |
| `ai_canvas_auto_login` | 是否启用自动登录（boolean） | 否 |
| `ai_canvas_server_base_url` | 后端服务器地址（默认 `http://101.37.80.236`） | 否 |
| `ai_canvas_viewport_{projectId}` | 每个项目的画布视口状态（缩放/位置） | 否 |
| `ai_canvas_setting_*` | 浏览器模式下的设置备份 | 否 |

以 `ai-canvas:` 为前缀的 Zustand 持久化设置：

| key | 说明 |
|-----|------|
| `ai-canvas:lastImageSize` | 上次选择的图片尺寸 |
| `ai-canvas:theme` | 主题偏好（light/dark/system） |
| `ai-canvas:lastModel:{category}` | 每类任务上次选择的模型 |

> localStorage 位于 WebView 的缓存目录中，清除应用数据或 WebView 缓存会丢失。

---

## 7. 涉及的源文件清单

### 后端 (Rust / src-tauri)

| 文件 | 职责 |
|------|------|
| `src/lib.rs` | `resolve_data_dir` / `resolve_auto_save_default_dir` 解析目录、迁移旧版 `auto-save/`、打开数据库、注册命令 |
| `src/db/mod.rs` | 数据库初始化（WAL 模式、外键、busy_timeout） |
| `src/db/migrations.rs` | 6 个版本的数据库迁移，含 API KEY 种子数据 |
| `src/commands/project.rs` | 项目 CRUD、卡片 CRUD、连线 CRUD、`get_setting`/`set_setting` |
| `src/commands/config.rs` | `read_api_config()` 从 settings 读取 provider 的 key/url |
| `src/commands/ai.rs` | AI 代理、`save_media`、`export_file`、`open_in_explorer`、`read_media_base64` |
| `src/commands/chat.rs` | 聊天会话和消息 CRUD |
| `src/commands/gateway.rs` | 模型列表、任务轮询、连接验证 |
| `src/commands/clipboard.rs` | 剪贴板读写 |

### 前端 (TypeScript / src)

#### 平台层 (platform/)
| 文件 | 职责 |
|------|------|
| `platform/index.ts` | 统一导出所有平台 API |
| `platform/runtime.ts` | Tauri 环境检测、`invoke`/`listen` 懒加载 |
| `platform/storage.ts` | localStorage 封装（`lsGet`/`lsSet`） |
| `platform/settings.api.ts` | `getSetting`/`setSetting`、`migrateApiConfig`、`hasApiKey` |
| `platform/media.api.ts` | `saveMedia`/`readMediaBase64` Rust 命令桥接 |
| `platform/viewport.api.ts` | 视口状态读写（localStorage） |
| `platform/auth.api.ts` | 登录 Token 存储（localStorage） |
| `platform/ai.api.ts` | AI 代理/流式/模型列表 Rust 命令桥接 |
| `platform/project.api.ts` | 项目 CRUD Rust 命令桥接 |
| `platform/card.api.ts` | 卡片 CRUD Rust 命令桥接 |
| `platform/connection.api.ts` | 连线 CRUD Rust 命令桥接 |
| `platform/chat.api.ts` | 聊天 CRUD Rust 命令桥接 |
| `platform/dialog.api.ts` | 系统对话框（目录选择） |
| `platform/clipboard.api.ts` | 剪贴板桥接 |
| `platform/file-drop.ts` | 文件拖放处理 |

#### 核心库 (lib/)
| 文件 | 职责 |
|------|------|
| `lib/media.ts` | 媒体持久化、显示 URL 转换、导出、后台重试 |
| `lib/autoSave.ts` | 画布卡片自动保存管理器（脏标记 + 定时批量写库） |
| `lib/tauri.ts` | 兼容层（重导出 platform/，仅 `lib/media.ts` 引用，待清理） |
| `lib/mappers.ts` | 前后端数据格式映射 |
| `lib/dataFlow.ts` | 数据流处理 |
| `lib/errors.ts` | 错误类型定义 |
| `lib/chatService.ts` | 聊天服务 |
| `lib/history.ts` | 操作历史（撤销/重做） |

#### 状态管理 (stores/)
| 文件 | 职责 |
|------|------|
| `stores/settingsStore.ts` | 主题、图片尺寸、模型偏好（Zustand + localStorage） |
| `stores/projectStore.ts` | 项目列表和当前项目 |
| `stores/cardStore.ts` | 卡片数据 |
| `stores/connectionStore.ts` | 连线数据 |
| `stores/canvasStore.ts` | 画布视口和交互状态 |
| `stores/uiStore.ts` | UI 状态（保存指示、弹窗等） |
| `stores/chatStore.ts` | 聊天状态 |
| `stores/authStore.ts` | 认证状态 |
| `stores/providerStore.ts` | AI Provider 状态 |
| `stores/agentStore.ts` | AI Agent 状态 |

#### UI (features/)
| 文件 | 职责 |
|------|------|
| `features/overlays/SettingsDialog.tsx` | 设置界面（API Key 管理 + 导出路径选择） |

### 配置文件

| 文件 | 关键配置 |
|------|----------|
| `tauri.conf.json` | `identifier: "com.ai-canvas.desktop"` → 决定 app_data_dir 路径 |
| `.env` | `VITE_COMFLY_BASE_URL`（仅 base URL，不含 API Key） |
| `.github/workflows/build.yml` | CI 中注入 `VITE_COMFLY_BASE_URL` 环境变量 |

---

## 8. 架构设计决策记录

### 8.1 数据目录策略：便携模式 vs 系统目录

**决策**：Windows 使用 exe 同级 `data/` 目录（便携），macOS/Linux 使用系统目录。

**原因**：
- Windows 用户通常选择安装到非系统盘（D:），期望数据跟随安装路径
- macOS 应用在 `.app` bundle 内，不适合存放用户数据
- 便携模式下换电脑只需拷贝整个安装目录

**实现**：`lib.rs` 中的 `resolve_data_dir()` 函数，Windows 优先尝试 exe 目录，失败则回退到 AppData。

### 8.2 自动保存路径演进

**v1：4 个冗余 key + 复杂回退链**
```
save_media:    file_auto_save_path → image_auto_save_path → 不保存
export_file:   file_export_path → file_auto_save_path → image_export_path → image_auto_save_path → 报错
open_explorer: 扫描全部 4 个 key 目录
```

**v2：精简到 2 个 key + 内部 auto-save/ 兜底**
```
save_media:    file_auto_save_path → {data_dir}/auto-save/
export_file:   file_export_path → file_auto_save_path → {data_dir}/auto-save/
```
问题：`rename_project` 漏掉了 `{data_dir}/auto-save/` 这一层 fallback —— 用户没设
`file_auto_save_path` 时改名项目，自动保存子目录不会跟着 rename，导致老文件孤儿化。
另外 `auto-save/` 这个英文名+嵌在 `data/` 深处，普通用户根本看不到。

**v3（当前）：默认目录抬到"程序运行目录/文件自动保存"，AppState 缓存**
```
启动时：state.auto_save_default_dir = resolve_auto_save_default_dir(data_dir)
       具体规则见 §3.2.1，简言之 Windows 便携模式 → exe 同级，否则 data_dir 内

save_media:    file_auto_save_path → state.auto_save_default_dir
export_file:   file_export_path → file_auto_save_path → state.auto_save_default_dir
rename_project: 对 {file_auto_save_path, state.auto_save_default_dir} 都尝试 rename
open_explorer: file_export_path → file_auto_save_path → state.auto_save_default_dir
                → {data_dir}/auto-save/ (旧版兼容) → {data_dir}/media/
```
迁移：启动时若发现旧版 `{data_dir}/auto-save/`，且新默认目录不存在或为空，自动 rename。

### 8.3 统一数据目录访问

**变更前**：`ai.rs` 中 7 处分散调用 `app.path().app_data_dir()`。

**变更后**：`AppState` 持有 `data_dir: PathBuf`，所有命令从 `state.data_dir` 读取。5 个命令移除了不再需要的 `AppHandle` 参数。

### 8.4 保留未删的部分

| 内容 | 原因 |
|------|------|
| `lib/tauri.ts` 兼容层 | 仅 `lib/media.ts` 引用已改为直接 import `@/platform`，文件暂保留 |
| DB 中已有的旧 key 行 | 不主动删除数据库行，只是代码不再读写 |
| 数据库迁移 v1-v6 代码 | 确保旧版本升级正常 |

---

## 9. 数据便携性

### Windows（便携模式 — 新安装）

```
D:\AICat\                    ← 安装目录
├── AICat.exe                ← 程序
├── 文件自动保存\              ← 自动保存默认目录（用户可见、按项目分组）
│   └── 我的画布_a1b2c3d4\
│       └── ...
└── data\                    ← 所有用户数据
    ├── data.db              ← 含 API Key，分享时注意
    └── media/images/
```

- 换电脑：整个 `D:\AICat\` 目录拷走即可
- **安全提示**：`data.db` 中存储了 API Key，分享/备份安装目录时需注意

### Windows 卸载/重装安全性

| 场景 | 数据是否安全 | 原因 |
|------|------------|------|
| 覆盖安装（不卸载） | **安全** | 安装器只覆盖 exe，不碰 data/ |
| 卸载后原路径重装 | **安全** | NSIS 卸载器不递归删 $INSTDIR，data/ 保留 |
| 卸载后换路径重装 | **旧数据孤立** | 新路径无数据，旧路径 data/ 残留 |
| 手动删除安装文件夹 | **数据丢失** | data/ 在安装目录中，一起被删 |

**保护措施**：
- NSIS 卸载 hook（`NSIS_HOOK_PREUNINSTALL`）：检测到 `$INSTDIR\data\data.db` 时弹出提醒
- 卸载程序本身**不会删除** data/ 目录

### Windows（旧版升级）

旧版用户升级后，数据**自动留在 AppData**（不会迁移到 exe/data），确保升级不丢数据。
如果用户希望迁移到便携模式，可手动将 AppData 中的 `data.db` 和 `media/` 拷贝到 `exe/data/`。

### macOS

```
~/Library/Application Support/com.ai-canvas.desktop/
├── data.db
├── media/images/
└── 文件自动保存/             ← 自动保存默认目录（macOS 不放到 .app 旁边）
```

- 遵循 macOS 标准数据存储规范
- 换电脑：需手动复制此目录
- **历史包袱**：早期 bundle identifier 为 `com.ai-canvas.app`（因与 `.app` 应用包扩展名冲突已弃用），
  老用户数据沉淀在 `~/Library/Application Support/com.ai-canvas.app/`。
  `resolve_data_dir()` 在 macOS 分支会自动检测此情况并把内容拷到新路径（[lib.rs](../src-tauri/src/lib.rs) `migrate_legacy_macos_identifier`）。

---

## 10. 设备绑定（一机一码）

### 10.1 整体架构

```
┌─ 客户端（Tauri Rust）─────────────────────────────────────┐
│  get_machine_code()     [待实现]                           │
│  ├─ Windows: HKLM\...\Cryptography\MachineGuid            │
│  └─ macOS:   ioreg IOPlatformUUID                         │
│  → 拼接 "ai-canvas:" + 原始ID → SHA-256 → 取前 32 字符     │
└────────────────────────────────────────────────────────────┘
                          ↓ machineCode
┌─ 前端（React）──────────────────────────────────────────────┐
│  authStore.login(username, password)    [待修改]             │
│  → invoke("get_machine_code") → machineCode                │
│  → apiLogin(username, password, machineCode)                │
└────────────────────────────────────────────────────────────┘
                          ↓ POST /api/auth/login
┌─ 服务端（Spring Boot）—— 已实现 ─────────────────────────────┐
│  AuthService.login()                                       │
│  → if machineCode 非空:                                     │
│       DeviceBindService.checkOrBind(userId, machineCode)    │
│       ├─ 无绑定记录 → 自动绑定（首台设备）                     │
│       ├─ 已绑定且匹配 → 通过                                 │
│       └─ 已绑定但不匹配 → 抛出 DEVICE_MISMATCH(40303)        │
│  → if machineCode 为空: 跳过校验  ← 当前状态                  │
└────────────────────────────────────────────────────────────┘
```

### 10.2 服务端实现（已完成）

#### 数据库表

```sql
-- user_device：一用户一设备（UNIQUE KEY uk_user_id）
CREATE TABLE user_device (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id       BIGINT NOT NULL,
    machine_code  VARCHAR(64) NOT NULL COMMENT '机器码 SHA-256',
    device_info   VARCHAR(256),
    bound_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    bound_ip      VARCHAR(64),
    UNIQUE KEY uk_user_id (user_id),
    KEY idx_machine_code (machine_code)
);

-- unbind_log：解绑操作审计
CREATE TABLE unbind_log (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id          BIGINT NOT NULL,
    old_machine_code VARCHAR(64),
    new_machine_code VARCHAR(64),
    ip               VARCHAR(64),
    operator         VARCHAR(16) DEFAULT 'user',   -- 'user' 或 'admin'
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- sys_config 相关键
-- unbind_limit_per_year = 1      每年用户自助解绑次数
-- unbind_cooldown_days = 0       两次解绑最短间隔天数
```

#### API 端点

| 端点 | 方法 | 说明 | 状态 |
|------|------|------|------|
| `/api/auth/login` | POST | 登录时校验 machineCode | 已实现（machineCode 可选） |
| `/api/user/device-info` | GET | 查询当前设备绑定信息和解绑余额 | 已实现 |
| `/api/user/unbind-device` | POST | 用户自助解绑并绑定新设备（有频率限制） | 已实现 |
| `/api/admin/user/force-unbind` | POST | 管理员强制解绑（不受频率限制） | 已实现 |

#### 错误码

| 错误码 | 枚举名 | 含义 |
|--------|--------|------|
| 40303 | `DEVICE_MISMATCH` | 当前设备与绑定设备不同 |
| 40304 | `UNBIND_LIMIT` | 本年解绑次数已用完 |
| 40305 | `UNBIND_COOLDOWN` | 解绑操作过于频繁 |

#### 核心逻辑（DeviceBindService）

| 方法 | 行为 |
|------|------|
| `checkOrBind(userId, machineCode, ...)` | 无绑定 → 自动绑定首台设备；已绑定且匹配 → 通过；不匹配 → 抛异常 |
| `unbindAndRebind(userId, newCode, ..., operator)` | operator="user" 时检查年度限额，删旧绑定+写新绑定+写解绑日志 |
| `getDeviceInfo(userId)` | 返回绑定状态、脱敏机器码、解绑余额（已用/剩余） |

### 10.3 客户端现状（未实现）

当前客户端的断裂点：

| 组件 | 现状 | 问题 |
|------|------|------|
| Rust 命令 | **不存在** `get_machine_code` | 无法获取硬件标识 |
| `authStore.ts` | `login()` 不传 machineCode | 服务端始终跳过校验 |
| `LoginWindow.tsx` | 自动登录不传 machineCode | 同上 |
| `deviceInfo` 参数 | 传 `navigator.userAgent` | 不是唯一标识，无法区分设备 |
| 错误处理 | 无 DEVICE_MISMATCH 处理 | 即使传了 machineCode 也没有 UI 反馈 |
| 设备管理 UI | 不存在 | 用户无法查看/解绑设备 |

### 10.4 实施计划

#### 阶段一：机器码生成（Rust）

**新建文件**：`src-tauri/src/commands/device.rs`

**Cargo.toml 新增依赖**：
- `sha2 = "0.10"` — SHA-256 哈希

**跨平台机器码获取策略**：

| 平台 | 数据源 | 稳定性 | 获取方式 |
|------|--------|--------|---------|
| Windows | `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` | 重装系统才变 | `std::process::Command` 执行 `reg query` |
| macOS | `IOPlatformUUID` | 硬件级，几乎不变 | `std::process::Command` 执行 `ioreg` 解析 |

**处理流程**：
```
原始 UUID
  → 拼接 "ai-canvas:" + UUID   （加盐防跨应用关联）
  → SHA-256 哈希
  → 取前 32 位十六进制          （最终 machineCode）
```

**降级策略**：如果获取硬件 ID 失败（权限不足等），生成随机 UUID 并持久化到 `{data_dir}/machine_id`，后续读取此文件。

**改动清单**：
| 文件 | 改动 |
|------|------|
| `src-tauri/src/commands/device.rs` | 新建，实现 `get_machine_code` 命令 |
| `src-tauri/src/commands/mod.rs` | 添加 `pub mod device;` |
| `src-tauri/src/lib.rs` | 注册 `commands::device::get_machine_code` |
| `src-tauri/Cargo.toml` | 添加 `sha2 = "0.10"` |

#### 阶段二：登录流程对接（前端）

| 文件 | 改动 |
|------|------|
| `stores/authStore.ts` | `login()` 签名改为 `login(username, password, machineCode?)`；内部调用 `invoke("get_machine_code")` 获取机器码后传给 `apiLogin` |
| `platform/auth.api.ts` | `apiLogin` 签名不变（machineCode 已是可选参数），无需改动 |
| `features/auth/LoginWindow.tsx` | 手动登录和自动登录前都先 `invoke("get_machine_code")`，传入 `login()` |

#### 阶段三：错误处理与设备管理 UI

**LoginWindow.tsx 错误处理**：

| 服务端错误码 | 前端行为 |
|-------------|---------|
| `40303` DEVICE_MISMATCH | 显示"当前设备与绑定设备不同"，提供"解绑并绑定此设备"按钮 |
| `40304` UNBIND_LIMIT | 显示"本年解绑次数已用完，请联系管理员" |
| `40305` UNBIND_COOLDOWN | 显示"操作过于频繁，请稍后再试" |

**设备管理（可选，SettingsDialog 或独立页面）**：
- 调用 `GET /api/user/device-info` 显示：绑定状态、脱敏机器码、绑定时间、剩余解绑次数
- 提供"解绑设备"按钮，调用 `POST /api/user/unbind-device`

### 10.5 边界情况

| 场景 | 行为 | 说明 |
|------|------|------|
| 首次登录（无绑定） | 自动绑定当前设备 | 服务端 `checkOrBind` 自动 INSERT |
| 同设备重装系统（Win） | MachineGuid 变化，视为新设备 | 需要解绑操作 |
| 同设备重装系统（Mac） | IOPlatformUUID 不变 | 自动通过 |
| 硬件 ID 获取失败 | 使用本地持久化的随机 UUID | 该 UUID 跟随 data_dir，便携拷贝仍有效 |
| 便携安装拷贝到新机器 | 硬件 ID 不同 → DEVICE_MISMATCH | 需要解绑 |
| machineCode 为空（旧版客户端） | 服务端跳过校验 | 向后兼容，不会阻止登录 |
| 虚拟机/容器 | 可能共享宿主机 UUID | 可接受 |
| 管理员强制解绑 | 不受年度限额 | 通过后台管理面板操作 |

---

## 11. 数据备份与恢复

> 起因：曾出现 Mac 用户反馈"重装应用后项目全没了"。根因主要有三类：
> ① bundle identifier 历史变更（`com.ai-canvas.app` → `com.ai-canvas.desktop`）
> ② AppCleaner / CleanMyMac 之类的卸载工具清掉了 `Application Support`
> ③ 用户为"干净重装"自己删了数据目录
>
> 第①类已通过 `migrate_legacy_macos_identifier` 自动迁移解决。
> 第②③类无法在 OS 标准目录里防御 —— 因此引入**异地自动备份**作为最后防线。

### 11.1 备份位置

```
~/Documents/AICat Data/backups/
├── data-20260514-093015.db
├── data-20260514-103015.db
├── ...
└── data-20260514-180015.db   ← 最新 10 份
```

**为什么放在 Documents 而不是 app_data_dir**：

| 位置 | 卸载/重装是否安全 | 卸载工具是否会清 |
|------|------------------|-----------------|
| `app_data_dir` | 看情况 | AppCleaner / CleanMyMac 会扫 bundle id 并清掉 |
| `Documents/` | 安全 | 几乎没有工具会动用户文档目录 |

跨平台路径解析（[backup.rs](../src-tauri/src/backup.rs) `resolve_backup_dir`）：

| 平台 | 备份目录 |
|------|---------|
| Windows | `%USERPROFILE%\Documents\AICat Data\backups\` |
| macOS | `~/Documents/AICat Data/backups/` |
| Linux | `~/Documents/AICat Data/backups/` |

### 11.2 备份触发时机

| 时机 | 行为 |
|------|------|
| 应用启动后 db::init 成功 | 立即写一份备份 |
| 运行中每 30 分钟 | tokio interval task 写一份 |
| 前端调用 `create_backup_now` | 手动触发一份 |

每次备份都会调用 `prune_old` 删除超出 `DEFAULT_MAX_KEEP = 10` 份的最早备份。

### 11.3 备份实现

使用 SQLite 的 `VACUUM INTO 'path'`，而非简单的 `fs::copy`。原因：
- 数据库运行在 WAL 模式，main db 文件不一定包含最新写入
- `VACUUM INTO` 会等到事务边界并生成完整快照，无需 checkpoint
- 生成的快照文件不带 WAL/SHM 后缀，单文件即完整

### 11.4 自动恢复

启动流程（[lib.rs](../src-tauri/src/lib.rs) setup）：

```
1. resolve_data_dir（含 macOS 旧 identifier 迁移）
2. resolve_backup_dir（解析 Documents 备份位置）
3. ── 检测 {data_dir}/.pending-restore 标记 ──
   有 → 用户上次会话点了"恢复某备份" → 立即执行 backup::restore_from
4. ── 检测 data.db 是否存在 ──
   不存在但备份目录有 → 自动从最新备份恢复（backup::restore_if_missing）
5. db::init
6. 写一份启动后备份
7. spawn 30 分钟定时备份 task
```

**自动恢复的标记**：恢复后会在 `{data_dir}/.restored-from` 写一行备份来源和时间，方便客服/用户事后追溯。

### 11.5 用户主动恢复（前端命令）

| 命令 | 用途 |
|------|------|
| `list_backups` | 返回所有备份的元信息列表（路径、大小、修改时间） |
| `get_backup_dir` | 返回备份目录绝对路径（用于在文件管理器中打开） |
| `create_backup_now` | 立即触发一次手动备份 |
| `prepare_restore(backup_path)` | 安排"下次启动时恢复"，写 `.pending-restore` 标记 |
| `cancel_pending_restore` | 取消已安排的恢复 |
| `get_pending_restore` | 查询是否有挂起的恢复 |

**为什么用"重启再恢复"而不是热替换**：
- 运行时替换需要让所有持有 db 连接的代码暂停，工程量大
- Windows 上正在打开的 db 文件不能直接被覆盖
- WAL 文件可能正在写入，热替换会导致数据撕裂

`prepare_restore` 在写标记前会校验：
- 备份文件必须存在
- 备份路径必须在 `state.backup_dir` 之下（防御任意路径写入）

恢复执行前会把当前 `data.db` 拷贝一份带 `.before-restore-{ts}` 后缀的副本作为"后悔药"，并清理 WAL/SHM。

### 11.6 灾难场景覆盖矩阵

| 场景 | 自动应对 | 用户感知 |
|------|---------|---------|
| Mac 老 identifier 升级 | `resolve_data_dir` 自动拷贝 | 无 |
| AppCleaner 清掉 Application Support | 启动时检测 db 缺失 → 从 Documents 备份恢复 | 项目最多丢失最近 30 分钟内的变更 |
| 手动删了 data/ 目录 | 同上 | 同上 |
| Windows 换路径重装 | 旧路径数据孤立 → 仍可通过 Documents 备份恢复 | 同上 |
| Documents 备份也被清 | 无法自动恢复 | 数据真正丢失（这是用户主动行为） |
| 数据库损坏 | 自动备份不能识别损坏，但定时备份有 10 份历史可手动回滚 | 用户在设置 UI 选某份回滚 |

### 11.7 不备份的内容

- **`media/` 媒体文件**：太大，备份成本高；用户可以重新生成
- **WebView localStorage**：浏览器层缓存，包含登录 Token，每次登录可重新获取
- **`auto-save/` 自动保存的友好副本**：是 `media/` 的可读版本，同样不备份

`data.db` 才是无可替代的（项目结构 + 卡片内容 + API Key + 设置）。媒体文件丢了能重做，项目结构丢了就是真没了。
