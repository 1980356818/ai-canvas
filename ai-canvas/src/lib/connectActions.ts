import { useConnectionStore } from "@/stores/connectionStore";
import { canAcceptConnection, type ConnectionReject } from "@/lib/dataFlow";
import type { Connection } from "@/types";

export interface ConnectSourcesResult {
  /** 实际新建的连线数。 */
  connected: number;
  /** 类型不兼容 / 槽位已满被拒的源数。 */
  rejected: number;
  /** 与目标已存在连线、跳过的源数。 */
  skippedExisting: number;
  /** 第一条拒绝原因(用于给调用方拼提示)。 */
  firstReject: ConnectionReject | null;
}

/**
 * 把多个源卡按顺序「扇入」连到同一个目标卡。
 *
 * 关键:**顺序逐条** `addConnection` —— 每条连线建立时,connectionStore 的
 * `onConnectionsAdded` 钩子会同步把上游产物注入目标卡并更新其槽位(refImages 等)。
 * 因此后一个源做 `canAcceptConnection` 校验时能看到最新状态,槽位有限的目标
 * (如图片卡只有 N 个参考位)会自然只连得下的、其余被拒——容量约束天然正确。
 *
 * 不弹 toast,由调用方按返回值决定提示文案(单连 / 多连汇总各有不同口径)。
 */
export function connectSourcesToTarget(
  sourceIds: Iterable<string>,
  targetCardId: string,
  projectId: string,
): ConnectSourcesResult {
  const connStore = useConnectionStore.getState();
  let connected = 0;
  let rejected = 0;
  let skippedExisting = 0;
  let firstReject: ConnectionReject | null = null;

  for (const sourceId of sourceIds) {
    if (sourceId === targetCardId) continue;
    if (connStore.hasConnection(sourceId, targetCardId)) {
      skippedExisting++;
      continue;
    }

    const reject = canAcceptConnection(targetCardId, sourceId);
    if (reject !== true) {
      rejected++;
      if (!firstReject) firstReject = reject;
      continue;
    }

    const conn: Connection = {
      id: crypto.randomUUID(),
      projectId,
      sourceCardId: sourceId,
      targetCardId,
      createdAt: new Date().toISOString(),
    };
    connStore.addConnection(conn);
    connected++;
  }

  return { connected, rejected, skippedExisting, firstReject };
}
