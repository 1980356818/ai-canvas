# Hermes Agent vs Claude Code 深度对比分析

> 基于源码级别的功能对比，分析两个 AI Agent 框架的架构差异与优劣

---

## 一、项目概览

| 维度 | Hermes Agent | Claude Code |
|------|-------------|-------------|
| **开发者** | Nous Research（开源社区） | Anthropic（商业公司） |
| **语言** | Python | TypeScript (Bun/React Ink) |
| **定位** | 自改进 AI Agent，多平台通信网关 | 专业代码辅助 CLI |
| **开源状态** | MIT 开源 | 源码泄露（npm sourcemap） |
| **模型支持** | 200+ 模型（OpenRouter/自定义端点） | 仅 Anthropic Claude 系列 |
| **工具数量** | 40+ 工具 | 40+ 工具 |
| **运行环境** | Linux/macOS/WSL2/Docker/SSH/Modal | 跨平台 CLI（Bun 运行时） |

---

## 二、核心功能对比总览

| 功能模块 | Hermes Agent | Claude Code | 优势方 |
|---------|-------------|-------------|--------|
| **上下文压缩** | 多阶段压缩 + 迭代摘要 + 工具裁剪 | 流式压缩 + 分析/摘要分离 + 缓存共享 | **Claude Code** ⭐ |
| **工具编排** | 工具集系统 + 子代理委派 + 代码执行 | Agent 工具 + Swarm 协调 + 延迟加载 | **Claude Code** ⭐ |
| **记忆系统** | MEMORY.md + 技能学习 + Session 搜索 | MEMORY.md + Dream 系统 + Session Memory | **Hermes** ⭐ |
| **多模型支持** | 200+ 模型自由切换，provider 路由 | 仅 Claude 系列 | **Hermes** ⭐⭐ |
| **通信平台** | Telegram/Discord/Slack/WhatsApp/Signal/微信/飞书/钉钉 等 15+ | 仅 CLI + IDE 集成 | **Hermes** ⭐⭐⭐ |
| **安全机制** | 命令审批 + DM 配对 + 容器隔离 | YOLO 分类器 + 权限模式 + 路径验证 | **Claude Code** ⭐ |
| **代码能力** | 终端 + 文件 + 搜索 + 补丁 | LSP + Bash + 文件编辑 + Grep + Glob + Notebook | **Claude Code** ⭐⭐ |
| **定时任务** | 内置 cron 调度器 + 平台推送 | Cron 工具（基础） | **Hermes** ⭐⭐ |
| **浏览器能力** | BrowserUse + Firecrawl + Browserbase + CamoFox | 无内置浏览器（依赖 MCP） | **Hermes** ⭐⭐ |
| **语音能力** | 语音模式 + TTS + 转录 | 基础语音支持 | **Hermes** ⭐⭐ |
| **RL 训练** | Atropos 环境 + 轨迹压缩 + 批量生成 | 无 | **Hermes** ⭐⭐⭐ |
| **可扩展性** | 插件系统 + 技能系统 + MCP | 插件 + Skills + MCP + Hooks | **持平** |
| **Prompt 缓存** | 无原生支持 | 原生缓存前缀共享 + 缓存中断检测 | **Claude Code** ⭐⭐ |

---

## 三、上下文压缩 —— 深度对比

### 3.1 架构设计哲学

#### Hermes Agent：「分层裁剪 + 辅助模型摘要」

```
阶段 1: 工具输出裁剪（零 LLM 成本）
  ├── 去重：MD5 哈希检测重复工具输出
  ├── 智能摘要：替换为 1 行结构化描述
  │   例: [terminal] ran `npm test` -> exit 0, 47 lines output
  └── 参数截断：JSON 感知的安全截断

阶段 2: 边界保护
  ├── 头部保护：系统提示 + 首轮对话（protect_first_n=3）
  ├── 尾部保护：Token 预算制（~20K tokens）
  └── 工具组完整性：不拆分 tool_call/tool_result 对

阶段 3: LLM 结构化摘要
  ├── 使用辅助模型（便宜/快速）
  ├── 结构化模板：14 个字段
  │   Active Task / Goal / Completed Actions / Active State /
  │   In Progress / Blocked / Key Decisions / Resolved Questions /
  │   Pending User Asks / Relevant Files / Remaining Work / Critical Context
  └── 迭代更新：保留前次摘要 + 增量合并

阶段 4: 完整性修复
  ├── 孤儿工具结果移除
  ├── 缺失工具结果填充存根
  └── 角色交替修复（避免连续 same-role）
```

**核心特点：**

- **可插拔引擎**：`ContextEngine` 抽象基类，支持第三方引擎（如 LCM）通过插件替换
- **辅助模型分离**：压缩使用独立的便宜模型，不消耗主模型预算
- **防抖机制**：连续 2 次压缩节省 <10% 则跳过，防止无限压缩循环
- **焦点压缩**：`/compress <topic>` 可指定保留某个主题 60-70% 的摘要预算
- **迭代摘要**：多次压缩时增量更新而非重写，信息保留率更高

#### Claude Code：「流式分析 + 缓存感知压缩」

```
阶段 1: 预处理
  ├── 图片/文档剥离：替换为 [image]/[document] 标记
  ├── 可重注入附件清理：跳过 skill_discovery/skill_listing
  └── Token 估算与阈值判断

阶段 2: LLM 流式摘要
  ├── 分析-摘要分离（<analysis> + <summary>）
  ├── 9 个结构化字段：
  │   Primary Request / Key Concepts / Files & Code /
  │   Errors & Fixes / Problem Solving / All User Messages /
  │   Pending Tasks / Current Work / Next Step
  ├── 缓存共享路径（forked agent 复用主对话缓存前缀）
  └── PTL 重试：prompt-too-long 时渐进截断头部

阶段 3: 后压缩恢复
  ├── 文件状态恢复：最近 5 个文件重新注入（50K token 预算）
  ├── 技能内容恢复：已调用技能重新注入（25K token 预算）
  ├── 计划模式保持：压缩后维持 plan mode 状态
  ├── 异步代理状态：保留运行中/已完成代理信息
  ├── 延迟工具重注入：差分计算，只注入缺失的工具
  └── Session hooks 重执行

阶段 4: 特殊模式
  ├── 部分压缩（partial compact）：支持 'from' / 'up_to' 方向
  ├── Session Memory 压缩：优先尝试轻量级会话记忆压缩
  ├── Context Collapse：高级上下文折叠系统（实验性）
  └── Reactive Compact：API 返回 prompt-too-long 时被动触发
```

**核心特点：**

- **缓存经济性**：forked agent 共享主对话 prompt 缓存，避免重复 cache_creation 费用
- **分析/摘要分离**：`<analysis>` 作为草稿被丢弃，`<summary>` 保留，提高摘要质量
- **部分压缩**：支持选择性压缩对话的前半段或后半段
- **后压缩状态恢复**：自动恢复文件、技能、计划、工具注册等上下文
- **断路器模式**：连续 3 次失败后停止自动压缩，避免浪费 API 调用

### 3.2 对比评分

| 对比维度 | Hermes Agent | Claude Code | 说明 |
|---------|:-----------:|:-----------:|------|
| **压缩策略完整性** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | CC 有部分压缩、Session Memory、Context Collapse 三层 |
| **信息保留精度** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Hermes 的 14 字段结构化模板 + 迭代更新更精确 |
| **成本效率** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | CC 的缓存共享显著降低压缩成本 |
| **后压缩恢复** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | CC 有文件/技能/计划/工具的全面恢复机制 |
| **模型兼容性** | ⭐⭐⭐⭐⭐ | ⭐⭐ | Hermes 支持任意模型，CC 绑定 Anthropic API |
| **错误处理** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | CC 有 PTL 重试、断路器、流式重试等完善机制 |
| **可扩展性** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | Hermes 的插件化引擎架构远超 CC 的硬编码实现 |
| **工具输出优化** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | Hermes 的 3 阶段工具裁剪 + 智能摘要更精细 |

### 3.3 核心代码差异

**Hermes 的工具输出智能摘要（零 LLM 成本）：**

```python
# 根据工具类型生成信息丰富的 1 行摘要
def _summarize_tool_result(tool_name, tool_args, tool_content):
    if tool_name == "terminal":
        cmd = args.get("command", "")[:80]
        exit_code = re.search(r'"exit_code"\s*:\s*(-?\d+)', content)
        return f"[terminal] ran `{cmd}` -> exit {exit_code}, {line_count} lines"
    
    if tool_name == "read_file":
        path = args.get("path", "?")
        return f"[read_file] read {path} ({content_len:,} chars)"
    # ... 20+ 工具类型的专用摘要模板
```

**Claude Code 的缓存共享压缩：**

```typescript
// 复用主对话的 prompt 缓存前缀，避免重复付费
const result = await runForkedAgent({
  promptMessages: [summaryRequest],
  cacheSafeParams,          // 继承主对话的缓存参数
  canUseTool: createCompactCanUseTool(), // 禁用工具
  maxTurns: 1,
  skipCacheWrite: true,     // 不写入新缓存
})
```

### 3.4 结论

**上下文压缩综合胜出：Claude Code** 🏆

Claude Code 胜在工程完整性——三层压缩策略（Session Memory → 标准压缩 → Reactive 压缩）、缓存共享降低成本、后压缩恢复机制、部分压缩支持。但 Hermes 在信息保留精度（14 字段结构化模板 + 迭代更新）和模型兼容性上有明显优势，其可插拔引擎架构也为未来扩展提供了更大空间。

---

## 四、工具编排 —— 深度对比

### 4.1 架构设计哲学

#### Hermes Agent：「工具集 + 委派 + 代码执行」

```
工具编排架构:
├── 工具集系统（Toolsets）
│   ├── 15+ 预定义工具集: web, terminal, file, browser, vision, delegation...
│   ├── 组合机制: toolset 可包含其他 toolset
│   ├── 平台专用工具集: hermes-cli, hermes-telegram, hermes-discord...
│   └── 动态解析: resolve_toolset() 递归展开嵌套
│
├── 委派系统（Delegate Tool）
│   ├── 子代理隔离: 独立对话、独立终端、独立工具集
│   ├── 并行模式: ThreadPoolExecutor 并发执行多个子任务
│   ├── 深度控制: MAX_DEPTH=2 防止递归委派
│   ├── 工具限制: 子代理不能委派/记忆/发消息
│   └── 最大 50 次迭代，心跳机制保活
│
├── 代码执行工具（execute_code）
│   └── 子代理可写 Python 脚本通过 RPC 调用工具
│
├── 工具注册表（Registry）
│   ├── 动态注册/注销
│   ├── 需求检查: check_fn 验证外部依赖
│   └── 平台门控: 某些工具仅在特定平台可用
│
└── Mixture of Agents（MoA）
    └── 多模型并行推理 + 聚合结果
```

**核心特点：**

- **灵活的工具集组合**：通过 `includes` 嵌套组合工具集，一个命令切换整套工具
- **真正的并行子代理**：`ThreadPoolExecutor` 实现并行委派，每个子代理完全隔离
- **代码即工具**：`execute_code` 让代理写脚本调用工具，零上下文成本
- **环境多态**：工具可运行在 Local/Docker/SSH/Modal/Daytona/Singularity 6 种后端
- **MoA 模式**：多模型并行推理后聚合，适合复杂决策

#### Claude Code：「Agent 工具 + Swarm 协调 + 延迟加载」

```
工具编排架构:
├── Agent 工具（AgentTool）
│   ├── 子代理生命周期管理: 创建/恢复/停止
│   ├── 独立 MCP 服务器: 每个 Agent 可定义专属 MCP
│   ├── 模型别名: 支持为不同 Agent 指定不同模型
│   ├── 工具过滤: allowedTools/disallowedTools 精确控制
│   ├── 内置 Agent: verificationAgent, statuslineSetup
│   └── Hook 系统: subagent_start hook 注入额外上下文
│
├── Swarm 协调（coordinator/）
│   ├── 多代理协同: teammateMailbox 消息传递
│   ├── 权限同步: permissionSync 跨代理权限一致
│   ├── 布局管理: teammateLayoutManager 终端布局
│   └── 重连机制: reconnection 断线重连
│
├── Task 系统
│   ├── TaskCreateTool: 创建后台异步任务
│   ├── TaskListTool: 列出所有任务状态
│   ├── TaskGetTool: 获取任务结果
│   ├── TaskStopTool: 停止运行中任务
│   └── TaskUpdateTool: 更新任务状态
│
├── 工具搜索（ToolSearchTool）
│   ├── 延迟加载: defer_loading 按需注入工具 schema
│   ├── 动态发现: 根据当前任务搜索可用工具
│   └── Token 节省: 未使用的工具 schema 不占上下文
│
├── KAIROS（前瞻性助手）
│   └── 监控日志，无需输入主动行动
│
├── ULTRAPLAN
│   └── 将复杂任务卸载到远程 Opus 4.6 会话（最长 30 分钟）
│
└── 权限系统
    ├── YOLO 分类器: 自动判断命令安全等级
    ├── 权限模式: plan/agent/debug/ask 四种模式
    ├── 交互式审批 + 自动审批
    └── 破坏性命令警告
```

**核心特点：**

- **延迟工具加载**：`defer_loading` 让工具 schema 按需注入，未使用的不占上下文
- **Agent 定义文件**：Markdown frontmatter 定义 Agent，支持自定义 prompt/工具/MCP
- **Swarm 多代理协同**：真正的多代理通信（mailbox 模式），不只是父子委派
- **Task 异步模型**：后台任务不阻塞主对话，结果异步获取
- **ULTRAPLAN**：深度规划卸载到专用 Opus 4.6 会话
- **四种权限模式**：plan/agent/debug/ask 精确控制工具权限

### 4.2 对比评分

| 对比维度 | Hermes Agent | Claude Code | 说明 |
|---------|:-----------:|:-----------:|------|
| **子代理隔离度** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Hermes 的 6 种环境后端隔离更彻底 |
| **并行能力** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | CC 有异步 Task 系统 + Swarm 协调 |
| **工具发现** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | CC 的 ToolSearchTool + defer_loading 更智能 |
| **多代理通信** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | CC 有 Swarm mailbox/权限同步/布局管理 |
| **模型灵活性** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | Hermes 子代理可用任意模型 |
| **MoA 能力** | ⭐⭐⭐⭐⭐ | ⭐ | Hermes 有原生 Mixture of Agents |
| **深度规划** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | CC 的 ULTRAPLAN 卸载到 Opus 4.6 |
| **权限控制** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | CC 的 4 种模式 + YOLO 分类器更精细 |
| **代码执行** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Hermes 的 execute_code 允许脚本编排工具 |
| **环境后端** | ⭐⭐⭐⭐⭐ | ⭐⭐ | 6 种执行环境 vs CLI 本地 |

### 4.3 核心代码差异

**Hermes 的委派系统（并行子代理）：**

```python
# 真正的线程池并行执行，每个子代理完全隔离
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task",   # 禁止递归委派
    "clarify",         # 禁止用户交互
    "memory",          # 禁止写入共享记忆
])
MAX_DEPTH = 2  # 最大嵌套深度

# 使用 ThreadPoolExecutor 并行执行
with ThreadPoolExecutor(max_workers=max_concurrent) as executor:
    futures = {executor.submit(run_child, task): task for task in tasks}
    for future in as_completed(futures):
        result = future.result()
```

**Claude Code 的延迟工具加载：**

```typescript
// 工具 schema 不预加载，按需发现注入
const useToolSearch = await isToolSearchEnabled(model, tools, ...)
const tools: Tool[] = useToolSearch
  ? [FileReadTool, ToolSearchTool, ...mcpTools.filter(t => t.isMcp)]
  : [FileReadTool]

// Agent 定义支持精确工具过滤
const resolvedTools = resolveAgentTools({
  allowedTools: agentDef.allowedTools,
  disallowedTools: agentDef.disallowedTools,
  parentTools: context.options.tools,
})
```

### 4.4 结论

**工具编排综合胜出：Claude Code** 🏆

Claude Code 在工具编排的工程深度上更胜一筹——延迟加载节省上下文、Swarm 多代理协同、Task 异步模型、ULTRAPLAN 深度规划。但 Hermes 在环境多样性（6 种后端）、模型灵活性（任意模型可用于子代理）和 MoA 能力上有独特优势。

---

## 五、各功能细分对比

### 5.1 记忆系统

| 特性 | Hermes Agent | Claude Code |
|-----|-------------|-------------|
| 持久化格式 | MEMORY.md + USER.md | CLAUDE.md（多层级） |
| 学习机制 | 自主技能创建 + 使用时自改进 | Dream 系统（后台巩固） |
| 用户建模 | Honcho 辩证用户建模 | 基础偏好记忆 |
| 会话搜索 | FTS5 全文搜索 + LLM 摘要 | Agentic Session Search |
| 记忆提供者 | 6 种可选（Honcho/Holographic/RetainDB/...） | 内置单一实现 |
| **优势方** | **Hermes** ⭐⭐ | |

### 5.2 安全机制

| 特性 | Hermes Agent | Claude Code |
|-----|-------------|-------------|
| 命令审批 | 白名单 + 交互审批 | YOLO 分类器 + 4 种权限模式 |
| 路径安全 | path_security 模块 | pathValidation + readOnlyValidation |
| Git 安全 | 基础 | gitSafety + 破坏性命令检测 |
| 容器隔离 | Docker/Singularity/Modal | 无原生容器隔离 |
| 隐身模式 | 无 | Undercover Mode（阻止泄露内部信息） |
| **优势方** | | **Claude Code** ⭐ |

### 5.3 MCP 集成

| 特性 | Hermes Agent | Claude Code |
|-----|-------------|-------------|
| MCP 支持 | 完整 MCP 客户端 | 完整 MCP 客户端 + OAuth |
| 工具网关 | Tool Gateway 中心化管理 | MCP 通道权限控制 |
| 凭证管理 | Credential Pools | OAuth 管理器 |
| **优势方** | **持平** | |

### 5.4 代码能力

| 特性 | Hermes Agent | Claude Code |
|-----|-------------|-------------|
| 终端 | terminal + process 管理 | Bash + PowerShell 双平台 |
| 文件操作 | read/write/patch/search | Read/Write/Edit + Glob + Grep |
| LSP | 无 | 内置 LSP 诊断 |
| Notebook | 无 | NotebookEditTool |
| 代码执行 | execute_code（Python 脚本） | 无独立代码执行工具 |
| **优势方** | | **Claude Code** ⭐⭐ |

---

## 六、总体评价

### Hermes Agent 的核心优势

1. **模型自由度**：200+ 模型无缝切换，不绑定任何供应商
2. **通信生态**：15+ 平台全覆盖，从 Telegram 到微信/飞书/钉钉
3. **自改进能力**：技能自主创建、使用时优化、跨会话知识积累
4. **运行环境多样性**：6 种终端后端，从 $5 VPS 到 GPU 集群
5. **研究价值**：RL 训练、轨迹压缩、批量评估，适合模型研究
6. **架构可扩展性**：插件化上下文引擎、记忆提供者、工具集组合

### Claude Code 的核心优势

1. **工程深度**：每个功能模块都有极致的错误处理和边界情况覆盖
2. **Prompt 缓存**：原生缓存共享显著降低 API 成本
3. **代码专精**：LSP 集成、Notebook 编辑、PowerShell 原生支持
4. **多代理协同**：Swarm 架构实现真正的多代理通信和协调
5. **深度规划**：ULTRAPLAN 卸载到 Opus 4.6 进行 30 分钟深度思考
6. **数据驱动优化**：BigQuery + Datadog + GrowthBook 全面遥测，每个决策都有数据支撑

### 选择建议

| 场景 | 推荐 | 原因 |
|------|------|------|
| 专业代码开发 | **Claude Code** | LSP 集成、代码编辑、工具编排更强 |
| 多模型/多平台 | **Hermes Agent** | 200+ 模型 + 15+ 通信平台 |
| 自部署/低成本 | **Hermes Agent** | 可用便宜模型 + serverless 休眠 |
| 企业级安全 | **Claude Code** | 权限系统更精细、审计更完善 |
| AI 研究/训练 | **Hermes Agent** | RL 环境 + 轨迹压缩 + 批量评估 |
| 自动化运维 | **Hermes Agent** | cron 调度 + 多平台推送 + 容器隔离 |
| IDE 深度集成 | **Claude Code** | 原生 Cursor/VS Code 集成 |

---

## 七、一句话总结

> **Hermes Agent** 是一个「什么都能做」的通用 AI Agent 平台，像一把万能的瑞士军刀；
> **Claude Code** 是一个「把代码写好」的专业代码助手，像一套精密的手术器械。

两者在各自的领域都做到了极致，选择取决于你的使用场景。如果你需要一个不绑定供应商、能接入各种平台、支持自改进的通用 Agent——选 Hermes；如果你需要一个在代码编写和多代理协同方面做到极致的专业工具——选 Claude Code。
