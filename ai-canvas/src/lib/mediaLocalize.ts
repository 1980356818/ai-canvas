/**
 * 生成结果媒体本地化 —— 统一收敛入口(规范)。
 *
 * ## 数据层规范
 * 卡片 data 的**结果字段**(imageUrl / results[].url / videoUrl / resultImageUrl /
 * audioUrl)只允许两种稳态:
 *   1. 本地相对 storagePath(`media/images/xxx.png`)—— 正常稳态,离线可用;
 *   2. 模板静态资源公网 URL(路径含 `/aicanvas-static/`)—— 模板体系刻意保留公网
 *      URL(数据层永远公网、本地只作显示缓存,见 lib/media.ts 模板缓存一节),
 *      **不得**被本模块改写成本地路径。
 * 其余形态一律视为**待收敛暂态**,由本模块负责修复:
 *   - 真远端 http(s) URL —— 生成完成时 saveMedia 失败的兜底残留,或上游图床直漏。
 *     远端地址不可靠(时效签名 / 境外站国内不可达),必须落地;
 *   - `http(s)://asset.localhost/...` / `asset://` / `local://` —— 显示 URL / IPC
 *     占位符漏进数据层(历史 bug 残留),纯字符串反解即可修复,零网络。
 *
 * ## 收敛时机
 *   - 结果落卡时(taskBridge / 编辑器 / cardRunner)入队 —— 首次 saveMedia 失败后
 *     5s/15s/45s/2m/5m 退避重试;
 *   - 项目加载完成后全量扫一遍(sweep)—— 上一会话失败的、带时效签名的尽早抢救。
 *     本会话重试用尽**不丢数据**:卡片数据本身就是队列,下次加载再扫。
 *
 * ## 为什么按"卡"而不按"URL"入队
 * 同一张卡可能同时有 imageUrl + results[N] 多个远端条目(批量生成)。旧
 * scheduleBackgroundSave 按 cardId 单飞且只补一个字段,批量第 2..N 张永远救不回、
 * results[].url 不补导致"手动保存成功但徽标/远端图还在"(显示层优先读 results)。
 * 按卡入队,每次执行时从**最新** card.data 现场收集全部暂态条目逐一落地 + 精确
 * 整卡替换(imageUrl 与 results[i].url 同源同换),天然多 URL、天然幂等。
 */

import { saveMedia } from "@/platform";
import { isTauri } from "@/platform/runtime";
import { normalizeToStoragePath } from "@/lib/media";
import { useCardStore } from "@/stores/cardStore";
import { autoSave } from "@/lib/autoSave";

/** 模板静态资源路径标志 —— 命中即视为模板体系资产,数据层保留公网 URL。 */
const TEMPLATE_STATIC_MARKER = "/aicanvas-static/";

/** 顶层结果字段白名单 —— 本模块只读写这些字段(+ results[].url),绝不碰 refImages 等输入字段。 */
const RESULT_URL_FIELDS = ["imageUrl", "videoUrl", "resultImageUrl", "audioUrl"] as const;

const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

export interface LocalizeOutcome {
  /** 纯字符串反解修复的条目数(asset.localhost / local:// 等,零网络)。 */
  repaired: number;
  /** 经 saveMedia 下载落地成功的条目数。 */
  saved: number;
  /** 下载失败(将退避重试)的条目数。 */
  failed: number;
  /** 无法处理跳过的条目数(如 asset URL 反解失败),不参与重试。 */
  skipped: number;
}

/** url 是否处于"待收敛暂态"(见模块头规范)。 */
export function needsLocalization(url: unknown): url is string {
  if (typeof url !== "string" || !url) return false;
  if (url.includes(TEMPLATE_STATIC_MARKER)) return false;
  if (
    url.startsWith("http://asset.localhost/") ||
    url.startsWith("https://asset.localhost/") ||
    url.startsWith("asset://") ||
    url.startsWith("local://")
  ) {
    return true; // 显示 URL / 占位符漏进数据层 → 字符串修复
  }
  return url.startsWith("http://") || url.startsWith("https://"); // 真远端 → 下载落地
}

/** 从卡片 data 收集全部待收敛 URL(去重,只看结果字段白名单 + results[].url)。 */
export function collectLocalizableUrls(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const out = new Set<string>();
  for (const f of RESULT_URL_FIELDS) {
    if (needsLocalization(d[f])) out.add(d[f] as string);
  }
  if (Array.isArray(d.results)) {
    for (const r of d.results) {
      const u = (r as { url?: unknown } | null)?.url;
      if (needsLocalization(u)) out.add(u);
    }
  }
  return [...out];
}

/** 卡片是否存在待收敛媒体(工具栏"保存到本地"按钮的显隐条件)。 */
export function hasLocalizableMedia(data: unknown): boolean {
  return collectLocalizableUrls(data).length > 0;
}

/**
 * 把 oldUrl 在结果字段里的所有出现替换成 newPath,返回只含改动字段的 patch。
 * results 条目顺带补 remoteUrl 溯源(仅真远端;反解修复不算)。
 */
function buildReplacementPatch(
  data: Record<string, unknown>,
  oldUrl: string,
  newPath: string,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  let changed = false;

  for (const f of RESULT_URL_FIELDS) {
    if (data[f] === oldUrl) {
      patch[f] = newPath;
      changed = true;
    }
  }

  if (Array.isArray(data.results)) {
    let resultsChanged = false;
    const isHttp = oldUrl.startsWith("http://") || oldUrl.startsWith("https://");
    const isAssetish = oldUrl.includes("asset.localhost") || oldUrl.startsWith("asset://");
    const next = (data.results as Array<Record<string, unknown> | null>).map((r) => {
      if (r && r.url === oldUrl) {
        resultsChanged = true;
        const remoteUrl = r.remoteUrl ?? (isHttp && !isAssetish ? oldUrl : undefined);
        return { ...r, url: newPath, ...(remoteUrl != null ? { remoteUrl } : {}) };
      }
      return r;
    });
    if (resultsChanged) {
      patch.results = next;
      changed = true;
    }
  }

  return changed ? patch : null;
}

/** 读最新卡片数据做精确替换 —— 期间数据被并发改动(URL 已不在)则静默跳过,绝不覆盖新值。 */
function applyReplacement(cardId: string, oldUrl: string, newPath: string): boolean {
  const store = useCardStore.getState();
  const card = store.getCard(cardId);
  if (!card) return false;
  const patch = buildReplacementPatch(card.data as Record<string, unknown>, oldUrl, newPath);
  if (!patch) return false;
  store.updateCardData(cardId, patch);
  autoSave.markDirty(cardId);
  return true;
}

/**
 * 立即对一张卡执行一轮收敛(工具栏"保存到本地"/重试按钮直接调;后台调度也走这里)。
 * 逐 URL:先尝试零网络反解修复,不行再 saveMedia 下载。失败不抛,计入 outcome.failed。
 */
export async function localizeCardMedia(cardId: string): Promise<LocalizeOutcome> {
  const outcome: LocalizeOutcome = { repaired: 0, saved: 0, failed: 0, skipped: 0 };
  const card = useCardStore.getState().getCard(cardId);
  if (!card) return outcome;

  for (const url of collectLocalizableUrls(card.data)) {
    // 1) 显示 URL / 占位符 → 纯字符串反解,零网络
    const rel = normalizeToStoragePath(url);
    if (rel) {
      if (applyReplacement(cardId, url, rel)) outcome.repaired++;
      continue;
    }
    // asset 形态但反解失败(指向 data_dir 之外)→ 没有可靠修复手段,跳过不重试
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      outcome.skipped++;
      continue;
    }
    if (url.includes("asset.localhost")) {
      console.warn(`[mediaLocalize] ${cardId} asset 显示 URL 无法反解,跳过: ${url.slice(0, 120)}`);
      outcome.skipped++;
      continue;
    }
    // 2) 真远端 → 下载落地(Rust 端自带 3 次下载重试)
    try {
      const saved = await saveMedia(url, undefined, card.title || undefined, card.projectId);
      if (saved.localPath && saved.localPath !== url) {
        applyReplacement(cardId, url, saved.localPath);
        outcome.saved++;
      } else {
        // 非 Tauri 降级等场景 saveMedia 原样返回 —— 视为无事发生
        outcome.skipped++;
      }
    } catch (err) {
      console.warn(`[mediaLocalize] ${cardId} 下载失败(稍后重试): ${url.slice(0, 120)}`, err);
      outcome.failed++;
    }
  }
  return outcome;
}

// ── 退避调度(按卡单飞) ─────────────────────────────────────────

interface PendingEntry {
  attempt: number;
  timerId: ReturnType<typeof setTimeout>;
}

const _pending = new Map<string, PendingEntry>();

/**
 * 把一张卡排进后台收敛队列。已在队列 / 无待收敛条目 / 非 Tauri 环境 → 返回 false。
 * `firstDelayMs` 仅作用于首次尝试(默认 5s;sweep 用它错峰,重试按钮用 0)。
 */
export function scheduleCardMediaLocalization(
  cardId: string,
  opts?: { firstDelayMs?: number },
): boolean {
  if (!isTauri) return false; // 纯 Web 模式无本地存储,远端 URL 即稳态
  if (_pending.has(cardId)) return false;
  const card = useCardStore.getState().getCard(cardId);
  if (!card || collectLocalizableUrls(card.data).length === 0) return false;
  enqueue(cardId, 0, opts?.firstDelayMs ?? RETRY_DELAYS_MS[0]!);
  return true;
}

export function cancelCardMediaLocalization(cardId: string): void {
  const entry = _pending.get(cardId);
  if (entry) {
    clearTimeout(entry.timerId);
    _pending.delete(cardId);
  }
}

function enqueue(cardId: string, attempt: number, delayMs: number): void {
  const timerId = setTimeout(() => void runScheduled(cardId, attempt), delayMs);
  _pending.set(cardId, { attempt, timerId });
}

async function runScheduled(cardId: string, attempt: number): Promise<void> {
  _pending.delete(cardId);
  let outcome: LocalizeOutcome;
  try {
    outcome = await localizeCardMedia(cardId);
  } catch (err) {
    // localizeCardMedia 自身不应抛;兜底当作整轮失败重试
    console.warn(`[mediaLocalize] ${cardId} 收敛执行异常:`, err);
    outcome = { repaired: 0, saved: 0, failed: 1, skipped: 0 };
  }
  if (outcome.failed === 0) {
    if (outcome.saved > 0 || outcome.repaired > 0) {
      console.log(
        `[mediaLocalize] ${cardId} 收敛完成: saved=${outcome.saved} repaired=${outcome.repaired}`,
      );
    }
    return;
  }
  const next = attempt + 1;
  if (next >= RETRY_DELAYS_MS.length) {
    console.warn(
      `[mediaLocalize] ${cardId} 本会话重试用尽(${RETRY_DELAYS_MS.length} 次),留待下次项目加载再扫`,
    );
    return;
  }
  enqueue(cardId, next, RETRY_DELAYS_MS[next]!);
}

/**
 * 项目加载完成后的全量补救扫描:把所有存在待收敛媒体的卡错峰入队。
 * 返回入队的卡数。
 */
export function sweepProjectMediaLocalization(projectId: string): number {
  if (!isTauri) return 0;
  let n = 0;
  for (const card of useCardStore.getState().cards.values()) {
    if (card.projectId !== projectId) continue;
    if (scheduleCardMediaLocalization(card.id, { firstDelayMs: 2_000 + n * 1_500 })) n++;
  }
  return n;
}

/** 测试钩子:清空调度状态(避免用例间串扰)。 */
export function _resetForTests(): void {
  for (const e of _pending.values()) clearTimeout(e.timerId);
  _pending.clear();
}
