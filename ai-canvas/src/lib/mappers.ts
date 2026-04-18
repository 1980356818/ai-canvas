import type { CanvasCard, CardRow, Connection, ConnectionRow, CardType } from "@/types";

export function cardToRow(card: CanvasCard): CardRow {
  return {
    id: card.id,
    project_id: card.projectId,
    type: card.type,
    x: card.x,
    y: card.y,
    width: card.width,
    height: card.height,
    z_index: card.zIndex,
    locked: card.locked,
    collapsed: card.collapsed,
    color: card.color ?? null,
    title: card.title ?? null,
    data: JSON.stringify(card.data),
    created_at: card.createdAt,
    updated_at: card.updatedAt,
  };
}

export function rowToCard(row: CardRow): CanvasCard {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type as CardType,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    zIndex: row.z_index,
    locked: row.locked,
    collapsed: row.collapsed,
    color: row.color ?? undefined,
    title: row.title ?? undefined,
    data: JSON.parse(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function connectionToRow(conn: Connection): ConnectionRow {
  return {
    id: conn.id,
    project_id: conn.projectId,
    source_card_id: conn.sourceCardId,
    target_card_id: conn.targetCardId,
    created_at: conn.createdAt,
  };
}

export function rowToConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceCardId: row.source_card_id,
    targetCardId: row.target_card_id,
    createdAt: row.created_at,
  };
}
