import type { WorkflowTemplate } from "@/types";
import { CARD_DEFAULTS, sizeFromRatio } from "@/shared/constants";

import whiteBgSource from "@/assets/templates/white-bg/source-photo.jpg";
import whiteBgRefined from "@/assets/templates/white-bg/refined-3d.jpg";
import whiteBgMultiAngle from "@/assets/templates/white-bg/multi-angle.jpg";
import tryonModel from "@/assets/templates/tryon/model.jpg";
import tryonGarment from "@/assets/templates/tryon/garment.jpg";
import tryonResult from "@/assets/templates/tryon/result.jpg";
import sceneReplacePerson from "@/assets/templates/scene-replace/person.jpg";
import sceneReplaceScene from "@/assets/templates/scene-replace/scene.jpg";
import sceneReplaceResult from "@/assets/templates/scene-replace/result.jpg";
import poseFissionPerson from "@/assets/templates/pose-fission/person.jpg";
import poseFissionResult from "@/assets/templates/pose-fission/result.jpg";
import faceMergePerson1 from "@/assets/templates/face-merge/person-1.jpg";
import faceMergePerson2 from "@/assets/templates/face-merge/person-2.jpg";
import faceMergeResult from "@/assets/templates/face-merge/result.jpg";
import lookFissionPerson from "@/assets/templates/look-fission/person.jpg";
import lookFissionResult1 from "@/assets/templates/look-fission/result-1.jpg";
import lookFissionResult2 from "@/assets/templates/look-fission/result-2.jpg";
import lookFissionResult3 from "@/assets/templates/look-fission/result-3.jpg";
import multimodalFusionPerson from "@/assets/templates/multimodal-fusion/person.jpg";
import multimodalFusionGarment from "@/assets/templates/multimodal-fusion/garment.jpg";
import multimodalFusionScene from "@/assets/templates/multimodal-fusion/scene.jpg";
import multimodalFusionPose from "@/assets/templates/multimodal-fusion/pose.jpg";
import multimodalFusionResult from "@/assets/templates/multimodal-fusion/result.jpg";
import mf6Person from "@/assets/templates/multimodal-fusion-6/person.jpg";
import mf6Garment from "@/assets/templates/multimodal-fusion-6/garment.jpg";
import mf6Scene from "@/assets/templates/multimodal-fusion-6/scene.jpg";
import mf6Pose from "@/assets/templates/multimodal-fusion-6/pose.jpg";
import mf6Result1 from "@/assets/templates/multimodal-fusion-6/result-1.jpg";
import mf6Result2 from "@/assets/templates/multimodal-fusion-6/result-2.jpg";
import mf6Result3 from "@/assets/templates/multimodal-fusion-6/result-3.jpg";
import mf6Result4 from "@/assets/templates/multimodal-fusion-6/result-4.jpg";
import mf6Result5 from "@/assets/templates/multimodal-fusion-6/result-5.jpg";
import mf2Person from "@/assets/templates/multimodal-fusion-2/person.jpg";
import mf2Garment from "@/assets/templates/multimodal-fusion-2/garment.jpg";
import mf2Tone from "@/assets/templates/multimodal-fusion-2/tone.jpg";
import mf2Scene from "@/assets/templates/multimodal-fusion-2/scene.jpg";
import mf2Result1 from "@/assets/templates/multimodal-fusion-2/result-1.jpg";
import mf2Result2 from "@/assets/templates/multimodal-fusion-2/result-2.jpg";
import mf2Result3 from "@/assets/templates/multimodal-fusion-2/result-3.jpg";
import mf2Result4 from "@/assets/templates/multimodal-fusion-2/result-4.jpg";
import mf2Result5 from "@/assets/templates/multimodal-fusion-2/result-5.jpg";
import studioLookPerson from "@/assets/templates/studio-look/person.jpg";
import studioLookGarment from "@/assets/templates/studio-look/garment.jpg";
import studioLookScene from "@/assets/templates/studio-look/scene.jpg";
import studioLookResult1 from "@/assets/templates/studio-look/result-1.jpg";
import studioLookResult2 from "@/assets/templates/studio-look/result-2.jpg";
import studioLookResult3 from "@/assets/templates/studio-look/result-3.jpg";
import studioLookResult4 from "@/assets/templates/studio-look/result-4.jpg";
import mirrorSelfiePerson from "@/assets/templates/mirror-selfie/person.jpg";
import mirrorSelfieGarment from "@/assets/templates/mirror-selfie/garment-cut.jpg";
import mirrorSelfieScene from "@/assets/templates/mirror-selfie/scene.jpg";
import mirrorSelfieResult1 from "@/assets/templates/mirror-selfie/result-1.jpg";
import mirrorSelfieResult2 from "@/assets/templates/mirror-selfie/result-2.jpg";
import mirrorSelfieResult3 from "@/assets/templates/mirror-selfie/result-3.jpg";
import mpPerson from "@/assets/templates/multimodal-pattern/person.jpg";
import mpGarment from "@/assets/templates/multimodal-pattern/garment.jpg";
import mpPose from "@/assets/templates/multimodal-pattern/pose.jpg";
import mpScene from "@/assets/templates/multimodal-pattern/scene.jpg";
import mpResult1 from "@/assets/templates/multimodal-pattern/result-1.jpg";
import mpResult2 from "@/assets/templates/multimodal-pattern/result-2.jpg";
import mpResult3 from "@/assets/templates/multimodal-pattern/result-3.jpg";
import mpResult4 from "@/assets/templates/multimodal-pattern/result-4.jpg";
import mpResult5 from "@/assets/templates/multimodal-pattern/result-5.jpg";
import kcPerson from "@/assets/templates/kids-clothing/person.jpg";
import kcGarment from "@/assets/templates/kids-clothing/garment.jpg";
import kcDetail from "@/assets/templates/kids-clothing/detail.jpg";
import kcScene from "@/assets/templates/kids-clothing/scene.jpg";
import kcResult1 from "@/assets/templates/kids-clothing/result-1.jpg";
import kcResult2 from "@/assets/templates/kids-clothing/result-2.jpg";
import kcResult3 from "@/assets/templates/kids-clothing/result-3.jpg";
import kcResult4 from "@/assets/templates/kids-clothing/result-4.jpg";
import kcResult5 from "@/assets/templates/kids-clothing/result-5.jpg";

import coverWhiteBg from "@/assets/templates/covers/white-bg.jpg";
import coverTryon from "@/assets/templates/covers/tryon.jpg";
import coverPoseFission from "@/assets/templates/covers/pose-fission.jpg";
import coverSceneReplace from "@/assets/templates/covers/scene-replace.jpg";
import coverFaceMerge from "@/assets/templates/covers/face-merge.jpg";
import coverLookFission from "@/assets/templates/covers/look-fission.jpg";
import coverMultimodalFusion from "@/assets/templates/covers/multimodal-fusion.jpg";
import coverMultimodalFusion6 from "@/assets/templates/covers/multimodal-fusion-6.jpg";
import coverStudioLook from "@/assets/templates/covers/studio-look.jpg";
import coverMirrorSelfie from "@/assets/templates/covers/mirror-selfie.jpg";
import coverMirrorSelfie1 from "@/assets/templates/covers/mirror-selfie-1.jpg";
import coverMultimodalFusion2 from "@/assets/templates/covers/multimodal-fusion-2.jpg";

// ── card sizes derived from actual template-image pixel ratios ──
const sz = (w: number, h: number) => sizeFromRatio(w / h);

const I_1792x2400  = sz(1792, 2400);   // 254×340  person / result (大量复用)
const I_1278x1644  = sz(1278, 1644);   // 264×340  tryon model, pose person
const I_1080x1440  = sz(1080, 1440);   // 255×340  3:4 exact
const I_720x900    = sz(720, 900);      // 272×340  4:5
const I_1536x2752  = sz(1536, 2752);   // 190×340  tall portrait
const I_1080x1621  = sz(1080, 1621);   // 227×340  ≈2:3
const I_624x1690   = sz(624, 1690);    // 126×340  garment cutout
const I_736x1308   = sz(736, 1308);    // 191×340  studio scene
const I_5760x3840  = sz(5760, 3840);   // 340×227  3:2
const I_3314x3072  = sz(3314, 3072);   // 340×315  refined
const I_5504x3072  = sz(5504, 3072);   // 340×190  multi-angle
const I_1970x2626  = sz(1970, 2626);   // 255×340  ≈3:4
const I_4936x6581  = sz(4936, 6581);   // 255×340  mf6 garment (3:4 exact)
const I_390x340    = sz(390, 340);      // 340×296  person landscape
const SQUARE       = sz(1, 1);          // 340×340  1:1
const PORTRAIT     = sz(3, 4);          // 255×340  3:4

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "wf-ai-chat",
    name: "AI 对话",
    description: "输入提示词，一键生成文字内容",
    icon: "MessageSquare",
    category: "chat",
    cards: [
      {
        type: "ai_chat",
        title: "生成文字",
        relativeX: 0,
        relativeY: 0,
        ...CARD_DEFAULTS.ai_chat,
      },
    ],
  },
  {
    id: "wf-ai-image",
    name: "AI 图片生成",
    description: "通过文字描述，一键生成高质量 AI 图片",
    icon: "ImageIcon",
    category: "image",
    cards: [
      {
        type: "ai_image",
        title: "AI 图片生成",
        relativeX: 0,
        relativeY: 0,
        ...CARD_DEFAULTS.ai_image,
      },
    ],
  },
  {
    id: "wf-content-plan",
    name: "内容策划",
    description: "AI 辅助制定内容策略，生成系列文案与配图方案",
    icon: "Layers",
    category: "composite",
    cards: [
      {
        type: "ai_chat",
        title: "内容策划",
        relativeX: 0,
        relativeY: 0,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: "请帮我制定一套完整的内容营销策划方案，包括主题、文案方向和配图建议。",
          result: "",
        },
      },
      {
        type: "text",
        title: "策划备注",
        relativeX: CARD_DEFAULTS.ai_chat.width + 40,
        relativeY: 0,
        ...CARD_DEFAULTS.text,
      },
    ],
  },
  {
    id: "wf-video-storyboard",
    name: "视频分镜分析",
    description: "拖入视频，AI 自动拆解每一个关键镜头，产出可复用的分镜脚本与关键帧时间戳",
    icon: "Clapperboard",
    category: "composite",
    cards: [
      {
        type: "ai_video",
        title: "视频原片",
        relativeX: 0,
        relativeY: 0,
        ...CARD_DEFAULTS.ai_video,
      },
      {
        type: "ai_chat",
        title: "分镜分析",
        relativeX: CARD_DEFAULTS.ai_video.width + 80,
        relativeY: 0,
        ...CARD_DEFAULTS.ai_chat,
        data: {
          model: "gemini-3.1-pro-preview",
          content: [
            "你是专业的视频分镜师。请仔细观看附带的视频，按时间顺序提取每一个关键镜头，产出可直接用于二次创作的分镜脚本。",
            "",
            "## 输出格式（三部分，按顺序全部输出，缺一不可）",
            "",
            "### 一、分镜表",
            "",
            "用 Markdown 表格列出全部镜头：",
            "",
            "| # | 时间区间 | 时长(s) | 镜头类型 | 运镜 | 画面描述 | 主体/动作 | 转场原因 |",
            "|---|---------|---------|---------|------|---------|----------|---------|",
            "",
            "字段规范：",
            "- 时间区间格式 `mm:ss-mm:ss`，精确到 0.5 秒",
            "- 镜头类型：大全景 / 全景 / 远景 / 中景 / 近景 / 特写 / 大特写 / 鸟瞰 / 仰拍 / POV",
            "- 运镜：固定 / 推 / 拉 / 摇 / 移 / 跟 / 升降 / 手持 / 环绕",
            "- 画面描述要具体可视化（色调、构图、光线、关键物体），足够让 AI 文生图复刻",
            "- 转场原因：开场 / 节奏切换 / 视点切换 / 情绪转折 / 信息补充 / 收尾",
            "",
            "### 二、整体分析",
            "",
            "- **叙事结构**：开场—发展—高潮—收尾如何拆分",
            "- **节奏**：平均镜头时长，有无长镜头或快剪段落",
            "- **视觉风格**：主色调、构图特点、统一的运镜风格",
            "- **声音线索**（若可推测）：配乐风格 / 旁白 / 关键音效",
            "",
            "### 三、关键帧 JSON（供下游程序抽帧、重制使用）",
            "",
            "```json",
            "{",
            "  \"shots\": [",
            "    {",
            "      \"index\": 1,",
            "      \"start\": 0.0,",
            "      \"end\": 3.2,",
            "      \"duration\": 3.2,",
            "      \"shot_type\": \"全景\",",
            "      \"camera_move\": \"推\",",
            "      \"description\": \"画面具体描述\",",
            "      \"subject\": \"主体/动作\",",
            "      \"keyframe_timestamp\": 1.5",
            "    }",
            "  ],",
            "  \"summary\": \"整段视频的一句话概括\",",
            "  \"total_duration\": 0.0",
            "}",
            "```",
            "",
            "## 注意事项",
            "",
            "1. 不要遗漏任何超过 0.5 秒的镜头，转场帧也算独立镜头",
            "2. 每个镜头给出最具代表性的 `keyframe_timestamp`（用于后续抽帧或重新生成）",
            "3. 描述要客观、具体、可视化，避免主观评价",
            "4. JSON 必须严格合法，可被程序直接解析",
          ].join("\n"),
          result: "",
        },
      },
      {
        type: "frame_extractor",
        title: "关键帧提取器",
        relativeX: CARD_DEFAULTS.ai_video.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: 0,
        ...CARD_DEFAULTS.frame_extractor,
      },
    ],
    connections: [
      // video → chat: Gemini 直接吃视频出分镜脚本
      { sourceIndex: 0, targetIndex: 1 },
      // chat → frame_extractor: 把分镜 JSON 喂给提取器
      { sourceIndex: 1, targetIndex: 2 },
      // video → frame_extractor: 直接告诉提取器视频源(也可省略,会从 chat.refVideos 回溯)
      { sourceIndex: 0, targetIndex: 2 },
    ],
  },
  {
    id: "wf-white-bg",
    name: "一键白底图",
    description: "上传商品图，配合预填的精修与多角度提示词，生成白底图与多角度展示图",
    icon: "ImageIcon",
    category: "composite",
    coverImage: coverWhiteBg,
    cards: [
      {
        type: "ai_image",
        title: "商品原图",
        relativeX: 0,
        relativeY: (I_3314x3072.height - I_5760x3840.height) / 2,
        ...I_5760x3840,
        data: { content: "", size: "3:2", imageUrl: whiteBgSource },
      },
      {
        type: "ai_chat",
        title: "白底精修提示词",
        relativeX: I_5760x3840.width + 80,
        relativeY: I_3314x3072.height / 2 - CARD_DEFAULTS.ai_chat.height - 40,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: [
            "识别核心信息：",
            "识别图片中的服装品类（如牛仔裤、羽绒服、衬衣等）",
            "识别服装颜色（如浅蓝色、米白色等）",
            "识别服装关键特征（如水洗做旧、菱格绗缝、亚麻纹理、纽扣细节等）",
            "套用模板生成提示词：",
            "基于识别到的信息，按照你给的格式生成标准化精修提示词，确保包含：",
            "服装提取与 3D 转换（如需）",
            "纯白背景与正面视图，背面视图的平视角",
            "领标、颜色、纹理、质感的精准还原",
            "多余褶皱去除与轮廓优化",
            "瑕疵清除与光线调整",
            "符合电商主图标准的要求",
            "示例演示",
            "",
            "如果上传一张浅蓝色破洞牛仔外套的图片，你会自动输出：",
            "产品精修，将图片中的浅蓝色破洞牛仔外套完整提取并转换成 3D 立体形状，置于纯净的纯白背景上。正面视图，背面视图，两个平视角，精准还原牛仔外套的颜色、水洗做旧效果、破洞细节与牛仔布料纹理质感，去除多余褶皱，使衣身轮廓平整顺滑，边缘干净无杂色。清除灰尘、瑕疵，让外套看起来挺括、崭新、洁净，光线均匀无杂乱阴影，符合电商主图标准，主体突出。",
            "结果只需要呈现精修提示词",
          ].join("\n"),
          result: "",
        },
      },
      {
        type: "ai_image",
        title: "白底精修图",
        relativeX: I_3314x3072.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: 0,
        ...I_3314x3072,
        data: { content: "", size: "1:1", imageUrl: whiteBgRefined },
      },
      {
        type: "ai_chat",
        title: "多角度提示词",
        relativeX: I_3314x3072.width + 80 + CARD_DEFAULTS.ai_chat.width + 80 + I_3314x3072.width + 80,
        relativeY: I_3314x3072.height / 2 - CARD_DEFAULTS.ai_chat.height - 40,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: [
            "识别服装核心信息",
            "品类：卫衣、牛仔裤、羽绒服等",
            "颜色：深灰色、浅蓝色等",
            "关键特征：圆领罗纹、水洗做旧、菱格绗缝、立领拉链等",
            "版型细节：阔腿版型、宽松版型等",
            "套用模板生成提示词把识别到的信息填入标准化模板，确保包含：",
            "基于原图，保持所有细节不变",
            "生成一组8张多角度细节展示图，在2*4的网格里，采用16：9的比例展示不同的角度，不要有重复的角度呈现。",
            "指定角度（正面、背面、45 度角、关键部位特写）",
            "白底商业图风格，光线均匀，突出质感与版型",
            "通用提示词模板",
            "",
            "基于我提供的这件【颜色】【服装品类】原图，生成一组产品细节特征展示图。要求保持【服装品类】的款式、【颜色】、【关键纹理 / 设计，如圆领罗纹 / 水洗做旧 / 菱格绗缝】、【版型 / 细节，如阔腿版型 / 立领设计 / 拉链细节】等所有细节完全不变，仅从不同角度（正面、侧面、背面、45 度角、【关键部位特写，如领口特写 / 腰头特写 / 拉链特写】、【细节特写，如袖口特写 / 口袋特写 / 绗缝纹理特写】等）进行拍摄式呈现，整体风格为简洁的白底商业产品图，光线均匀柔和，清晰展现【面料质感，如卫衣面料 / 牛仔面料 / 羽绒面料】与版型细节。",
            "示例",
            "",
            "如果你上传一张米白色带刺绣翻领衬衫的图片，智能体会自动生成：",
            "基于我提供的这件米白色带刺绣翻领衬衫原图，生成一组8张产品细节特征展示图，在2*4的网格里，采用16：9的比例展示不同的角度，不要有重复的角度呈现。。要求保持衬衫的款式、米白色、刺绣图案、翻领设计、纽扣细节等所有细节完全不变，仅从不同角度（正面、背面、45 度角、领口特写、刺绣特写、袖口特写等）进行拍摄式呈现，整体风格为简洁的白底商业产品图，光线均匀柔和，清晰展现棉感面料质感与版型细节。",
            "结果只需要呈现提示词",
          ].join("\n"),
          result: "",
        },
      },
      {
        type: "ai_image",
        title: "多角度展示图",
        relativeX: I_3314x3072.width + 80 + CARD_DEFAULTS.ai_chat.width + 80 + I_3314x3072.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: (I_3314x3072.height - I_5504x3072.height) / 2,
        ...I_5504x3072,
        data: { content: "", size: "16:9", imageUrl: whiteBgMultiAngle },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 1 },
      { sourceIndex: 0, targetIndex: 2 },
      { sourceIndex: 1, targetIndex: 2 },
      { sourceIndex: 2, targetIndex: 3 },
      { sourceIndex: 2, targetIndex: 4 },
      { sourceIndex: 3, targetIndex: 4 },
    ],
  },
  {
    id: "wf-tryon",
    name: "一键换衣",
    description: "上传模特图与服装图，AI 自动将服装穿在模特身上",
    icon: "Shirt",
    category: "composite",
    coverImage: coverTryon,
    cards: [
      {
        type: "ai_image",
        title: "模特图",
        relativeX: 0,
        relativeY: 0,
        ...I_1278x1644,
        data: { content: "", size: "3:4", imageUrl: tryonModel },
      },
      {
        type: "ai_image",
        title: "服装图",
        relativeX: (I_1278x1644.width - I_624x1690.width) / 2,
        relativeY: I_1278x1644.height + 60,
        ...I_624x1690,
        data: { content: "", size: "9:16", imageUrl: tryonGarment },
      },
      {
        type: "ai_image",
        title: "模特换装",
        relativeX: I_1278x1644.width + 80,
        relativeY: (I_1278x1644.height * 2 + 60 - I_1792x2400.height) / 2,
        ...I_1792x2400,
        data: {
          content: "给@图一的人物，穿上@图二的服装",
          size: "3:4",
          imageUrl: tryonResult,
        },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 2 },
      { sourceIndex: 1, targetIndex: 2 },
    ],
  },
  {
    id: "wf-scene-replace",
    name: "场景替换",
    description: "上传人物图与场景图，配合预填融合提示词，AI 将人物完美融入新场景",
    icon: "Mountain",
    category: "composite",
    coverImage: coverSceneReplace,
    cards: [
      {
        type: "ai_image",
        title: "人物图",
        relativeX: 0,
        relativeY: 0,
        ...I_1792x2400,
        data: { content: "", size: "3:4", imageUrl: sceneReplacePerson },
      },
      {
        type: "ai_image",
        title: "场景图",
        relativeX: 0,
        relativeY: I_1792x2400.height + 60,
        ...I_1080x1621,
        data: { content: "", size: "2:3", imageUrl: sceneReplaceScene },
      },
      {
        type: "ai_chat",
        title: "场景融合提示词",
        relativeX: I_1792x2400.width + 80,
        relativeY: (I_1792x2400.height + 60 + I_1080x1621.height - CARD_DEFAULTS.ai_chat.height) / 2,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: [
            "这是一张极度写实的商业摄影大片。请以侧边参考图 1（Image 1）中的人物形象和全套服装为核心主体，将其完美平移并融入到参考图 2（Image 2）的环境。",
            "1:场景继承： 人物所处的环境完全继承自图1，必须精准保留 [描述图1 背景的具体元素，。",
            "2. 人物与动作继承： 替换后的人物必须精准继承图1中的 [描述图 1 的服装及面部特征]。人物的姿态必须完美复刻图 2 原人物的 [描述图 2 的动作状态]。",
            "3. 物理光影融合（核心）： 人物的全身光影必须受到图 2 环境的 [描述图2 的光影特征，如：暖色调侧逆光/散射日光] 物理约束。皮肤纹理、布料反光和阴影边缘必须与图 2的光源方向及色温完全匹配，消除一切抠图感。",
            "4. 场景稳定性： 严禁改变图 2 背景中的任何细节，包括 [描述图 2 特有背景元素，如：面包店招牌、地板纹理]。保持与图2 一致的浅景深和镜头焦段。",
            "画质要求： 8K超清，电影级胶片质感，商业后期质感，极致细节。",
          ].join("\n"),
          result: "",
        },
      },
      {
        type: "ai_image",
        title: "场景替换",
        relativeX: I_1792x2400.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: (I_1792x2400.height + 60 + I_1080x1621.height - I_1792x2400.height) / 2,
        ...I_1792x2400,
        data: { content: "", size: "3:4", imageUrl: sceneReplaceResult },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 2 },
      { sourceIndex: 1, targetIndex: 2 },
      { sourceIndex: 0, targetIndex: 3 },
      { sourceIndex: 1, targetIndex: 3 },
      { sourceIndex: 2, targetIndex: 3 },
    ],
  },
  {
    id: "wf-pose-fission",
    name: "模特姿态裂变",
    description: "上传模特图，AI 生成多种姿态变体（面部与服装保持不变）",
    icon: "PersonStanding",
    category: "composite",
    coverImage: coverPoseFission,
    cards: [
      {
        type: "ai_image",
        title: "人物图",
        relativeX: 0,
        relativeY: (I_1792x2400.height - I_1278x1644.height) / 2,
        ...I_1278x1644,
        data: { content: "", size: "3:4", imageUrl: poseFissionPerson },
      },
      {
        type: "ai_image",
        title: "姿态裂变",
        relativeX: I_1278x1644.width + 80,
        relativeY: 0,
        ...I_1792x2400,
        data: {
          content: "保持@图1人物面部和服装不变，环境不变。生成4张不同的人物姿态图：第一张全身站立，第二张半身特写，第三张坐在路边长椅，第四张服装特写。保持服装细节，超写实，高细节，lookbook质感，不要出现人物黑边。",
          size: "3:4",
          imageUrl: poseFissionResult,
        },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 1 },
    ],
  },
  {
    id: "wf-face-merge",
    name: "人脸合成",
    description: "上传两张人物照片，AI 融合面部特征生成全新写实人像",
    icon: "ScanFace",
    category: "composite",
    coverImage: coverFaceMerge,
    cards: (() => {
      const faceMergePromptTemplate = [
        "A photorealistic portrait of a distinct individual who looks like the biological offspring of the people in the provided reference photos.",
        "The face should be a natural, organic blend of the input features, creating a unique new identity that bears a strong family resemblance to both inputs without being a direct copy of either.",
        "Capture the subtle genetic traits from the references.",
        "",
        "Character Description:",
        "Subject: An Asian {{gender}} model with flawless, pore-level skin texture.",
        "Expression: Neutral and candid, with a high-quality photo realism aesthetic — soft, cinematic lighting that highlights facial contours.",
        "Vibe: High-fashion, sophisticated, and authentic.",
        "Setting: white background, eye-level front face.",
        "",
        "Technical Constraints:",
        "Maintain consistent lighting across the blended features.",
        "Output in 4k resolution, raw photography style.",
        "",
        "A 2x2 grid character sheet of reference image, white background. The grid shows the same character from 4 different camera angles: 1. Front view, 2. Left Profile view, 3. Right Three-Quarter view, 4. Low angle looking up. Headshot framing. Consistent facial features",
      ].join("\n");

      return [
        {
          type: "ai_image" as const,
          title: "人物1",
          relativeX: 0,
          relativeY: 0,
          ...I_1792x2400,
          data: { content: "", size: "3:4", imageUrl: faceMergePerson1 },
        },
        {
          type: "ai_image" as const,
          title: "人物2",
          relativeX: 0,
          relativeY: I_1792x2400.height + 60,
          ...I_1536x2752,
          data: { content: "", size: "9:16", imageUrl: faceMergePerson2 },
        },
        {
          type: "ai_image" as const,
          title: "人脸合成",
          relativeX: I_1792x2400.width + 80,
          relativeY: (I_1792x2400.height + 60 + I_1536x2752.height - I_1792x2400.height) / 2,
          ...I_1792x2400,
          data: {
            content: faceMergePromptTemplate.replaceAll("{{gender}}", "female"),
            _promptTemplate: faceMergePromptTemplate,
            _params: { gender: "female" },
            _locked: true,
            _label: "人脸合成",
            _description: "选择生成性别，提示词会自动封装到该图片节点中",
            size: "3:4",
            imageUrl: faceMergeResult,
          },
        },
      ];
    })(),
    connections: [
      { sourceIndex: 0, targetIndex: 2 },
      { sourceIndex: 1, targetIndex: 2 },
    ],
  },
  {
    id: "wf-look-fission",
    name: "Look 全身裂变",
    description: "上传模特图，配合预填锁定机位提示词，生成多组 Lookbook 风格姿态变体",
    icon: "PersonStanding",
    category: "composite",
    coverImage: coverLookFission,
    cards: (() => {
      const GAP = 80;
      const RESULT_GAP = 40;
      const PERSON = I_1970x2626;
      const RESULT_FRONT = I_1536x2752;
      const RESULT_SIDE = I_1080x1440;
      const CHAT_W = CARD_DEFAULTS.ai_chat.width;
      const CHAT_H = CARD_DEFAULTS.ai_chat.height;

      const CONTAINER_H = Math.max(PERSON.height, CHAT_H, RESULT_FRONT.height);
      const CHAT_X = PERSON.width + GAP;
      const RESULT_X_1 = CHAT_X + CHAT_W + GAP;
      const RESULT_X_2 = RESULT_X_1 + RESULT_FRONT.width + RESULT_GAP;
      const RESULT_X_3 = RESULT_X_2 + RESULT_SIDE.width + RESULT_GAP;

      const promptContent = [
        "【任务目标】",
        "基于我上传的人物参考图，生成一组适合 Nano Banana 2 / 香蕉2 出图的全身模特多角度提示词。",
        "",
        "请先严格分析参考图中的人物、服装和场景，并在生成提示词时保持高度一致：",
        "- 人物：性别、年龄感、脸型、五官特征、发型、妆容、肤色、体型、身高比例、气质必须一致",
        "- 服装：颜色、款式、版型、面料、图案、纽扣/拉链/绑带/口袋/缝线等结构细节、鞋子、包袋、首饰和所有配饰必须一致",
        "- 场景：拍摄空间、背景材质、地面、光线方向、阴影、色调、氛围必须一致",
        "",
        "【核心要求】",
        "最终生成 3 个中文提示词方案，分别为:",
        "1. 人物全身正面 90 度",
        "2. 人物全身右侧 45 度",
        "3. 人物全身左侧 45 度",
        "",
        "【最高优先级 · 一致性锁定】",
        "1. 必须保持同一位模特：",
        "面部特征、发型、妆容、肤色、体型、气质、年龄感一致。",
        "",
        "2. 必须保持同一套服装：",
        "服装颜色、款式、版型、材质、图案、纹理、褶皱逻辑、鞋子、包袋、首饰和配饰一致，不得改款，不得减少或新增配饰。",
        "",
        "3. 必须保持同一场景：",
        "背景、地面、空间尺度、光线方向、阴影形状、色调和整体氛围一致。",
        "",
        "4. 必须是完整全身画面：",
        "从头到脚完整可见，人物不能被裁切，鞋子必须完整出现。",
        "",
        "5. 必须保持真实比例：",
        "人物头身比例、肩宽、腰臀比例、腿长、手脚大小自然真实，人物与场景比例协调，不得拉长腿，不得缩小头部，不得改变体型。",
        "",
        "【角度要求】",
        "参考图只用于锁定人物身份、脸部特征、发型、服装、鞋包配饰、背景、光线和画面质感，不参考原图站姿和身体朝向。",
        "",
        "- 正面 90 度：人物身体正对镜头，脸部正对镜头，胸口正对镜头，完整展示正面服装效果。",
        "- 右侧 45 度：必须生成明确但自然的全身右侧 45 度角度。人物身体整体向画面右侧自然旋转约 45 度，鼻尖偏向画面右侧，胸口不再正对镜头；右肩略靠近镜头，左肩自然向后，肩线形成清楚但不僵硬的前后关系；髋部、膝盖和双脚脚尖也随身体一起朝画面右侧自然偏转。镜头能同时看到人物正面与右侧侧面交界，重点展示服装右侧轮廓。禁止只转头不转身体，禁止轻微偏头冒充侧身。",
        "- 左侧 45 度：必须生成明确但自然的全身左侧 45 度角度。人物身体整体向画面左侧自然旋转约 45 度，鼻尖偏向画面左侧，胸口不再正对镜头；左肩略靠近镜头，右肩自然后退，肩线形成清楚但不僵硬的前后关系；髋部、膝盖和双脚脚尖也随身体一起朝画面左侧自然偏转。镜头能同时看到人物正面与左侧侧面交界，重点展示服装左侧轮廓。禁止只转头不转身体，禁止轻微偏头冒充侧身。",
        "",
        "【动作要求】",
        "每个角度可以有小幅度、合理、真实的人体姿态变化，但动作必须克制自然，符合商业摄影、电商模特、lookbook 风格。",
        "侧身 45 度不要做成机械转身，要像真实模特在摄影师引导下轻微转身停留的一瞬间：身体重心轻微落在一条腿上，另一条腿自然前后半步，膝盖微松；肩膀放松，脖颈自然，手臂自然下垂或轻轻扶住包带/衣摆，手指自然弯曲。",
        "允许变化：",
        "- 手臂自然垂落、轻扶腰侧、轻触衣摆、轻扶包带、轻整理发丝",
        "- 双腿自然站立、轻微前后错落、重心小幅转移",
        "禁止变化：",
        "- 夸张摆拍",
        "- 舞蹈动作",
        "- 大幅度扭腰",
        "- 只转头不转身体",
        "- 身体仍然正对镜头",
        "- 轻微偏头冒充侧身",
        "- 身体僵硬",
        "- 军姿站立",
        "- 双脚完全并拢",
        "- 肩膀过度端平",
        "- 跳跃",
        "- 坐姿",
        "- 背影",
        "- 半身图",
        "- 近景图",
        "",
        "【摄影风格】",
        "真实商业摄影，电商模特，品牌 lookbook，全身棚拍，自然克制，专业高级，柔和自然光，真实皮肤质感，服装清晰展示，面料纹理真实，褶皱自然，上身效果真实。",
        "",
        "【输出格式】",
        "只输出以下 3 个提示词，不要解释，不要输出分析过程：",
        "",
        "【灵感1：全身正面90度】",
        "提示词：",
        "",
        "【灵感2：全身右侧45度】",
        "提示词：",
        "",
        "【灵感3：全身左侧45度】",
        "提示词：",
        "",
        "【统一负面提示词】",
        "不同人物，不同脸，不同发型，不同妆容，不同体型，不同服装，服装改款，颜色改变，材质改变，图案改变，配饰丢失，新增配饰，鞋子改变，场景改变，背景改变，光线改变，半身图，近景图，坐姿，背影，人物被裁切，脚被裁切，头被裁切，比例异常，腿过长，头太小，头太大，手脚过大，手指畸形，肢体扭曲，夸张姿势，正面站姿冒充侧身，只转头不转身体，身体正对镜头，轻微偏头冒充侧身，网红写真感，卡通，插画，CG感，低清晰度。",
      ].join("\n");

      const inspirationFront = [
        "请严格以已上传参考图为唯一人物、服装和场景依据生成。保持同一位模特、同一张脸、同一发型、同一妆容、同一肤色、同一体型比例、同一气质；保持同一套服装、同一颜色、同一款式、同一面料、同一图案、同一版型、同一褶皱逻辑、同一鞋子、同一包袋和全部配饰；保持同一拍摄场景、同一背景、同一地面、同一光线、同一阴影、同一色调。",
        "",
        "人物身体正对镜头，脸部正对镜头，完整展示正面服装效果。只允许小幅度自然姿势变化，生成完整全身画面。人物从头到脚完整可见，人物大小比例真实，头身比例、腿长比例、手脚大小与参考图一致。不要扩图，不要裁切，不要补边，不要改变画布比例。真实商业摄影，电商模特，lookbook风格，自然克制专业。",
        "",
        "禁止：换脸，换发型，换衣服，改颜色，改图案，改版型，少配饰，多配饰，换鞋，换包，改变背景，改变光线，半身图，近景图，坐姿，背影，人物被裁切，比例异常，腿变长，头变小，肢体扭曲，手指畸形，网红写真感，卡通感，CG感。",
      ].join("\n");

      const makeSideInspiration = (side: "右" | "左") => {
        const near = side === "右" ? "右" : "左";
        const far = side === "右" ? "左" : "右";
        return [
          "请严格以已上传参考图为唯一人物、服装和场景依据生成。保持同一位模特、同一张脸、同一发型、同一妆容、同一肤色、同一体型比例、同一气质；保持同一套服装、同一颜色、同一款式、同一面料、同一图案、同一版型、同一褶皱逻辑、同一鞋子、同一包袋和全部配饰；保持同一拍摄场景、同一背景、同一地面、同一光线、同一阴影、同一色调。",
          "",
          "参考图只用于人物身份、服装、鞋包配饰、背景和画面质感保真，不参考原图站姿和身体朝向。",
          "",
          `本次必须生成明确的全身${side}侧45度角度图。人物身体整体向画面${side}侧自然旋转约45度，鼻尖偏向画面${side}侧，胸口不再正对镜头；${near}肩略靠近镜头，${far}肩自然后退，肩线形成清楚但不僵硬的前后关系。髋部、膝盖和双脚脚尖随身体方向自然偏转，不能只有脸或头发转向。镜头能同时看到人物正面和${side}侧侧面交界，服装${side}侧轮廓线条和侧面版型要清楚。`,
          "",
          "站姿保持真实棚拍模特感：身体重心轻微落在后侧腿，前侧腿自然放松半步，膝盖微松，肩膀放松，脖颈自然，不要刻意挺胸或军姿站立。手臂自然下垂，或一只手轻轻扶住包带/衣摆，手指自然弯曲。整体像真实模特在摄影师引导下轻微转身停留的一瞬间，自然、松弛、克制。",
          "",
          "保持完整全身画面，人物从头到脚完整可见，人物位于画面中央，人物大小比例真实，头身比例、腿长比例、手脚大小与参考图一致。不要扩图，不要裁切，不要补边，不要改变画布比例。真实商业摄影，电商模特，lookbook风格，自然克制专业。",
          "",
          "禁止：正面站姿，身体正对镜头，只转头不转身体，轻微偏头，背影，身体僵硬，军姿站立，双脚完全并拢，肩膀过度端平，刻意摆拍，夸张扭腰，换脸，换发型，换衣服，改颜色，改图案，改版型，少配饰，多配饰，换鞋，换包，改变背景，改变光线，半身图，近景图，坐姿，人物被裁切，比例异常，腿变长，头变小，肢体扭曲，手指畸形，网红写真感，卡通感，CG感。",
        ].join("\n");
      };

      const makeResult = (
        title: string,
        relativeX: number,
        content: string,
        imageUrl: string,
        dims = RESULT_FRONT,
        size = "9:16",
      ) => ({
        type: "ai_image" as const,
        title,
        relativeX,
        relativeY: (CONTAINER_H - dims.height) / 2,
        ...dims,
        data: {
          imageUrl,
          content,
          size,
        },
      });

      return [
        {
          type: "ai_image" as const,
          title: "人物图",
          relativeX: 0,
          relativeY: (CONTAINER_H - PERSON.height) / 2,
          ...PERSON,
          data: { content: "", size: "3:4", imageUrl: lookFissionPerson },
        },
        {
          type: "ai_chat" as const,
          title: "全身裂变提示词",
          relativeX: CHAT_X,
          relativeY: (CONTAINER_H - CHAT_H) / 2,
          width: CHAT_W,
          height: CHAT_H,
          data: {
            model: "gemini-3.1-pro",
            content: promptContent,
            result: "",
          },
        },
        makeResult(
          "全身正面 90 度",
          RESULT_X_1,
          ["生成【灵感1：全身正面90度】。", "", inspirationFront].join("\n"),
          lookFissionResult1,
        ),
        makeResult(
          "全身右侧 45 度",
          RESULT_X_2,
          ["生成【灵感2：全身右侧45度】。", "", makeSideInspiration("右")].join("\n"),
          lookFissionResult2,
          RESULT_SIDE,
          "3:4",
        ),
        makeResult(
          "全身左侧 45 度",
          RESULT_X_3,
          ["生成【灵感3：全身左侧45度】。", "", makeSideInspiration("左")].join("\n"),
          lookFissionResult3,
          RESULT_SIDE,
          "3:4",
        ),
      ];
    })(),
    connections: [
      { sourceIndex: 0, targetIndex: 1 },
      { sourceIndex: 0, targetIndex: 2 },
      { sourceIndex: 1, targetIndex: 2 },
      { sourceIndex: 0, targetIndex: 3 },
      { sourceIndex: 1, targetIndex: 3 },
      { sourceIndex: 0, targetIndex: 4 },
      { sourceIndex: 1, targetIndex: 4 },
    ],
  },
  {
    id: "wf-multimodal-fusion",
    name: "多模态融合1",
    description: "上传模特、服装、场景与拍摄角度参考图，AI 综合融合生成商业写真",
    icon: "Combine",
    category: "composite",
    coverImage: coverMultimodalFusion,
    cards: (() => {
      const GAP = 60;
      const IMG_L = I_1792x2400;
      const IMG_R = I_1080x1440;
      const COL_W = Math.max(IMG_L.width, IMG_R.width);
      const CHAT_W = CARD_DEFAULTS.ai_chat.width;
      const CHAT_H = IMG_L.height * 2 + GAP;
      const CHAT_X = COL_W * 2 + GAP * 2;
      const RESULT_X = CHAT_X + CHAT_W + GAP;
      const fusionPrompt = [
        "你是一个专业的商业时尚摄影师和服装提示词架构师。你的任务是将以下分散的元素，整合成一句逻辑清晰、细节丰富、视觉一致的中文提示词。",
        "必须遵循以下结构来重构提示词：",
        "1:画面主体：详细描述模特（基于输入1），包括发型、妆容和她此刻在服装中的姿态。",
        "2:服装主体：详细描述模特所穿的服装（裙子，裤子）（基于输入2），强调面料和剪裁细节，必须说明这套衣服是如何穿在模特身上的。如果这套搭配是裙子或者是裤子，且在白底图上，裙子，裤子的长度，参考以下特征分析长短：",
        "",
        "请遵守以下内容：你现在正在识别一张标准服装平铺图。由于缺乏模特参照，请严格观察图片中裙摆最大宽度 (W) 与 裙身垂直长度 (L, 从腰带顶部到最底端) 的比例关系来判定长度： 短裙 (Mini/Short Skirt)： 比例特征：$L \\approx W$ 或 $L < W$（长度接近或小于宽度）。 视觉描述：外形接近正方形或横向长方形，裙摆看起来较为短促。 反向注入词：Mini length, Mid-thigh length, Straight short cut。 中裙 (Midi/Knee-length)： 比例特征：$L \\approx 1.2 \\times W$ 至 $1.5 \\times W$（长度略长于宽度）。 视觉描述：呈现纵向长方形，线条开始延伸。 反向注入词：Midi length, Over-the-knee, Below-the-knee。 长裙 (Maxi/Full-length)： 比例特征：$L > 1.8 \\times W$（长度远大于宽度，通常是宽度的2倍左右）。 视觉描述：极度细长的纵向比例，裙摆处通常伴随更多的布料褶皱或垂坠感。 反向注入词：Maxi length, Ankle-length, Floor-sweeping hem。 【强制执行规则】： 识别后，必须在提示词开头显式声明长度属性。 绝对禁止混淆：若判定为长裙，提示词中严禁出现 short 或 showing legs；若判定为短裙，严禁出现 long 或 flowing maxi。",
        "3:场景环境：详细描述模特所处的环境（基于输入3，如果没有自动忽略），说明环境的光照和氛围，以及它与主体的互动。",
        "4:拍摄角度：详细描述模特的动作姿态，摄像机的拍摄位置（基于输入4）",
        "6:整体氛围与摄影风格：整体氛围与摄影风格：定义画面的艺术风格、色彩倾向（如：复古冷调、胶片质感）、镜头语言（如：中景、特写）。",
        "限制：",
        "不要增加任何不相关的多余元素。",
        "确保道具的使用是符合逻辑的。",
        "输出必须是一个连贯的段落，不要使用列表。",
      ].join("\n");
      return [
        {
          type: "ai_image" as const,
          title: "模特图（输入1）",
          relativeX: 0,
          relativeY: 0,
          ...IMG_L,
          data: { content: "", size: "3:4", imageUrl: multimodalFusionPerson },
        },
        {
          type: "ai_image" as const,
          title: "服装图（输入2）",
          relativeX: COL_W + GAP,
          relativeY: 0,
          ...IMG_R,
          data: { content: "", size: "3:4", imageUrl: multimodalFusionGarment },
        },
        {
          type: "ai_image" as const,
          title: "场景图（输入3）",
          relativeX: 0,
          relativeY: IMG_L.height + GAP,
          ...IMG_R,
          data: { content: "", size: "3:4", imageUrl: multimodalFusionScene },
        },
        {
          type: "ai_image" as const,
          title: "拍摄角度图（输入4）",
          relativeX: COL_W + GAP,
          relativeY: IMG_L.height + GAP,
          ...IMG_R,
          data: { content: "", size: "3:4", imageUrl: multimodalFusionPose },
        },
        {
          type: "ai_chat" as const,
          title: "融合提示词",
          relativeX: CHAT_X,
          relativeY: 0,
          width: CHAT_W,
          height: CHAT_H,
          data: {
            content: fusionPrompt,
            result: "",
          },
        },
        {
          type: "ai_image" as const,
          title: "多模态融合",
          relativeX: RESULT_X,
          relativeY: (CHAT_H - IMG_L.height) / 2,
          ...IMG_L,
          data: {
            content: "合成出来的图，要求 人物@图1   100%一致，高权重，图二衣服@图二  100%一致，高权重。",
            size: "3:4",
            imageUrl: multimodalFusionResult,
          },
        },
      ];
    })(),
    connections: [
      { sourceIndex: 0, targetIndex: 4 },
      { sourceIndex: 1, targetIndex: 4 },
      { sourceIndex: 2, targetIndex: 4 },
      { sourceIndex: 3, targetIndex: 4 },
      { sourceIndex: 0, targetIndex: 5 },
      { sourceIndex: 1, targetIndex: 5 },
      { sourceIndex: 2, targetIndex: 5 },
      { sourceIndex: 3, targetIndex: 5 },
      { sourceIndex: 4, targetIndex: 5 },
    ],
  },
  {
    id: "wf-multimodal-fusion-6",
    name: "服装多模态融合6",
    description:
      "上传模特、服装、影调与环境参考图，AI 解构服装细节并生成多组差异化商业写真",
    icon: "Combine",
    category: "composite",
    coverImage: coverMultimodalFusion6,
    cards: (() => {
      const GAP = 60;
      const IMG_P = I_1792x2400;
      const IMG_G = I_4936x6581;
      const IMG_REF = I_720x900;
      const IMG_RES = I_1792x2400;
      const COL_W = Math.max(IMG_P.width, IMG_REF.width);
      const CHAT_W = CARD_DEFAULTS.ai_chat.width;
      const CHAT_H = IMG_P.height * 2 + GAP;
      const CHAT_X = COL_W * 2 + GAP * 2;
      const RESULT_X = CHAT_X + CHAT_W + GAP;
      const ROW_STEP = IMG_RES.width + GAP;
      const TOP_ROW_W = IMG_RES.width * 3 + GAP * 2;
      const BTM_ROW_W = IMG_RES.width * 2 + GAP;
      const BTM_OFFSET = Math.round((TOP_ROW_W - BTM_ROW_W) / 2);

      const fusionPrompt = [
        '你是一位拥有 10 年资深摄影经验、精通面料工业与人体解剖的顶级导演。请执行"白底测绘 + 面料全扫描 + 动态构图补全"的终极任务。',
        "",
        "第一步：全维度像素级解构 (Strict Physical Scan)",
        "",
        "【层 1：服装长度与比例锁死 (图 2 专属 - 核心判定)】",
        "实穿优先：若有模特，100% 像素级镜像服装边缘相对于人体关节（如：膝盖上方 5cm、踝骨）的精确位置。",
        "白底测绘：若无模特，必须以人体比例为基准，测算领口到腰线的单位，强制锁定下装落点，严禁脑补。",
        "比例保护：强制黄金比例，严禁任何镜头畸变导致的人物比例失调。",
        "",
        "【层 2：7 点全量细节扫描 (执行 7 位一体点名)】",
        "头部妆发 (图 1)：扫描妆容，发型，脸部特征",
        "肩颈领口 (图 2)：领型、肩部剪裁。",
        "胸腹面料 (图 2)：面料属性（如：罗纹、翻毛皮、丝绸）、纹理、褶皱、金属扣件、材质颜色等。",
        "腰胯塞入 (图 2)：衣服层叠逻辑、腰位。",
        "下摆边缘 (图 2)：物理落点、走线细节、材质颜色，纹理的材质，纹理的工艺。",
        "足部构造 (图 2)：精控识别（如：米色翻毛皮露趾短靴/Beige Suede Open-toe Booties），锁死材质与露趾结构。",
        "袜套层叠 (图 2)：长度、织纹、堆叠感。",
        "",
        "【层 3：影调与环境】",
        "影调（图 3）：第一步：彻底清空之前场景。第二步：分析影调必须按照从明暗基调+色彩倾向+质感+光线+情绪风格+色彩细节，6 个纬度分析，强制 1:1 像素级镜像图 3 的影调，100% 复刻图 3 色温、对比度、图片的色调。",
        "环境（图 4）：彻底清空之前场景，仅依据图 4 环境描述，严禁提取光色。",
        "",
        "第二步：多维构图生成逻辑 (Composition Logic)",
        "",
        "【参考图判定机制】：",
        "若提供图 4、图 5、图 6、图 7、图 8 等：强制分析图片的构图，模特的表情、动作，提取其中的镜头语言（仰拍/俯拍/遮挡等）进行定向组合创作。",
        "若不提供：禁止重复或忽略！必须基于图 4 空间的物理特性，自动生成 [特写]、[全身]、[对角线俯视]、[动态广角] 等 6 组高审美差异化构图。",
        "",
        "第三步：输出 6 个差异化灵感方案 (中文输出)",
        "要求：所有方案必须统一在（图 3）影调分析后的色调下，采用以下固定结构：",
        "[场景描述]：严禁残留设定，基于图 4 物理材质重新定义拍摄空间。",
        "[人物五官表情动作]：锁定图 1 妆发、五官等特征。",
        "[细致的服装搭配描述]：执行第一步的 7 点扫描结果。从领口开始，经由面料纹理、下装长度，直到足部的鞋履材质与露趾构造。",
        "[图片的色调质感描述]：执行第一步层 2 的影调分析，必须 100% 复刻图三的影调。",
        "[摄影构图]：执行第二步的多维构图逻辑。",
        "",
        "输出格式要求 确保英文提示词包含：商业摄影术语）：",
        "【灵感 X：[灵感主题名]】",
        "商业级中文提示词：[人物、妆容描述+服装穿搭描述+人物动作描述+场景描述+相机构图描述+影调描述]",
        "输出必须是一个连贯的段落，不要使用列表。",
      ].join("\n");

      return [
        {
          type: "ai_image" as const,
          title: "模特图（图1）",
          relativeX: 0,
          relativeY: 0,
          ...IMG_P,
          data: { content: "", size: "3:4", imageUrl: mf6Person },
        },
        {
          type: "ai_image" as const,
          title: "服装图（图2）",
          relativeX: COL_W + GAP,
          relativeY: 0,
          ...IMG_G,
          data: { content: "", size: "3:4", imageUrl: mf6Garment },
        },
        {
          type: "ai_image" as const,
          title: "影调参考（图3）",
          relativeX: 0,
          relativeY: IMG_P.height + GAP,
          ...IMG_REF,
          data: { content: "", size: "3:4", imageUrl: mf6Scene },
        },
        {
          type: "ai_image" as const,
          title: "环境参考（图4）",
          relativeX: COL_W + GAP,
          relativeY: IMG_P.height + GAP,
          ...IMG_REF,
          data: { content: "", size: "3:4", imageUrl: mf6Pose },
        },
        {
          type: "ai_chat" as const,
          title: "融合提示词",
          relativeX: CHAT_X,
          relativeY: 0,
          width: CHAT_W,
          height: CHAT_H,
          data: {
            content: fusionPrompt,
            result: "",
          },
        },
        {
          type: "ai_image" as const,
          title: "效果图1",
          relativeX: RESULT_X,
          relativeY: 0,
          ...IMG_RES,
          data: { content: "生成灵感1:保持人物跟图一100%一致，服装跟图二100%一致，场景跟图四类似。", size: "3:4", imageUrl: mf6Result1 },
        },
        {
          type: "ai_image" as const,
          title: "效果图2",
          relativeX: RESULT_X + ROW_STEP,
          relativeY: 0,
          ...IMG_RES,
          data: { content: "生成灵感2:保持人物跟图一100%一致，服装跟图二100%一致，场景跟图四类似。", size: "3:4", imageUrl: mf6Result2 },
        },
        {
          type: "ai_image" as const,
          title: "效果图3",
          relativeX: RESULT_X + ROW_STEP * 2,
          relativeY: 0,
          ...IMG_RES,
          data: { content: "生成灵感3:保持人物跟图一100%一致，服装跟图二100%一致，场景跟图四类似。", size: "3:4", imageUrl: mf6Result3 },
        },
        {
          type: "ai_image" as const,
          title: "效果图4",
          relativeX: RESULT_X + BTM_OFFSET,
          relativeY: IMG_RES.height + GAP,
          ...IMG_RES,
          data: { content: "生成灵感4:保持人物跟图一100%一致，服装跟图二100%一致，场景跟图四类似。", size: "3:4", imageUrl: mf6Result4 },
        },
        {
          type: "ai_image" as const,
          title: "效果图5",
          relativeX: RESULT_X + BTM_OFFSET + ROW_STEP,
          relativeY: IMG_RES.height + GAP,
          ...IMG_RES,
          data: { content: "生成灵感5:保持人物跟图一100%一致，服装跟图二100%一致，场景跟图四类似。", size: "3:4", imageUrl: mf6Result5 },
        },
      ];
    })(),
    connections: [
      { sourceIndex: 0, targetIndex: 4 },
      { sourceIndex: 1, targetIndex: 4 },
      { sourceIndex: 2, targetIndex: 4 },
      { sourceIndex: 3, targetIndex: 4 },
      { sourceIndex: 0, targetIndex: 5 },
      { sourceIndex: 1, targetIndex: 5 },
      { sourceIndex: 2, targetIndex: 5 },
      { sourceIndex: 3, targetIndex: 5 },
      { sourceIndex: 4, targetIndex: 5 },
      { sourceIndex: 0, targetIndex: 6 },
      { sourceIndex: 1, targetIndex: 6 },
      { sourceIndex: 2, targetIndex: 6 },
      { sourceIndex: 3, targetIndex: 6 },
      { sourceIndex: 4, targetIndex: 6 },
      { sourceIndex: 0, targetIndex: 7 },
      { sourceIndex: 1, targetIndex: 7 },
      { sourceIndex: 2, targetIndex: 7 },
      { sourceIndex: 3, targetIndex: 7 },
      { sourceIndex: 4, targetIndex: 7 },
      { sourceIndex: 0, targetIndex: 8 },
      { sourceIndex: 1, targetIndex: 8 },
      { sourceIndex: 2, targetIndex: 8 },
      { sourceIndex: 3, targetIndex: 8 },
      { sourceIndex: 4, targetIndex: 8 },
      { sourceIndex: 0, targetIndex: 9 },
      { sourceIndex: 1, targetIndex: 9 },
      { sourceIndex: 2, targetIndex: 9 },
      { sourceIndex: 3, targetIndex: 9 },
      { sourceIndex: 4, targetIndex: 9 },
    ],
  },
  {
    id: "wf-studio-look",
    name: "一键棚拍Look图",
    description:
      "上传模特、服装与场景图，AI 生成专业棚拍 Lookbook 写真",
    icon: "Camera",
    category: "composite",
    coverImage: coverStudioLook,
    cards: (() => {
      const GAP = 60;
      const RESULT_GAP = 40;
      const IMG_PERSON = I_1792x2400;
      const IMG_GARMENT = I_624x1690;
      const IMG_SCENE = I_736x1308;
      const IMG_RESULT = I_1792x2400;
      const COL_W = Math.max(IMG_PERSON.width, IMG_GARMENT.width, IMG_SCENE.width);
      const COL_H = IMG_PERSON.height + GAP + IMG_GARMENT.height + GAP + IMG_SCENE.height;
      const CHAT_W = CARD_DEFAULTS.ai_chat.width;
      const CHAT_H = CARD_DEFAULTS.ai_chat.height;
      const CHAT_X = COL_W + GAP + 20;
      const RESULT_X_1 = CHAT_X + CHAT_W + GAP + 20;
      const RESULT_X_2 = RESULT_X_1 + IMG_RESULT.width + RESULT_GAP;
      const RESULT_GRID_H = IMG_RESULT.height * 2 + RESULT_GAP;
      const RESULT_TOP_Y = (COL_H - RESULT_GRID_H) / 2;
      const RESULT_BTM_Y = RESULT_TOP_Y + IMG_RESULT.height + RESULT_GAP;

      const lookbookPrompt = [
        "请严格分析我上传的三张参考图，并反推出一组可直接用于 Nano Banana 2 / 香蕉2 的专业时装 lookbook 摄影提示词。",
        "三张图定义：",
        "图1 = 模特参考图",
        "图2 = 服装参考图",
        "图3 = 场景参考图",
        "请先完成反推分析，但分析内容要简洁准确，不要发挥不存在的细节。",
        "",
        "图1请分析：模特性别、年龄感、面部气质、脸型、五官特征、发型、妆容、肤色、身材比例、整体气质。生成时保持核心面部特征、发型、年龄感和气质一致。",
        "图2请分析：服装品类、颜色、面料、版型、领口、袖型、纽扣/拉链/绑带/口袋/缝线等结构细节、上下装搭配、鞋子和配饰。生成时必须保持服装款式准确，不能改款，不能把上衣/下装/鞋子生成成其他品类。",
        "图3请分析：拍摄空间、背景材质、主色调、光线方向、阴影形状、空间尺度、氛围风格。生成时保持同一场景风格，背景干净高级，人物比例与场景尺度协调。",
        "请输出 4 个中文提示词方案：",
        "1. 全身站姿图",
        "2. 半身图",
        "3. 坐姿图",
        "4. 服装细节图",
        "重要要求：",
        "- 四张图必须像同一个品牌 lookbook 系列里的连续四张。",
        "- 必须是同一位模特、同一套服装、同一个场景、同一套光线、同一套色调。",
        "- 每张图只允许改变构图、姿态、镜头距离和表情情绪。",
        "- 每条提示词都必须完整自包含，不要写\"同上\"。",
        "- 每张图的人物情绪都要不同，但都要高级、克制、冷静。",
        "- 服装必须清晰展示，面料纹理真实，褶皱自然，版型准确，上身效果真实，不夸张变形。",
        "- 模特自然淡妆，真实皮肤质感，姿态松弛高级，符合品牌服装大片气质。",
        "- 摄影风格为专业时装 lookbook，高端杂志编辑片风格，柔和自然光，细腻阴影，低饱和色调，85mm 人像镜头，浅景深，超写实，高细节。",
        "- 特别注意人物比例、头身比例、手脚大小、坐姿比例、人物与场景比例都必须真实协调。",
        "服装细节图要求：",
        "必须是服装穿在模特身上的细节图，不是平铺图，不是单独产品图。可以裁切到下半张脸、肩颈、胸口、腰部、手部和服装区域，但必须看出服装真实上身效果。",
        "坐姿图要求：",
        "人物坐在与场景风格一致的简洁座椅或方凳上，座椅比例真实，腿部不拉长，手脚自然，服装在坐姿下产生真实自然褶皱。",
        "请按以下格式输出：",
        "【统一反推设定】",
        "模特描述：",
        "服装描述：",
        "场景描述：",
        "统一摄影风格：",
        "统一生成稳定性提示：",
        "【方案一：全身站姿图】",
        "情绪：",
        "提示词：",
        "【方案二：半身图】",
        "情绪：",
        "提示词：",
        "【方案三：坐姿图】",
        "情绪：",
        "提示词：",
        "【方案四：服装细节图】",
        "情绪：",
        "提示词：",
        "【统一负面提示词】",
        "不同模特，不同发型，不同服装，不同场景，不同光线，服装改款，服装品类错误，面料塑料感，布料纹理模糊，衣服过曝，白色层次丢失，身体比例异常，头太大，腿过长，手脚过大，手指畸形，多余手指，肢体扭曲，脸部变形，过度磨皮，AI塑料皮肤，浓妆，夸张表情，夸张姿势，网红写真感，婚纱照感，电商白底平铺图，产品单独平铺，背景杂乱，人物与场景比例不协调，卡通，插画，CG感，低清晰度。",
      ].join("\n");

      const makeResult = (
        title: string,
        relativeX: number,
        relativeY: number,
        content: string,
        imageUrl: string,
      ) => ({
        type: "ai_image" as const,
        title,
        relativeX,
        relativeY,
        ...IMG_RESULT,
        data: {
          imageUrl,
          content,
          size: "3:4",
        },
      });

      return [
        {
          type: "ai_image" as const,
          title: "模特图（图1）",
          relativeX: 0,
          relativeY: 0,
          ...IMG_PERSON,
          data: { content: "", size: "3:4", imageUrl: studioLookPerson },
        },
        {
          type: "ai_image" as const,
          title: "服装图（图2）",
          relativeX: 0,
          relativeY: IMG_PERSON.height + GAP,
          ...IMG_GARMENT,
          data: { content: "", size: "9:16", imageUrl: studioLookGarment },
        },
        {
          type: "ai_image" as const,
          title: "场景图（图3）",
          relativeX: 0,
          relativeY: IMG_PERSON.height + GAP + IMG_GARMENT.height + GAP,
          ...IMG_SCENE,
          data: { content: "", size: "9:16", imageUrl: studioLookScene },
        },
        {
          type: "ai_chat" as const,
          title: "Lookbook 提示词",
          relativeX: CHAT_X,
          relativeY: (COL_H - CHAT_H) / 2,
          width: CHAT_W,
          height: CHAT_H,
          data: {
            content: lookbookPrompt,
            result: "",
          },
        },
        makeResult(
          "棚拍 Look 1",
          RESULT_X_1,
          RESULT_TOP_Y,
          "生成方案1：要求人物跟图一 100%一致，服装跟图二 100%一致。",
          studioLookResult1,
        ),
        makeResult(
          "棚拍 Look 2",
          RESULT_X_2,
          RESULT_TOP_Y,
          "生成方案2：要求人物跟图一 100%一致，服装跟图二 100%一致。",
          studioLookResult2,
        ),
        makeResult(
          "棚拍 Look 3",
          RESULT_X_1,
          RESULT_BTM_Y,
          "生成方案3：要求人物跟图一 100%一致，服装跟图二 100%一致。",
          studioLookResult3,
        ),
        makeResult(
          "棚拍 Look 4",
          RESULT_X_2,
          RESULT_BTM_Y,
          "生成方案4：要求人物跟图一 100%一致，服装跟图二 100%一致。",
          studioLookResult4,
        ),
      ];
    })(),
    connections: [
      { sourceIndex: 0, targetIndex: 3 },
      { sourceIndex: 1, targetIndex: 3 },
      { sourceIndex: 2, targetIndex: 3 },
      { sourceIndex: 0, targetIndex: 4 },
      { sourceIndex: 1, targetIndex: 4 },
      { sourceIndex: 2, targetIndex: 4 },
      { sourceIndex: 3, targetIndex: 4 },
      { sourceIndex: 0, targetIndex: 5 },
      { sourceIndex: 1, targetIndex: 5 },
      { sourceIndex: 2, targetIndex: 5 },
      { sourceIndex: 3, targetIndex: 5 },
      { sourceIndex: 0, targetIndex: 6 },
      { sourceIndex: 1, targetIndex: 6 },
      { sourceIndex: 2, targetIndex: 6 },
      { sourceIndex: 3, targetIndex: 6 },
      { sourceIndex: 0, targetIndex: 7 },
      { sourceIndex: 1, targetIndex: 7 },
      { sourceIndex: 2, targetIndex: 7 },
      { sourceIndex: 3, targetIndex: 7 },
    ],
  },
  {
    id: "wf-mirror-selfie-1",
    name: "对镜自拍一键换装1.0",
    description:
      "上传模特、服装与场景参考图，AI 生成一张电商对镜自拍穿搭图",
    icon: "Smartphone",
    category: "composite",
    coverImage: coverMirrorSelfie1,
    cards: (() => {
      const GAP = 60;
      const COL_H = PORTRAIT.height * 3 + GAP * 2;
      const CHAT_W = CARD_DEFAULTS.ai_chat.width;
      const CHAT_H = CARD_DEFAULTS.ai_chat.height;
      const CHAT_X = PORTRAIT.width + GAP + 20;
      const RESULT_X = CHAT_X + CHAT_W + GAP + 20;

      const selfiePrompt = [
        "把图1、图2、图3这三张图组合成一张电商对镜自拍图。",
        "",
        "人物保持图1的五官长相，穿上图2的服装，背景换成图3的场景。人物正对镜子，一手举手机自拍，手机挡住脸部，展示全身穿搭。光线和色调参考图3。人物脸部要有明显的真实质感，不要磨皮，写实风格，高质量电商图片。",
        "",
        "最终生成4个提示词方案，分别为一张全身正面，一张全身侧面，一张半身侧面，一张半身正面，要求人物状态自然，悠闲。不要有任何的废话。",
      ].join("\n");

      return [
        {
          type: "ai_image" as const,
          title: "模特图（图1）",
          relativeX: 0,
          relativeY: 0,
          ...PORTRAIT,
          data: { content: "", size: "3:4", imageUrl: mirrorSelfiePerson },
        },
        {
          type: "ai_image" as const,
          title: "服装图（图2）",
          relativeX: 0,
          relativeY: PORTRAIT.height + GAP,
          ...I_624x1690,
          data: { content: "", size: "3:4", imageUrl: mirrorSelfieGarment },
        },
        {
          type: "ai_image" as const,
          title: "场景图（图3）",
          relativeX: 0,
          relativeY: (PORTRAIT.height + GAP) * 2,
          ...PORTRAIT,
          data: { content: "", size: "3:4", imageUrl: mirrorSelfieScene },
        },
        {
          type: "ai_chat" as const,
          title: "对镜自拍提示词",
          relativeX: CHAT_X,
          relativeY: (COL_H - CHAT_H) / 2,
          width: CHAT_W,
          height: CHAT_H,
          data: {
            content: selfiePrompt,
            result: "",
          },
        },
        {
          type: "ai_image" as const,
          title: "效果图",
          relativeX: RESULT_X,
          relativeY: (COL_H - PORTRAIT.height) / 2,
          ...PORTRAIT,
          data: { content: "", size: "3:4", imageUrl: mirrorSelfieResult1 },
        },
      ];
    })(),
    connections: [
      { sourceIndex: 0, targetIndex: 3 },
      { sourceIndex: 1, targetIndex: 3 },
      { sourceIndex: 2, targetIndex: 3 },
      { sourceIndex: 0, targetIndex: 4 },
      { sourceIndex: 1, targetIndex: 4 },
      { sourceIndex: 2, targetIndex: 4 },
      { sourceIndex: 3, targetIndex: 4 },
    ],
  },
  {
    id: "wf-mirror-selfie",
    name: "对镜自拍一键换装2.0",
    description:
      "上传模特、服装与场景参考图，AI 生成电商对镜自拍穿搭图",
    icon: "Smartphone",
    category: "composite",
    coverImage: coverMirrorSelfie,
    cards: (() => {
      const GAP = 60;
      const COL_H = PORTRAIT.height * 3 + GAP * 2;
      const CHAT_W = CARD_DEFAULTS.ai_chat.width;
      const CHAT_H = CARD_DEFAULTS.ai_chat.height;
      const CHAT_X = PORTRAIT.width + GAP + 20;
      const RESULT_X = CHAT_X + CHAT_W + GAP + 20;

      const selfiePrompt = [
        "角色设定：你是一位资深的商业摄影提示词专家，擅长将服装、模特与场景完美融合，特别精通\"博主风对镜自拍\"的视觉构图。",
        "",
        "输入分析要求：",
        "",
        "识别图1（模特）：提取模特的面部特征、发型及肤质感。",
        "",
        "识别图2（服装）：精准提取服装的款式（如：马甲、短裤）、颜色、材质（如：亚麻、针织）以及细节（如：纽扣、褶皱）。",
        "",
        "识别图3（场景）：提取室内装修风格、光影环境，但必须严格忽略图3人物所穿的任何服装、帽子及配饰。",
        "",
        "任务指令：",
        "请基于上述分析，结合\"对镜自拍\"核心要素（45度侧身、顶胯S曲线、高低肩、手机遮脸），生成3个针对 Nano Banana 2 优化的绘图提示词。",
        "",
        "输出格式要求（仅输出提示词内容）：",
        "",
        "方案 1：【全身构图 - 视觉拉伸模式】",
        "提示词：(Full-body mirror selfie), 将[图1模特特征]与[图2服装细节]完美融合。场景设定在[图3的环境空间]中。动作核心：((侧身45度，重心向一侧顶胯，双脚贴近画面底边缘以拉长腿部))。一侧肩膀提肘，一侧下沉。手机遮脸，画面顶端留白1/3。画质：Nano Banana 2高保真还原，极致面料肌理，电影感自然光影。",
        "",
        "方案 2：【半身构图 - 氛围质感模式】",
        "提示词：(Waist-up mirror selfie), 重点展现[图2服装]的上半身剪裁。模特为[图1特征]，置身于[图3场景]。动作核心：((手机半遮脸，手肘抬高凹出直角肩，身体轻微扭转))。侧重表现腰线位置与服装垂直感。画质：写实皮肤质感，柔和室内散射光，极简高级感。",
        "",
        "方案 3：【下半身构图 - 搭配与剪裁模式】",
        "提示词：(Lower-body mirror selfie), 不露脸构图。画面截取自模特胸部以下至脚部。重点展现[图2服装]的下半身剪裁与垂坠感。模特身材参考[图1]，置身于[图3场景]。",
        "动作核心：((单手插兜或手持手机下压，重心向一侧顶胯，双腿呈交叉步或一前一后摆放))。通过对镜角度产生极强的纵深感，视觉中心锁定在腰线下方的服装轮廓。",
        "画质：Nano Banana 2 极高精细度，重点强化((下半身面料纹理与褶皱))。100%还原[图2]中鞋子与下装的材质，自然光影，极简背景。",
      ].join("\n");

      return [
        {
          type: "ai_image" as const,
          title: "模特图（图1）",
          relativeX: 0,
          relativeY: 0,
          ...PORTRAIT,
          data: { content: "", size: "3:4", imageUrl: mirrorSelfiePerson },
        },
        {
          type: "ai_image" as const,
          title: "服装图（图2）",
          relativeX: 0,
          relativeY: PORTRAIT.height + GAP,
          ...I_624x1690,
          data: { content: "", size: "3:4", imageUrl: mirrorSelfieGarment },
        },
        {
          type: "ai_image" as const,
          title: "场景图（图3）",
          relativeX: 0,
          relativeY: (PORTRAIT.height + GAP) * 2,
          ...PORTRAIT,
          data: { content: "", size: "3:4", imageUrl: mirrorSelfieScene },
        },
        {
          type: "ai_chat" as const,
          title: "对镜自拍提示词",
          relativeX: CHAT_X,
          relativeY: (COL_H - CHAT_H) / 2,
          width: CHAT_W,
          height: CHAT_H,
          data: {
            content: selfiePrompt,
            result: "",
          },
        },
        {
          type: "ai_image" as const,
          title: "效果图1",
          relativeX: RESULT_X,
          relativeY: 0,
          ...PORTRAIT,
          data: { content: "", size: "3:4", imageUrl: mirrorSelfieResult1 },
        },
        {
          type: "ai_image" as const,
          title: "效果图2",
          relativeX: RESULT_X,
          relativeY: PORTRAIT.height + GAP,
          ...PORTRAIT,
          data: { content: "", size: "3:4", imageUrl: mirrorSelfieResult2 },
        },
        {
          type: "ai_image" as const,
          title: "效果图3",
          relativeX: RESULT_X,
          relativeY: (PORTRAIT.height + GAP) * 2,
          ...PORTRAIT,
          data: { content: "", size: "3:4", imageUrl: mirrorSelfieResult3 },
        },
      ];
    })(),
    connections: [
      { sourceIndex: 0, targetIndex: 3 },
      { sourceIndex: 1, targetIndex: 3 },
      { sourceIndex: 2, targetIndex: 3 },
      { sourceIndex: 0, targetIndex: 4 },
      { sourceIndex: 1, targetIndex: 4 },
      { sourceIndex: 2, targetIndex: 4 },
      { sourceIndex: 3, targetIndex: 4 },
      { sourceIndex: 0, targetIndex: 5 },
      { sourceIndex: 1, targetIndex: 5 },
      { sourceIndex: 2, targetIndex: 5 },
      { sourceIndex: 3, targetIndex: 5 },
      { sourceIndex: 0, targetIndex: 6 },
      { sourceIndex: 1, targetIndex: 6 },
      { sourceIndex: 2, targetIndex: 6 },
      { sourceIndex: 3, targetIndex: 6 },
    ],
  },
  {
    id: "wf-multimodal-fusion-2",
    name: "多模态融合2",
    description:
      "上传模特、服装、影调与环境参考图，AI 生成5组差异化商业摄影灵感方案",
    icon: "Combine",
    category: "composite",
    coverImage: coverMultimodalFusion2,
    cards: (() => {
      const GAP = 60;
      const IMG_P = I_390x340;
      const IMG_G = SQUARE;
      const IMG_REF = PORTRAIT;
      const IMG_RES = PORTRAIT;
      const ROW1_H = Math.max(IMG_P.height, IMG_G.height);
      const COL_W = Math.max(IMG_P.width, IMG_G.width, IMG_REF.width);
      const CHAT_W = CARD_DEFAULTS.ai_chat.width;
      const CHAT_H = ROW1_H + GAP + IMG_REF.height;
      const CHAT_X = COL_W * 2 + GAP * 2;
      const RESULT_X = CHAT_X + CHAT_W + GAP;
      const ROW_STEP = IMG_RES.width + GAP;
      const TOP_ROW_W = IMG_RES.width * 3 + GAP * 2;
      const BTM_ROW_W = IMG_RES.width * 2 + GAP;
      const BTM_OFFSET = Math.round((TOP_ROW_W - BTM_ROW_W) / 2);

      const fusionPrompt = [
        "你是一位资深服装商业摄影导演。请基于用户上传的多张参考图，完成「模特 + 服装 + 影调 + 环境 + 动作神态」的多模态融合任务，并一次性输出 5 个差异化商业摄影灵感方案。",
        "",
        "核心目标：",
        "你不是直接出图，而是为 Nanobanana 准备 5 条独立可用的单图出图提示词。每个灵感必须输出 display_prompt、nanobanana_prompt、negative_prompt。",
        "",
        "最重要原则：",
        "nanobanana_prompt 只写正向摄影描述，只描述最终画面应该出现什么。不要在 nanobanana_prompt 中写负面视觉词，例如拼图、四宫格、排版页、标题文字、水印、乱码等。这些只能写入 negative_prompt。",
        "",
        "一、参考图角色",
        "",
        "严禁跨图串用：",
        "图1只做主体人物参考。",
        "图2是唯一服装与配饰来源。",
        "图3只做影调参考。",
        "图4是唯一环境来源。",
        "图5只做灵感1的动作、姿态、神态、景别和裁切参考。",
        "",
        "图1：只提取人物五官、脸型、发型、妆容、肤色、身材比例、年龄感和气质。最终主体人物必须保持图1同一位模特，不得换脸或改变年龄感。图1中的服装、配饰、姿态、背景、光线不得继承。",
        "",
        "图2：唯一服装与配饰来源。最终画面里所有服装、鞋履、帽子、包袋、眼镜、首饰、图案、logo、颜色、层叠关系都只能来自图2。图1、图3、图4、图5里的任何服装和配饰都视为噪声，不得继承。",
        "",
        "若图2只提供一件单品，例如只有卫衣、裤子或鞋，则只强制还原该单品。缺失单品用低存在感、基础款、无品牌、无图案、中性色自然补全，不得从其他图借用。",
        "",
        "若图2没有外套，不得写外套、夹克、西装、风衣、大衣。若图2没有墨镜，不得写墨镜。若图2没有鞋履或裤装，只能写基础中性鞋履/下装自然补全。",
        "",
        "若图2包含多件上身单品，先判断是否为合理层叠穿搭，例如内搭+外套、衬衫+马甲、连衣裙+外套。只有同一层级且无法同时穿着时才视为冲突。",
        "",
        "图3：只提取色温、明暗、对比度、饱和度、光线方向、阴影、颗粒感和镜头质感。不得继承人物、服装、环境和道具。",
        "",
        "图4：唯一环境来源。只提取图4中的空间结构、地面、墙面、窗户、家具、植物、建筑、主体可站立或坐卧区域、前中后景和镜头视角。不得从图1、图2、图3、图5提取环境。",
        "",
        "图4环境描述必须包含相对位置，例如「人物后方的白色窗框」「画面右侧的沙发靠垫」「下方浅色座面」「窗外绿色树景」，不能只写「室内、草地、花丛、街道」这种泛化词。",
        "",
        "图5：灵感1专属动作神态参考，可选。若提供图5，灵感1必须参考图5的动作、姿态、神态、景别和裁切。图5是半身，灵感1就是半身；图5是近景，灵感1就是近景；图5是坐姿、躺姿、倚靠，就按该动作转译。不得强行改成全身。图5不得提供人物身份、服装、环境、影调。",
        "",
        "二、五个灵感",
        "",
        "5 个灵感不能都是半身或中景，必须形成清楚的远近变化。",
        "",
        "灵感1：如果有图5，就按图5的景别和动作来；如果没有图5，就做全身图。",
        "灵感2：做七分身或近全身，至少看到头部到小腿。",
        "灵感3：做半身图，只看到头部到腰部或胸口。",
        "灵感4：做全身或近全身环境互动图。如果灵感1不是全身，灵感4必须补一张全身或近全身。",
        "灵感5：做近景或半身 editorial 图，不能做普通全身站立图。",
        "",
        "三、景别约束",
        "",
        "每条提示词必须写清人物裁切范围，例如头到鞋完整入镜、头到小腿、头到腰部、胸口以上近景。",
        "",
        "全身图：可以描述完整穿搭。",
        "七分身/中景：描述上衣、腰线、部分下装，不强制鞋履。",
        "半身图：只描述脸部、领口、肩线、上衣、胸前结构、袖口和手部趋势。",
        "近景：只描述画面内可见的脸、头发、领口、面料、扣件、配饰或局部手势。",
        "",
        "不得为了展示完整服装或完整环境而破坏当前景别。",
        "",
        "四、人物角度与神态",
        "",
        "如果某个灵感不是正面直视，必须明确写出身体朝向、肩线方向、脸部方向、眼神方向，以及是否看镜头。避免只写「轻微转头」「看向远处」等模糊描述。",
        "",
        "示例写法：",
        "人物身体为三分之二侧身，肩线朝向画面左侧，脸部转向画面右侧窗外，视线不看镜头，鼻梁方向与镜头形成约45度夹角。",
        "",
        "5 个灵感必须保持图1同一人物身份，但表情和神态需要有细微差异。表情高级、克制、自然。避免夸张大笑、过度甜美、网红摆拍、戏剧化表情和低级媚态。",
        "",
        "五、Nanobanana 提示词要求",
        "",
        "nanobanana_prompt 只写正向摄影描述，不写「不要、禁止、不得」，不写负面词，不写分析过程，不写「生成灵感X」。",
        "",
        "nanobanana_prompt 结构：",
        "「一张单幅、连续、完整的真实商业摄影照片，[景别 + 动作 + 神态 + 构图目标]。画面为[裁切范围]，[身体朝向/肩线方向/脸部方向/眼神方向/手部动作]，整体干净自然。主体模特严格参考图1，[人物关键特征]；服装严格参考图2，[只写图2中存在的服装与配饰，缺失单品用基础中性款自然补全]；影调参考图3，[光线与色调]；环境严格参考图4，[按当前景别可见的图4环境锚点和相对位置]。」",
        "",
        "negative_prompt 写负面限制，不能拼到 nanobanana_prompt。",
        "",
        "六、输出前自检",
        "",
        "输出前检查：",
        "1. clothing_analysis 和 nanobanana_prompt 中的服装、配饰、logo、颜色、层叠关系都必须来自图2。",
        "2. 如果图2没有外套、夹克、墨镜、帽子、包袋，不得在正向字段出现这些词。",
        "3. environment_anchors 和 nanobanana_prompt 的环境只能来自图4。",
        "4. 若提供图5，只有灵感1可参考图5；灵感2-5不得引用图5。",
        "5. 若图5不是全身，灵感1不得写全身、完整全身、头到脚、完整展示比例。",
        "6. 整组必须至少有一张全身或近全身图；不能 5 张都裁成半身。",
        "7. 灵感2不得是半身；灵感3不得是全身；灵感5不得是普通全身站立图。",
        "8. nanobanana_prompt 不得出现负面视觉词。",
        "9. 半身和近景不得强制展示鞋履、完整下装或完整环境。",
        "",
        "七、输出格式",
        "",
        "只输出可被 JSON.parse 解析的 JSON，不要 Markdown，不要解释文字。",
        "",
        "{",
        '  "clothing_analysis": {',
        '    "top_length": "",',
        '    "bottom_length": "",',
        '    "outerwear_length": "",',
        '    "shoes_accessories": "",',
        '    "layering_relation": "",',
        '    "uncertain_items": ""',
        "  },",
        '  "environment_anchors": {',
        '    "scene_type": "",',
        '    "anchors": ["", "", "", "", ""],',
        '    "spatial_relation": "",',
        '    "composition_relation": "",',
        '    "do_not_replace_with": ""',
        "  },",
        '  "inspirations": [',
        "    {",
        '      "id": 1,',
        '      "title": "",',
        '      "shot_type": "",',
        '      "expression": "",',
        '      "pose_expression_reference": "",',
        '      "display_prompt": "",',
        '      "nanobanana_prompt": "",',
        '      "negative_prompt": ""',
        "    },",
        "    ... (共5个)",
        "  ]",
        "}",
        "",
        "negative_prompt 统一包含但不限于：改款，改色，换脸，第二清晰主角，遮挡服装，其他参考图服装，外套，夹克，西装，风衣，大衣，墨镜，白底商品图，服装贴片，拼图，四宫格，多图排版，标题文字，水印，后期文字，乱码，平台标识，畸形肢体，错误手指，过度磨皮，卡通插画风，正脸直视镜头，证件照角度，头部正对镜头，双肩完全平行镜头。",
      ].join("\n");

      return [
        {
          type: "ai_image" as const,
          title: "模特图（图1）",
          relativeX: 0,
          relativeY: 0,
          ...IMG_P,
          data: { content: "", size: "3:4", imageUrl: mf2Person },
        },
        {
          type: "ai_image" as const,
          title: "服装图（图2）",
          relativeX: COL_W + GAP,
          relativeY: 0,
          ...IMG_G,
          data: { content: "", size: "1:1", imageUrl: mf2Garment },
        },
        {
          type: "ai_image" as const,
          title: "影调参考（图3）",
          relativeX: 0,
          relativeY: ROW1_H + GAP,
          ...IMG_REF,
          data: { content: "", size: "3:4", imageUrl: mf2Tone },
        },
        {
          type: "ai_image" as const,
          title: "环境参考（图4）",
          relativeX: COL_W + GAP,
          relativeY: ROW1_H + GAP,
          ...IMG_REF,
          data: { content: "", size: "3:4", imageUrl: mf2Scene },
        },
        {
          type: "ai_chat" as const,
          title: "融合提示词",
          relativeX: CHAT_X,
          relativeY: 0,
          width: CHAT_W,
          height: CHAT_H,
          data: {
            content: fusionPrompt,
            result: "",
          },
        },
        {
          type: "ai_image" as const,
          title: "效果图1",
          relativeX: RESULT_X,
          relativeY: 0,
          ...IMG_RES,
          data: { content: "效果图1 正向：{{inspirations[0].nanobanana_prompt}}\n效果图1 负向：{{inspirations[0].negative_prompt}}\n4k画质", size: "3:4", imageUrl: mf2Result1 },
        },
        {
          type: "ai_image" as const,
          title: "效果图2",
          relativeX: RESULT_X + ROW_STEP,
          relativeY: 0,
          ...IMG_RES,
          data: { content: "效果图2 正向：{{inspirations[1].nanobanana_prompt}}\n效果图2 负向：{{inspirations[1].negative_prompt}}\n4k画质", size: "3:4", imageUrl: mf2Result2 },
        },
        {
          type: "ai_image" as const,
          title: "效果图3",
          relativeX: RESULT_X + ROW_STEP * 2,
          relativeY: 0,
          ...IMG_RES,
          data: { content: "效果图3 正向：{{inspirations[2].nanobanana_prompt}}\n效果图3 负向：{{inspirations[2].negative_prompt}}\n4k画质", size: "3:4", imageUrl: mf2Result3 },
        },
        {
          type: "ai_image" as const,
          title: "效果图4",
          relativeX: RESULT_X + BTM_OFFSET,
          relativeY: IMG_RES.height + GAP,
          ...IMG_RES,
          data: { content: "效果图4 正向：{{inspirations[3].nanobanana_prompt}}\n效果图4 负向：{{inspirations[3].negative_prompt}}\n4k画质", size: "3:4", imageUrl: mf2Result4 },
        },
        {
          type: "ai_image" as const,
          title: "效果图5",
          relativeX: RESULT_X + BTM_OFFSET + ROW_STEP,
          relativeY: IMG_RES.height + GAP,
          ...IMG_RES,
          data: { content: "效果图5 正向：{{inspirations[4].nanobanana_prompt}}\n效果图5 负向：{{inspirations[4].negative_prompt}}\n4k画质", size: "3:4", imageUrl: mf2Result5 },
        },
      ];
    })(),
    connections: [
      { sourceIndex: 0, targetIndex: 4 },
      { sourceIndex: 1, targetIndex: 4 },
      { sourceIndex: 2, targetIndex: 4 },
      { sourceIndex: 3, targetIndex: 4 },
      { sourceIndex: 0, targetIndex: 5 },
      { sourceIndex: 1, targetIndex: 5 },
      { sourceIndex: 2, targetIndex: 5 },
      { sourceIndex: 3, targetIndex: 5 },
      { sourceIndex: 4, targetIndex: 5 },
      { sourceIndex: 0, targetIndex: 6 },
      { sourceIndex: 1, targetIndex: 6 },
      { sourceIndex: 2, targetIndex: 6 },
      { sourceIndex: 3, targetIndex: 6 },
      { sourceIndex: 4, targetIndex: 6 },
      { sourceIndex: 0, targetIndex: 7 },
      { sourceIndex: 1, targetIndex: 7 },
      { sourceIndex: 2, targetIndex: 7 },
      { sourceIndex: 3, targetIndex: 7 },
      { sourceIndex: 4, targetIndex: 7 },
      { sourceIndex: 0, targetIndex: 8 },
      { sourceIndex: 1, targetIndex: 8 },
      { sourceIndex: 2, targetIndex: 8 },
      { sourceIndex: 3, targetIndex: 8 },
      { sourceIndex: 4, targetIndex: 8 },
      { sourceIndex: 0, targetIndex: 9 },
      { sourceIndex: 1, targetIndex: 9 },
      { sourceIndex: 2, targetIndex: 9 },
      { sourceIndex: 3, targetIndex: 9 },
      { sourceIndex: 4, targetIndex: 9 },
    ],
  },
  {
    id: "wf-multimodal-pattern",
    name: "多模态版型参考",
    description:
      "上传人物、穿搭、版型与场景参考图，AI 解构服装细节并生成 5 组差异化商业写真",
    icon: "Layers",
    category: "composite",
    cards: (() => {
      const GAP = 60;
      const INPUT_COL_W = SQUARE.width; // 340
      const INPUT_STEP = SQUARE.height + GAP; // 400
      const CHAT_X = INPUT_COL_W + GAP;
      const CHAT_W = CARD_DEFAULTS.ai_chat.width;
      const CHAT_H = INPUT_STEP * 2;
      const RESULT_X = CHAT_X + CHAT_W + GAP;
      const RES_STEP = PORTRAIT.height + GAP; // 400
      const TOP_ROW_W = PORTRAIT.width * 3 + GAP * 2;
      const BTM_ROW_W = PORTRAIT.width * 2 + GAP;
      const BTM_OFFSET = Math.round((TOP_ROW_W - BTM_ROW_W) / 2);

      const patternPrompt = [
        "你是一位拥有 10 年商业时尚摄影经验，同时熟悉服装面料、制版结构与人体比例的视觉导演。请依据我上传的 4 张参考图和客户文字输入，先在内部完成识别，再输出 5 个差异明显、可直接用于生图的服装人像灵感方案。不要展示分析过程。",
        "",
        "【可选但强烈建议填写】",
        "本次重点产品：__裤子__。",
        "如果用户填写了商品主角，例如裤子、上衣、鞋、包袋、帽子、首饰、整套搭配，则必须以用户填写为最高优先级。即使图2是一套完整搭配，5个灵感也必须围绕本次重点产品构图，其他单品只作为搭配辅助。",
        "",
        "",
        "一、参考图职责",
        "",
        "图 1 = 人物身份参考。",
        "把图 1 作为唯一人物来源，严格保持同一人物的脸型、五官比例、眉眼特征、眼距、鼻型、唇形、下颌线、肤色、发际线、发型、发色、妆容气质和身材比例。不得读取图 2、图 3、图 4 中人物的长相，也不得把不同参考图的人脸混合。5 个方案必须让人一眼认出是图 1 中的同一个人。",
        "",
        "允许根据镜头和动作产生正常的透视、侧脸角度与轻微表情变化，但不得重新设计五官。人物整体状态要克制、松弛、有质感，避免夸张表演、僵硬假笑和网红式嘟嘴。只在脸部实际进入画面的方案中安排表情：露脸方案必须同时覆盖平静高级表情和闭唇温柔浅笑；如果有 4 个及以上露脸方案，至少 2 个为平静高级表情、至少 2 个为闭唇温柔浅笑。下半身构图和产品特写不需要为了满足表情数量而补入脸部。浅笑只改变嘴角和眼神，不改变脸型与五官结构。",
        "",
        "图 2 = 实际商品细节参考。",
        "严格读取白底服装穿搭图中的真实款式、颜色、面料、纹理、光泽、织法、印花、走线、纽扣、拉链、口袋、腰头、褶皱、拼接、装饰、鞋履和配饰。图 2 负责\"商品是什么\"，不负责人物长相、场景、动作和光线。",
        "",
        "先判断图 2 的输入类型：",
        "",
        "类型 A：完整穿搭图。图 2 已经提供完成穿搭所需的上衣、下装、连衣裙、外套或其他明确搭配单品。此时整套搭配严格以图 2 为准，不得新增、删除、替换或重新设计任何服装；画面中需要出现的所有服装都只能来自图 2。不得擅自增加图 2 中不存在的内搭、外套、裤子、裙装或其他服装。",
        "",
        "类型 B：单件或不完整商品图。图 2 只提供客户点名的重点产品，没有提供完成穿搭所需的其他服装。此时允许根据重点产品和实际构图补齐完成穿搭所需要的上衣、下装、内搭、外套或鞋履，但不得增加与穿搭无关的服装和装饰性单品。补充搭配必须简洁、低存在感、无明显图案和标识，不遮挡重点产品，不改变重点产品的轮廓、颜色和展示面积，并与图 2 商品的颜色、材质和风格协调。",
        "",
        "图 2 为单件或不完整商品图时，必须先在内部确定一套完整补充搭配，再用于全部 5 个灵感方案。5 个方案中的补充上衣、下装、内搭、外套和鞋履必须保持同款、同色、同材质，不得每个方案重新搭配。只有景别裁切导致某件补充单品不进入画面时，才不在该方案中描述。",
        "",
        "图 2 是完整穿搭还是单件产品，必须根据图片实际内容判断，不能根据客户填写的重点产品数量判断。即使重点产品只写\"裤子\"，只要图 2 同时提供了上衣和裤子，也按完整穿搭图处理，必须保留图 2 中的上衣。",
        "",
        "图 3 = 上身版型参考。",
        "先判断图 3 是否为有效的版型穿搭效果图。有效图 3 必须能清楚看到服装穿在真人或模特身上的轮廓、松量、长度和比例。白底平铺图、白底挂拍图、单件商品图、与图 2 相同或近似的白底图，都不属于有效版型穿搭效果图。",
        "",
        "如果没有上传图 3，或图 3 不是有效版型穿搭效果图，或图 3 与图 2 一样都是白底商品图：完全放弃图 3，不读取图 3 的任何版型信息，整套服装的款式、颜色、材质、结构、长度、松量和版型全部以图 2 为准。",
        "",
        "如果图 3 是有效版型穿搭效果图：只读取客户填写的\"重点产品\"对应部分的版型，不得读取其他非重点产品的版型。图 3 只提供重点产品穿在人身上的轮廓参考，不提供商品颜色、材质、纹理、工艺和配件。",
        "",
        "重点产品与图 3 的读取关系：",
        "重点产品填写\"裤子\"：只读取图 3 的裤子腰线、臀腿松量、裤型、裤长和裤脚宽度；上衣、外套、鞋履及其他单品全部以图 2 为准。",
        "重点产品填写\"上衣\"：只读取图 3 的上衣肩线、胸围松量、腰部松量、袖肥、袖长、衣长和下摆轮廓；裤子、裙装、鞋履及其他单品全部以图 2 为准。",
        "重点产品填写\"上衣、裤子\"：只读取图 3 的上衣版型和裤子版型；外套、鞋履、配饰及其他单品全部以图 2 为准。",
        "重点产品填写\"半裙\"或\"连衣裙\"：只读取图 3 对应裙装的腰线、裙长、裙型、裙摆体量和垂坠轮廓。",
        "重点产品填写\"外套\"：只读取图 3 的外套肩线、胸围松量、袖型、衣长、门襟和整体轮廓。",
        "重点产品填写\"整套\"：才允许读取图 3 中整套服装的上身版型和上下装比例。",
        "重点产品填写多个单品时：只读取被点名的单品版型，未被点名的所有服装仍以图 2 为准。",
        "",
        "图 2 与有效图 3 同时存在时，优先级如下：",
        "客户手动填写的重点产品和尺寸要求优先；重点产品的上身松量、长度、腰线、裤型、裙型和轮廓以有效图 3 为参考；所有商品的款式、颜色、材质、纹理、工艺、配件和搭配关系以图 2 为准；非重点产品的版型也以图 2 为准。禁止为了显腿长擅自收窄裤腿、提高腰线、缩短上衣、加长腿部或改变裙摆体量。",
        "",
        "图 4 = 环境与光线参考。",
        "清除其他参考图中的背景，只读取图 4 的空间类型、建筑与室内材质、背景物件、主色关系、光线方向、光源软硬、色温、曝光倾向、明暗层次、阴影形态和空气感。5 个方案必须像在同一环境、同一时段完成的一组商业拍摄，但机位、景别、人物位置与动作不能重复。不得照搬图 4 中人物、服装、文字、品牌标识和无关道具。",
        "",
        "二、重点产品展示",
        "",
        "客户填写的\"重点产品\"是本次拍摄的展示中心。5 个方案都必须保证重点产品不被手臂、头发、道具或裁切长期遮挡，并根据品类安排可见范围：",
        "",
        "重点为上衣：至少 3 个方案清楚展示领口、肩线、袖型、衣长、下摆和面料。",
        "重点为裤子：至少 3 个方案使用全身或三分之二身构图，清楚展示腰线、臀腿松量、裤型、裤长、裤脚与鞋面关系。",
        "重点为裙装：至少 3 个方案看清腰线、裙长、裙摆体量、垂坠和动态形态。",
        "重点为外套：至少 3 个方案看清肩线、门襟、衣长、整体松量以及敞开或扣合方式。",
        "重点为整套：至少 3 个方案完整展示上下装比例，不得只拍上半身。",
        "重点为鞋履或配饰：至少 2 个方案安排清晰近景，其余方案保留其与整套穿搭的关系。",
        "",
        "只有全身或三分之二身画面可以描述完整裤长、完整裙长和鞋履。半身、近景和特写只描述画面实际可见的服装部分，不要把画面外的人物、服装、鞋履、动作和环境强行写进提示词。",
        "",
        "\"不描述画面外内容\"不等于忽略画面内露出的非重点产品。每个方案生成提示词前，必须先判断图 2 是完整穿搭还是单件产品，再判断裁切后实际进入画面的全部单品。完全位于画面外的单品才不描述。",
        "",
        "执行\"可见即锁定\"规则：",
        "重点产品决定景别、构图和主要描述篇幅；图 2 决定画面内所有可见服装的真实外观。",
        "如果图 2 是完整穿搭图：只要某件服装有任何部分进入画面，即使它不是重点产品，也必须按照图 2 写清当前可见部分的款式、颜色、材质、纹理和搭配关系，不得新增图 2 中不存在的服装。",
        "如果图 2 是单件或不完整商品图：先确定一套完整且固定的补充搭配。画面中需要出现其他服装时，明确写出补充单品的品类、颜色、材质和简洁版型；补充单品只承担完成穿搭的作用，不得抢占重点产品。全部 5 个方案使用同一套补充搭配，不得换款、换色或增减单品。",
        "非重点产品或补充搭配只描述进入画面的那一小部分，不扩写画面外结构，也不读取图 3 的版型。",
        "不得使用\"上衣局部\"\"其他搭配\"\"少量衣摆\"等模糊说法，必须写明图 2 中该可见部分的具体颜色、材质、纹理和结构。",
        "不得因为重点产品是裤子，就省略腰线上方实际露出的上衣下摆；不得因为重点产品是上衣，就省略腰线下方实际露出的裤腰或裙腰。完整穿搭按图 2 锁定；单件产品则明确补齐必要搭配。",
        "如果图 2 是完整穿搭且无法保证非重点产品准确还原，应收紧裁切边界，让该单品完全退出画面，不得让它露出后交给 AI 自由补全。",
        "",
        "可见范围采用硬限制：",
        "",
        "产品特写方案只允许描述一个重点产品局部，例如领口与纽扣、袖口与走线、面料纹理、腰头与褶裥、口袋与侧缝、裤脚与面料垂坠、裙摆工艺或外套门襟。优先通过更紧的裁切让其他单品完全退出画面；如果画面边缘不可避免地露出其他单品，完整穿搭按图 2 锁定该可见边缘，单件产品则明确补齐必要搭配的可见边缘。画面只出现重点产品局部、必要的少量身体区域以及被准确说明的服装边缘，背景只保留图 4 的虚化色块、光影或材质痕迹。不得描述完整人物、完整脸部、全身姿势、完整上下装、完整裤长、完整裙长、鞋履、远景、建筑全貌或大面积环境。",
        "",
        "半身构图必须根据重点产品自动选择裁切范围：",
        "重点产品为上衣或外套：使用上半身构图，画面范围控制在头部或肩颈至腰线、胯部上方，描述脸部、肩颈、手臂以及上衣或外套的可见部分；如果腰线下方露出裤腰或裙腰，完整穿搭按图 2 锁定，单件产品则明确补齐简洁的裤腰或裙腰。不得描述腿部、裤脚、裙摆、鞋履、脚部和全身站姿。",
        "重点产品为裤子：使用下半身构图，画面范围控制在腰部上方少量区域至脚踝或鞋面，描述腰线、臀腿松量、裤型、裤长、裤脚、腿部动作和必要的手部局部；如果裤腰上方露出上衣下摆，完整穿搭必须按图 2 写清该下摆，单件裤子图则补充简洁、低存在感且不遮挡裤腰的上衣下摆。只描述进入画面的部分，不描述完整上衣。不得描述脸部、妆容、发型、肩颈、上衣领口、完整上半身和人物表情。",
        "重点产品为半裙：使用下半身构图，画面范围控制在腰部上方少量区域至裙摆，描述腰线、裙型、裙长、裙摆体量、腿部或鞋面的必要关系；如果裙腰上方露出上衣下摆，完整穿搭按图 2 锁定，单件半裙图则补充简洁、低存在感且不遮挡裙腰的上衣下摆。不得描述脸部、妆容、发型和完整上半身。",
        "重点产品为连衣裙或整套：根据客户填写的\"重点产品必须看清的细节\"选择上半身或下半身，只能选择一个裁切范围，不得同时描述头部到脚部。",
        "重点产品为鞋履或配饰：半身方案改为对应产品的中近景，只保留产品及与其发生关系的必要身体部分。",
        "",
        "特写和半身方案必须在提示词中明确写入\"严格局部取景，不扩展画面范围，不生成全身或全景\"。提示词中凡是位于裁切范围外的内容一律不写，不能用\"虽然画面外不可见但保持一致\"等方式补充。",
        "",
        "三、人物自然 Pose 规则",
        "",
        "5 个方案中的人物动作必须像摄影师在真实拍摄现场引导出来的自然瞬间，不得只写\"自然站立\"\"时尚姿势\"或\"高级姿态\"等空泛描述。全身和动态方案要写清楚人物的身体朝向、重心落点、腿部关系、肩胯关系、手臂与手指去向、头部角度和视线方向；半身与特写方案只写裁切范围内实际可见的姿态，不得为了补齐动作信息描述画面外的身体部位。",
        "",
        "站姿必须有明确支撑腿和放松腿：身体重量自然落在一侧腿上，另一侧腿轻微屈膝、向前半步或脚尖自然外开；双膝不得同时锁死，双脚不得机械并拢，身体不得像证件照一样正对镜头僵直站立。",
        "",
        "肩颈保持放松，肩线允许轻微高低差；胸腔、腰胯和头部可以形成轻微反向关系，但不得夸张扭腰、过度挺胸、刻意塌腰或摆出不符合人体习惯的 S 形曲线。",
        "",
        "双手必须有合理去向，可以自然垂落、轻触袖口、轻扶衣摆、单手松弛插袋、指尖轻碰门框或桌面。手掌不得同时正对镜头，手腕不得反折，手肘不得同时外翻，手指保持放松并略有间距，不得握拳、五指僵直或无目的悬在空中。",
        "",
        "人物与环境发生接触时必须有真实受力关系：倚靠墙面、门框、桌沿或座椅时，接触点、身体倾斜方向和重心必须一致；不得身体悬空，不得手掌穿入物体，不得用不可能的角度支撑身体。",
        "",
        "行走、转身和回头动作应处于动作中间帧：步幅小而自然，前后脚承担合理重量，衣摆或裤腿只产生轻微惯性；头部转动与肩线协调，不得头部过度旋转，不得四肢同时大幅动作。",
        "",
        "动作必须服务重点产品展示。手臂、头发和环境物件不得长时间遮挡领口、门襟、腰线、裤型、裙摆或其他重点细节。需要插袋时只允许单手浅插，不得拉扯口袋或改变裤子版型；需要整理衣物时只允许轻触，不得抓紧、掀起或遮住商品结构。",
        "",
        "5 个方案的动作不能重复。整体动作应覆盖松弛静态站姿、半身范围内的自然姿态、产品局部的单一手部动作、行走或转身动态、与环境发生轻接触的姿态。动作幅度整体克制，像抓拍到的真实瞬间，不像舞台表演、走秀定点或刻意凹造型。",
        "",
        "四、5 个差异化方案",
        "",
        "方案 1：标准全身主视觉。平视机位，人物采用松弛静态站姿，身体重量自然落在一侧支撑腿，另一条腿微屈并向前半步，肩线轻微错落，一只手自然垂落，另一只手根据服装轻触裤侧、衣摆或浅插口袋；人物与环境关系完整，重点看清整套比例、服装长度和鞋履，使用平静高级表情。",
        "方案 2：重点产品半身构图。根据重点产品自动选择上半身或下半身构图。重点为上衣或外套时，只拍头部或肩颈至腰线、胯部上方，人物轻微侧身，肩颈放松，一只手自然垂落或轻触袖口、门襟、衣摆，使用温柔闭唇浅笑；如果画面下缘露出裤腰或裙腰，必须按图 2 锁定其可见颜色、材质和结构，不得随机补款；不得描述腿部、裤脚、裙摆和鞋履。重点为裤子时，只拍腰部上方少量区域至脚踝或鞋面，身体重量自然落在一侧腿，另一条腿微屈或向前半步，一只手可在画面边缘轻触腰侧或浅插口袋；裤腰上方只要露出上衣下摆，就必须按图 2 写清该可见下摆的真实颜色、材质、纹理、长度关系和叠穿方式，不能换成其他上衣；不得描述脸部、表情、妆发、肩颈、上衣领口和完整上衣。重点为半裙时采用相同的\"可见上衣下摆锁定\"规则。严格局部取景，不扩展画面范围，不生成全身或全景。",
        "方案 3：重点产品局部特写。只选择重点产品中一个最有识别度的局部进行近距离拍摄，例如上衣领口与纽扣、袖口与走线、面料纹理、裤子腰头与褶裥、口袋与侧缝、裤脚与垂坠、裙摆工艺或外套门襟；只允许一只手以放松指尖轻触或整理该细节，也可以完全不出现手。优先收紧裁切，让非重点产品退出画面；如果边缘仍露出其他服装，必须按图 2 写清该可见边缘的真实颜色、材质、纹理和结构，不得自行补款。画面不描述完整人物和完整服装，背景仅保留图 4 的少量虚化色块、光影或材质痕迹，使用 macro fashion detail photography、close-up product shot、high fabric fidelity。严格局部取景，不扩展画面范围，不生成半身、全身或全景。",
        "方案 4：自然动态展示。捕捉人物缓步向前、迈出小步、轻转身或自然回头的动作中间帧，前后脚受力合理，手臂随动作轻微自然摆动，衣摆、裤腿或裙摆只有真实的小幅惯性；动作不得遮挡重点产品，用温柔闭唇浅笑展示面料垂坠和动态形态。",
        "方案 5：环境叙事展示。人物与图 4 中适合的门框、墙面、桌沿、栏杆或座椅产生轻微接触，一只手指尖轻扶物体，身体只有小幅倚靠且重心真实，另一只手自然垂落或轻放腿侧；利用环境线条和光影形成层次，表情可轻微侧目或自然放松，同时保证重点产品清楚可见。",
        "",
        "5 个方案必须固定覆盖：标准全身、重点产品半身、重点产品局部特写、自然动态、环境氛围。方案 2 和方案 3 不得改成全身图或环境全景，不得只更换手势或表情来假装方案不同。",
        "",
        "五、摄影与画质要求",
        "",
        "每个方案的中文提示词中都要自然加入适合该画面的英文商业摄影术语，例如 fashion campaign photography、commercial editorial photography、full-body shot、three-quarter shot、medium close-up、eye-level angle、soft directional light、natural skin texture、high fabric fidelity、realistic garment construction、controlled highlights、clean shadow detail。英文术语应融入中文段落，不单独列词。",
        "",
        "画面必须是写实商业服装摄影，人体比例自然，姿态符合人体受力，肩颈与四肢放松，皮肤保留真实纹理，面料结构清楚，手指与关节正常，服装不融入身体，背景透视合理。避免站军姿、证件照站姿、双膝锁死、双脚机械并拢、双手无目的悬空、双手同时摆造型、交叉抱臂、夸张叉腰、过度扭腰、手腕反折、手肘外翻、手指僵直、动作与视线不协调；避免过度磨皮、塑料皮肤、夸张长腿、异常细腰、广角拉伸、五官漂移、服装变色、纹理重绘、版型收窄、裤长缩短、裙长变化、鞋履替换和无关配饰。",
        "",
        "六、最终输出",
        "",
        "只输出 5 个灵感方案，不输出参考图分析、执行步骤、说明、提醒或总结。",
        "",
        "每个方案必须严格使用以下格式：",
        "",
        "【灵感 X：四到八字主题名】",
        "商业级中文提示词：[写成一个完整、连贯、可直接用于生图的中文段落。先判断当前方案的可见范围，并列出画面内实际进入镜头的所有服装单品。重点产品负责主要描述，非重点产品只要有任何部分进入画面，也必须按图 2 写清可见部分的颜色、材质、纹理和结构；完全位于画面外的内容才不写。全身方案可依次写人物身份与表情、妆发、服装、完整动作、环境、光线与构图；上半身方案只写头部或肩颈至腰胯上方；下半身方案只写腰部上方少量区域至脚踝或鞋面；产品特写只写一个商品局部、必要手部、不可避免露出的准确服装边缘以及少量背景光影。不得描述裁切范围外的人物、服装、动作和环境，不得使用列表。]",
        "",
        "全身、动态、环境以及露脸的上半身方案必须明确写入：",
        "人物严格以图 1 为唯一身份参考；商品细节和非重点产品版型严格以图 2 为准；环境与光线严格以图 4 为准；重点产品为客户填写内容。",
        "",
        "不露脸的下半身方案不得描述图 1 的脸部、妆发和表情，只写\"人物身体比例与肤色保持图 1 的一致性\"；商品细节和非重点产品版型以图 2 为准；图 4 只提供当前局部可见的地面、墙面色块和光线，不扩展为环境全景。",
        "",
        "产品特写方案不得写人物身份、脸部、妆发、完整身材和完整姿势，只写\"重点产品细节严格以图 2 为准\"；图 4 只提供光线方向、色温、阴影和少量虚化背景色块，不描述完整场景。",
        "",
        "图 3 的写法必须根据内部判定二选一：",
        "如果图 3 是有效版型穿搭效果图，写明\"仅参考图 3 中客户点名的重点产品版型，其他单品不读取图 3\"。",
        "如果图 3 缺失、无效或与图 2 一样是白底商品图，写明\"忽略图 3，全部服装版型以图 2 为准\"。",
      ].join("\n");

      return [
        {
          type: "ai_image" as const,
          title: "人物形象（图1）",
          relativeX: 0,
          relativeY: 0,
          ...SQUARE,
          data: { content: "", size: "1:1", model: "gpt-image-2-official", imageUrl: mpPerson },
        },
        {
          type: "ai_image" as const,
          title: "白底穿搭/细节图（图2）",
          relativeX: 0,
          relativeY: INPUT_STEP,
          ...I_1080x1440,
          data: { content: "", size: "1:1", model: "gpt-image-2-official", imageUrl: mpGarment },
        },
        {
          type: "ai_image" as const,
          title: "人物版型参考（图3）",
          relativeX: 0,
          relativeY: INPUT_STEP * 2,
          ...I_1536x2752,
          data: { content: "", size: "1:1", model: "gpt-image-2-official", imageUrl: mpPose },
        },
        {
          type: "ai_image" as const,
          title: "场景参考（图4）",
          relativeX: 0,
          relativeY: INPUT_STEP * 3,
          ...I_1080x1440,
          data: { content: "", size: "1:1", model: "gpt-image-2-official", imageUrl: mpScene },
        },
        {
          type: "ai_chat" as const,
          title: "版型参考提示词",
          relativeX: CHAT_X,
          relativeY: 0,
          width: CHAT_W,
          height: CHAT_H,
          data: {
            model: "gpt-5.5-medium",
            content: patternPrompt,
            result: "",
          },
        },
        {
          type: "ai_image" as const,
          title: "灵感1",
          relativeX: RESULT_X,
          relativeY: 0,
          ...PORTRAIT,
          data: { content: "生成灵感1", size: "3:4", imageUrl: mpResult1 },
        },
        {
          type: "ai_image" as const,
          title: "灵感2",
          relativeX: RESULT_X + PORTRAIT.width + GAP,
          relativeY: 0,
          ...PORTRAIT,
          data: { content: "生成灵感2", size: "3:4", imageUrl: mpResult2 },
        },
        {
          type: "ai_image" as const,
          title: "灵感3",
          relativeX: RESULT_X + (PORTRAIT.width + GAP) * 2,
          relativeY: 0,
          ...PORTRAIT,
          data: { content: "生成灵感3。", size: "3:4", imageUrl: mpResult3 },
        },
        {
          type: "ai_image" as const,
          title: "灵感4",
          relativeX: RESULT_X + BTM_OFFSET,
          relativeY: RES_STEP,
          ...PORTRAIT,
          data: { content: "生成灵感4", size: "3:4", imageUrl: mpResult4 },
        },
        {
          type: "ai_image" as const,
          title: "灵感5",
          relativeX: RESULT_X + BTM_OFFSET + PORTRAIT.width + GAP,
          relativeY: RES_STEP,
          ...PORTRAIT,
          data: { content: "生成灵感5", size: "3:4", imageUrl: mpResult5 },
        },
      ];
    })(),
    connections: [
      { sourceIndex: 0, targetIndex: 4 },
      { sourceIndex: 1, targetIndex: 4 },
      { sourceIndex: 2, targetIndex: 4 },
      { sourceIndex: 3, targetIndex: 4 },
      { sourceIndex: 4, targetIndex: 5 },
      { sourceIndex: 0, targetIndex: 5 },
      { sourceIndex: 1, targetIndex: 5 },
      { sourceIndex: 2, targetIndex: 5 },
      { sourceIndex: 3, targetIndex: 5 },
      { sourceIndex: 4, targetIndex: 6 },
      { sourceIndex: 0, targetIndex: 6 },
      { sourceIndex: 1, targetIndex: 6 },
      { sourceIndex: 2, targetIndex: 6 },
      { sourceIndex: 3, targetIndex: 6 },
      { sourceIndex: 4, targetIndex: 7 },
      { sourceIndex: 0, targetIndex: 7 },
      { sourceIndex: 1, targetIndex: 7 },
      { sourceIndex: 2, targetIndex: 7 },
      { sourceIndex: 3, targetIndex: 7 },
      { sourceIndex: 4, targetIndex: 8 },
      { sourceIndex: 0, targetIndex: 8 },
      { sourceIndex: 1, targetIndex: 8 },
      { sourceIndex: 2, targetIndex: 8 },
      { sourceIndex: 3, targetIndex: 8 },
      { sourceIndex: 4, targetIndex: 9 },
      { sourceIndex: 0, targetIndex: 9 },
      { sourceIndex: 1, targetIndex: 9 },
      { sourceIndex: 2, targetIndex: 9 },
      { sourceIndex: 3, targetIndex: 9 },
    ],
  },
  {
    id: "wf-kids-clothing",
    name: "儿童服装5灵感方案",
    description:
      "上传儿童模特、服装、细节与场景图，AI 生成 5 组差异化儿童服装电商写真",
    icon: "Shirt",
    category: "composite",
    cards: (() => {
      const GAP = 60;
      const IMG_PERSON = SQUARE;
      const IMG_GARMENT = sz(163, 340);
      const IMG_DETAIL = sz(330, 340);
      const IMG_SCENE = sz(163, 340);
      const INPUT_COL_W = IMG_PERSON.width;
      const INPUT_STEP = IMG_PERSON.height + GAP;
      const TEXT_W = 430;
      const TEXT_H = 390;
      const CHAT_X = INPUT_COL_W + GAP;
      const CHAT_W = 650;
      const CHAT_H = 850;
      const RESULT_X = CHAT_X + CHAT_W + GAP;
      const RES_STEP = PORTRAIT.height + GAP;
      const TOP_ROW_W = PORTRAIT.width * 3 + GAP * 2;
      const BTM_ROW_W = PORTRAIT.width * 2 + GAP;
      const BTM_OFFSET = Math.round((TOP_ROW_W - BTM_ROW_W) / 2);

      const customerInput = [
        "【客户输入区】",
        "",
        "重点产品：",
        "可填：上衣 ",
        "示例：儿童背心",
        "",
        "重点产品必须看清的细节：",
        "示例：86.4%聚酯纤维，13.6%氨纶，轻盈透气，接触晾感，舒适透气",
        "",
        "画面比例：",
        "默认：3:4",
        "可填：1:1 / 3:4 / 4:5 / 9:16",
        "",
        "图片用途：",
        "默认：淘宝主图 + 店铺风格图",
        "可填：淘宝主图 / 店铺风格图 / 小红书种草图 / 抖音封面 / 详情页氛围图",
        "",
        "补充要求：",
        "示例：希望更像儿童户外功能服，浅灰白背景，人物自然笑，服装颜色明亮干净。",
        "",
        "不要出现：",
        "示例：成人化姿势、复杂背景、文字水印、衣服变形、手臂遮挡重点产品。",
      ].join("\n");

      const chatPrompt = [
        "你是一位儿童服装电商视觉导演，熟悉儿童模特拍摄、童装商品结构、服装面料表现和电商主图审美。请依据我上传的 4 张参考图和客户文字输入，先在内部完成识别，再输出 5 个差异明显、可直接用于生图的儿童服装灵感方案。不要展示分析过程。",
        "",
        "一、参考图职责",
        "",
        "图 1 = 儿童人物形象参考。",
        "【图 1 面部身份锁定规则｜最高优先级】",
        "图 1 是唯一的人物面部身份来源。所有 5 个方案只要出现儿童脸部，必须使用图 1 的同一个儿童身份，不得参考、吸收或混合图 2、图 3、图 4 中任何人物的长相。",
        "",
        "必须逐项保留图 1 的脸型、额头比例、下颌线、脸颊饱满度、五官间距、眼睛形状、眉眼距离、鼻梁和鼻头形态、嘴唇厚薄与嘴角走势、耳朵可见特征、肤色、面部小痣/雀斑/胎记、发际线、刘海方向、发色、发量、发尾长度、年龄感、体型比例和整体气质。",
        "",
        "允许产生儿童拍摄里的自然表情变化，例如闭唇微笑、轻微露齿笑、看向镜头、看向旁边、低头看衣服、回头笑。但这些变化只能改变表情瞬间，不能改变五官结构、脸型、发型、发色、年龄感和面部识别点。不要把儿童变成更成熟、更网红、更混血、更精致、更瘦脸、更大眼或更换发型的人。",
        "",
        "第一轮生成以稳定同脸为优先：方案 1、方案 2、方案 4、方案 5 如果露脸，尽量使用正脸或轻微 15 度内侧脸，眼睛、鼻子、嘴巴和发际线必须清楚；不要使用大侧脸、过度回头、低头遮脸、帽檐遮住眉眼、手或道具遮住脸。方案 3 为商品细节近景，不出现完整脸部；如出现儿童手部，只参考图 1 的年龄感和肤色，不生成新人物脸。",
        "",
        "所有输出到 inspirations 的 prompt，必须先判断该方案是否需要露脸；需要露脸才写人物面部严格复制图 1 的同一儿童身份，保持脸型、五官比例、眼睛形状、鼻子、嘴唇、发际线、刘海、发色、肤色、年龄感、面部小痣/雀斑和整体气质一致。服装以图 2 和图 3 为准，场景与光线以图 4 为准。",
        "",
        "所有 negative_prompt 必须按景别分别写：露脸方案才加入换脸、五官漂移、发型变化、年龄感变化等限制；不露脸方案不要写换脸和五官锁定，而是加入禁止完整脸部、头部、发型、眼睛、鼻子、嘴巴、表情、肖像照、半身照或全身照，禁止为了锁脸而生成脸。",
        "",
        "图 2 = 服装图。",
        "图 2 负责锁定商品是什么。必须严格读取服装的品类、颜色、版型、衣长、袖长、领口、帽子、拉链、门襟、腰头、裤型、裤长、裤脚、裙长、裙摆、面料、纹理、印花、拼接、口袋、纽扣、走线、鞋子和配饰。图 2 不负责人物长相、场景和光线。",
        "",
        "先判断图 2 的输入类型：",
        "",
        "类型 A：完整穿搭图。图 2 已经提供上衣、下装、外套、鞋子或其他明确搭配。此时 5 个方案中的整套搭配都严格以图 2 为准，不新增、删除、替换或重新设计任何服装。",
        "",
        "类型 B：单件商品图。图 2 只提供一个重点产品，没有提供完整穿搭。此时允许根据儿童服装风格补齐必要搭配，但补充单品必须简单、低存在感、没有明显图案，不遮挡重点产品，不改变重点产品轮廓和颜色。补充搭配一旦确定，5 个方案保持同一套，不得每个方案换款。",
        "",
        "图 3 = 服装细节图。",
        "图 3 只用于补充图 2 没看清的商品细节。优先读取客户填写的重点产品对应局部，例如上衣领口、肩线、袖口、拉链、下摆、面料纹理；裤子腰头、抽绳、口袋、侧缝、裤脚、面料垂感；裙装腰线、裙摆、褶皱、边缘工艺；外套门襟、帽子、拉链、袖口、防风结构；泳装领口、肩带、包边、弹力面料和图案。",
        "",
        "图 3 不负责人物、场景、整套搭配和光线。不得把图 3 中与商品无关的背景、手部、文字、水印、尺码牌带入最终画面。",
        "",
        "图 4 = 场景图。",
        "图 4 只用于参考场景类型、空间材质、背景物件、地面、墙面、植物、天空、室内陈列、光线方向、色温、曝光、阴影和整体画面气质。不得读取图 4 中其他人物、服装、品牌标识、文字和无关商品。",
        "",
        "如果图 4 是户外场景：画面可以选择草地、道路、浅色墙、天空、树影、运动场、公园、露营地、泳池边、海边或儿童活动空间，但背景不能复杂到抢走服装。",
        "",
        "如果图 4 是棚拍或白灰背景：画面要像干净儿童服装电商主图，浅灰白背景、柔和光线、人物自然、服装清楚，可以加入少量功能型道具，但不能做成海报版式。",
        "",
        "",
        "【先判断景别，再决定是否锁脸】",
        "锁脸不是所有节点都要写。只有画面实际出现儿童脸部时，才使用图 1 的面部身份锁定。商品细节近景、裤子下半身、只拍腰头/裤脚/面料/口袋的画面，不需要脸，也禁止生成脸、头发、表情和完整人物。",
        "",
        "每个方案先决定\"画面里应该出现什么\"，再写提示词：",
        "- 方案 1 全景主视觉：一般露脸，露脸时锁定图 1。",
        "- 方案 2 重点半身：上衣/外套/防晒衣/T 恤用上半身，可露脸，露脸时锁定图 1；裤子/短裤/速干裤/运动裤用下半身，不露脸，不写脸部词；裙装/套装按客户重点只选一个范围。",
        "- 方案 3 商品细节：不出现完整脸部，不生成人物肖像，只允许儿童手部辅助。",
        "- 方案 4 自然动作：一般露脸，露脸时锁定图 1。",
        "- 方案 5 同场景生活感笑容：延续前面灵感的同一套场景体系和光线，状态更生活化，笑容更有感染力；一般露脸或可识别人物，露脸时锁定图 1。",
        "",
        "二、重点产品展示",
        "",
        "客户填写的\"重点产品\"是 5 个方案的主要展示对象。每个方案都要根据当前景别判断画面实际可见范围，只写画面里看得到的服装，不写画面外内容。",
        "",
        "重点为上衣、防晒衣、T 恤、衬衫、外套：",
        "- 方案 1 和方案 4 至少看清完整上半身与整套比例。",
        "- 方案 2 必须使用上半身构图，画面范围为头部或肩颈到腰线/胯部上方。",
        "- 必须看清领口、肩线、袖长、衣长、下摆、面料和印花/拉链/纽扣等重点细节。",
        "- 半身方案不要描述完整裤长、裤脚、鞋子和脚部。",
        "",
        "重点为裤子、短裤、速干裤、运动裤：",
        "- 方案 1 和方案 4 至少看清整套比例、裤腰、裤型、裤长和鞋面关系。",
        "- 方案 2 必须使用下半身构图，画面范围为腰部上方少量区域到脚踝或鞋面。",
        "- 必须看清腰线、臀腿松量、裤型、裤长、裤脚、口袋和面料。",
        "- 下半身方案不得描述脸部、发型、表情、完整上衣和完整上半身；只允许写画面边缘可见的上衣下摆。",
        "",
        "重点为裙装、连衣裙、套装：",
        "- 方案 1 必须做人物全景，完整展示上下比例。",
        "- 方案 2 根据客户重点自动选择上半身或下半身，不要同时强行从头写到脚。",
        "- 必须看清腰线、裙长、裙摆体量、肩线、袖口或套装分界。",
        "",
        "重点为泳装：",
        "- 方案 1 使用全身或三分之二身，展示泳装版型、包边、肩带、腰部和腿部比例。",
        "- 方案 2 根据泳装重点选择上半身或腰胯到大腿构图。",
        "- 场景可选择泳池边、海边、浅色浴巾、干净白灰棚拍或儿童水上活动区。",
        "- 人物状态必须健康、自然、童真，不得成人化。",
        "",
        "三、儿童自然状态规则",
        "",
        "儿童人物状态必须真实、轻松、明亮。动作来自真实儿童拍摄现场，不要成人时装姿势。",
        "",
        "允许的自然动作：",
        "- 正面自然站立，身体略微转向一侧，脚尖轻微外开。",
        "- 轻轻扶帽檐、抬手遮阳、整理袖口、拉拉衣摆、扶拉链。",
        "- 小步往前走、轻轻转身、回头笑、看向旁边。",
        "- 手拿水壶、帽子、小背包、球、登山杖、泳镜等与场景相关的小道具。",
        "- 坐在台阶、草地、椅子或泳池边，身体自然放松。",
        "- 下半身方案可安排一脚向前、轻微屈膝、脚尖点地、裤脚自然垂落。",
        "",
        "禁止的动作：",
        "- 成人化叉腰、冷脸走秀、夸张扭腰、性感姿势、成熟表情。",
        "- 站军姿、双脚机械并拢、双手僵硬贴身、五指僵直。",
        "- 四肢同时大幅张开、跳跃过高、身体失去重心。",
        "- 手臂或道具长时间遮挡重点产品。",
        "",
        "四、5 个固定灵感方案",
        "",
        "方案 1：人物全景主视觉。",
        "必须生成儿童人物全景或三分之二身画面。平视机位，人物完整进入场景，能看清整套服装比例、上衣衣长、下装长度、鞋面关系和整体颜色。儿童自然微笑或安静看镜头，身体略微侧向，一只脚轻轻向前，手部根据服装自然扶帽檐、整理袖口、轻拉衣摆或拿小道具。画面适合作为店铺主图或首张风格图。",
        "",
        "方案 2：重点半身展示。",
        "根据重点产品自动选择半身范围。",
        "如果重点产品是上衣、防晒衣、T 恤、衬衫、外套：使用上半身构图，画面从头部或肩颈到腰线/胯部上方，重点展示领口、肩线、袖长、下摆、印花、拉链、面料和儿童自然表情。",
        "如果重点产品是裤子、短裤、速干裤、运动裤：使用下半身构图，画面从腰部上方少量区域到鞋面，重点展示腰头、裤型、裤长、裤脚、口袋、面料和腿部自然动作，不出现脸部和完整上半身。",
        "如果重点产品是裙装或套装：根据客户填写的重点细节选择上半身或下半身，只选一个范围，不要生成全身。",
        "",
        "方案 3：服装细节近景。",
        "只选择一个最重要的商品局部进行近距离拍摄，例如领口和拉链、袖口和走线、面料纹理、印花图案、裤子腰头、口袋、裤脚、裙摆、帽檐、泳装包边或肩带。可以出现一只儿童手轻轻触摸、整理或拉起细节。画面不出现完整人物，不出现完整脸部，不出现完整场景，只保留少量图 4 的光线和虚化色块。",
        "",
        "方案 4：自然动作展示。",
        "生成儿童在场景中轻微活动的画面，例如小步向前走、回头笑、抬手遮阳、扶帽檐、轻轻转身、拿水壶、背小包、站在草地或浅色墙前。动作要清楚服务服装展示：上衣不能被手臂遮住，裤型不能被大幅动作破坏，衣摆和裤脚只产生轻微自然摆动。画面可以是全身或三分之二身。",
        "",
        "方案 5：同场景生活感笑容展示。",
        "必须延续前面灵感使用的同一套场景体系、背景材质、光线方向、色温和整体画面气质，不要突然换成另一种地点或另一套拍摄风格。人物与图 4 场景发生自然关系，例如靠近同一面浅色墙、站在同一片草地或道路上、坐在同一组台阶、走在同一条公园小路、站在同一处泳池边、轻扶同一类栏杆或拿同一类小道具。儿童状态更生活化、更有感染力，可以是自然露齿笑、回头笑、边走边笑、看向旁边被逗笑，但笑容必须童真真实，不能成人化、网红式或过度夸张。商品仍然清楚，背景不能杂乱，不能让场景抢走服装.",
        "",
        "5 个方案必须固定覆盖：",
        "人物全景、重点半身、服装细节、自然动作、场景生活感。",
        "其中方案 2 必须根据重点产品自动判断：裤子用下半身，上衣用上半身。不得把 5 个方案都写成全身图，也不得只换表情和手势。",
        "",
        "五、画面风格要求",
        "",
        "儿童服装图片要真实、干净、明亮。可以选择两种主要风格：",
        "",
        "风格 A：儿童户外功能服电商主图。",
        "浅灰白或淡蓝灰棚拍背景，柔和均匀光线，儿童自然笑，服装颜色明亮，适合防晒衣、速干裤、冲锋衣、外套、T 恤、户外套装。可以有水壶、帽子、小背包、球、登山杖等轻户外道具。画面重点是商品清楚、面料干净、儿童状态阳光。",
        "",
        "风格 B：儿童生活场景图。",
        "参考图 4 的真实场景，画面有草地、浅色墙、门口、泳池边、海边、公园路面、室内窗边或儿童活动空间。光线自然，人物像在玩耍或准备出门，服装在真实状态中被看清。",
        "",
        "如果客户没有指定风格，默认采用：干净儿童电商图 + 轻户外自然状态。不要生成复杂海报，不要生成拼图，不要生成带文字的详情页。",
        "",
        "六、最终输出格式",
        "",
        "只输出 5 个灵感方案，不输出分析过程。",
        "",
        "每个方案严格使用以下格式：",
        "",
        "【灵感 1：全景主视觉】",
        "生成提示词：[写成一段完整中文，可直接用于生图。必须说明人物以图 1 为准，服装以图 2 和图 3 为准，场景与光线以图 4 为准。描述儿童人物状态、景别、服装可见范围、动作、场景、光线和画面用途。]",
        "反向限制词：[写该方案专用限制，避免人物变脸、服装变款、成人化姿势、错误景别、遮挡重点产品、文字水印、拼图海报。]",
        "",
        "【灵感 2：重点半身】",
        "生成提示词：[根据重点产品自动写上半身或下半身。上衣/外套写上半身，裤子/短裤写下半身。只写当前画面实际可见内容。]",
        "反向限制词：[上半身方案禁止写腿部、裤脚、鞋子和全身；下半身方案禁止写脸部、发型、表情、完整上半身和全身。]",
        "",
        "【灵感 3：商品细节】",
        "生成提示词：[只写一个商品局部，细节严格以图 2 和图 3 为准，可以有一只儿童手轻触或整理，不出现完整人物。]",
        "反向限制词：[禁止完整人物、完整脸部、全身、半身、远景、文字、水印、详情页版式和错误商品细节。]",
        "",
        "【灵感 4：自然动作】",
        "生成提示词：[写儿童轻微活动状态，动作要自然，服装重点清楚，不遮挡商品。]",
        "反向限制词：[禁止成人化动作、走秀感、夸张跳跃、动作失衡、服装变形、手臂遮挡商品。]",
        "",
        "【灵感 5：场景生活感】",
        "生成提示词：[写儿童和图 4 场景的自然关系，让服装进入真实生活状态，背景干净。]",
        "反向限制词：[禁止背景杂乱、场景抢主体、错误光线、人物过小、服装看不清。]",
        "",
        "请严格输出一个 JSON 对象，不要输出 Markdown，不要输出代码块，不要解释。",
        "JSON 结构必须为：",
        "{",
        '  "inspirations": [',
        '    {"title":"全景主视觉", "prompt":"可直接用于生图的完整中文正向提示词", "negative_prompt":"该方案反向限制词"},',
        '    {"title":"重点半身", "prompt":"可直接用于生图的完整中文正向提示词", "negative_prompt":"该方案反向限制词"},',
        '    {"title":"商品细节", "prompt":"可直接用于生图的完整中文正向提示词", "negative_prompt":"该方案反向限制词"},',
        '    {"title":"自然动作", "prompt":"可直接用于生图的完整中文正向提示词", "negative_prompt":"该方案反向限制词"},',
        '    {"title":"场景生活感", "prompt":"可直接用于生图的完整中文正向提示词", "negative_prompt":"该方案反向限制词"}',
        "  ]",
        "}",
        "",
        "硬性要求：",
        "1. inspirations 必须正好 5 条，顺序固定。",
        "2. 每条 prompt 必须先判断该方案是否露脸：露脸方案写人物面部以图 1 为准；不露脸方案明确不出现完整脸部、头部和肖像。所有方案都必须写服装以图 2 和图 3 为准，场景与光线以图 4 为准。",
        "3. 灵感 2 必须根据客户填写的重点产品自动判断：上衣/外套/防晒衣/T 恤输出上半身；裤子/短裤/速干裤输出下半身；裙装/套装只选择一个范围。",
        "4. 不要把 5 个方案写成拼图、海报、详情页版式或同一张图里的多个画面。",
        "5. 输出中不要包含\"分析过程\"\"识别过程\"\"根据图片来看\"等说明。",
      ].join("\n");

      const inspiration1Content = [
        "【本节点画面决策】",
        "本节点是人物全景或三分之二身，通常需要露脸。只有在画面中出现脸部时，才执行图 1 面部身份锁定：同一个儿童、同一脸型、五官比例、眼睛、鼻子、嘴唇、发际线、刘海、发色、肤色、年龄感、面部小痣/雀斑和整体气质。不要混合其他参考图人物长相。",
        "",
        "灵感1｜全景主视觉 正向：{{inspirations[0].prompt}}",
        "灵感1｜全景主视觉 负向：{{inspirations[0].negative_prompt}}",
        "真实儿童服装电商摄影，服装结构清楚，严格按照本节点景别生成。",
        "",
        "本节点反向限制：禁止换脸、不同儿童、混合其他参考图人脸、改变脸型五官、成人化表情、遮脸；禁止服装变款、颜色变色、结构错误、文字、水印、拼图、海报版式。",
      ].join("\n");

      const inspiration2Content = [
        "【本节点画面决策】",
        "本节点必须先看 inspirations[1].prompt 的景别。若重点产品是上衣/外套/防晒衣/T 恤/衬衫，按上半身或头肩到腰线画面执行，允许露脸，露脸时才锁定图 1 同一个儿童面部身份。若重点产品是裤子/短裤/速干裤/运动裤，必须按腰部上方少量区域到鞋面的下半身画面执行，不生成脸部、头发、表情、完整上半身，也不写任何面部锁定词。若重点是裙装/套装，按 inspirations[1].prompt 选择的单一范围执行，不扩成全身。",
        "",
        "灵感2｜重点半身 正向：{{inspirations[1].prompt}}",
        "灵感2｜重点半身 负向：{{inspirations[1].negative_prompt}}",
        "真实儿童服装电商摄影，服装结构清楚，严格按照本节点景别生成。",
        "",
        "本节点反向限制：上半身方案禁止写腿部、裤脚、鞋子和全身；下半身方案禁止脸部、头发、表情、完整上半身、全身照、肖像照、人物正脸；禁止服装变款、颜色变色、结构错误、文字、水印、拼图、海报版式。",
      ].join("\n");

      const inspiration3Content = [
        "【本节点画面决策】",
        "本节点只生成商品局部近景，不执行人脸生成，也不执行面部锁定。画面可以出现一只儿童手轻触或整理商品细节；手部只参考图 1 的儿童年龄感和肤色。不要出现完整人物、完整脸部、半身或全身。",
        "",
        "灵感3｜商品细节 正向：{{inspirations[2].prompt}}",
        "灵感3｜商品细节 负向：{{inspirations[2].negative_prompt}}",
        "真实儿童服装电商摄影，服装结构清楚，严格按照本节点景别生成。",
        "",
        "本节点反向限制：禁止完整脸部、人物肖像、头发、眼睛、鼻子、嘴巴、半身、全身、远景、多人、文字、水印、详情页版式、错误商品细节、服装变款。",
      ].join("\n");

      const inspiration4Content = [
        "【本节点画面决策】",
        "本节点是儿童自然轻动作展示，通常需要露脸或至少能识别同一个儿童。只有在画面中出现脸部时，才执行图 1 面部身份锁定：同一个儿童、同一脸型、五官比例、眼睛、鼻子、嘴唇、发际线、刘海、发色、肤色、年龄感、面部小痣/雀斑和整体气质。动作优先服务服装展示，不用手臂或道具挡住重点产品。",
        "",
        "灵感4｜自然动作 正向：{{inspirations[3].prompt}}",
        "灵感4｜自然动作 负向：{{inspirations[3].negative_prompt}}",
        "真实儿童服装电商摄影，服装结构清楚，严格按照本节点景别生成。",
        "",
        "本节点反向限制：禁止换脸、不同儿童、混合其他参考图人脸、成人化动作、走秀感、夸张跳跃、动作失衡、遮脸、手臂遮挡商品、服装变形、服装变款、文字、水印、拼图、海报版式。",
      ].join("\n");

      const inspiration5Content = [
        "【本节点画面决策】",
        "本节点是同场景生活感笑容展示。必须延续前面灵感使用的同一套场景体系、背景材质、光线方向、色温和整体画面气质，不要突然换成另一种地点或另一套拍摄风格。儿童状态更生活化、更有感染力，可以是自然露齿笑、回头笑、边走边笑、看向旁边被逗笑；笑容必须童真真实，不能成人化、网红式或过度夸张。只有在画面中出现脸部时，才执行图 1 面部身份锁定：同一个儿童、同一脸型、五官比例、眼睛、鼻子、嘴唇、发际线、刘海、发色、肤色、年龄感、面部小痣/雀斑和整体气质。背景服务商品，不抢主体。",
        "",
        "灵感5｜场景生活感 正向：{{inspirations[4].prompt}}",
        "灵感5｜场景生活感 负向：{{inspirations[4].negative_prompt}}",
        "真实儿童服装电商摄影，服装结构清楚，严格按照本节点景别生成。",
        "",
        "本节点反向限制：禁止突然换场景，禁止与前面灵感不是同一套场景体系，禁止换脸、不同儿童、混合其他参考图人脸、背景杂乱、场景抢主体、错误光线、人物过小、服装看不清、遮脸、成人化笑容、网红式表情、过度夸张大笑、服装变款、文字、水印、拼图、海报版式。",
      ].join("\n");

      return [
        {
          type: "ai_image" as const,
          title: "输入图1｜儿童人物形象",
          relativeX: 0,
          relativeY: 0,
          ...IMG_PERSON,
          data: { content: "", size: "4:5", imageUrl: kcPerson },
        },
        {
          type: "ai_image" as const,
          title: "输入图2｜服装图",
          relativeX: 0,
          relativeY: INPUT_STEP,
          ...IMG_GARMENT,
          data: { content: "", size: "4:5", imageUrl: kcGarment },
        },
        {
          type: "ai_image" as const,
          title: "输入图3｜服装细节图",
          relativeX: 0,
          relativeY: INPUT_STEP * 2,
          ...IMG_DETAIL,
          data: { content: "", size: "4:5", imageUrl: kcDetail },
        },
        {
          type: "ai_image" as const,
          title: "输入图4｜场景图",
          relativeX: 0,
          relativeY: INPUT_STEP * 3,
          ...IMG_SCENE,
          data: { content: "", size: "4:5", imageUrl: kcScene },
        },
        {
          type: "text" as const,
          title: "客户输入区",
          relativeX: 0,
          relativeY: INPUT_STEP * 4,
          width: TEXT_W,
          height: TEXT_H,
          data: { content: customerInput },
        },
        {
          type: "ai_chat" as const,
          title: "儿童服装5灵感方案生成节点",
          relativeX: CHAT_X,
          relativeY: Math.round((INPUT_STEP * 4 + TEXT_H - CHAT_H) / 2),
          width: CHAT_W,
          height: CHAT_H,
          data: {
            model: "gemini-3.5-flash",
            content: chatPrompt,
            result: "",
          },
        },
        {
          type: "ai_image" as const,
          title: "灵感1｜全景主视觉",
          relativeX: RESULT_X,
          relativeY: 0,
          ...PORTRAIT,
          data: { content: inspiration1Content, size: "3:4", imageUrl: kcResult1 },
        },
        {
          type: "ai_image" as const,
          title: "灵感2｜重点半身",
          relativeX: RESULT_X + PORTRAIT.width + GAP,
          relativeY: 0,
          ...PORTRAIT,
          data: { content: inspiration2Content, size: "3:4", imageUrl: kcResult2 },
        },
        {
          type: "ai_image" as const,
          title: "灵感3｜商品细节",
          relativeX: RESULT_X + (PORTRAIT.width + GAP) * 2,
          relativeY: 0,
          ...PORTRAIT,
          data: { content: inspiration3Content, size: "3:4", imageUrl: kcResult3 },
        },
        {
          type: "ai_image" as const,
          title: "灵感4｜自然动作",
          relativeX: RESULT_X + BTM_OFFSET,
          relativeY: RES_STEP,
          ...PORTRAIT,
          data: { content: inspiration4Content, size: "3:4", imageUrl: kcResult4 },
        },
        {
          type: "ai_image" as const,
          title: "灵感5｜场景生活感",
          relativeX: RESULT_X + BTM_OFFSET + PORTRAIT.width + GAP,
          relativeY: RES_STEP,
          ...PORTRAIT,
          data: { content: inspiration5Content, size: "3:4", imageUrl: kcResult5 },
        },
      ];
    })(),
    connections: [
      { sourceIndex: 0, targetIndex: 5 },
      { sourceIndex: 1, targetIndex: 5 },
      { sourceIndex: 2, targetIndex: 5 },
      { sourceIndex: 3, targetIndex: 5 },
      { sourceIndex: 4, targetIndex: 5 },
      { sourceIndex: 5, targetIndex: 6 },
      { sourceIndex: 0, targetIndex: 6 },
      { sourceIndex: 1, targetIndex: 6 },
      { sourceIndex: 2, targetIndex: 6 },
      { sourceIndex: 3, targetIndex: 6 },
      { sourceIndex: 5, targetIndex: 7 },
      { sourceIndex: 0, targetIndex: 7 },
      { sourceIndex: 1, targetIndex: 7 },
      { sourceIndex: 2, targetIndex: 7 },
      { sourceIndex: 3, targetIndex: 7 },
      { sourceIndex: 5, targetIndex: 8 },
      { sourceIndex: 0, targetIndex: 8 },
      { sourceIndex: 2, targetIndex: 8 },
      { sourceIndex: 3, targetIndex: 8 },
      { sourceIndex: 5, targetIndex: 9 },
      { sourceIndex: 0, targetIndex: 9 },
      { sourceIndex: 1, targetIndex: 9 },
      { sourceIndex: 2, targetIndex: 9 },
      { sourceIndex: 3, targetIndex: 9 },
      { sourceIndex: 5, targetIndex: 10 },
      { sourceIndex: 0, targetIndex: 10 },
      { sourceIndex: 1, targetIndex: 10 },
      { sourceIndex: 2, targetIndex: 10 },
      { sourceIndex: 3, targetIndex: 10 },
    ],
  },
];
