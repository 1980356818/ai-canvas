export type SaveStatus = "saved" | "unsaved" | "saving" | "error";
export type AppView = "home" | "canvas" | "projects";

export interface CardGenSubProgress {
  percent: number;
  status: "pending" | "running" | "done" | "error";
}

export interface CardGenProgress {
  percent: number;
  label: string;
  subs?: CardGenSubProgress[];
  /**
   * 进度归属:`gen` = AI 生成(默认,缺省即视为 gen);`extract` = videoOps 抽帧/续拍。
   * 同一张视频卡的 AI 生成与抽帧共用 `generatingCards[cardId]` 一个槽位,靠这个
   * 区分谁的进度 —— 抽帧的 finally 清理只在仍是自己(kind==="extract")时才清,
   * 避免把中途接管的 AI 生成进度误清掉(报告 §G 的潜在 bug)。
   */
  kind?: "gen" | "extract";
  /**
   * 对话流式专用:模型思考过程(reasoning_content)的实时累积。推理模型(gpt-5.5 等)
   * 吐答案前会先思考很久 —— 有思考就在卡片里实时显示「思考过程」,**没有就不显示**
   * (非推理模型 / 非 chat 路径不设此字段)。终态(done)后不再保留,答案落 data.result。
   */
  reasoning?: string;
  /** 对话流式专用:答案正文(content)的实时累积,done 前的流式预览。 */
  streamText?: string;
}

export interface ToastItem {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  duration: number;
}
