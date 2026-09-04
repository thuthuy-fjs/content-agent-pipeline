// GET /api/runs (paged/filtered run history) and GET /api/result (one run).
// Both read from Notion — it is the only store; a Worker has no filesystem.

import { jsonResponse } from "../http";
import { isConfigured, queryRuns, readRun, type NotionEnv, type RunListItem } from "../notion";
import {
  HISTORY_CACHE_TTL_SEC,
  HISTORY_MAX_RECORDS,
  HISTORY_PAGE_SIZE,
  PLATFORM_LABELS,
} from "../webConfig";

const HISTORY_CACHE_KEY = "history-cache";

interface DecoratedRun extends RunListItem {
  platform_label: string;
  date: string;
  run_at: string;
}

// Lich su hien thi theo gio VN co dinh (UTC+7), khong theo gio may chu — Workers
// khong co "gio dia phuong" on dinh nen cong offset thang vao epoch.
function decorate(run: RunListItem): DecoratedRun {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date((run._sort_ts || 0) * 1000 + 7 * 3600 * 1000);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const run_at = `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const platform = (run.platform as string) || "";
  return { ...run, platform_label: PLATFORM_LABELS[platform] || platform, date, run_at };
}

async function allRuns(kv: KVNamespace, env: NotionEnv, refresh: boolean): Promise<DecoratedRun[]> {
  if (!refresh) {
    const cached = await kv.get(HISTORY_CACHE_KEY);
    if (cached) return JSON.parse(cached) as DecoratedRun[];
  }

  let runs: RunListItem[] = [];
  let complete = true;
  if (isConfigured(env)) {
    let cursor: string | null = null;
    try {
      while (runs.length < HISTORY_MAX_RECORDS) {
        const page = await queryRuns(env, 100, cursor);
        runs = runs.concat(page.runs);
        cursor = page.next_cursor;
        if (!cursor) break;
      }
    } catch {
      complete = false; // network hiccup — still show what we already fetched
    }
  }

  runs.sort((a, b) => (b._sort_ts || 0) - (a._sort_ts || 0));
  const decorated = runs.slice(0, HISTORY_MAX_RECORDS).map(decorate);
  if (complete) {
    await kv.put(HISTORY_CACHE_KEY, JSON.stringify(decorated), { expirationTtl: HISTORY_CACHE_TTL_SEC });
  }
  return decorated;
}

export async function handleHistory(request: Request, env: NotionEnv, kv: KVNamespace): Promise<Response> {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10) || 1;
  const date = (url.searchParams.get("date") || "").trim();
  const platform = (url.searchParams.get("platform") || "").trim();
  const refresh = url.searchParams.has("refresh");

  let runs = await allRuns(kv, env, refresh);
  if (platform) runs = runs.filter((r) => r.platform === platform);
  if (date) runs = runs.filter((r) => r.date === date);

  const total = runs.length;
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(1, page), pages);
  const start = (clampedPage - 1) * HISTORY_PAGE_SIZE;

  return jsonResponse({
    runs: runs.slice(start, start + HISTORY_PAGE_SIZE),
    page: clampedPage,
    pages,
    total,
    page_size: HISTORY_PAGE_SIZE,
  });
}

export async function handleResult(env: NotionEnv, pageId: string): Promise<Response> {
  if (!pageId) return jsonResponse({ error: "Thiếu page_id." }, 400);
  try {
    const result = await readRun(pageId, env);
    if (result === null) return jsonResponse({ error: "Trang Notion này không có khối JSON gốc." }, 404);
    return jsonResponse(result);
  } catch (exc) {
    return jsonResponse({ error: (exc as Error).message }, 502);
  }
}
