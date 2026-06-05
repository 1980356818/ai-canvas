// 客户端 WORKFLOW_TEMPLATES 的镜像目录（id + 名称），供"会员等级"配置里勾选可用模板。
// ⚠️ 与 ai-canvas/src/config/workflows.ts 的模板列表保持一致；客户端增删模板时同步更新这里。
export interface TemplateMeta {
  id: string
  name: string
}

export const TEMPLATE_CATALOG: TemplateMeta[] = [
  { id: 'wf-ai-chat', name: 'AI 对话' },
  { id: 'wf-ai-image', name: 'AI 图片生成' },
  { id: 'wf-content-plan', name: '内容策划' },
  { id: 'wf-video-storyboard', name: '视频分镜分析' },
  { id: 'wf-white-bg', name: '一键白底图' },
  { id: 'wf-tryon', name: '一键换衣' },
  { id: 'wf-scene-replace', name: '场景替换' },
  { id: 'wf-pose-fission', name: '模特姿态裂变' },
  { id: 'wf-face-merge', name: '人脸合成' },
  { id: 'wf-look-fission', name: 'Look 全身裂变' },
  { id: 'wf-multimodal-fusion', name: '多模态融合1' },
  { id: 'wf-multimodal-fusion-2', name: '多模态融合2' },
  { id: 'wf-multimodal-fusion-6', name: '服装多模态融合6' },
  { id: 'wf-studio-look', name: '一键棚拍Look图' },
  { id: 'wf-mirror-selfie-1', name: '对镜自拍一键换装1.0' },
  { id: 'wf-mirror-selfie', name: '对镜自拍一键换装2.0' },
]
