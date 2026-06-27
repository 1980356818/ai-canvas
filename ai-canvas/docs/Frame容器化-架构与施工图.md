# Frame 容器化重构 — 架构与施工图

> 把「组(Group)」从 **`cardIds` 显式清单 + 成员外接框** 重构为真正的容器 **Frame**:
> **Frame 拥有自己存储的边界矩形,成员 = 落在框内的卡片(空间即真相)。**
>
> 与 `D:\Project\税东升\lumaxflow` 同款实现(画布代码镜像)。内部仍沿用 `group`/`card_groups`/`CardGroup` 标识,UI 概念为「容器/Frame」。**bounds 迁移 = v12**(与 lumaxflow 对齐):**跳过 v11** —— 部分历史/开发库已被一条早先(已移除)迁移占用到 `user_version=11` 且不含 bounds 列,设为 v11 会被这些库跳过,故用 v12 保证在 v10/v11 库上都执行。

## 1. 根因
旧模型:`card_groups.card_ids` 是用户手填清单,组矩形是成员卡的外接框。导入(`transfer::remap_group_card_ids` 静默丢弃未映射 id)/整组拖动/粘贴/打开项目都不做空间核对 → 「卡视觉在框里但不是成员」→ 连到框内非成员卡的连线被判跨组、画虚线。

## 2. 架构:边界为真相 + 成员派生缓存 + 单一校准权威
**唯一真相 = Frame 自存矩形 `{x,y,width,height}` + 卡片坐标;成员 = 中心点落在框内的卡。** `cardIds` 降级为派生缓存,由 `reconcileFrameMembership` 在每次几何提交时从边界重算。规则:中心点命中、重叠时成员粘性优先(既有成员留守原框,仅自由卡归最上层框)、折叠框成员冻结。不选纯派生:折叠会丢成员 + 多处消费点需可枚举成员集。

## 3. 数据模型(迁移 v12)
`card_groups` 加 `x/y/width/height REAL NOT NULL DEFAULT 0`(width=0 哨兵)。**打开项目回填**(`hooks/useProjectLifecycle.ts`):width===0 → 用成员外接框写回 + 落库(视觉零变化),随即 `reconcileFrameMembership` 自愈(导入掉组当场归位)。`card_ids` 列保留。

## 4. 关键文件
- 新 `src/lib/frameMembership.ts`:`cardsInFrame` + `reconcileFrameMembership`。
- `src/lib/groupBounds.ts`:`computeGroupBounds` 读存储边界(+按 group.id 的 dragOffset 平移、空框非 null、width===0 兜底退外接框);`computeEnvelopeBounds`=原外接框(回填/建框/粘贴用)。
- 新 `src/features/canvas/hooks/useGroupResize.ts`:8 向缩放手柄。GroupLayer 加 RESIZE_HANDLES/shellRef/标题栏宽 100%。
- `useGroupDrag.ts`:整框拖 offsets 加 group.id key + 松手提交边界 + reconcile。
- `CardShell.tsx`:拖卡松手用 reconcile 替换 hitGroupAt+add/remove。
- `hooks/useProjectLifecycle.ts`:打开项目 backfill + reconcile(**本仓 load 路径,非 lumaxflow 的 services/projectData.ts**)。
- 数据层:migrations v12、groups.rs、types/group.ts、mappers.ts、transfer.rs(`..clone()` 自动带边界)、clipboard.ts(粘贴用外接框)。

## 5. 产品决策
成员=中心点;移框带成员一起移 + 落点吸收新覆盖卡;Ctrl+G 建组保持恰好选中(首次几何变更后转空间);空框创建 UI 未做(模型已支持);不改内部名。

## 6. 与 lumaxflow 的差异
- 迁移号 v11(非 v12)。
- 打开项目 backfill+reconcile 在 `hooks/useProjectLifecycle.ts`(lumaxflow 在 `services/projectData.ts`)。
- 本仓 automation 为 `services/automation/verbs/*`(无 graph.ts 的 CardGroup 构造,故无需线程化)。
- clipboard MIME `ai-canvas-card/v3`、导出后缀 `.aicat`(均在编辑区之外,不受影响)。
