import type { WorkflowTemplate } from "@/types";
import { CARD_DEFAULTS, sizeFromRatio } from "@/shared/constants";

import whiteBgSource from "@/assets/templates/white-bg/source-photo.jpg";
import whiteBgRefined from "@/assets/templates/white-bg/refined-3d.jpg";
import whiteBgMultiAngle from "@/assets/templates/white-bg/multi-angle.jpg";
import tryonModel from "@/assets/templates/tryon/model.jpg";
import tryonGarment from "@/assets/templates/tryon/garment.png";
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
import lookFissionResult from "@/assets/templates/look-fission/result.jpg";
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
import studioLookPerson from "@/assets/templates/studio-look/person.jpg";
import studioLookGarment from "@/assets/templates/studio-look/garment.png";
import studioLookScene from "@/assets/templates/studio-look/scene.jpg";
import studioLookResult from "@/assets/templates/studio-look/result.jpg";
import mirrorSelfiePerson from "@/assets/templates/mirror-selfie/person.jpg";
import mirrorSelfieGarment from "@/assets/templates/mirror-selfie/garment-cut.png";
import mirrorSelfieScene from "@/assets/templates/mirror-selfie/scene.jpg";
import mirrorSelfieResult1 from "@/assets/templates/mirror-selfie/result-1.jpg";
import mirrorSelfieResult2 from "@/assets/templates/mirror-selfie/result-2.jpg";
import mirrorSelfieResult3 from "@/assets/templates/mirror-selfie/result-3.jpg";

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
// @ts-expect-error reserved for future use
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
    cards: [
      {
        type: "ai_image",
        title: "人物图",
        relativeX: 0,
        relativeY: (CARD_DEFAULTS.ai_chat.height - I_1970x2626.height) / 2,
        ...I_1970x2626,
        data: { content: "", size: "3:4", imageUrl: lookFissionPerson },
      },
      {
        type: "ai_chat",
        title: "全身裂变提示词",
        relativeX: I_1970x2626.width + 80,
        relativeY: 0,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: [
            "【任务目标】",
            "基于我上传的模特图像，在【不改变机位、不改变构图、不改变比例、不扩图】的前提下，",
            "仅对模特姿势进行【小幅度、合理、真实】的动作变化，",
            "生成5张看起来像\"同一场景下，模特动了一下\"的真实照片。",
            "【最高优先级 · 强制锁定规则】",
            "1. 机位必须完全锁定：",
            "- 拍摄角度不变",
            "- 镜头视角不变",
            "- 相机高度不变",
            "2. 构图必须完全一致：",
            "- 模特在画面中的位置不变",
            "- 人物大小比例不变",
            "- 头身比例、腿长比例完全一致",
            "3. 严禁扩图：",
            "- 画布尺寸不变",
            "- 不新增画面内容",
            "- 不补边、不拉伸、不裁切",
            "4. 模特身份必须一致：",
            "- 面部、发型、体型、气质保持完全一致",
            "- 服装保持 100% 一致（颜色、版型、材质、褶皱逻辑）",
            "【唯一允许变化的内容：动作（小幅度）】",
            "- 角色姿态：请随机设计全新的、符合商业摄影美感的人体姿势",
            "【真实感要求】",
            "- 动作变化必须符合真实人体力学",
            "【整体风格】",
            "真实商业摄影 / 电商模特 / Lookbook 风格",
            "自然、克制、专业",
            "最终只生成适合banana出图的中文提示词，按灵感1、灵感2、灵感3的格式输出，不解释",
          ].join("\n"),
          result: "",
        },
      },
      {
        type: "ai_image",
        title: "全身裂变",
        relativeX: I_1970x2626.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: (CARD_DEFAULTS.ai_chat.height - I_1536x2752.height) / 2,
        ...I_1536x2752,
        data: {
          imageUrl: lookFissionResult,
          content: "",
          size: "9:16",
        },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 1 },
      { sourceIndex: 0, targetIndex: 2 },
      { sourceIndex: 1, targetIndex: 2 },
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
          data: { content: "", size: "3:4", imageUrl: mf6Result1 },
        },
        {
          type: "ai_image" as const,
          title: "效果图2",
          relativeX: RESULT_X + ROW_STEP,
          relativeY: 0,
          ...IMG_RES,
          data: { content: "", size: "3:4", imageUrl: mf6Result2 },
        },
        {
          type: "ai_image" as const,
          title: "效果图3",
          relativeX: RESULT_X + ROW_STEP * 2,
          relativeY: 0,
          ...IMG_RES,
          data: { content: "", size: "3:4", imageUrl: mf6Result3 },
        },
        {
          type: "ai_image" as const,
          title: "效果图4",
          relativeX: RESULT_X + BTM_OFFSET,
          relativeY: IMG_RES.height + GAP,
          ...IMG_RES,
          data: { content: "", size: "3:4", imageUrl: mf6Result4 },
        },
        {
          type: "ai_image" as const,
          title: "效果图5",
          relativeX: RESULT_X + BTM_OFFSET + ROW_STEP,
          relativeY: IMG_RES.height + GAP,
          ...IMG_RES,
          data: { content: "", size: "3:4", imageUrl: mf6Result5 },
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
      const IMG_PERSON = I_1792x2400;
      const IMG_GARMENT = I_624x1690;
      const IMG_SCENE = I_736x1308;
      const IMG_RESULT = I_1792x2400;
      const COL_W = Math.max(IMG_PERSON.width, IMG_GARMENT.width, IMG_SCENE.width);
      const COL_H = IMG_PERSON.height + GAP + IMG_GARMENT.height + GAP + IMG_SCENE.height;
      const CHAT_W = CARD_DEFAULTS.ai_chat.width;
      const CHAT_H = CARD_DEFAULTS.ai_chat.height;
      const CHAT_X = COL_W + GAP + 20;
      const RESULT_X = CHAT_X + CHAT_W + GAP + 20;

      const lookbookPrompt = [
        "生成 4 个专业时装 lookbook 摄影的提示词方案",
        "",
        "要求：专业时装 lookbook 摄影，一位[模特描述：分析图1]穿着[服装描述：分析图2]。",
        "服装要清晰展示，面料纹理真实，褶皱自然，版型准确，上身效果真实，不夸张变形。",
        "模特自然淡妆，表情冷静，姿态松弛高级，符合品牌服装大片气质。",
        "拍摄场景为[场景描述：分析图3]，背景干净高级，和服装风格统一。",
        "柔和自然光，细腻阴影，低饱和色调，高端杂志编辑片风格，真实皮肤质感，85mm 人像镜头，浅景深。",
        "包含全身站姿、半身图、坐姿图、服装细节图，超写实，高细节，lookbook 质感。",
      ].join("\n");

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
        {
          type: "ai_image" as const,
          title: "棚拍 Look 图",
          relativeX: RESULT_X,
          relativeY: (COL_H - IMG_RESULT.height) / 2,
          ...IMG_RESULT,
          data: {
            content:
              "生成方案1-4在2×2的宫格里全部展示。要求人物跟图1 100%一致，服装跟图2 100%一致。",
            size: "3:4",
            imageUrl: studioLookResult,
          },
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
];
