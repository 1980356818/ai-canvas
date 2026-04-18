export interface AiProxyResponse {
  body: string;
  status: number;
}

export interface SaveMediaResult {
  local_path: string;
  width: number | null;
  height: number | null;
}

export interface StreamCallbacks {
  onChunk: (data: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}
