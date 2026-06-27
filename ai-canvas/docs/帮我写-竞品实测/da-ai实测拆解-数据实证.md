# 「帮我写」竞品 da-ai.cc 实测拆解（数据实证）

> 对象：`https://da-ai.cc/toolbox/video-generation` 的「帮我写」（AI 视频脚本生成）。
> 方法：Roxy 真机浏览器内注入 fetch/XHR 拦截器，真人操作走完 **分析素材 → 脚本配置 → 生成脚本 → 应用脚本** 全流程，抓取所有 API 请求/响应原文。**未生成视频**（仅到「应用脚本」止）。
> 原则：本文每条结论都对应一条抓到的请求/响应或 UI 实测；**无法从网络抓到的（如服务端系统提示词原文）一律标注为「逆向推断」，不臆造**。
> 配套原始证据：同目录 `da-ai-evidence-bundle.json`、`01-起始-素材已上传.png`、`02-生成的分镜脚本.png`。
> 本次实测素材：1 视频（@视频1，模特动态展示，15s）+ 2 图（@图片1 LOOK BREAKDOWN 拆解图、@图片2 模特多角度试穿）。商品=白色黑色波点无袖V领长连衣裙。

---

## 0. 一句话结论

> **da-ai 的「帮我写」不是一次 LLM 调用，而是一条服务端批处理流水线：`analyze`（多模态拆素材）→ 可选 `viral_breakdown`（参考视频拆解）→ `generate_script`（出脚本）。三段各自计费、各自落库、前端轮询。** 模型两段都用 **`gemini-3.5-flash`（经 `tencent` 供应商路由）**。脚本最终是 **markdown 文本**（不是结构化 shots[] JSON），通过 **`@素材标签`** 把镜头和上传素材绑定，「应用脚本」把这段 markdown 原样写进视频生成框当 prompt。

这条结论直接校验/修正了我们已有的 `docs/帮我写-分镜脚本节点-设计与施工图.md`，差异见 §9（最重要，给施工用）。

---

## 1. 整体架构（实测）

**服务端批处理 + 前端轮询**，三个端点：

| 端点 | 作用 |
|---|---|
| `POST /api/v1/credits/quote` | 计费预估（每个 job_kind 调一次，纯报价不执行） |
| `POST /api/v1/batches` | 创建批处理任务，返回 `batch_id` |
| `GET /api/v1/batches/{batch_id}` | 轮询任务状态/进度/结果（~1.5s 一次，直到 `status:"succeeded"`） |

鉴权：`Authorization: Bearer <JWT>`（HS256，sub=用户 UUID）。

**与我们设计的根本差异**：我们的设计是「客户端编排 + 走 JiJing 网关」（无服务端工作流）；da-ai 是**服务端 batch 流水线**，每个 batch 内部是有名字的 step 序列（见下）。我们的客户端编排路线对 ai-canvas 是合理简化，但要知道对方做得更重（可观测、可恢复、可重放都靠这套 batch 表）。

每个 batch 内部 `steps[]`（实测字段 `node_key / step_type / status / provider_code / model_code`）：

**analyze 批**（batch `479882b9…`）：
1. `load_prompt_context_assets`（system）→ 输出 `references`（素材 CDN URL，图片自动加 `?x-tos-process=image/resize,p_30` 压缩 → 用的是**火山引擎 TOS** 对象存储，域名 `cdn.da-ai.vip`）
2. `analyze_prompt_context`（model，**tencent / gemini-3.5-flash**）→ 输出 `analysis_payload`

**generate_script 批**（batch `2bcd2183…`）：
1. `load_prompt_context_assets`（system）
2. `validate_prompt_analysis_payload`（transform）→ 校验/规整第 1 步的分析结果
3. `generate_prompt_script`（model，**tencent / gemini-3.5-flash**）→ 输出 `generated_script` + `generated_scripts` + `script_variant_count`

---

## 2. 三步流水线 + 计费（实测原文）

打开「帮我写」先弹计费确认框，明细即三段流水线（截图实测）：

| # | 项目 | job_kind | pricing_rule_id | 单价 | 计费方式 |
|---|---|---|---|---|---|
| 1 | 分析我的素材 | `analyze` | `prompt-analyze-video` | 0.20 积分 | 整批计费 |
| 2 | 参考视频拆解（可选，未计入合计） | `viral_breakdown` | `prompt-viral-video` | 0.30 积分 | 整批计费 |
| 3 | 生成视频脚本（按条计费） | `generate_script` | `prompt-script-video` | 0.30 积分/条 | **单位计费 × candidate_count** |

- 预估合计 ≈ 0.50（= 分析 0.20 + 生成 1 条 0.30），参考视频拆解默认不计入。
- 「失败不扣对应项积分」属实：`actual_consumed_credits` 只在 `succeeded` 后等于 estimated。
- 计费规则版本 `2026-06-14.v25`（响应里带，说明他们规则是版本化的）。
- **关键点：生成是「按条」**——`candidate_count`/`generate_count` 决定生成几条脚本变体，按条乘价。我们设计目前只生成 1 条，对方支持 N 条（`generated_scripts[]` 数组）。

实测 token 用量（小，印证用 flash 足够）：
- analyze：input 4125 / output 2302
- generate：input 5958 / output 2602

---

## 3. 数据契约（抓到的真实 schema）

### 3.1 创建 analyze 批 — 请求体
```json
{
  "tool_slug": "prompt-generator",
  "target_tool_slug": "video-generation",
  "job_kind": "analyze",
  "reference_elements": [
    {"asset_id":"<uuid>.mp4","media_type":"video","mention_label":"视频1"},
    {"asset_id":"<uuid>.png","media_type":"image","mention_label":"图片1"},
    {"asset_id":"<uuid>.jpg","media_type":"image","mention_label":"图片2"}
  ],
  "video_settings": {"resolution":"720p","duration_seconds":15,"aspect_ratio":"9:16","generate_audio":true}
}
```
要点：素材只传 `asset_id + media_type + mention_label`（不传 URL，URL 由服务端 `load_assets` 步用 asset_id 拼）。`mention_label`（"视频1"/"图片1"）就是后面脚本里 `@视频1` 的来源。

### 3.2 analyze 输出 — `analysis_payload`（实测原文结构）
```json
{
  "product": {
    "detected": true,
    "name": "白色黑色波点无袖V领长连衣裙",
    "category": "女装-连衣裙",
    "features": ["经典黑白细碎波点图案","深V领设计，领口处带微折细节","背面V领低露背设计","无袖、收腰版型"],
    "selling_points": ["法式复古优雅风格，经典不过时","前后V领修饰颈部与背部线条","清爽无袖剪裁，适合夏日穿着"]
  },
  "audience": ["18-30岁年轻女性","钟爱法式复古、简约优雅风格的时尚女性","都市白领及大学生群体"],
  "scenarios": ["夏日日常出游与约会","海边度假或拍照打卡","日常休闲逛街","通勤穿着"],
  "elements": [
    {"id":"element_1","type":"video","mention":"@视频1","role":"主体参考","product_related":true,
     "desc":"模特上身示范蓝色挂脖设计荷叶边无袖上衣搭配白色宽松阔腿裤，展示整体穿着效果及走动时的动态形态。"},
    {"id":"element_2","type":"image","mention":"@图片1","role":"主体参考","product_related":true,
     "desc":"LOOK BREAKDOWN穿搭拆解图，展示白色黑色波点无袖V领长连衣裙、黑色单肩包（带挂饰）及黑色玛丽珍平底鞋的平面搭配。"},
    {"id":"element_3","type":"image","mention":"@图片2","role":"主体参考","product_related":true,
     "desc":"模特身穿白色黑色波点无袖V领长连衣裙的多角度试穿实拍，包含正面全身、背面、半身侧面以及领口设计细节。"}
  ]
}
```
**这就是「商品洞察」面板的数据源**，前端全部渲染成可增删的可编辑 chip（实测每个字段都是 textbox）。
- 比我们设计多的字段：`product.detected`（是否检测到商品——非电商场景的关键开关）、`elements[].role`（素材角色，如"主体参考"）、`elements[].mention`（@标签，**生成阶段绑定素材的命脉**）、`elements[].product_related`（素材是否与商品相关）。

### 3.3 创建 generate_script 批 — 请求体（实测）
```json
{
  "tool_slug": "prompt-generator", "target_tool_slug": "video-generation",
  "job_kind": "generate_script", "candidate_count": 1,
  "reference_elements": [ …同上三素材… ],
  "video_settings": {"resolution":"720p","duration_seconds":15,"aspect_ratio":"9:16","generate_audio":true},
  "source_analysis_batch_id": "479882b9…",          // 关联回 analyze 批
  "analysis_payload_snapshot": { …§3.2 整个分析结果（可被用户编辑后回传）… },
  "business_scene": "commerce",
  "shooting_method": "auto",    // 智能匹配 = "auto"
  "content_type": "auto",       // 智能匹配 = "auto"
  "analysis_edited": true,
  "viral_breakdown_payload": null,   // 开了参考视频拆解才有值
  "extra_instruction": null          // = 补充说明文本框
}
```
要点：generate 不重新分析，而是**把 analyze 的结果快照（用户可在 UI 改）+ 配置一起回传**。`source_analysis_batch_id` 做溯源。

### 3.4 generate 输出 — `generated_script`（实测原文结构）
```json
{
  "title": "15秒法式复古波点连衣裙种草视频脚本",
  "content": "## 视频总览\n- 整体风格关键词：…\n## 场景与光线\n- 场景一（暖调衣帽间）：…\n- 场景二（无影白背景）：…（参考 @图片2 的拍摄质感）…\n## 逐秒镜头拆解列表\n### 0-3s\n- 景别/角度：…\n- 运镜：…\n- 场景与对白：…（参考 @视频1）…\n- 旁白（轻快闺蜜语气）：“…”\n- BGM：…\n### 3-7s … ### 7-11s … ### 11-15s …",
  "summary": "该脚本专为女装电商带货设计，时长15秒…有效激发购买欲，促成交易转化。"
}
```
`generated_scripts` 是上面对象的数组（本次 1 条）。**注意：脚本是 markdown 文本，不是结构化 shots[] 数组**——这是与我们设计最大的一处契约差异（§9）。

---

## 4. 核心机制：`@素材标签` 闭环 + 子图区域引用（最值得抄）

这是 da-ai「分镜能用上传素材」的命脉，分三跳：

1. **analyze 给每个素材分配稳定标签** `mention:"@视频1"`（来自上传时的 `mention_label`）。
2. **generate 把标签织进脚本正文**，且**精确到子区域**。实测原文（@图片2 是一张多角度拼图，模型会指明用哪一格）：
   - `（参考 @图片2 右下半身局部图）`
   - `（参考 @图片2 右上细节）`
   - `（参考 @图片2 中间背影图）`
   - `（参考 @图片2 左一全身图）`
   - `（参考 @视频1）` 模仿动态、`（参考 @图片1，展示波点裙、黑色单肩包和黑色玛丽珍鞋）` 闪 LOOK 拆解图
3. **「应用脚本」把整段 markdown 写进主输入框当 prompt**，`@图片2` 以纯文本（编辑器里渲染成 chip，底层用零宽空格 `​图片2​` 包裹）保留；随后视频生成请求 `reference_elements` 仍带 asset_id，prompt 里的 `@标签` 映射回素材。

> 实测「应用脚本」后自动触发了一次视频报价 `POST /credits/quote (tool_slug:video-generation)`：`logical_model_key:"video.standard"` → 计费 label 显示 **`720p / Seedance-2.0-VIP / 输入15s / 输出15s` = 26.10 积分**。即脚本→视频是同一个 prompt 直送 Seedance-2.0-VIP。（**我没点「立即生成视频」，仅报价，未真生成。**）

**给我们的启示**：我们设计里 `materials[{ref, description}]` 必须显式带 `mention` 字段，生成提示词必须要求模型①只用已分配的 @标签 引用素材、②对多格拼图精确到"第几格/哪个区域"。这是脚本"可落地拍/可喂视频模型"的关键，目前设计文档没写死这条。

---

## 5. 模型与存储（实测）

- **模型**：`gemini-3.5-flash`，`provider_code:"tencent"`（经腾讯云路由）。**分析和生成都用同一个 flash 模型**——便宜快，token 量小（§2）足够。我们设计默认 `gemini-3.1-pro-preview`，可考虑分析/生成都降到 flash 档省钱提速。
- **存储**：火山引擎 TOS，`https://cdn.da-ai.vip/users/{userUUID}/assets/{assetId}.{ext}`；喂模型的图走 `?x-tos-process=image/resize,p_30`（压到 30% 再喂多模态，省 token，和我们 `r2v参考视频像素压缩` 思路一致）。视频直接喂原 mp4 URL。

---

## 6. 配置项全集（脚本配置步，实测）

第 2 步「脚本配置」表单（智能匹配=auto）：

| 维度 | 选项（UI 文案） | 实测取值 |
|---|---|---|
| 业务 | 电商带货 / 同城到店 / 上门服务 / 教育培训 | 顶层另发 `business_scene:"commerce"`（业务子类映射未完全抓到） |
| 语言 | 不限 / 中文 / 英文 / 日文 / 德文 / 法文 | `spoken_language`（本次"不限"→ null） |
| 内容类型 | 智能匹配 / 带货 / 种草 / 卖点钩子 / 剧情演绎 / 生活记录 | `content_type`（智能匹配→`"auto"`） |
| 拍摄方式 | 智能匹配 / 桌拍开箱 / 真人口播 / 一镜到底 / 运动跟拍 / 品牌TVC | `shooting_method`（智能匹配→`"auto"`） |
| 参考视频 | 开关；开后要**单独上传一条视频**做结构拆解（≠ 素材里的@视频1） | 开→走 `viral_breakdown` 批 |
| 补充说明 | 自由文本 | `extra_instruction` |

✅ **校验结果：我们设计文档 §3 的 `ScriptConfig` 枚举（business/language/contentType/shootingStyle 的取值）与实测逐项吻合**，可以放心施工。

**隐藏的完整 form_input 契约（实测 analyze 响应 `input_summary.form_input` 暴露，UI 智能匹配时全 null）**——这是 da-ai 底层的「高级参数集」，30+ 字段，是他们"方法"的全貌：

```
script_requirement, goal, style_direction, must_include, avoid_elements, extra_notes,
industry_primary, industry_secondary, marketing_scene, video_type,
audiences[], selling_points[], campaign_offer, product_name,
subject, subject_consistency, action, environment, camera_language, aesthetic, mood,
text_requirement, text_content, text_timing, text_position, text_animation, text_style,
dialogue_or_voiceover, audio_requirement, voice_tone_ref, audio_content_ref,
timeline, edit_instruction, must_keep, constraints,
image_usage, composition, lighting, negative_prompt
```
即对方简单 UI 之下，藏着一套结构化的「视频 prompt 要素」契约（主体/动作/环境/镜头语言/审美/情绪/文字/音频/时间线/负面词…）。我们 P3 富化阶段可参考此清单做"高级模式"。

---

## 7. 生成脚本的固定结构（实测，模型被要求严格遵守）

每条脚本恒定三段式：

1. **视频总览**：`整体风格关键词`（如"法式复古、优雅显瘦、日常松弛感"）+ `特别说明`（拍摄视角/模特声音调性，如"手持手机Vlog视角 + 闺蜜分享口吻"）。
2. **场景与光线**：**多个**场景，每个含布景 + 光线（实测 2 个：暖调衣帽间 / 无影白背景；后者还注明"参考 @图片2 的拍摄质感"）。
3. **逐秒镜头拆解列表**：按 `video_settings.duration_seconds` 切镜。**15s → 4 镜（0-3s / 3-7s / 7-11s / 11-15s）**。每镜恒定 6 个槽位：
   - `景别/角度`（如"中景、手持镜前自拍角度"）
   - `运镜`（如"手持微晃，随人物动作轻微左右跟摆"）
   - `场景与对白`（含 @素材引用，最长的一段）
   - `旁白（<语气标注>）`：**口播文案带语气标签**（轻快闺蜜语气 / 温柔种草 / 安利语气 / 热烈鼓动）——一条隐形的情绪递进线。
   - `BGM` 或 `音效`：每镜给节奏点（"法式Lofi渐入 → 节奏点 → 鼓点清晰 → 定音鼓收尾"）。

镜数随时长走（非固定 6–10），是从传入的 `duration_seconds` 推的。

---

## 8. 提示词逆向（**逆向推断，非抓到的原文**）

⚠️ 诚实声明：服务端模型调用的 `input_payload` 在所有 batch 响应里**恒为空 `{}`**（实测扫遍全部轮询响应确认），系统提示词**只在服务端、网络抓不到**。以下是**根据输出契约 + 进度文案 + 输出特征逆向出的提示词意图**，可直接拿去写我们自己的 `scriptPrompts.ts`，但**不是 da-ai 的原文**。

**分析提示词（多模态）** — 证据：输出 schema §3.2 + 进度文案"正在提炼商品卖点和使用场景 / 正在分析素材适合的脚本节奏 / 正在生成可转化为脚本的创意方向"：
> 你是电商短视频策划。给你若干已编号的素材（@视频1/@图片1/…）与视频规格。**只依据可见内容**客观提炼，禁止臆造。识别是否存在主推商品（`detected`），输出商品名/类目/特性/卖点、目标人群、使用场景；并为**每个素材**给一句话客观描述 + 角色（主体参考/氛围/…）+ 是否与商品相关 + 保留其 @标签。严格输出指定 JSON。

**生成提示词（文本）** — 证据：输出 §3.4 + 结构 §7 + @机制 §4：
> 你是资深带货短视频导演/编剧。基于【商品洞察 JSON】+【配置：业务/内容类型/拍摄方式/语言/补充说明】+【视频规格：时长 Ns、画幅、是否带音频】，写一条可直接拍摄的逐秒分镜。要求：① 三段式（视频总览/场景与光线/逐秒镜头拆解）；② 按时长切镜（每镜 3–4s）；③ 每镜给 景别·运镜·场景对白·旁白(带语气)·BGM/音效；④ **引用素材必须用且只用已给的 @标签**，多格拼图要精确到具体区域；⑤ 口播口语化、有钩子有 CTA；⑥ content 输出 markdown，另给 title 与 summary。`shooting_method/content_type="auto"` 时由你智能匹配最合适的形式。

---

## 9. 与现有设计文档（`帮我写-分镜脚本节点-设计与施工图.md`）的差异 / 优化建议

> ✅=实测验证我们设计正确，可放心施工；⚠️=实测与设计有差，建议改；➕=对方有、我们没有，建议补。

| # | 维度 | 我们的设计 | da-ai 实测 | 结论/建议 |
|---|---|---|---|---|
| 1 | ✅ 三段流水线 | 分析 #1 / 可选拆解 #1.5 / 生成 #2 | `analyze` / `viral_breakdown` / `generate_script` | **逐段对上**，设计方向正确 |
| 2 | ✅ 配置枚举 | business/language/contentType/shootingStyle 取值 | §6 逐项吻合 | 枚举不用改 |
| 3 | ✅ 应用脚本=写文本 result | `script→markdown→data.result` | 应用即把 markdown 当 prompt 直送 | 思路一致 |
| 4 | ⚠️ **生成输出契约** | 结构化 `StoryboardScript{overview, sceneLighting, shots[]}` 严格 JSON | 模型实际只出 **`{title, content(markdown), summary}`** | **二选一决策点**：(a) 抄 da-ai 出 markdown，最稳、可直接当 prompt、但失去逐镜结构化编辑；(b) 坚持我们更强的 shots[] JSON，能做逐镜预览卡，但长脚本严格 JSON 不稳，需 §5 防御解析 + 重试。**建议：让模型同时出 `summary` + 结构化 shots[]，序列化成 markdown 落 result**——兼得（对方的 summary 字段值得加） |
| 5 | ⚠️ 场景与光线 | 单对象 `sceneLighting:{scene,lighting}` | 实测**多个**场景（暖调衣帽间/无影白背景各带光线） | 改成 `scenes: {name, setup, lighting}[]` 数组 |
| 6 | ⚠️ 素材分析字段 | `materials:[{ref, description}]` | `elements:[{id, mention, type, role, desc, product_related}]` | **补 `mention`（@标签）字段**——这是 §4 闭环命脉，不能只有 ref/description |
| 7 | ➕ `product.detected` | 无 | 有，标识是否检测到主推品 | 补：非电商/无明确商品时走不同生成策略 |
| 8 | ➕ **@子区域引用** | 设计只抽象提到 @ 引用 | 实测精确到"@图片2 右下半身局部图" | 生成提示词**显式要求**多格图精确到区域（§4/§8） |
| 9 | ➕ 多脚本变体 | 只生成 1 条 | `candidate_count` → `generated_scripts[]`，按条计费 | 可选增强：一次出 N 条供挑选 |
| 10 | ➕ summary 字段 | 无 | 每条带一段卖点总结 | 低成本高价值，建议加 |
| 11 | 💡 模型选型 | 默认 `gemini-3.1-pro-preview` | 分析+生成都用 `gemini-3.5-flash` | token 量很小（<6k in），可降到 flash 档省钱提速；保证多模态视觉即可 |
| 12 | 💡 架构 | 客户端编排走网关 | 服务端 batch 流水线 + 轮询 | 我们客户端编排对单机 Tauri 合理；但「逐步落库 + `_wizardStep` 恢复」对应了对方 batch 的可恢复性，**保留这条设计**（§9 健壮性）很对 |

**最小改动清单（落到我们文档/类型）**：
1. `ProductInsights.materials[]` 项加 `mention: string`（@标签）、可选 `role`/`productRelated`/`detected`。
2. `StoryboardScript`：`sceneLighting` → `scenes[]`；新增顶层 `title`、`summary`。
3. `scriptPrompts.ts` 生成段：写死「只用 @标签引用素材 + 多格图精确到区域 + 按 `video_settings.duration_seconds` 切镜（每镜 3–4s）+ 旁白带语气 + 每镜给 BGM/音效 + 另出 title/summary」。
4. 模型默认档评估降到 flash（仅需视觉多模态）。
5.（可选）`config` 加 `candidateCount`，支持一次多条。

---

## 10. 附：原始证据文件

- `da-ai-evidence-bundle.json` — 三段 quote 报价 + analyze/generate 的请求体与结果（含完整 `analysis_payload`、`generated_script` 原文、steps、token、计费）。**不含 token/敏感头**。
- `01-起始-素材已上传.png` — 起始页（3 素材已挂）。
- `02-生成的分镜脚本.png` — 生成出的分镜脚本（向导第 3 步，@素材渲染成 chip）。

**实测边界（诚实声明）**：① 服务端系统提示词原文未抓到（§8 为逆向）；② 业务子类（同城到店等）→`business_scene` 的精确映射只抓到 commerce 默认；③ `viral_breakdown`（参考视频拆解）需另传一条本地视频，本次未跑该分支，仅从计费/UI 文案确认其存在与作用（"自动分析内容结构、拍摄方式与节奏亮点"）；④ 素材上传端点在我接管浏览器前已完成，未抓到上传协议（但已知 asset 存火山 TOS）。
