export interface TaskInfo {
  id: string;
  status: string;
  progress: number;
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
