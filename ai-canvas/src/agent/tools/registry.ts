import type {
  AgentContext,
  ToolDefinition,
  ToolOutput,
} from "../types";
import type { FunctionSchema } from "../providers/base";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  toFunctionSchemas(): FunctionSchema[] {
    return [...this.tools.values()].map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: AgentContext,
  ): Promise<ToolOutput> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        data: { error: `Unknown tool: ${name}` },
      };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      return {
        success: false,
        data: { error: String(err) },
      };
    }
  }

  listTools(): Array<{ name: string; description: string }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }
}
