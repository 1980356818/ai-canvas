import type { ModelInfo } from "@/types";

export const SEEDANCE_MODELS: ModelInfo[] = [
  { id: "doubao-seedance-2-0-260128", display_name: "Seedance 2.0", capability: "VIDEO" },
  { id: "doubao-seedance-2-0-fast-260128", display_name: "Seedance 2.0 Fast", capability: "VIDEO" },
];

export const LEGACY_MODEL_MAP: Record<string, string> = {
  "doubao-seedance-2-0-v2-250528": "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-v2-250528-fast": "doubao-seedance-2-0-fast-260128",
  "doubao-seedance-2-0-fast-v2-250528": "doubao-seedance-2-0-fast-260128",
};

export function resolveModel(model: string | undefined): string {
  if (!model) return "doubao-seedance-2-0-260128";
  return LEGACY_MODEL_MAP[model] ?? model;
}
