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
import lookFissionResult from "@/assets/templates/look-fission/result.jpg";
import multimodalFusionPerson from "@/assets/templates/multimodal-fusion/person.jpg";
import multimodalFusionGarment from "@/assets/templates/multimodal-fusion/garment.jpg";
import multimodalFusionScene from "@/assets/templates/multimodal-fusion/scene.jpg";
import multimodalFusionPose from "@/assets/templates/multimodal-fusion/pose.jpg";
import multimodalFusionResult from "@/assets/templates/multimodal-fusion/result.jpg";

const SQUARE = sizeFromRatio(1);
const PORTRAIT = sizeFromRatio(3 / 4);
const LANDSCAPE = sizeFromRatio(16 / 9);

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
    cards: [
      {
        type: "ai_image",
        title: "商品原图",
        relativeX: 0,
        relativeY: 0,
        ...SQUARE,
        data: { content: "", size: "1:1", imageUrl: whiteBgSource },
      },
      {
        type: "ai_chat",
        title: "白底精修提示词",
        relativeX: SQUARE.width + 80,
        relativeY: SQUARE.height / 2 - CARD_DEFAULTS.ai_chat.height - 40,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: "",
          result: [
            "产品精修，将图片中的[颜色][服装品类]完整提取并转换成3D立体形状，置于纯净的纯白背景上。正面视图，背面视图，两个平视角，精准还原[服装品类]的颜色、[关键特征1]、[关键特征2]与[面料纹理质感]，去除多余褶皱，使衣身轮廓平整顺滑，边缘干净无杂色。清除灰尘、瑕疵，让[服装品类]看起来挺括、崭新、洁净，光线均匀无杂乱阴影，符合电商主图标准，主体突出。",
            "",
            "示例（浅蓝色破洞牛仔外套）：",
            "产品精修，将图片中的浅蓝色破洞牛仔外套完整提取并转换成3D立体形状，置于纯净的纯白背景上。正面视图，背面视图，两个平视角，精准还原牛仔外套的颜色、水洗做旧效果、破洞细节与牛仔布料纹理质感，去除多余褶皱，使衣身轮廓平整顺滑，边缘干净无杂色。清除灰尘、瑕疵，让外套看起来挺括、崭新、洁净，光线均匀无杂乱阴影，符合电商主图标准，主体突出。",
          ].join("\n"),
        },
      },
      {
        type: "ai_image",
        title: "白底精修图",
        relativeX: SQUARE.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: 0,
        ...SQUARE,
        data: { content: "", size: "1:1", imageUrl: whiteBgRefined },
      },
      {
        type: "ai_chat",
        title: "多角度提示词",
        relativeX: SQUARE.width + 80 + CARD_DEFAULTS.ai_chat.width + 80 + SQUARE.width + 80,
        relativeY: SQUARE.height / 2 - CARD_DEFAULTS.ai_chat.height - 40,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: "",
          result: [
            "基于我提供的这件[颜色][服装品类]原图，生成一组8张产品细节特征展示图，在2×4的网格里，采用16:9的比例展示不同的角度，不要有重复的角度呈现。要求保持[服装品类]的款式、[颜色]、[关键纹理/设计]、[版型/细节]等所有细节完全不变，仅从不同角度（正面、侧面、背面、45度角、[关键部位特写1]、[关键部位特写2]、[细节特写1]、[细节特写2]等）进行拍摄式呈现，整体风格为简洁的白底商业产品图，光线均匀柔和，清晰展现[面料质感]与版型细节。",
            "",
            "示例（米白色带刺绣翻领衬衫）：",
            "基于我提供的这件米白色带刺绣翻领衬衫原图，生成一组8张产品细节特征展示图，在2×4的网格里，采用16:9的比例展示不同的角度，不要有重复的角度呈现。要求保持衬衫的款式、米白色、刺绣图案、翻领设计、纽扣细节等所有细节完全不变，仅从不同角度（正面、背面、45度角、领口特写、刺绣特写、袖口特写等）进行拍摄式呈现，整体风格为简洁的白底商业产品图，光线均匀柔和，清晰展现棉感面料质感与版型细节。",
          ].join("\n"),
        },
      },
      {
        type: "ai_image",
        title: "多角度展示图",
        relativeX: SQUARE.width + 80 + CARD_DEFAULTS.ai_chat.width + 80 + SQUARE.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: (SQUARE.height - LANDSCAPE.height) / 2,
        ...LANDSCAPE,
        data: { content: "", size: "16:9", imageUrl: whiteBgMultiAngle },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 2 },
      { sourceIndex: 1, targetIndex: 2 },
      { sourceIndex: 2, targetIndex: 4 },
      { sourceIndex: 3, targetIndex: 4 },
    ],
  },
  {
    id: "wf-tryon",
    name: "模特换装",
    description: "上传模特图与服装图，配合预填换装提示词，AI 自动将服装穿在模特身上",
    icon: "Shirt",
    category: "composite",
    cards: [
      {
        type: "ai_image",
        title: "模特图",
        relativeX: 0,
        relativeY: 0,
        ...SQUARE,
        data: { content: "", size: "1:1", imageUrl: tryonModel },
      },
      {
        type: "ai_image",
        title: "服装图",
        relativeX: 0,
        relativeY: SQUARE.height + 60,
        ...SQUARE,
        data: { content: "", size: "1:1", imageUrl: tryonGarment },
      },
      {
        type: "ai_chat",
        title: "换装提示词",
        relativeX: SQUARE.width + 80,
        relativeY: (SQUARE.height * 2 + 60 - CARD_DEFAULTS.ai_chat.height) / 2,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: "",
          result: [
            "请将第一张参考图（模特图）中的人物穿上第二张参考图（服装图）展示的服装。",
            "",
            "严格保持人物的姿态、面部特征、肤色、发型与原始背景完全不变；",
            "仅替换身上的服装，确保新服装的款式、颜色、图案、纹理细节与版型与服装图完全一致；",
            "服装的穿着效果要符合人体结构与透视，光影自然过渡，整体真实协调。",
          ].join("\n"),
        },
      },
      {
        type: "ai_image",
        title: "模特换装",
        relativeX: SQUARE.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: (SQUARE.height * 2 + 60 - PORTRAIT.height) / 2,
        ...PORTRAIT,
        data: {
          content: "",
          size: "3:4",
          imageUrl: tryonResult,
        },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 3 },
      { sourceIndex: 1, targetIndex: 3 },
      { sourceIndex: 2, targetIndex: 3 },
    ],
  },
  {
    id: "wf-scene-replace",
    name: "场景替换",
    description: "上传人物图与场景图，配合预填融合提示词，AI 将人物完美融入新场景",
    icon: "Mountain",
    category: "composite",
    cards: [
      {
        type: "ai_image",
        title: "人物图",
        relativeX: 0,
        relativeY: 0,
        ...SQUARE,
        data: { content: "", size: "1:1", imageUrl: sceneReplacePerson },
      },
      {
        type: "ai_image",
        title: "场景图",
        relativeX: 0,
        relativeY: SQUARE.height + 60,
        ...SQUARE,
        data: { content: "", size: "1:1", imageUrl: sceneReplaceScene },
      },
      {
        type: "ai_chat",
        title: "场景融合提示词",
        relativeX: SQUARE.width + 80,
        relativeY: (SQUARE.height * 2 + 60 - CARD_DEFAULTS.ai_chat.height) / 2,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: "",
          result: [
            "这是一张极度写实的商业摄影大片。请以参考图1（人物图）中的人物形象和全套服装为核心主体，将其完美平移并融入到参考图2（场景图）的环境。",
            "",
            "1. 场景继承：人物所处的环境完全继承自图2，必须精准保留 [描述图2背景的具体元素]。",
            "2. 人物与动作继承：替换后的人物必须精准继承图1中的 [描述图1的服装及面部特征]。人物的姿态必须完美复刻图2原人物的 [描述图2的动作状态]。",
            "3. 物理光影融合（核心）：人物的全身光影必须受到图2环境的 [描述图2的光影特征，如：暖色调侧逆光/散射日光] 物理约束。皮肤纹理、布料反光和阴影边缘必须与图2的光源方向及色温完全匹配，消除一切抠图感。",
            "4. 场景稳定性：严禁改变图2背景中的任何细节，包括 [描述图2特有背景元素，如：面包店招牌、地板纹理]。保持与图2一致的浅景深和镜头焦段。",
            "",
            "画质要求：8K超清，电影级胶片质感，商业后期质感，极致细节。",
          ].join("\n"),
        },
      },
      {
        type: "ai_image",
        title: "场景替换",
        relativeX: SQUARE.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: (SQUARE.height * 2 + 60 - PORTRAIT.height) / 2,
        ...PORTRAIT,
        data: { content: "", size: "3:4", imageUrl: sceneReplaceResult },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 3 },
      { sourceIndex: 1, targetIndex: 3 },
      { sourceIndex: 2, targetIndex: 3 },
    ],
  },
  {
    id: "wf-pose-fission",
    name: "模特姿态裂变",
    description: "上传模特图，配合预填裂变提示词，生成多种姿态变体（面部与服装保持不变）",
    icon: "PersonStanding",
    category: "composite",
    cards: [
      {
        type: "ai_image",
        title: "人物图",
        relativeX: 0,
        relativeY: (CARD_DEFAULTS.ai_chat.height - PORTRAIT.height) / 2,
        ...PORTRAIT,
        data: { content: "", size: "3:4", imageUrl: poseFissionPerson },
      },
      {
        type: "ai_chat",
        title: "姿态裂变提示词",
        relativeX: PORTRAIT.width + 80,
        relativeY: 0,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: "",
          result: [
            "保持参考图中人物面部和服装不变，环境不变。",
            "",
            "生成 4 张不同的人物姿态图：",
            "- 第一张：全身站立",
            "- 第二张：半身特写",
            "- 第三张：坐在路边长椅",
            "- 第四张：服装特写",
            "",
            "保持服装细节，超写实，高细节，lookbook 质感，不要出现人物黑边。",
          ].join("\n"),
        },
      },
      {
        type: "ai_image",
        title: "姿态裂变",
        relativeX: PORTRAIT.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: (CARD_DEFAULTS.ai_chat.height - LANDSCAPE.height) / 2,
        ...LANDSCAPE,
        data: {
          imageUrl: poseFissionResult,
          content: "",
          size: "16:9",
        },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 2 },
      { sourceIndex: 1, targetIndex: 2 },
    ],
  },
  {
    id: "wf-face-merge",
    name: "人脸合成",
    description: "上传两张人物照片，AI 融合面部特征生成全新写实人像",
    icon: "ScanFace",
    category: "composite",
    cards: [
      {
        type: "ai_image",
        title: "人物1",
        relativeX: 0,
        relativeY: 0,
        ...SQUARE,
        data: { content: "", size: "1:1", imageUrl: faceMergePerson1 },
      },
      {
        type: "ai_image",
        title: "人物2",
        relativeX: 0,
        relativeY: SQUARE.height + 60,
        ...SQUARE,
        data: { content: "", size: "1:1", imageUrl: faceMergePerson2 },
      },
      {
        type: "ai_chat",
        title: "人脸合成提示词",
        relativeX: SQUARE.width + 80,
        relativeY: (SQUARE.height * 2 + 60 - CARD_DEFAULTS.ai_chat.height) / 2,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: "",
          result: [
            "A photorealistic portrait of a distinct individual who looks like the biological offspring of the people in the provided reference photos.",
            "The face should be a natural, organic blend of the input features, creating a unique new identity that bears a strong family resemblance to both inputs without being a direct copy of either.",
            "Capture the subtle genetic traits from the references.",
            "",
            "Character Description:",
            "Subject: An Asian female model with flawless, pore-level skin texture.",
            "Expression: Neutral and candid, with a high-quality photo realism aesthetic — soft, cinematic lighting that highlights facial contours.",
            "Vibe: High-fashion, sophisticated, and authentic.",
            "Setting: white background, eye-level front face.",
            "",
            "Technical Constraints:",
            "Maintain consistent lighting across the blended features.",
            "Output in 4k resolution, raw photography style.",
          ].join("\n"),
        },
      },
      {
        type: "ai_image",
        title: "人脸合成",
        relativeX: SQUARE.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: (SQUARE.height * 2 + 60 - SQUARE.height) / 2,
        ...SQUARE,
        data: {
          content: "",
          size: "1:1",
          imageUrl: faceMergeResult,
        },
      },
    ],
    connections: [
      { sourceIndex: 0, targetIndex: 3 },
      { sourceIndex: 1, targetIndex: 3 },
      { sourceIndex: 2, targetIndex: 3 },
    ],
  },
  {
    id: "wf-look-fission",
    name: "Look 全身裂变",
    description: "上传模特图，配合预填锁定机位提示词，生成多组 Lookbook 风格姿态变体",
    icon: "PersonStanding",
    category: "composite",
    cards: [
      {
        type: "ai_image",
        title: "人物图",
        relativeX: 0,
        relativeY: (CARD_DEFAULTS.ai_chat.height - PORTRAIT.height) / 2,
        ...PORTRAIT,
        data: { content: "", size: "3:4", imageUrl: lookFissionPerson },
      },
      {
        type: "ai_chat",
        title: "全身裂变提示词",
        relativeX: PORTRAIT.width + 80,
        relativeY: 0,
        width: CARD_DEFAULTS.ai_chat.width,
        height: CARD_DEFAULTS.ai_chat.height,
        data: {
          content: "",
          result: [
            "基于参考图，生成 5 组不同姿势的全身写真。",
            "",
            "【强制锁定规则】",
            "1. 机位完全锁定：拍摄角度不变、镜头视角不变、相机高度不变",
            "2. 构图完全一致：模特在画面中的位置不变、人物大小比例不变、头身比例/腿长比例完全一致",
            "3. 严禁扩图：画布尺寸不变、不新增画面内容、不补边/不拉伸/不裁切",
            "4. 模特身份必须一致：面部/发型/体型/气质保持完全一致、服装保持 100% 一致（颜色/版型/材质/褶皱逻辑）",
            "",
            "【仅允许变化】",
            "- 角色姿态：5 组全新的、符合商业摄影美感的人体姿势",
            "- 动作变化必须符合真实人体力学",
            "",
            "【整体风格】",
            "真实商业摄影 / 电商模特 / Lookbook 风格，自然、克制、专业。",
          ].join("\n"),
        },
      },
      {
        type: "ai_image",
        title: "全身裂变",
        relativeX: PORTRAIT.width + 80 + CARD_DEFAULTS.ai_chat.width + 80,
        relativeY: (CARD_DEFAULTS.ai_chat.height - PORTRAIT.height) / 2,
        ...PORTRAIT,
        data: {
          imageUrl: lookFissionResult,
          content: "",
          size: "3:4",
        },
      },
    ],
    connections: [
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
    cards: (() => {
      const GAP = 60;
      const CHAT_W = CARD_DEFAULTS.ai_chat.width;
      const CHAT_H = SQUARE.height * 2 + GAP;
      const CHAT_X = SQUARE.width * 2 + GAP * 2;
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
          ...SQUARE,
          data: { content: "", size: "1:1", imageUrl: multimodalFusionPerson },
        },
        {
          type: "ai_image" as const,
          title: "服装图（输入2）",
          relativeX: SQUARE.width + GAP,
          relativeY: 0,
          ...SQUARE,
          data: { content: "", size: "1:1", imageUrl: multimodalFusionGarment },
        },
        {
          type: "ai_image" as const,
          title: "场景图（输入3）",
          relativeX: 0,
          relativeY: SQUARE.height + GAP,
          ...SQUARE,
          data: { content: "", size: "1:1", imageUrl: multimodalFusionScene },
        },
        {
          type: "ai_image" as const,
          title: "拍摄角度图（输入4）",
          relativeX: SQUARE.width + GAP,
          relativeY: SQUARE.height + GAP,
          ...SQUARE,
          data: { content: "", size: "1:1", imageUrl: multimodalFusionPose },
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
          relativeY: (CHAT_H - SQUARE.height) / 2,
          ...SQUARE,
          data: {
            content: "合成出来的图，要求 人物@图1   100%一致，高权重，图二衣服@图二  100%一致，高权重。",
            size: "1:1",
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
];
