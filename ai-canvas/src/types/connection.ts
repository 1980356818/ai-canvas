export type PortSide = "input" | "output";

export interface Connection {
  id: string;
  projectId: string;
  sourceCardId: string;
  targetCardId: string;
  createdAt: string;
}

export interface ConnectionRow {
  id: string;
  project_id: string;
  source_card_id: string;
  target_card_id: string;
  created_at: string;
}

export interface DraftWire {
  sourceCardId: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface PendingDrop {
  /** 发起拖拽的那张卡(用于定位 / 单连兼容)。 */
  sourceCardId: string;
  /**
   * 扇入:松手时希望一并连到新建卡的所有源卡(含 sourceCardId,且排在首位)。
   * 多选时 = 当时所有选中卡;单选时省略或仅含 sourceCardId。
   */
  sourceCardIds?: string[];
  screenX: number;
  screenY: number;
  canvasX: number;
  canvasY: number;
}
