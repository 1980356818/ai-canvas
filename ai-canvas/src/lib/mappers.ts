import type {
  CanvasCard,
  CardRow,
  Connection,
  ConnectionRow,
  CardType,
  CardGroup,
  CardGroupRow,
} from "@/types";

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

export function groupToRow(group: CardGroup): CardGroupRow {
  return {
    id: group.id,
    project_id: group.projectId,
    card_ids: JSON.stringify(group.cardIds),
    title: group.title,
    color: group.color,
    collapsed: group.collapsed,
    created_at: group.createdAt,
    updated_at: group.updatedAt,
  };
}

export function rowToGroup(row: CardGroupRow): CardGroup {
  let cardIds: string[] = [];
  try {
    const parsed = JSON.parse(row.card_ids);
    if (Array.isArray(parsed)) {
      // 防御 cardIds JSON 损坏:只保留字符串项,其它静默丢弃。
      cardIds = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* 留空数组,组会在下次 consistency 检查时被清理 */
  }
  return {
    id: row.id,
    projectId: row.project_id,
    cardIds,
    title: row.title,
    color: row.color,
    collapsed: row.collapsed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
