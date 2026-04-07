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

  return lsGet<ProjectInfo[]>("projects", []);
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
  lsSet(
    "projects",
    projects.filter((p) => p.id !== id),
  );
  localStorage.removeItem(LS_PREFIX + "cards_" + id);
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
): Promise<{ localPath: string }> {
  if (isTauri) {
    await ensureTauriAPIs();
    const r = await _invoke<SaveMediaResult>("save_media", {
      source,
      filename: _filename,
    });
    return { localPath: r.local_path };
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

const imageUrlCache = new Map<string, string>();

function dataUrlToBlobUrl(dataUrl: string): string {
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx === -1) return dataUrl;
  const meta = dataUrl.slice(0, commaIdx);
  const b64 = dataUrl.slice(commaIdx + 1);
  const mime = meta.match(/:(.*?);/)?.[1] || "image/png";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: mime }));
}

/**
 * Resolve an image path to a short Blob URL for display.
 * Local paths are read via Rust IPC; results are cached as Blob URLs
 * so React reconciliation never compares multi-MB base64 strings.
 */
export async function resolveImageUrl(path: string): Promise<string> {
  if (!path) return "";
  if (path.startsWith("blob:") || path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  const cached = imageUrlCache.get(path);
  if (cached) return cached;

  let blobUrl: string;
  if (path.startsWith("data:")) {
    blobUrl = dataUrlToBlobUrl(path);
  } else {
    const dataUrl = await readMediaBase64(path);
    blobUrl = dataUrlToBlobUrl(dataUrl);
  }
  imageUrlCache.set(path, blobUrl);
  return blobUrl;
}

// ── Streaming AI Proxy ───────────────────────────────────────

export async function aiProxyStream(
  provider: string,
  endpoint: string,
  body: Record<string, unknown>,
  callbacks: StreamCallbacks,
): Promise<{ streamId: string; abort: () => Promise<void> }> {
  const streamId = crypto.randomUUID();

  if (isTauri) {
    await ensureTauriAPIs();

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
          callbacks.onChunk(payload.data);
          break;
        case "done":
          callbacks.onDone();
          unlisten();
          break;
        case "error":
          callbacks.onError(payload.data);
          break;
      }
    });

    await _invoke("ai_proxy_stream", {
      provider,
      endpoint,
      body: { ...body, stream: true },
      streamId,
    });

    return {
      streamId,
      abort: async () => {
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

  (async () => {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: true }),
        signal: abortController.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        callbacks.onError(`HTTP ${resp.status}: ${errText}`);
        return;
      }

      const reader = resp.body?.getReader();
      if (!reader) {
        callbacks.onError("No readable stream");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          if (trimmed === "data: [DONE]") {
            callbacks.onDone();
            return;
          }
          if (trimmed.startsWith("data: ")) {
            callbacks.onChunk(trimmed.slice(6));
          }
        }
      }

      callbacks.onDone();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    }
  })();

  return {
    streamId,
    abort: async () => {
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
  return {
    id: String(raw.id ?? ""),
    status: String(raw.status ?? ""),
    progress: Number(raw.progress ?? 0),
    resultUrl: (raw.resultUrl ?? raw.result_url) as string | undefined,
    thumbnailUrl: (raw.thumbnailUrl ?? raw.thumbnail_url) as string | undefined,
    errorMessage: (raw.errorMessage ?? raw.error_message) as string | undefined,
    createdAt: (raw.createdAt ?? raw.created_at) as string | undefined,
    finishedAt: (raw.finishedAt ?? raw.finished_at) as string | undefined,
  };
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
        const imagePaths = paths.filter((p: string) =>
          /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?)$/i.test(p),
        );
        if (imagePaths.length > 0) cb(imagePaths, pos.x, pos.y);
      }
    });
    return unlisten;
  } catch {
    return () => {};
  }
}

export { isTauri };
