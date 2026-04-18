export interface ModelInfo {
  id: string;
  display_name?: string;
  model_family?: string;
  capability?: string;
  lines?: Array<{ tag: string; name: string; type: string }>;
  spec?: Record<string, unknown>;
}
