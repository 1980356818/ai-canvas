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
}

export interface ToastItem {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  duration: number;
}
