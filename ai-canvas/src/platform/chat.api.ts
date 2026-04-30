import type { ChatSessionRow, ChatMessageRow } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { lsGet, lsSet } from "./storage";

export async function listChatSessions(projectId?: string): Promise<ChatSessionRow[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<ChatSessionRow[]>("list_chat_sessions", {
      projectId: projectId ?? null,
    });
  }
  const rows = lsGet<ChatSessionRow[]>("chat_sessions", []);
  if (projectId === undefined) return rows;
  return rows.filter((r) => r.project_id === projectId);
}

export async function createChatSession(
  id: string,
  title: string,
  projectId?: string,
): Promise<ChatSessionRow> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<ChatSessionRow>("create_chat_session", {
      id,
      title,
      projectId: projectId ?? null,
    });
  }
  const now = new Date().toISOString();
  const session: ChatSessionRow = {
    id,
    project_id: projectId ?? null,
    title,
    created_at: now,
    updated_at: now,
  };
  const sessions = lsGet<ChatSessionRow[]>("chat_sessions", []);
  sessions.unshift(session);
  lsSet("chat_sessions", sessions);
  return session;
}

export async function renameChatSession(
  id: string,
  title: string,
): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("rename_chat_session", { id, title });
    return;
  }
  const sessions = lsGet<ChatSessionRow[]>("chat_sessions", []);
  const s = sessions.find((x) => x.id === id);
  if (s) {
    s.title = title;
    s.updated_at = new Date().toISOString();
    lsSet("chat_sessions", sessions);
  }
}

export async function deleteChatSession(id: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("delete_chat_session", { id });
    return;
  }
  const sessions = lsGet<ChatSessionRow[]>("chat_sessions", []);
  lsSet("chat_sessions", sessions.filter((s) => s.id !== id));
  localStorage.removeItem("ai_canvas_chat_msgs_" + id);
}

export async function loadChatMessages(
  sessionId: string,
): Promise<ChatMessageRow[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<ChatMessageRow[]>("load_chat_messages", { sessionId });
  }
  return lsGet<ChatMessageRow[]>("chat_msgs_" + sessionId, []);
}

export async function saveChatMessage(
  message: ChatMessageRow,
): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("save_chat_message", { message });
    return;
  }
  const key = "chat_msgs_" + message.session_id;
  const msgs = lsGet<ChatMessageRow[]>(key, []);
  const idx = msgs.findIndex((m) => m.id === message.id);
  if (idx >= 0) msgs[idx] = message;
  else msgs.push(message);
  lsSet(key, msgs);

  const sessions = lsGet<ChatSessionRow[]>("chat_sessions", []);
  const s = sessions.find((x) => x.id === message.session_id);
  if (s) {
    s.updated_at = new Date().toISOString();
    lsSet("chat_sessions", sessions);
  }
}

export async function clearChatMessages(sessionId: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("clear_chat_messages", { sessionId });
    return;
  }
  lsSet("chat_msgs_" + sessionId, []);
}
