import type { ProjectInfo } from "@/stores/projectStore";

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

let _invoke: typeof import("@tauri-apps/api/core").invoke;
let _listen: typeof import("@tauri-apps/api/event").listen;

async function ensureTauriAPIs() {
  if (!_invoke) {
    const core = await import("@tauri-apps/api/core");
    _invoke = core.invoke;
  }
  if (!_listen) {
    const event = await import("@tauri-apps/api/event");
    _listen = event.listen;
  }
}

// ── Browser fallback storage helpers ─────────────────────────

const LS_PREFIX = "ai_canvas_";

function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function lsSet(key: string, value: unknown) {
  localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
}

function getBrowserApiConfig(): { apiKey: string; baseUrl: string } {
  return {
    apiKey: lsGet("setting_openai_api_key", ""),
    baseUrl: lsGet("setting_openai_base_url", ""),
  };
}

function buildProxyUrl(endpoint: string): string {
  return "/v1-proxy" + endpoint;
}

function getAuthHeaders(): Record<string, string> {
  const { apiKey } = getBrowserApiConfig();
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

// ── Types ────────────────────────────────────────────────────

export interface CardRow {
  id: string;
  project_id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  locked: boolean;
  collapsed: boolean;
  color: string | null;
  title: string | null;
  data: string;
  created_at: string;
  updated_at: string;
}

export interface AiProxyResponse {
  body: string;
  status: number;
}

export interface SaveMediaResult {
  local_path: string;
  width: number | null;
  height: number | null;
}

export interface StreamCallbacks {
  onChunk: (data: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

export interface ModelInfo {
  id: string;
  display_name?: string;
  model_family?: string;
  capability?: string;
  lines?: Array<{ tag: string; name: string; type: string }>;
  spec?: Record<string, unknown>;
}

export interface TaskInfo {
  id: string;
  status: string;
  progress: number;
  resultUrl?: string;
  thumbnailUrl?: string;
  errorMessage?: string;
  createdAt?: string;
  finishedAt?: string;
}

// ── Project Commands ─────────────────────────────────────────

export async function listProjects(): Promise<ProjectInfo[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    const rows = await _invoke<
      {
        id: string;
        title: string;
        thumbnail: string | null;
        node_count: number;
        created_at: string;
        updated_at: string;
      }[]
    >("list_projects");
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      thumbnail: r.thumbnail ?? undefined,
      nodeCount: r.node_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  const all = lsGet<(ProjectInfo & { deletedAt?: string })[]>("projects", []);
  return all.filter((p) => !p.deletedAt);
}

export async function createProject(title: string): Promise<ProjectInfo> {
  if (isTauri) {
    await ensureTauriAPIs();
    const r = await _invoke<{
      id: string;
      title: string;
      thumbnail: string | null;
      node_count: number;
      created_at: string;
      updated_at: string;
    }>("create_project", { title });
    return {
      id: r.id,
      title: r.title,
      thumbnail: r.thumbnail ?? undefined,
      nodeCount: r.node_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  const now = new Date().toISOString();
  const project: ProjectInfo = {
    id: crypto.randomUUID(),
    title,
    nodeCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const projects = lsGet<ProjectInfo[]>("projects", []);
  projects.unshift(project);
  lsSet("projects", projects);
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await _invoke("delete_project", { id });
    return;
  }

  const projects = lsGet<ProjectInfo[]>("projects", []);
  const target = projects.find((p) => p.id === id);
  if (target) {
    (target as ProjectInfo & { deletedAt?: string }).deletedAt = new Date().toISOString();
    lsSet("projects", projects);
  }
}

export async function listDeletedProjects(): Promise<ProjectInfo[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    const rows = await _invoke<
      {
        id: string;
        title: string;
        thumbnail: string | null;
        node_count: number;
        created_at: string;
        updated_at: string;
      }[]
    >("list_deleted_projects");
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      thumbnail: r.thumbnail ?? undefined,
      nodeCount: r.node_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  const all = lsGet<(ProjectInfo & { deletedAt?: string })[]>("projects", []);
  return all.filter((p) => !!p.deletedAt);
}

export async function restoreProject(id: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await _invoke("restore_project", { id });
    return;
  }

  const projects = lsGet<(ProjectInfo & { deletedAt?: string })[]>("projects", []);
  const target = projects.find((p) => p.id === id);
  if (target) {
    delete target.deletedAt;
    lsSet("projects", projects);
  }
}

export async function permanentlyDeleteProject(id: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await _invoke("permanently_delete_project", { id });
    return;
  }

  const projects = lsGet<ProjectInfo[]>("projects", []);
  lsSet(
    "projects",
    projects.filter((p) => p.id !== id),
  );
  localStorage.removeItem(LS_PREFIX + "cards_" + id);
  localStorage.removeItem(LS_PREFIX + "viewport_" + id);
}

export async function renameProject(
  id: string,
  title: string,
): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await _invoke("rename_project", { id, title });
    return;
  }

  const projects = lsGet<ProjectInfo[]>("projects", []);
  const p = projects.find((x) => x.id === id);
  if (p) {
    p.title = title;
    p.updatedAt = new Date().toISOString();
    lsSet("projects", projects);
  }
}

export async function updateProjectMeta(
  id: string,
  partial: Partial<ProjectInfo>,
): Promise<void> {
  if (isTauri) {
    return;
  }

  const projects = lsGet<ProjectInfo[]>("projects", []);
  const p = projects.find((x) => x.id === id);
  if (p) {
    Object.assign(p, partial, { updatedAt: new Date().toISOString() });
    lsSet("projects", projects);
  }
}

// ── Card Commands ────────────────────────────────────────────

export async function loadCards(projectId: string): Promise<CardRow[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    return _invoke<CardRow[]>("load_cards", { projectId });
  }

  return lsGet<CardRow[]>("cards_" + projectId, []);
}

export async function saveCardsBatch(cards: CardRow[]): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await _invoke("save_cards_batch", { cards });
    return;
  }

  if (cards.length === 0) return;
  const projectId = cards[0]!.project_id;
  const existing = lsGet<CardRow[]>("cards_" + projectId, []);
  const map = new Map(existing.map((c) => [c.id, c]));
  for (const card of cards) map.set(card.id, card);
  lsSet("cards_" + projectId, Array.from(map.values()));
}

export async function deleteCard(id: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await _invoke("delete_card", { id });
    return;
  }

  const projectKeys = Object.keys(localStorage).filter((k) =>
    k.startsWith(LS_PREFIX + "cards_"),
  );
  for (const key of projectKeys) {
    try {
      const cards: CardRow[] = JSON.parse(localStorage.getItem(key)!);
      const filtered = cards.filter((c) => c.id !== id);
      if (filtered.length !== cards.length) {
        localStorage.setItem(key, JSON.stringify(filtered));
        break;
      }
    } catch { /* skip */ }
  }
}

// ── AI Commands ──────────────────────────────────────────────

export async function aiProxy(
  provider: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<AiProxyResponse> {
  if (isTauri) {
    await ensureTauriAPIs();
    return _invoke<AiProxyResponse>("ai_proxy", { provider, endpoint, body });
  }

  const url = buildProxyUrl(endpoint);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  return { body: text, status: resp.status };
}

export async function saveMedia(
  source: string,
  _filename?: string,
  title?: string,
  projectId?: string,
): Promise<{ localPath: string; width?: number; height?: number }> {
  if (isTauri) {
    await ensureTauriAPIs();
    const r = await _invoke<SaveMediaResult>("save_media", {
      source,
      filename: _filename,
      title,
      projectId: projectId ?? null,
    });
    return {
      localPath: r.local_path,
      width: r.width ?? undefined,
      height: r.height ?? undefined,
    };
  }

  return { localPath: source };
}

export async function readMediaBase64(path: string): Promise<string> {
  if (isTauri) {
    await ensureTauriAPIs();
    return _invoke<string>("read_media_base64", { path });
  }
  return path;
}

// resolveImageUrl / imageUrlCache / dataUrlToBlobUrl removed —
// replaced by media.ts getDisplayUrl() which uses Tauri Asset Protocol.

// ── Streaming AI Proxy ───────────────────────────────────────

export async function aiProxyStream(
  provider: string,
  endpoint: string,
  body: Record<string, unknown>,
  callbacks: StreamCallbacks,
): Promise<{ streamId: string; abort: () => Promise<void> }> {
  const streamId = crypto.randomUUID();
  console.log("[Stream] aiProxyStream called, provider:", provider, "endpoint:", endpoint, "streamId:", streamId);
  console.log("[Stream] isTauri:", isTauri);

  if (isTauri) {
    await ensureTauriAPIs();
    let tauriChunkCount = 0;

    interface StreamEvent {
      stream_id: string;
      event: "chunk" | "done" | "error";
      data: string;
    }

    const unlisten = await _listen<StreamEvent>("ai-stream", (event) => {
      const payload = event.payload;
      if (payload.stream_id !== streamId) return;
      switch (payload.event) {
        case "chunk":
          tauriChunkCount++;
          console.log(`[Stream][Tauri] chunk #${tauriChunkCount}, data(${payload.data.length}):`, payload.data.slice(0, 200));
          callbacks.onChunk(payload.data);
          break;
        case "done":
          console.log("[Stream][Tauri] done, total chunks:", tauriChunkCount);
          callbacks.onDone();
          unlisten();
          break;
        case "error":
          console.error("[Stream][Tauri] error:", payload.data.slice(0, 500));
          callbacks.onError(payload.data);
          break;
      }
    });

    console.log("[Stream][Tauri] invoking ai_proxy_stream...");
    await _invoke("ai_proxy_stream", {
      provider,
      endpoint,
      body: { ...body, stream: true },
      streamId,
    });
    console.log("[Stream][Tauri] ai_proxy_stream invoked ok");

    return {
      streamId,
      abort: async () => {
        console.log("[Stream][Tauri] aborting stream:", streamId);
        await _invoke("ai_proxy_stream_abort", { streamId });
        unlisten();
      },
    };
  }

  // Browser: SSE via fetch ReadableStream
  const abortController = new AbortController();
  const url = buildProxyUrl(endpoint);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
  };
  console.log("[Stream][Browser] fetch url:", url);

  (async () => {
    let browserChunkCount = 0;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: true }),
        signal: abortController.signal,
      });
      console.log("[Stream][Browser] response status:", resp.status, "content-type:", resp.headers.get("content-type"));

      if (!resp.ok) {
        const errText = await resp.text();
        console.error("[Stream][Browser] HTTP error:", resp.status, errText.slice(0, 500));
        callbacks.onError(`HTTP ${resp.status}: ${errText}`);
        return;
      }

      const reader = resp.body?.getReader();
      if (!reader) {
        console.error("[Stream][Browser] No readable stream in response");
        callbacks.onError("No readable stream");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let readCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log("[Stream][Browser] reader done, remaining buffer:", JSON.stringify(buffer.slice(0, 200)));
          break;
        }

        readCount++;
        const chunk = decoder.decode(value, { stream: true });
        console.log(`[Stream][Browser] read #${readCount}, bytes: ${value.byteLength}, decoded:`, chunk.slice(0, 200));
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          if (trimmed === "data: [DONE]") {
            console.log("[Stream][Browser] received [DONE], total SSE chunks:", browserChunkCount);
            callbacks.onDone();
            return;
          }
          if (trimmed.startsWith("data: ")) {
            browserChunkCount++;
            const payload = trimmed.slice(6);
            console.log(`[Stream][Browser] SSE chunk #${browserChunkCount}:`, payload.slice(0, 200));
            callbacks.onChunk(payload);
          } else {
            console.warn("[Stream][Browser] unexpected line:", trimmed.slice(0, 200));
          }
        }
      }

      console.log("[Stream][Browser] stream ended without [DONE], calling onDone, chunks:", browserChunkCount);
      callbacks.onDone();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[Stream][Browser] fetch error:", err);
        callbacks.onError(err instanceof Error ? err.message : String(err));
      } else {
        console.log("[Stream][Browser] fetch aborted");
      }
    }
  })();

  return {
    streamId,
    abort: async () => {
      console.log("[Stream][Browser] aborting fetch");
      abortController.abort();
    },
  };
}

// ── Gateway Commands ─────────────────────────────────────────

export async function listModels(): Promise<ModelInfo[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    const raw = await _invoke<{ data?: ModelInfo[] }>("list_models");
    return raw.data ?? [];
  }

  const url = buildProxyUrl("/v1/models");
  const resp = await fetch(url, { headers: getAuthHeaders() });
  if (!resp.ok) throw new Error(`Failed to list models: ${resp.status}`);
  const data = await resp.json();
  return data.data ?? [];
}

function normalizeTaskInfo(raw: Record<string, unknown>): TaskInfo {
  console.log("[TaskPoll] 原始响应字段:", Object.keys(raw));
  console.log("[TaskPoll] 原始响应（不含大数据）:", JSON.stringify(raw, (_key, value) => {
    if (typeof value === "string" && value.length > 200) return value.slice(0, 200) + "…";
    return value;
  }));
  const info: TaskInfo = {
    id: String(raw.id ?? ""),
    status: String(raw.status ?? ""),
    progress: Number(raw.progress ?? 0),
    resultUrl: (raw.resultUrl ?? raw.result_url) as string | undefined,
    thumbnailUrl: (raw.thumbnailUrl ?? raw.thumbnail_url) as string | undefined,
    errorMessage: (raw.errorMessage ?? raw.error_message) as string | undefined,
    createdAt: (raw.createdAt ?? raw.created_at) as string | undefined,
    finishedAt: (raw.finishedAt ?? raw.finished_at) as string | undefined,
  };
  if (info.status && /complet|success|fail|error|cancel/i.test(info.status)) {
    console.log("[TaskPoll] 任务终态:", {
      status: info.status,
      resultUrl: info.resultUrl?.slice(0, 100),
      errorMessage: info.errorMessage,
    });
  }
  return info;
}

export async function pollTask(taskId: string): Promise<TaskInfo> {
  if (isTauri) {
    await ensureTauriAPIs();
    const raw = await _invoke<Record<string, unknown>>("poll_task", { taskId });
    return normalizeTaskInfo(raw);
  }

  const url = buildProxyUrl(`/v1/tasks/${taskId}`);
  const resp = await fetch(url, { headers: getAuthHeaders() });
  if (!resp.ok) throw new Error(`Failed to poll task: ${resp.status}`);
  const raw = await resp.json();
  return normalizeTaskInfo(raw);
}

export async function validateConnection(): Promise<boolean> {
  if (isTauri) {
    await ensureTauriAPIs();
    return _invoke<boolean>("validate_connection");
  }

  const url = buildProxyUrl("/v1/models");
  const resp = await fetch(url, { headers: getAuthHeaders() });
  if (!resp.ok)
    throw new Error(`连接失败: HTTP ${resp.status}`);
  return true;
}

// ── Settings helpers ─────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  if (isTauri) {
    await ensureTauriAPIs();
    return _invoke<string | null>("get_setting", { key });
  }
  return lsGet<string | null>("setting_" + key, null);
}

export async function setSetting(key: string, value: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await _invoke("set_setting", { key, value });
    return;
  }
  lsSet("setting_" + key, value);
}

let _apiKeyCache: string | null | undefined;

export async function hasApiKey(): Promise<boolean> {
  if (_apiKeyCache === undefined) {
    _apiKeyCache = await getSetting("openai_api_key");
  }
  return !!_apiKeyCache;
}

export function invalidateApiKeyCache() {
  _apiKeyCache = undefined;
}

const COMFLY_API_KEY = "sk-V3CT1nzrBVT39hZezULUjczUEy9e3jiCZCK8qBTRbbbfOZB6";
const COMFLY_BASE_URL = "https://ai.comfly.chat";

export async function migrateApiConfig(): Promise<void> {
  const currentUrl = await getSetting("openai_base_url");
  if (currentUrl && currentUrl.includes("comfly.chat")) return;

  await setSetting("openai_api_key", COMFLY_API_KEY);
  await setSetting("openai_base_url", COMFLY_BASE_URL);
  invalidateApiKeyCache();
  console.log("[migrateApiConfig] 已切换到 comfly.chat");
}

// ── Dialog helpers ───────────────────────────────────────────

export async function pickDirectory(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title: "选择图片保存目录" });
    return typeof selected === "string" ? selected : null;
  }
  return null;
}

// ── File drop (Tauri-native fallback) ────────────────────────

export type FileDropCallback = (paths: string[], x: number, y: number) => void;

/**
 * Listen for Tauri-native file-drop events (fallback when browser
 * drag/drop is intercepted by the webview). Returns an unlisten function.
 */
export async function onTauriFileDrop(
  cb: FileDropCallback,
): Promise<() => void> {
  if (!isTauri) return () => {};
  try {
    await ensureTauriAPIs();
    const { getCurrentWebviewWindow } = await import(
      "@tauri-apps/api/webviewWindow"
    );
    const win = getCurrentWebviewWindow();
    const unlisten = await win.onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const pos = (event.payload as { position?: { x: number; y: number } })
          .position ?? { x: 0, y: 0 };
        const paths = (event.payload as { paths?: string[] }).paths ?? [];
        const mediaPaths = paths.filter((p: string) =>
          /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?|mp4|webm|mov|avi|mkv)$/i.test(p),
        );
        if (mediaPaths.length > 0) cb(mediaPaths, pos.x, pos.y);
      }
    });
    return unlisten;
  } catch {
    return () => {};
  }
}

// ── Per-project viewport persistence ─────────────────────────

export interface SavedViewport {
  x: number;
  y: number;
  zoom: number;
}

export function saveProjectViewport(
  projectId: string,
  viewport: SavedViewport,
): void {
  lsSet("viewport_" + projectId, viewport);
}

export function loadProjectViewport(
  projectId: string,
): SavedViewport | null {
  return lsGet<SavedViewport | null>("viewport_" + projectId, null);
}

export function removeProjectViewport(projectId: string): void {
  localStorage.removeItem(LS_PREFIX + "viewport_" + projectId);
}

// ── Connection persistence ───────────────────────────────────

export interface ConnectionRow {
  id: string;
  project_id: string;
  source_card_id: string;
  target_card_id: string;
  created_at: string;
}

export async function loadConnections(projectId: string): Promise<ConnectionRow[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    return _invoke<ConnectionRow[]>("load_connections", { projectId });
  }
  return lsGet<ConnectionRow[]>("connections_" + projectId, []);
}

export async function saveConnections(
  projectId: string,
  connections: ConnectionRow[],
): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await _invoke("save_connections_batch", { connections });
    return;
  }
  lsSet("connections_" + projectId, connections);
}

export async function clearProjectConnections(projectId: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await _invoke("clear_project_connections", { projectId });
    return;
  }
  lsSet("connections_" + projectId, []);
}

// ── Chat Session / Message persistence ───────────────────────

export interface ChatSessionRow {
  id: string;
  project_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  metadata: string | null;
  created_at: string;
}

export async function listChatSessions(): Promise<ChatSessionRow[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    return _invoke<ChatSessionRow[]>("list_chat_sessions");
  }
  return lsGet<ChatSessionRow[]>("chat_sessions", []);
}

export async function createChatSession(
  id: string,
  title: string,
  projectId?: string,
): Promise<ChatSessionRow> {
  if (isTauri) {
    await ensureTauriAPIs();
    return _invoke<ChatSessionRow>("create_chat_session", {
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
    await _invoke("rename_chat_session", { id, title });
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
    await _invoke("delete_chat_session", { id });
    return;
  }
  const sessions = lsGet<ChatSessionRow[]>("chat_sessions", []);
  lsSet("chat_sessions", sessions.filter((s) => s.id !== id));
  localStorage.removeItem(LS_PREFIX + "chat_msgs_" + id);
}

export async function loadChatMessages(
  sessionId: string,
): Promise<ChatMessageRow[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    return _invoke<ChatMessageRow[]>("load_chat_messages", { sessionId });
  }
  return lsGet<ChatMessageRow[]>("chat_msgs_" + sessionId, []);
}

export async function saveChatMessage(
  message: ChatMessageRow,
): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await _invoke("save_chat_message", { message });
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
    await _invoke("clear_chat_messages", { sessionId });
    return;
  }
  lsSet("chat_msgs_" + sessionId, []);
}

// ── Clipboard (native via Rust arboard) ──────────────────────

export async function clipboardWriteText(text: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await _invoke("clipboard_write", { text });
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function clipboardReadText(): Promise<string> {
  if (isTauri) {
    await ensureTauriAPIs();
    return _invoke<string>("clipboard_read");
  }
  return navigator.clipboard.readText();
}

export { isTauri };
