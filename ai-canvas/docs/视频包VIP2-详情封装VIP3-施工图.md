# 视频版 / 视频详情版（两个新增试用等级 + 提示词封装）— 施工图

> 状态：**已对代码核对、定稿待开工**。本文是权威施工图，改动前先读。
> 关联：[会员等级体系设计.md](会员等级体系设计.md)、[平面模板试用版-提示词封装-施工图.md](平面模板试用版-提示词封装-施工图.md)。
> 文件名沿用历史（曾叫 VIP2/VIP3），实际定稿为两个**新增试用等级**，见 §3。

---

## 0. 一句话定位

用户要的"两个临时版本"**不是两个安装包**，而是在现有会员体系里**新增两个试用等级** + 复用已上线的封装管线。加上现有的，**一共三档试用**（均 `is_official=0`，带"升级"入口引导买全开 `vip1`）：

| 试用档 | 给什么（可用 + 可见） |
|---|---|
| `trial`（已有）| 现有 25 个「（试用）」封装副本 |
| **`trial-video`（新）= 版本一** | 现有试用副本 + `video` 分类；其余分类显示「升级可用」|
| **`trial-video-detail`（新）= 版本二** | 现有试用副本 + `video` + `detail`（这两类**提示词封装**、不给看）；其余「升级可用」|

门禁（`canUseTemplate`）、可见性（`canSeeTemplate`）、封装（`ENC1::`）、提示词框隐藏（`_locked`）、解码钩子——**全部现成**，1.3.8 已发版。本次工作量 ≈ 80% 服务端配置/数据 + 20% 客户端（**一个判定增强 + 文案集中化**）。

---

## 1. 架构总览（职责单一、数据驱动、便于拓展）

```
                       ┌─────────────────────────────────────────────┐
   单一真相(SoT)        │  服务端 aicat / 101.37.80.236                 │
   ─────────────       │                                               │
   "谁能用什么"  ──────▶│  tier_def.features         (等级 → 能力)       │
                       │     · templates: string[]|"*"                 │
                       │     · templateCategories: string[]  ★本次新增   │
                       │                                               │
   "模板长什么样/  ────▶│  template.definition (JSON) + category(列,权威) │
    提示词密文"        │     · cards[].data.content/_systemPrompt/...   │
                       │       = ENC1:: 密文 (video/detail)  ★本次封装   │
                       │     · cards[].data._locked = true              │
                       │     · min_app_version = '1.3.8'  (版本守卫)     │
                       └───────────────┬───────────────────────────────┘
                                       │ GET /api/templates?appVersion=<本机版本>
                                       │   (TemplateService.versionAllows 过滤 mav 高于本机的)
                                       ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │  桌面端 (≥1.3.8，本次只增强不重写)                                    │
   │                                                                     │
   │  entitlements.ts                                                    │
   │     canUseTemplate(ent, tpl)   ←★加 templateCategories（唯一逻辑改动）│
   │     canSeeTemplate(ent, tpl)   ←  不改（现有 !isOfficial 已正确，见 §3.1）│
   │       │                                                             │
   │       ├─ WorkflowGrid / NewProjectDialog / ContextMenu  (用 canUse) │
   │       │      locked = !canUseTemplate → <TemplateLockedCover/> ★集中  │
   │       │                                                             │
   │  promptCloak.ts  uncloak(content)   (生成前即时解码，已就绪/PROD 实证)│
   │  *Editor.tsx     data._locked → 隐藏提示词框 (已就绪)               │
   └───────────────────────────────────────────────────────────────────┘
```

**三条设计铁律（保证"逻辑正确、便于拓展"）**

1. **能力只来自服务端 `tier_def.features`**：客户端绝不硬编码"某等级能用什么"。加档 = 改库一行，零发版。
2. **按分类授权（不是按 id 清单）**：`features.templateCategories:["video"]` 表示"该分类全员可用"。以后 admin 新加视频模板，对应档**自动**纳入。
3. **封装是"按模板行就地"的、幂等的、分类驱动的**：一个可重跑脚本"把这些分类的提示词全封装"，遇 `ENC1::` 跳过。

---

## 2. 线上现状盘点（实时 `/api/templates`，共 60 个）

| 分类 | 数量 | min_app_version | 已封装? | id |
|---|---|---|---|---|
| **video 视频** | 8 | None | 否 | product-seeding / clothing-talk / content-replace / solo-replica / live-selling / drive-transform / clothing-fixed / clothing-show（前缀 `wf-`，后缀 `-video`）|
| **detail 详情页** | 4 | None | 否 | `wf-detail-cn` / `wf-detail-overseas` / `wf-hot-replica-main` / `wf-kv-poster` |
| trial 试用版 | 25 | **1.3.8** | **ENC + LOCK** | （封装方案的活样板）|
| flat 平面 | 21 | None | 否 | |
| digital-human | 2 | None | 无提示词 | |

---

## 2.1 已核对（代码佐证，2026-06-23 通读源码）

> 本计划的每条关键假设都已落到具体文件行，避免"凭记忆"：

| 断言 | 佐证 | 结论 |
|---|---|---|
| `canUseTemplate(ent, id:string)` 现签名收字符串 | [entitlements.ts:38](../src/lib/entitlements.ts) | 需改签名收 `{id,category}` |
| `canSeeTemplate` 现为 `trial → !ent.isOfficial` | [entitlements.ts:48](../src/lib/entitlements.ts) | 三档试用都 `is_official=0`→都可见副本；全开隐藏。**正好正确，不改** |
| `canUseTemplate` 全部直接调用点 = 4 处 | WorkflowGrid:164 / NewProjectDialog:389 / **ContextMenu:463** / entitlements.ts:67(canInsertTemplate 内) | 4 处都改传对象 |
| 锁角标"正式版"= 4 处 | WorkflowGrid:82、NewProjectDialog:429(模板)/359(空白)、**HomePage:281(空白)** | 集中到 1 组件 + 1 常量 |
| 升级文案 = 8 处 | WorkflowGrid:21、NewProjectDialog:400/343/264、ContextMenu:466、**HomePage:270/240、AIPromptInput:187** | 集中到 1 文案模块 |
| 服务端按 `min_app_version` 过滤 | [TemplateService.java:114 `versionAllows`](../../ai-canvas-server/src/main/java/com/aicat/server/service/TemplateService.java) | 真有；`appVersion` 空则放行全部 |
| 桌面端**总是**带 `appVersion` | [templateStore.ts:65 `getVersion()`](../src/stores/templateStore.ts) → [templates.api.ts:18](../src/platform/templates.api.ts) | 真机老客户端(1.3.3)发"1.3.3"→封装件被过滤，安全 |
| `category` 以**列**为权威 | [TemplateService.java:47-49](../../ai-canvas-server/src/main/java/com/aicat/server/service/TemplateService.java) | 封装改 definition 不动 category；门禁分类可靠 |
| `isOfficial` 读 `is_official` 列（非 rank≥10） | [TierService.java:62-65](../../ai-canvas-server/src/main/java/com/aicat/server/service/TierService.java) | 试用档 rank 任意排 + 显式标 0 |
| 解码钩子已就绪 | `lib/promptCloak.ts` + 试用封装 PROD 实证（见 [[project_ai_canvas_trial_prompt_cloak]]）| 生成链路零改 |

---

## 3. 决策记录（已定稿）

### 3.1 设计决策

| # | 决策 | 选型 | 理由 |
|---|---|---|---|
| D1 | 视频/详情提示词封装方式 | **就地封装(in-place)** | 封装按模板行，做不到"同模板对甲明文、对乙密文"；更护 IP。比"造副本"省 12 个冗余模板，最干净。|
| D2 | 白名单粒度 | **按分类授权 `templateCategories`** | 加模板免维护白名单；向后兼容旧 id 清单。|
| D3 | 锁文案/锁角标 | **集中到 1 文案模块 + 1 组件** | "正式版"散在 5 文件、8+4 处；集中后改一处生效，不扎推。|
| D4 | 两个"版本"的载体 | **新增 2 个试用等级**（不复用 vip2/vip3）| vip2/vip3 在递进会员线上，塞会与"只升不降"倒挂；试用档更贴业务（引流→升级买全开）。|
| **D5** | **`canSeeTemplate` 是否要改** | **不改**（维持现有 `trial → !isOfficial`）| 核对后发现：三档试用都 `is_official=0` ⇒ 现有规则已让它们都看得到 trial 副本（用户要的 B），全开 `is_official=1` 已隐藏副本。改反而要动测试、改语义。**少改一处、零测试回归。**|

### 3.2 等级阶梯（定稿，严格嵌套、非倒挂）

> **关键事实（已核 `TierService.isOfficial`）**：`isOfficial` 读 **`is_official` 列**、不是 `rank≥10`。试用档 rank 可任意排 + 显式标 0。

| tier_key | 展示名 | rank | is_official | features | 看到/用到 |
|---|---|---|---|---|---|
| `trial`（已有，改配置）| 试用版 | 0 | 0 | `{"templateCategories":["trial"],"allowBlank":true,"allowImport":false}` | 25 个封装副本 |
| **`trial-video`** | 视频版 | **4** | **0** | `{"templateCategories":["trial","video"],"allowBlank":true,"allowImport":false}` | 副本 + video，其余锁定 |
| **`trial-video-detail`** | 视频详情版 | **6** | **0** | `{"templateCategories":["trial","video","detail"],"allowBlank":true,"allowImport":false}` | 副本 + video+detail（封装），其余锁定 |
| `vip1` | VIP1·全开 | 10 | 1 | `{"templates":"*","allowBlank":true,"allowImport":true}` | 全部（`is_official` 隐藏副本）|
| ~~`vip2` / `vip3`~~ | — | — | — | — | **停用** `is_active=0` |

- 阶梯**严格嵌套、永不倒挂**：trial(副本) ⊂ 视频版(副本+video) ⊂ 视频详情版(副本+video+detail) ⊂ 全开；rank 0<4<6<10，"只升不降"完全自洽。
- **可见性沿用现有 `canSeeTemplate`**（不改）：trial 副本 `→ !isOfficial`。三档试用 `is_official=0` ⇒ 都可见副本；全开 `vip1` `is_official=1` ⇒ 隐藏副本（它用真模板）。非 trial 分类对所有人可见（未授予者由 `canUseTemplate` 算 `locked` 作升级引导）。
- **可用性走 `canUseTemplate` 的 `templateCategories`**：三档各自 grant 决定能用哪些；其余分类落 `locked`。
- 现有 `trial` 档由"id 白名单"改为 `templateCategories:["trial"]`（可用一并交给 grant，加副本免维护；`canSeeTemplate` 不依赖它、不受影响）。
- 注：视频详情版同时拿到"真 detail（就地封装）"和"detail 的 trial 副本"，详情页会出现两张同源卡（都封装）；可接受，若要去重可后续把 4 个 detail 的 trial 副本下架。

---

## 4. 客户端改造（≥1.3.8，只增强不重写）

> 原则：**一个判定增强（canUseTemplate）+ 文案/锁角标集中化**。不动 `canSeeTemplate`、不动渲染契约（见根 CLAUDE.md）、不碰生成/解码（已就绪）。

### 4.1 门禁：`canUseTemplate` 加"按分类授权"（唯一逻辑改动）

**`src/platform/auth.api.ts`** — `TierFeatures` 加字段：
```ts
export interface TierFeatures {
  templates?: string[] | "*";
  templateCategories?: string[];   // ★新增：整类授权
  allowBlank?: boolean;
  allowImport?: boolean;
  [k: string]: unknown;
}
```

**`src/lib/entitlements.ts`** — 归一化 + 判定（向后兼容，纯增量）：
```ts
export interface Entitlements {
  // …现有字段…
  templates: string[] | "*";
  templateCategories: string[];    // ★新增
  allowBlank: boolean;
  allowImport: boolean;
}

// entitlementsFromUser 内：
const templateCategories = Array.isArray(f.templateCategories) ? f.templateCategories : [];

// 改签名收 {id, category}，加分类命中（兼容 id 白名单 + "*"）
export function canUseTemplate(ent: Entitlements, tpl: { id: string; category: string }): boolean {
  if (ent.templates === "*") return true;
  if (ent.templateCategories.includes(tpl.category)) return true;   // ★整类授权
  return ent.templates.includes(tpl.id);
}

// canInsertTemplate 内部调用改传对象（:67）
//   return canSeeTemplate(ent, tpl) && canUseTemplate(ent, tpl);
//
// canSeeTemplate 保持不变。
```

**4 个直接调用点**改成传整个模板对象（都已有 `wf`/`tpl`，含 `.category`）：
- [WorkflowGrid.tsx:164](../src/features/home/WorkflowGrid.tsx) `canUseTemplate(ent, wf.id)` → `canUseTemplate(ent, wf)`
- [NewProjectDialog.tsx:389](../src/features/overlays/NewProjectDialog.tsx) `canUseTemplate(ent, wf.id)` → `canUseTemplate(ent, wf)`
- [ContextMenu.tsx:463](../src/features/overlays/ContextMenu.tsx) `canUseTemplate(ent, wf.id)` → `canUseTemplate(ent, wf)`（防御性二次校验，直接调用，**勿漏**）
- [entitlements.ts:67](../src/lib/entitlements.ts) `canInsertTemplate` 内 `canUseTemplate(ent, tpl.id)` → `canUseTemplate(ent, tpl)`

**测试** — `src/lib/__tests__/entitlements.test.ts`：
- `canUseTemplate` 用例（:78-90）改传对象 `{id,category}`；新增"按分类授权"用例：`templateCategories:["video"]` → `{category:"video"}` 可用、`{category:"flat"}` 不可用；`["trial","video"]` → trial+video 可用。
- `canSeeTemplate` / `canInsertTemplate` / `entitlementsFromUser` 用例**不变**（canSeeTemplate 未改；canInsertTemplate 入参本就是对象）。新增 `entitlementsFromUser` 解析 `templateCategories` 的小用例。

### 4.2 锁角标 + 升级文案：集中化（消除散落的"正式版"）

**新建 `src/config/membershipCopy.ts`**（升级相关文案单一真相）：
```ts
export const LOCK_BADGE_LABEL = "升级可用";
export const lockedTemplateMsg = (name: string) => `「${name}」升级会员后即可使用`;
export const BLANK_LOCK_MSG = "空白创作升级会员后解锁";
export const IMPORT_LOCK_MSG = "导入项目升级会员后解锁";
export const AI_CREATE_LOCK_MSG = "AI 自由创作升级会员后解锁";
```

**新建 `src/features/home/components/TemplateLockedCover.tsx`**（模板卡锁定遮罩，吃掉两处完全相同的 JSX）：
```tsx
import { Lock } from "lucide-react";
import { LOCK_BADGE_LABEL } from "@/config/membershipCopy";
export function TemplateLockedCover() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/30">
      <div className="flex items-center gap-1 rounded-full bg-black/65 px-2 py-1 text-[9px] font-medium text-white/90">
        <Lock className="h-2.5 w-2.5" /> {LOCK_BADGE_LABEL}
      </div>
    </div>
  );
}
```

**接入点（5 个文件，逐处对照 §2.1）**：
- [WorkflowGrid.tsx](../src/features/home/WorkflowGrid.tsx)：`:79-85` 模板遮罩 → `{locked && <TemplateLockedCover/>}`；`:21` → `lockedTemplateMsg(workflow.name)`。
- [NewProjectDialog.tsx](../src/features/overlays/NewProjectDialog.tsx)：`:426-432` 模板遮罩 → `<TemplateLockedCover/>`；`:359` 空白角标"正式版" → `LOCK_BADGE_LABEL`；`:400` → `lockedTemplateMsg(wf.name)`；`:343` → `BLANK_LOCK_MSG`；`:264` → `IMPORT_LOCK_MSG`。
- [HomePage.tsx](../src/features/home/HomePage.tsx)：`:281` 空白角标 → `LOCK_BADGE_LABEL`；`:270` → `BLANK_LOCK_MSG`；`:240` → `IMPORT_LOCK_MSG`。
- [ContextMenu.tsx](../src/features/overlays/ContextMenu.tsx)：`:466` → `lockedTemplateMsg(wf.name)`。
- [AIPromptInput.tsx](../src/features/home/AIPromptInput.tsx)：`:187` → `AI_CREATE_LOCK_MSG`。

> 空白卡角标（NewProjectDialog:359 / HomePage:281）是另一种小 pill 布局，只复用 `LOCK_BADGE_LABEL` 常量、不套 `<TemplateLockedCover/>`。
> **不动**会员管理 UI（UpgradeDialog / MembershipChip / SettingsDialog / TitleBar 里的"升级正式版"按钮、当前等级展示）——那是会员体系词汇，与本次"按功能上锁"无关。

> 客户端改动小结：**改 7 个文件 + 新增 2 个 + 改 1 个测试**（见 §11）。无渲染契约风险、无生成链路风险、无 `canSeeTemplate` 回归。

---

## 5. 服务端配置（tier_def，零发版即时生效）

新增两个试用等级 + 现有 trial 改 grant + 停用 vip2/vip3。按分类授权，不必枚举 id：

```sql
-- 版本一：视频版（试用档，rank 4，副本 + video）
INSERT INTO tier_def (tier_key,name,tier_rank,is_official,features,is_active,sort) VALUES
('trial-video','视频版',4,0,
 '{"templateCategories":["trial","video"],"allowBlank":true,"allowImport":false}',1,4)
ON DUPLICATE KEY UPDATE
 name=VALUES(name),tier_rank=VALUES(tier_rank),is_official=VALUES(is_official),
 features=VALUES(features),is_active=VALUES(is_active),sort=VALUES(sort);

-- 版本二：视频详情版（试用档，rank 6，副本 + video+detail）
INSERT INTO tier_def (tier_key,name,tier_rank,is_official,features,is_active,sort) VALUES
('trial-video-detail','视频详情版',6,0,
 '{"templateCategories":["trial","video","detail"],"allowBlank":true,"allowImport":false}',1,6)
ON DUPLICATE KEY UPDATE
 name=VALUES(name),tier_rank=VALUES(tier_rank),is_official=VALUES(is_official),
 features=VALUES(features),is_active=VALUES(is_active),sort=VALUES(sort);

-- 现有试用档：白名单改 grant（可用靠它，加副本免维护；canSeeTemplate 不依赖它）
UPDATE tier_def
SET features = JSON_SET(JSON_REMOVE(features,'$.templates'),
      '$.templateCategories', JSON_ARRAY('trial'))
WHERE tier_key = 'trial';

-- 顶档全开：确认 vip1=rank10、features.templates="*"（幂等兜一下）
UPDATE tier_def SET features = JSON_SET(features,'$.templates','*') WHERE tier_key='vip1';

-- 停用不再使用的 vip2/vip3（只下架不删，可回滚）
UPDATE tier_def SET is_active = 0 WHERE tier_key IN ('vip2','vip3');
```
> 改前 `SELECT tier_key,name,tier_rank,is_official,features,is_active FROM tier_def` 存档。改完 `GET /api/user/status`（或重登）刷新即生效。发码走 admin GenCodeDialog 选新等级（`requireTier` 仅校验存在）。
> 注：`trial` 改 grant 与新档配置**无需等发版**（`canSeeTemplate` 没改，新旧客户端可用性行为一致；唯一差别在封装件可见性，由 §7 时序保证）。

---

## 6. 数据封装（video+detail 就地封装，幂等、分类驱动）

### 6.1 复用与抽取（避免和 trial 逻辑分叉）

把"单卡提示词封装"的转换抽成共享函数，**derive-trial 与本次就地封装共用**（不扎推、不漂移）：
- 在 [scripts/promptcloak.py](../scripts/promptcloak.py) 旁补 `cloak_card_data(data) -> (data, changed)`：对 `content/_systemPrompt/_promptTemplate` 三键里非空且非 `ENC1::` 的字符串做 `cloak()`；命中则置 `_locked=true`，并在缺省时补 `_label`（取卡 `title` 或"提示词（已封装）"）、`_description`。
- [scripts/derive-trial-templates.py](../scripts/derive-trial-templates.py) 改为调用该共享函数（行为不变）。

### 6.2 新脚本 `scripts/cloak-templates.py`（就地封装，可回滚）

```
用法: python scripts/cloak-templates.py --categories video,detail [--write] [--uncloak]
默认 dry-run；--write 落库；--uncloak 反向（配合 mysqldump 双保险回滚）。

流程:
  1. 直连 101.37.80.236 MySQL aicat (root / AImao123456!)
  2. mysqldump 备份 template 表 → /tmp/aicat_template_bak_<ts>.sql   ← 先备份
  3. SELECT id,category,definition FROM template WHERE category IN (…) AND is_active=1
     （category 以列为准，与客户端一致 —— 见 §2.1）
  4. 逐行: json.loads(definition) → 遍历 cards 调 cloak_card_data → 任一卡变更则:
       UPDATE template
         SET definition = CONVERT(0x<hex(new_json)> USING utf8mb4),   -- hex 免转义
             min_app_version = '1.3.8'                                -- 版本守卫
       WHERE id = ?
  5. 校验: 重新 SELECT，断言提示词均 ENC1:: 且能 uncloak 还原；min_app_version='1.3.8'
```

**幂等**：遇 `ENC1::` 跳过；**可重跑**：admin 日后加视频模板，重跑 `--categories video` 即补封装。

### 6.3 为什么必须配 `min_app_version='1.3.8'`（已核对）

`<1.3.8` 客户端没有解码钩子，读到 `ENC1::` 会把乱码当提示词发上游 → 生成炸。靠版本守卫整体隐藏：
- 服务端 `TemplateService.versionAllows`（:114）：`encode(appVersion) >= encode(minAppVersion)` 才下发。
- 桌面端 `templateStore.load()`（:65）总是 `getVersion()` 带上真实版本 → 老客户端(1.3.3)发"1.3.3" → 封装件被过滤、看不到。
- 现有 25 个 trial 副本已是 `mav=1.3.8`，同一约束，无新风险。
- ⚠ 边界：`appVersion` 为空时服务端放行全部（:116）。仅 dev 浏览器（拿不到 `getVersion`）会这样，真机不会 —— 不影响线上安全。

---

## 7. 上线顺序（关键时序，不可颠倒）

```
① 客户端改完(§4) → 从当前 HEAD 构建 ≥1.3.8 安装包
     （顺带带上已就绪未发的修复：TLS 根证书 / 黑poster / 模板下载并发锁）
②  上传安装包到 app_release 并 promote 到 stable        ← 清掉长期挂着的 1.3.3 阻塞
③ 服务端配置 tier_def(§5)  —— 可与①②并行（canSeeTemplate 未改，老客户端无回归）
④ 等自动更新铺开后，跑封装脚本(§6 --write)             ← 必须在②之后
⑤ E2E 验证(§8)
```

> ⚠ 唯一硬前置：**步骤②的 promote 不做，视频详情版封装无法安全上线**（封装给 video/detail 打 `mav=1.3.8`，老客户端会丢这两类）。这一步需要你这边操作发版渠道。

---

## 8. 验证清单

**单元/构建**
- [ ] `npm test`（entitlements：canUseTemplate 改对象签名 + 分类授权新用例；canSeeTemplate 用例**应仍全绿**=无回归；buildRequests 跨语言对拍仍绿）
- [ ] `tsc -b` 0 错；改动文件 eslint 0

**服务端**
- [ ] `GET /api/templates?appVersion=1.3.8`：video/detail 提示词均 `ENC1::`、`_locked`、`min_app_version=1.3.8`
- [ ] `GET …?appVersion=1.3.7`：video/detail（与 25 trial 副本）被过滤
- [ ] `GET /api/user/status`：视频版 `features.templateCategories=["trial","video"]`、`isOfficial=false`；视频详情版 `["trial","video","detail"]`

**E2E（真账号或浏览器注入，见后台扫页 recipe）**
- [ ] 视频版登录：video + 25 个试用副本均可用；flat/detail/数字人显示「升级可用」+ 点击弹升级
- [ ] 视频详情版登录：video+detail + 25 副本可用；打开 video/detail 编辑器**看不到提示词框**（`_locked`）；运行能出图/出视频（解码生效）
- [ ] 现有试用版登录：仍能见+用那 25 个封装副本（grant 改造无回归）
- [ ] 全开 vip1 登录：看不到 25 副本（与改造前一致）

---

## 9. 拓展指南（体现"便于拓展维护更新"）

| 以后要做 | 怎么做 | 是否发版 |
|---|---|---|
| 新增一个视频模板 | admin 上架、`category=video` | 否；视频版/视频详情版经 `templateCategories` 自动可用 |
| 让新视频模板也封装 | 重跑 `python scripts/cloak-templates.py --categories video --write` | 否（脚本幂等）|
| 出一个"详情版"试用单卖 | 新 tier_key、`templateCategories:["trial","detail"]`、`is_official=0`、rank 排合适位置 | 否 |
| 改"升级可用"文案 | 改 `src/config/membershipCopy.ts` 一处 | 是（前端文案）|
| 调整等级阶梯 | 改 tier_def rank/features（注意非倒挂、`is_official` 列）| 否 |
| 真不可绕过的封装 | 生成走服务端代理（见会员设计 §8，本次仍是障眼法级）| 大改，另立项 |

---

## 10. 回滚预案

- **客户端**：上一个 stable 安装包；前端改动纯增量（只加 `canUseTemplate` 分支 + 抽文案/组件），回退 commit 即可。
- **tier_def**：改前 `SELECT … FROM tier_def` 存档；新档 `is_active=0` 即下架；`trial` 改回原 `templates` 白名单；vip2/vip3 改回 `is_active=1`。
- **封装数据**：`mysqldump` 备份恢复，或 `cloak-templates.py --uncloak --write`（同时清 `min_app_version`）。
- **解耦**：发版受阻时，§5 的新档可独立先上（门禁先生效，video/detail 暂不封装、明文可用），等②就绪再封装。

---

## 11. 改动清单（开工对照）

**客户端（7 文件改 + 2 新增 + 1 测试）**
- 改 `src/platform/auth.api.ts`（`TierFeatures` +`templateCategories`）
- 改 `src/lib/entitlements.ts`（`Entitlements` +字段、`entitlementsFromUser` 归一化、`canUseTemplate` 签名+分类命中、`canInsertTemplate` 内调用 :67；**`canSeeTemplate` 不动**）
- 改 `src/features/home/WorkflowGrid.tsx`（:164 传对象、:79-85 锁组件、:21 文案）
- 改 `src/features/overlays/NewProjectDialog.tsx`（:389 传对象、:426-432 锁组件、:359 角标、:400/:343/:264 文案）
- 改 `src/features/overlays/ContextMenu.tsx`（:463 传对象、:466 文案）
- 改 `src/features/home/HomePage.tsx`（:281 角标、:270/:240 文案）
- 改 `src/features/home/AIPromptInput.tsx`（:187 文案）
- 新 `src/config/membershipCopy.ts`、`src/features/home/components/TemplateLockedCover.tsx`
- 改 `src/lib/__tests__/entitlements.test.ts`（仅 canUseTemplate 用例 + entitlementsFromUser 一例）

**脚本（1 抽取 + 1 新增）**
- 改 `scripts/promptcloak.py`（抽 `cloak_card_data`）、`scripts/derive-trial-templates.py`（改调用）
- 新 `scripts/cloak-templates.py`

**服务端（无代码，仅数据）**
- `tier_def`：新增 `trial-video`/`trial-video-detail`（`is_official=0`）、现有 `trial` 改 `templateCategories:["trial"]`、停用 `vip2`/`vip3`、确认 `vip1="*"`（§5 SQL）
- `template` 表 video+detail 行的 `definition` + `min_app_version`（§6 脚本）
