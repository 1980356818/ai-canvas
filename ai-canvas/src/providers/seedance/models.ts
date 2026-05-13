import type { ModelInfo } from "@/types";
import { resolveSeedanceUpstreamModel } from "../shared/video";

export const SEEDANCE_MODELS: ModelInfo[] = [
  { id: "seedance", display_name: "Seedance 2.0", capability: "VIDEO" },
  { id: "doubao-seedance-2-0-260128", display_name: "Seedance 2.0", capability: "VIDEO" },
  { id: "doubao-seedance-2-0-fast-260128", display_name: "Seedance 2.0 Fast", capability: "VIDEO" },
];

export const resolveModel = resolveSeedanceUpstreamModel;
