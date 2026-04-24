export interface AiProxyResponse {
  body: string;
  status: number;
  rotated_key_name?: string | null;
  tried_count?: number;
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
  onKeySwitched?: (keyName: string, triedCount: number) => void;
}
