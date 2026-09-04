// Run state + event log, kept in Workers KV. A Worker keeps nothing between
// requests, so KV is the only "process memory" available. Budget ~10-15 writes
// per run (one per event) to stay inside the free tier, and note KV is
// eventually consistent — fine for a single-user tool, not for shared state.

import type { PipelineEvent } from "./events";
import { vnClock } from "./webConfig";

export type RunStatus = "running" | "done" | "error" | "stopped";

/** Dùng ở cả /api/stop lẫn nhánh StoppedError của pipeline — phải giống nhau. */
export const STOP_MESSAGE = "Đã dừng theo yêu cầu.";

export interface RunBrief {
  topic: string;
  platform: string;
  platform_label: string;
  duration: number;
  llm_platform: string;
  model: string;
  light_model: string | null;
  dry_run: boolean;
}

export interface RunRecord {
  id: string;
  brief: RunBrief;
  started_at: number; // epoch seconds
  status: RunStatus;
  events: PipelineEvent[];
  notion_url: string | null;
  error: string | null;
  result: unknown | null;
  stopRequested: boolean;
}

export interface RunMetadata {
  status: RunStatus;
  topic: string;
  platform: string;
  duration: number;
  dry_run: boolean;
  started_at: number;
  step: { name: string; index: number; total: number } | null;
}

function key(id: string): string {
  return `run:${id}`;
}

function currentStep(events: PipelineEvent[]): { name: string; index: number; total: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "step") return { name: ev.name, index: ev.index, total: ev.total };
  }
  return null;
}

function metadataFor(record: RunRecord): RunMetadata {
  return {
    status: record.status,
    topic: record.brief.topic,
    platform: record.brief.platform_label || record.brief.platform,
    duration: record.brief.duration,
    dry_run: record.brief.dry_run,
    started_at: record.started_at,
    step: currentStep(record.events),
  };
}

export async function createRun(kv: KVNamespace, id: string, brief: RunBrief): Promise<RunRecord> {
  const record: RunRecord = {
    id,
    brief,
    started_at: Date.now() / 1000,
    status: "running",
    events: [],
    notion_url: null,
    error: null,
    result: null,
    stopRequested: false,
  };
  await kv.put(key(id), JSON.stringify(record), { metadata: metadataFor(record) });
  return record;
}

export async function getRun(kv: KVNamespace, id: string): Promise<RunRecord | null> {
  const value = await kv.get(key(id));
  if (!value) return null;
  return JSON.parse(value) as RunRecord;
}

export async function saveRun(kv: KVNamespace, record: RunRecord): Promise<void> {
  await kv.put(key(record.id), JSON.stringify(record), { metadata: metadataFor(record) });
}

/** Read-modify-write helper; KV has no atomic transactions, fine for a single-user tool. */
export async function updateRun(
  kv: KVNamespace,
  id: string,
  mutate: (record: RunRecord) => void
): Promise<RunRecord | null> {
  const record = await getRun(kv, id);
  if (!record) return null;
  mutate(record);
  await saveRun(kv, record);
  return record;
}

export function snapshot(record: RunRecord, since = 0): Record<string, unknown> {
  return {
    status: record.status,
    brief: record.brief,
    started_at: record.started_at,
    events: record.events.slice(since),
    total_events: record.events.length,
    notion_url: record.notion_url,
    error: record.error,
    result: record.result,
  };
}

export interface ActiveRunSummary {
  id: string;
  topic: string;
  platform: string;
  duration: number;
  dry_run: boolean;
  /** Giờ bắt đầu theo giờ VN, "HH:MM" — chỉ để hiện tooltip; UI đếm thời gian
      chạy từ `started_at`. */
  started: string;
  started_at: number;
  step: { name: string; index: number; total: number } | null;
}

/** GET /api/active — no run reads needed, list() returns metadata for free. */
export async function listActiveRuns(kv: KVNamespace): Promise<ActiveRunSummary[]> {
  const out: ActiveRunSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list<RunMetadata>({ prefix: "run:", cursor });
    for (const entry of page.keys) {
      const meta = entry.metadata;
      if (!meta || meta.status !== "running") continue;
      out.push({
        id: entry.name.slice("run:".length),
        topic: meta.topic,
        platform: meta.platform,
        duration: meta.duration,
        dry_run: meta.dry_run,
        started: vnClock(meta.started_at),
        started_at: meta.started_at,
        step: meta.step,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => b.started_at - a.started_at);
  return out;
}

/* Cờ dừng nằm ở key riêng, không nằm trong bản ghi run. Lý do: updateRun() là
   đọc-sửa-ghi không nguyên tử, nên một emit() của pipeline (đã đọc bản ghi từ
   trước) có thể ghi đè mất cờ vừa đặt — đúng lúc cần nhất thì hỏng. Key riêng
   thì hai bên không giẫm chân nhau. TTL 24h để không rác lại mãi. */
const STOP_TTL_SEC = 86400;

export async function requestStop(kv: KVNamespace, id: string): Promise<void> {
  await kv.put(`stop:${id}`, String(Math.round(Date.now() / 1000)), { expirationTtl: STOP_TTL_SEC });
}

export async function isStopRequested(kv: KVNamespace, id: string): Promise<boolean> {
  return (await kv.get(`stop:${id}`)) !== null;
}

/* Lượt chạy của một lần truy cập. Key nằm ngoài prefix "run:" nên không lọt vào
   listActiveRuns(). KV không có compare-and-set, nhưng ở đây chỉ cần chặn lần
   bấm thứ hai của cùng một tab nên đọc-rồi-ghi là đủ. */
export async function claimVisit(kv: KVNamespace, visitId: string, ttlSec: number): Promise<boolean> {
  const visitKey = `visit:${visitId}`;
  if (await kv.get(visitKey)) return false;
  await kv.put(visitKey, String(Math.round(Date.now() / 1000)), { expirationTtl: ttlSec });
  return true;
}
