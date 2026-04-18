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
  sourceCardId: string;
  screenX: number;
  screenY: number;
  canvasX: number;
  canvasY: number;
}
