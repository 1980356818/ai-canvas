# AI 无限画布 — E2E 全自动测试计划

## 1. 项目概览

### 1.1 被测系统

| 项目 | 技术栈 | 运行位置 | 端口 |
|------|--------|----------|------|
| **AI 无限画布** (`ai-canvas`) | React 19 + Tauri 2 + Zustand + Vite 6 | 本机 | 1420 |
| **JiJing_Server** | Spring Boot + Java | 远程服务器 (`https://ai.snoworangekeji.cn`) | — |
| **JiJing_Open** | Vue 3 + Arco Design + Vite | 本机（获取 API Key 用） | 3200 |

### 1.2 系统关系

```
AI 无限画布 ──(sk-xxx API Key)──▶ JiJing_Server /v1/*
                                       ▲
JiJing_Open ──(JWT 登录)──────────────┘  (管理 API Key)
```

- **AI 无限画布**是纯消费者，只通过 `sk-` 前缀的 API Key 调用 JiJing 的 OpenAI 兼容接口
- **JiJing_Open**是开放平台控制台，登录后可创建/管理 API Key
- **JiJing_Server**后端已在远程运行，无需本地部署

### 1.3 AI 无限画布的核心功能

| 功能模块 | 描述 | 依赖 |
|---------|------|------|
| 首页 | 标题展示、AI 提示输入、项目/工作流网格 | Tauri（项目列表） |
| 项目管理 | 创建、列表、重命名、删除项目 | Tauri SQLite |
| 画布操作 | 平移、缩放、卡片拖拽、选择框选 | 纯前端 |
| AI 对话卡片 | 发送消息、流式回复、Markdown 渲染 | Tauri AI Proxy → `/v1/chat/completions` |
| AI 图片卡片 | 输入提示词生成图片、异步任务轮询 | Tauri AI Proxy → `/v1/images/generations` + `/v1/tasks/{id}` |
| 文本/便签卡片 | 富文本编辑、便签笔记 | Tauri（持久化） |
| 设置面板 | 配置 API Key、Base URL、测试连接、主题切换 | Tauri `get_setting`/`set_setting` |
| Agent 侧栏 | 工具调用、多轮对话 | Tauri AI Proxy |
| 模型列表 | 拉取可用模型 | Tauri → `/v1/models` |

---

## 2. 核心挑战与解决方案

### 2.1 Tauri 强绑定问题

**问题**：AI 无限画布是 Tauri 桌面应用，**所有核心功能**（项目 CRUD、设置存储、AI 调用、文件操作）都通过 `@tauri-apps/api` 的 `invoke()` 调用 Rust 后端。在纯浏览器中打开 `localhost:1420`，这些调用会直接报错，导致功能不可用。

**受影响的调用清单**（`src/lib/tauri.ts`）：

| 函数 | Tauri 命令 | 浏览器可用性 |
|------|-----------|-------------|
| `listProjects` | `list_projects` | ❌ |
| `createProject` | `create_project` | ❌ |
| `deleteProject` | `delete_project` | ❌ |
| `loadCards` | `load_cards` | ❌ |
| `saveCardsBatch` | `save_cards_batch` | ❌ |
| `aiProxy` | `ai_proxy` | ❌ |
| `aiProxyStream` | `ai_proxy_stream` | ❌ |
| `getSetting`/`setSetting` | `get_setting`/`set_setting` | ❌ |
| `listModels` | `list_models` | ❌ |
| `pollTask` | `poll_task` | ❌ |
| `validateConnection` | `validate_connection` | ❌ |
| `saveMedia` | `save_media` | ❌ |

### 2.2 解决方案：添加浏览器兼容适配层

在 `src/lib/tauri.ts` 中检测 Tauri 环境，若不可用则降级为：

| Tauri 功能 | 浏览器降级方案 |
|-----------|--------------|
| SQLite 设置 | `localStorage` |
| SQLite 项目/卡片 | `localStorage` + JSON |
| AI Proxy（非流式） | 浏览器 `fetch()` 直连 JiJing API |
| AI Proxy（流式） | 浏览器 `fetch()` + ReadableStream |
| 模型列表/任务轮询 | 浏览器 `fetch()` |
| 连接验证 | 浏览器 `fetch()` |
| 媒体保存 | Blob URL / 内存 |
| 窗口控制 | 隐藏标题栏按钮 |

**这使得 SuperDebugger 可以在浏览器中完整测试所有功能。**

---

## 3. 测试环境搭建

### 3.1 前置步骤

```
步骤 1: 安装依赖并构建 JiJing_Open（获取 API Key）
  cd D:\Project\JiJing
  pnpm install
  pnpm dev:open                    → http://localhost:3200

步骤 2: 通过 JiJing_Open 注册账号并创建 API Key
  - 注册 → 登录 → /apikeys → 创建密钥
  - 权限需包含: chat, image, model, task

步骤 3: 为 AI 无限画布添加浏览器兼容层（代码修改）
  修改 src/lib/tauri.ts，添加 isTauri 检测与降级逻辑

步骤 4: 启动 AI 无限画布前端
  cd D:\Project\AI无限画布\ai-canvas
  npm install
  npm run dev                      → http://localhost:1420
```

### 3.2 测试数据

| 项 | 值 |
|----|----|
| JiJing 后端地址 | `https://ai.snoworangekeji.cn` |
| API Key | 通过 JiJing_Open 动态获取（`sk-...`） |
| Base URL | `https://ai.snoworangekeji.cn` |
| 测试用户 | 自动注册（用时间戳生成唯一用户名） |

---

## 4. 测试用例详细设计

### Phase 0: JiJing_Open — 获取 API Key

> 使用 SuperDebugger 自动完成注册、登录、创建密钥的全流程

| 编号 | 用例名 | 步骤 | 预期结果 |
|------|-------|------|---------|
| P0-01 | 访问开放平台 | 打开 `http://localhost:3200` | 页面正常加载，显示登录页或落地页 |
| P0-02 | 注册新用户 | 导航到 `/register`，填写用户名/密码/确认密码，勾选协议，提交 | 注册成功，跳转登录页 |
| P0-03 | 登录 | 在 `/login` 填写用户名密码，提交 | 登录成功，跳转 `/dashboard` |
| P0-04 | 导航到密钥管理 | 点击侧栏「密钥管理」或访问 `/apikeys` | 密钥管理页加载 |
| P0-05 | 创建 API Key | 点击创建按钮，填写名称，选择 scopes（chat/image/model/task），提交 | 返回 `sk-` 开头的密钥，保存备用 |
| P0-06 | 验证 Key 显示 | 刷新密钥列表 | 新创建的 Key 出现在列表中（掩码显示） |

### Phase 1: AI 无限画布 — 基础 UI 与设置

| 编号 | 用例名 | 步骤 | 预期结果 |
|------|-------|------|---------|
| P1-01 | 首页加载 | 打开 `http://localhost:1420` | 显示「AI 无限画布」标题、AI 提示输入框、工作流网格 |
| P1-02 | 主题切换 | 打开设置 → 切换为深色主题 | `<html>` 元素添加 `dark` class，页面颜色变化 |
| P1-03 | 主题持久化 | 刷新页面 | 深色主题保持 |
| P1-04 | 打开设置面板 | 点击设置按钮/齿轮图标 | 设置对话框弹出，显示 API Key 和 Base URL 输入框 |
| P1-05 | 配置 API Key | 输入从 Phase 0 获取的 `sk-xxx` 密钥 | 输入框正确显示（密码类型） |
| P1-06 | 配置 Base URL | 输入 `https://ai.snoworangekeji.cn` | 输入框正确显示 |
| P1-07 | 保存设置 | 点击保存按钮 | 设置成功保存，显示成功提示 |
| P1-08 | 测试连接 | 点击「测试连接」按钮 | 连接成功提示（调用 `/v1/models` 验证） |
| P1-09 | 设置持久化 | 刷新页面 → 打开设置 | API Key 和 Base URL 仍然存在 |

### Phase 2: AI 无限画布 — 项目管理

| 编号 | 用例名 | 步骤 | 预期结果 |
|------|-------|------|---------|
| P2-01 | 创建新项目 | 在首页点击创建项目按钮或通过 AI 输入框 | 项目创建成功，进入画布视图 |
| P2-02 | 返回首页 | 在画布模式点击返回首页 | 回到首页，项目出现在网格中 |
| P2-03 | 项目列表展示 | 查看首页工作流网格 | 显示已创建的项目 |
| P2-04 | 重命名项目 | 右键项目 → 重命名 → 输入新名称 | 项目名更新 |
| P2-05 | 打开项目 | 点击项目卡片 | 进入画布视图，加载该项目的卡片 |
| P2-06 | 删除项目 | 右键项目 → 删除 → 确认 | 项目从列表移除 |

### Phase 3: AI 无限画布 — 画布操作

| 编号 | 用例名 | 步骤 | 预期结果 |
|------|-------|------|---------|
| P3-01 | 画布渲染 | 进入项目画布 | 画布区域正确渲染，无 JS 错误 |
| P3-02 | 画布平移 | 鼠标拖拽画布空白区域 | 画布视口平移 |
| P3-03 | 画布缩放 | 滚轮缩放 | 画布缩放，缩放指示器更新 |
| P3-04 | 添加文本卡片 | 通过工具栏或右键菜单添加文本卡片 | 新文本卡片出现在画布上 |
| P3-05 | 添加便签卡片 | 通过工具栏添加便签 | 便签卡片出现 |
| P3-06 | 卡片拖拽 | 拖拽卡片到新位置 | 卡片位置更新 |
| P3-07 | 卡片编辑 | 双击文本卡片 → 输入内容 | 文本正确保存 |
| P3-08 | 卡片删除 | 选中卡片 → 按 Delete 或右键删除 | 卡片从画布移除 |
| P3-09 | 多选操作 | 框选多张卡片 | 多张卡片同时选中 |
| P3-10 | 键盘快捷键 | Ctrl+Z 撤销 / Ctrl+Y 重做 | 操作正确回退/前进 |

### Phase 4: AI 无限画布 — AI 对话功能

| 编号 | 用例名 | 步骤 | 预期结果 |
|------|-------|------|---------|
| P4-01 | 添加 AI 对话卡片 | 通过工具栏添加 AI Chat 卡片 | AI 对话卡片出现，显示输入框 |
| P4-02 | 发送消息 | 在 AI 对话卡片中输入「你好，请介绍你自己」→ 发送 | 消息发送成功，显示发送中状态 |
| P4-03 | 流式回复 | 等待 AI 回复 | 回复文字逐步出现（流式效果），无报错 |
| P4-04 | Markdown 渲染 | 发送「用 markdown 写一个表格」 | 回复正确渲染 Markdown（表格、代码块等） |
| P4-05 | 多轮对话 | 连续发送多条消息 | 对话历史正确维护，上下文连贯 |
| P4-06 | 错误处理 | 配置错误的 API Key → 发送消息 | 显示友好的错误提示，不崩溃 |
| P4-07 | 首页快捷输入 | 在首页 AI 输入框输入问题提交 | 自动创建项目+AI 对话卡片，进入画布 |

### Phase 5: AI 无限画布 — AI 图片生成

| 编号 | 用例名 | 步骤 | 预期结果 |
|------|-------|------|---------|
| P5-01 | 添加 AI 图片卡片 | 通过工具栏添加 AI Image 卡片 | AI 图片卡片出现，显示提示词输入框 |
| P5-02 | 生成图片 | 输入「一只可爱的猫咪在花园里」→ 生成 | 显示加载状态，请求发送到 `/v1/images/generations` |
| P5-03 | 异步任务轮询 | 等待图片生成完成 | 轮询 `/v1/tasks/{id}`，完成后显示图片 |
| P5-04 | 图片展示 | 图片生成完毕 | 图片正确渲染在卡片中 |
| P5-05 | 生成失败处理 | 输入违规内容或超时 | 显示友好错误提示 |

### Phase 6: AI 无限画布 — 模型与高级功能

| 编号 | 用例名 | 步骤 | 预期结果 |
|------|-------|------|---------|
| P6-01 | 模型列表加载 | 打开模型选择器 | 从 `/v1/models` 获取并展示可用模型列表 |
| P6-02 | 切换模型 | 选择不同的模型 | 后续 AI 请求使用新选择的模型 |
| P6-03 | Agent 侧栏 | 打开 Agent 面板 | Agent 面板正确显示 |
| P6-04 | Agent 对话 | 在 Agent 面板发送消息 | Agent 正确回复，支持工具调用 |
| P6-05 | 自动保存 | 编辑卡片内容后等待 | 内容自动保存（Ctrl+S 也可手动触发） |
| P6-06 | 右键菜单 | 右键点击画布/卡片 | 显示上下文菜单，选项正确 |

### Phase 7: 稳定性与边界测试

| 编号 | 用例名 | 步骤 | 预期结果 |
|------|-------|------|---------|
| P7-01 | 无 API Key 使用 | 不配置 Key 直接使用 AI 功能 | 友好提示用户配置 Key |
| P7-02 | 无效 Key | 配置无效的 API Key | 测试连接失败，给出明确错误信息 |
| P7-03 | 网络中断恢复 | 断网 → 恢复 → 重试 | 恢复后功能正常 |
| P7-04 | 大量卡片性能 | 创建 20+ 张卡片 | 画布操作仍然流畅 |
| P7-05 | 页面刷新恢复 | 刷新浏览器 | 项目和设置正确恢复 |
| P7-06 | Console 无错误 | 全流程操作 | 浏览器控制台无 JS 错误 |

---

## 5. 实施步骤

### Step 1: 代码改造（浏览器兼容层）

修改 `ai-canvas/src/lib/tauri.ts`，添加环境检测：

```typescript
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
```

为每个 `invoke` 调用提供浏览器降级实现：
- 设置 → `localStorage`
- 项目/卡片 → `localStorage` + JSON 结构
- AI 代理 → `fetch()` 直连 JiJing API（`Authorization: Bearer sk-xxx`）
- 流式代理 → `fetch()` + `ReadableStream` SSE 解析
- 模型列表 → `fetch()` GET `/v1/models`
- 任务轮询 → `fetch()` GET `/v1/tasks/{id}`
- 媒体 → `Blob URL` 或 `data:` URL
- 窗口控制 → noop / 隐藏

### Step 2: 构建 JiJing_Open 并获取 API Key

```bash
cd D:\Project\JiJing
pnpm install
pnpm dev:open
```

使用 SuperDebugger 自动完成注册+登录+创建密钥。

### Step 3: 启动 AI 无限画布

```bash
cd D:\Project\AI无限画布\ai-canvas
npm install
npm run dev
```

### Step 4: 执行全自动 E2E 测试

使用 SuperDebugger 按 Phase 0 → Phase 7 顺序自动执行所有测试用例。

### Step 5: 生成测试报告

汇总所有用例的通过/失败状态、截图、Console 日志。

---

## 6. 测试工具链

| 工具 | 用途 |
|------|------|
| **SuperDebugger** (MCP) | 浏览器自动化、DOM 交互、截图、Console 监控、网络抓包 |
| `open_browser` | 打开被测页面 |
| `browser_click` / `browser_fill` | 表单填写与交互 |
| `browser_screenshot` | 每步截图用于报告 |
| `inspect_console_start/get` | 监控 JS 错误 |
| `inspect_deep_start/requests` | 验证 API 请求是否正确发出 |
| `assert_element_*` | 断言元素存在、文本、可见性 |
| `page_snapshot` | 获取页面完整快照 |

---

## 7. 预计时间

| 阶段 | 预计耗时 |
|------|---------|
| 代码改造（浏览器兼容层） | 30-45 分钟 |
| JiJing_Open 构建 + 获取 Key | 5-10 分钟 |
| AI 无限画布启动 | 2-3 分钟 |
| Phase 0 测试执行 | 5 分钟 |
| Phase 1-2 测试执行 | 10 分钟 |
| Phase 3-4 测试执行 | 15 分钟 |
| Phase 5-6 测试执行 | 15 分钟 |
| Phase 7 稳定性测试 | 10 分钟 |
| 报告生成 | 5 分钟 |
| **合计** | **约 1.5-2 小时** |

---

## 8. 风险与注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| JiJing_Server 不可用 | 所有 AI 功能测试失败 | 先 `validate_connection` 确认服务状态 |
| 注册可能需要邮箱验证 | Phase 0 被阻断 | 观察注册流程，必要时手动提供已有账号 |
| API Key 额度限制 | 大量测试消耗 quota | 控制每个测试用例的请求量 |
| 图片生成耗时长 | Phase 5 超时 | 设置合理的轮询超时（60-120 秒） |
| 浏览器兼容层可能不完美 | 部分功能降级行为与 Tauri 不一致 | 记录差异，标注为「仅限浏览器模式」 |
| CORS 问题 | 浏览器直连 JiJing API 被拦截 | 需要配置 Vite 代理或 JiJing 服务端允许跨域 |

---

## 9. 成功标准

- **Phase 0**: API Key 成功获取 ✅
- **Phase 1**: 设置面板功能全部正常，连接测试通过 ✅
- **Phase 2**: 项目 CRUD 全部正常 ✅
- **Phase 3**: 画布交互基本流畅 ✅
- **Phase 4**: AI 对话流式回复正常 ✅
- **Phase 5**: 图片生成流程完整（若后端支持） ✅
- **Phase 6**: 模型列表加载、Agent 基本功能 ✅
- **Phase 7**: 无 JS Console 错误、边界情况处理友好 ✅

**总体通过率目标**: ≥ 85%（考虑到部分后端依赖功能可能不完全可控）
