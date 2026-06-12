/** 自动化服务入口。 */

export { installAutomationHost, uninstallAutomationHost, handleRequest } from "./host";
export { verbRegistry } from "./registry";
export type { CallResponse, RequestEvent, ErrorCode, VerbDefinition } from "./types";
