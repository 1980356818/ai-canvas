import type { ToolRegistry } from "./tools/registry";
import { generateImageTool } from "./tools/generate-image";
import { analyzeImageTool } from "./tools/analyze-image";
import { generateTextTool } from "./tools/generate-text";
import { buildAutomationTools } from "./tools/automation-bridge";

export function registerAllTools(registry: ToolRegistry) {
  // 生成类:LLM 一步产出内容并落卡(文生图 / 写文案 / 识图)。
  registry.register(generateImageTool);
  registry.register(generateTextTool);
  registry.register(analyzeImageTool);
  // 画布编排类:复用自动化动词层(建卡 / 连线 / 运行 / 快照 / 项目),与外部 AI 工具
  // (Claude Code / Codex)完全同一套语义。取代了旧的 canvas_operations(已退役)。
  for (const tool of buildAutomationTools()) {
    registry.register(tool);
  }
}
