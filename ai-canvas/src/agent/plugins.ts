import type { ToolRegistry } from "./tools/registry";
import { generateImageTool } from "./tools/generate-image";
import { analyzeImageTool } from "./tools/analyze-image";
import { generateTextTool } from "./tools/generate-text";
import { canvasOpsTool } from "./tools/canvas-ops";

export function registerAllTools(registry: ToolRegistry) {
  registry.register(generateImageTool);
  registry.register(analyzeImageTool);
  registry.register(generateTextTool);
  registry.register(canvasOpsTool);
}
