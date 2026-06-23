/**
 * 动词注册表 —— 所有自动化动词的唯一登记处。
 *
 * host 启动时把整张表的 schema 推给 Rust (MCP tools/list 用),并按名字分发执行。
 * 应用内对话面板 (P3) 复用同一张表,把动词 1:1 映射成 LLM function-calling 工具。
 */

import type { VerbDefinition } from "./types";

class VerbRegistry {
  private verbs = new Map<string, VerbDefinition>();

  register(verb: VerbDefinition): void {
    if (this.verbs.has(verb.name)) {
      console.warn(`[automation] 动词重复注册: ${verb.name}`);
    }
    this.verbs.set(verb.name, verb);
  }

  registerAll(verbs: VerbDefinition[]): void {
    for (const v of verbs) this.register(v);
  }

  get(name: string): VerbDefinition | undefined {
    return this.verbs.get(name);
  }

  list(): VerbDefinition[] {
    return [...this.verbs.values()];
  }

  /**
   * 生成 MCP `tools/list` 用的 descriptor。`inputSchema` 即动词的参数 JSON Schema。
   * Rust 缓存这份,外部 MCP 客户端 (Claude Code / Codex) 据此发现可调工具。
   */
  toDescriptor(): { tools: Array<{ name: string; description: string; inputSchema: unknown }> } {
    return {
      tools: this.list().map((v) => ({
        name: v.name,
        description: v.description,
        inputSchema: v.params,
      })),
    };
  }
}

export const verbRegistry = new VerbRegistry();
