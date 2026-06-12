/** 动词总注册 —— host 启动时调一次,把所有动词登记进 verbRegistry。 */

import { verbRegistry } from "../registry";
import { describeVerbs } from "./describe";
import { projectVerbs } from "./project";
import { canvasVerbs } from "./canvas";
import { cardVerbs } from "./card";
import { connectionVerbs } from "./connection";
import { runVerbs } from "./run";
import { taskVerbs } from "./task";
import { logsVerbs } from "./logs";
import { specVerbs } from "./spec";

let registered = false;

/** 幂等:多次调用只注册一次(host 可能随设置开关反复 install)。 */
export function registerAllVerbs(): void {
  if (registered) return;
  verbRegistry.registerAll([
    ...describeVerbs,
    ...projectVerbs,
    ...canvasVerbs,
    ...cardVerbs,
    ...connectionVerbs,
    ...runVerbs,
    ...taskVerbs,
    ...logsVerbs,
    ...specVerbs,
  ]);
  registered = true;
}
