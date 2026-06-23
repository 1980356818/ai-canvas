/** 自描述动词:返回所有动词及其参数 schema。agent 不必读外部文档即可发现能力。 */

import type { VerbDefinition } from "../types";
import { verbRegistry } from "../registry";

/** 与 Rust `automation::API_VERSION` 对齐。破坏性变更才 +1。 */
const API_VERSION = 1;

const describe: VerbDefinition = {
  name: "describe",
  description: "返回所有可用动词、各自的参数 schema 和 API 版本。",
  params: { type: "object", properties: {} },
  async handler() {
    return {
      apiVersion: API_VERSION,
      verbs: verbRegistry.list().map((v) => ({
        name: v.name,
        description: v.description,
        params: v.params,
      })),
    };
  },
};

export const describeVerbs: VerbDefinition[] = [describe];
