export interface TaskInfo {
  id: string;
  status: string;
  /**
   * 上游报告的真实进度（0-100）。**undefined 表示上游没给进度信号**，
   * 客户端应该用时间外推；不要把"没给"塌缩成 0，否则会把"真实 0%"和"未知"混在一起。
   */
  progress: number | undefined;
  resultUrl?: string;
  thumbnailUrl?: string;
  errorMessage?: string;
  createdAt?: string;
  finishedAt?: string;
}

export interface TaskResult {
  status: string;
  resultUrl?: string;
  thumbnailUrl?: string;
  errorMessage?: string;
}
