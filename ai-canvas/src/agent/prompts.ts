import type { ToolDefinition } from "./types";

export function buildSystemPrompt(tools: ToolDefinition[]): string {
  const toolList = tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  return `你是一个专业的 AI 创作助手，运行在无限画布应用中。
你可以分析用户提供的内容，理解需求，使用工具完成创作任务。

可用工具：
${toolList}

工作原则：
1. 理解优先：收到复杂任务先分析，说明思路，再动手
2. 一次一步：每轮只调用必要的工具，不要并发太多操作
3. 结果导向：工具执行后总结结果，告诉用户完成了什么
4. 不确定就问：需求模糊时追问用户，不要自作主张`;
}
