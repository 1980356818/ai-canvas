# AICat 自动化操作手册(给 AI 编程工具读)

> 你正运行在一台安装了 **AICat(AI 无限画布)** 的电脑上。本文件告诉你如何用它的本地自动化
> 接口操控软件:新建项目、创建卡片、连线、运行生成、取回结果——**全程不要碰软件内部的
> `data/` 数据文件**。

---

## 1. 能做 / 不能做

**能**:列/建/开项目、建/改/删卡片、连线、跑单卡或整组生成、查任务状态、读调用日志。

**不能(被接口设计拒绝)**:读取或修改 API Key;读取被封装(试用模板)卡片的提示词明文;
直接读写 `data/`(`data.db`、`media/`);改软件设置。这些会返回 `GATED` / 不提供对应动词。

---

## 2. 怎么连上

### 2.1 确认接口已开启
软件里:**设置 → 通用 → 「允许本机 AI 工具控制」** 打开。开启后生成发现文件 `bridge.json`:

- Windows 便携安装:`<安装目录>\data\automation\bridge.json`
- 其它平台 / 回退:`%APPDATA%\com.ai-canvas.desktop\automation\bridge.json`(macOS/Linux 为对应数据目录)

内容:
```json
{ "port": 11420, "token": "…64位…", "pid": 1234, "appVersion": "1.3.8", "apiVersion": 1 }
```
所有请求都要带头 `Authorization: Bearer <token>`。

### 2.2 软件没开 / 文件不存在
先启动 AICat 主程序,等最多 15 秒让 `bridge.json` 出现。若开关是关的,需要用户在设置里手动
打开一次(**无法远程开启**,这是安全设计)。

### 2.3 接入方式(二选一)

**MCP(推荐;Claude Code / Codex)** —— 设置界面有「复制接入命令」按钮,已填好端口和 token:
```
claude mcp add --transport http aicat http://127.0.0.1:<port>/mcp \
  --header "Authorization: Bearer <token>"
```
Codex:在 `~/.codex/config.toml` 加
```toml
[mcp_servers.aicat]
url = "http://127.0.0.1:<port>/mcp"
headers = { Authorization = "Bearer <token>" }
```

**REST(curl 兜底 / 任意脚本)** —— 统一 `POST /v1/call`,信封 `{verb, params}`:
```
curl -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"verb":"describe"}' http://127.0.0.1:<port>/v1/call
```
响应:`{"ok":true,"requestId":"…","data":{…}}` 或 `{"ok":false,"error":{"code":"…","message":"…"}}`。

---

## 3. 动词速查

> 第一步永远先调 `describe`,拿到所有动词的实时参数 schema。

| 动词 | 作用 | 关键参数 |
|------|------|----------|
| `describe` | 列出所有动词 + schema | — |
| `project.list` | 列项目 | — |
| `project.create` | 新建空项目 → `projectId` | `title` |
| `project.open` | 打开项目并等加载完成 | `projectId` |
| `canvas.snapshot` | 看画布现状(卡片+连线) | `projectId?` |
| `card.create` | 建卡 → `cardId` | `type`, `prompt?`, `size?`, `resolution?`, `model?`, `projectId?` |
| `card.update` | 改卡(标题/提示词/模型/尺寸) | `cardId`, `prompt?`, … |
| `card.delete` | 删卡(连带连线) | `cardId` |
| `connection.create` | 连线 source→target | `sourceCardId`, `targetCardId` |
| `connection.delete` | 删连线 | `connectionId` |
| `run.card` | 跑一张卡 → `taskId` | `cardId` |
| `run.group` | 跑一个分组 → `taskId` | `groupId` |
| `task.status` | 查任务状态/结果 | `taskId` |
| `task.cancel` | 取消任务 | `taskId` |
| `logs.tail` | 读调用日志排障 | `lines?` |
| `spec.import` | 一次性声明式导入整张工作流 | `spec`(含 cards/connections), `projectId?` |
| `spec.export` | 把项目导出为 spec | `projectId?` |

**声明式建图(`spec.import`)** —— 多卡工作流一次成型,比逐个动词更省事:
```jsonc
{ "specVersion": 1, "title": "九宫格", "cards": [
    { "ref": "p", "type": "text", "prompt": "白底极简产品图" },
    { "ref": "i", "type": "ai_image", "size": "1:1" } ],
  "connections": [ { "from": "p", "to": "i" } ] }
```

**卡片类型(`card.create` 的 `type`)**:`text`、`sticky_note`、`ai_image`、`ai_video`、
`ai_chat`、`ai_multiangle`、`ai_tryon`。

**异步约定**:`run.*` 立即返回 `taskId`(生成要 30–200 秒);轮询 `task.status` 直到
`state` 为 `succeeded` / `failed` / `cancelled`。

---

## 4. 两个完整示例

### 4.1 文生图一条龙
```
1. project.create  {title:"自动化测试"}                  → projectId
2. project.open    {projectId}
3. card.create     {type:"ai_image", prompt:"a cyber cat, neon, 4k", size:"1:1"}  → cardId
4. run.card        {cardId}                              → taskId
5. 轮询 task.status {taskId} 直到 state="succeeded"
6. 成品图在  <安装目录>\文件自动保存\  (按项目分文件夹)
```

### 4.2 提示词卡 + 连线(把提示词单独成卡,便于复用/改写)
```
1-2 同上
3. card.create {type:"text", prompt:"完整提示词…"}        → t1
4. card.create {type:"ai_image", size:"16:9"}            → i1
5. connection.create {sourceCardId:t1, targetCardId:i1}
6. run.card {cardId:i1}                                   → 运行时上游 t1 的文本会注入 i1
```

---

## 5. Prompt 渲染要点

- 图片卡最终提示词 = **上游连线注入的文本(按连线创建顺序)** + **本卡自身 prompt**,拼接而成。
- 想让某张图用某段提示词:要么直接写进图片卡的 `prompt`,要么建一张 `text` 卡连过去。
- `model` 省略时系统按卡片类型自动选默认模型;`size` 用比例(`1:1`/`16:9`/`9:16`);
  `resolution` 用档位(`2K`/`4K`,省略默认 2K)。

---

## 6. 红线(不要做)

- **不要**读写软件安装目录下的 `data\`(含 `data.db`、`media\`)——会损坏运行中的数据库,
  且格式随版本变化、不被支持。唯一写入面就是上面的动词。
- **取结果**去 `文件自动保存\`,不要去 `data\media\`。
- `run.*` 会**真实消耗用户额度**;批量运行前先确认意图。
- 失败了先调 `logs.tail` 看结构化日志(含错误码),再决定重试还是换法。
