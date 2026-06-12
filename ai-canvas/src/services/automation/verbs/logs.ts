/** 日志动词:读自动化调用日志尾部(JSONL),供 agent 自助排障。 */

import type { VerbDefinition } from "../types";
import { automationLogTail } from "@/platform/automation.api";

const logsTail: VerbDefinition = {
  name: "logs.tail",
  description:
    "读取自动化调用日志的最近若干行(结构化:含动词/结果/耗时/错误码),用于排查上一步为什么失败。",
  params: {
    type: "object",
    properties: {
      lines: { type: "number", description: "行数,默认 100,最多 1000" },
    },
  },
  async handler(params) {
    const n = Number(params.lines) || 100;
    const raw = await automationLogTail(n);
    const lines = raw.map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return { raw: l };
      }
    });
    return { lines };
  },
};

export const logsVerbs: VerbDefinition[] = [logsTail];
