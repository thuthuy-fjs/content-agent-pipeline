// Notion is the pipeline's only store.
//
// Write: one page per real run — a human-readable rendering plus a `code` block
// holding the run's raw JSON. Read: reconstructs everything from that raw JSON
// block only, never by parsing the pretty blocks back (lossy, one-way, breaks
// the moment someone hand-edits the page).

import { makeBrief, type VideoBrief } from "./brief";
import { renderScriptMd } from "./render";
import {
  validateBrollList,
  validateOutlineDraft,
  validateResearchNotes,
  validateScriptDraft,
  validateVideoMetadata,
  type BrollList,
  type OutlineDraft,
  type ResearchNotes,
  type ScriptDraft,
  type VideoMetadata,
} from "./schemas";
import { buildTimeline, durationReport, formatTimestamp, type TimedSection } from "./timeline";

const NOTION_API = "https://api.notion.com/v1";
// Data-source-aware API version (multi-source databases).
const NOTION_VERSION = "2025-09-03";

// Notion limits: 100 child blocks per page-create call, 2000 chars per rich
// text object. Raw JSON is always kept; pretty blocks are what gets cut at the
// ceiling, since losing them only makes the page uglier, not lossy.
const MAX_BLOCKS = 100;
const MAX_TEXT_LEN = 2000;

// Heading marking the raw-JSON region — the anchor used when reading back.
const RAW_MARKER = "Dữ liệu gốc (JSON — đừng sửa tay)";

const CONFIDENCE_LABEL: Record<string, string> = { high: "CAO", medium: "TRUNG BÌNH", low: "THẤP" };
const CONFIDENCE_COLOR: Record<string, string> = { high: "green", medium: "yellow", low: "red" };

export class NotionPublishError extends Error {}

export interface NotionEnv {
  NOTION_TOKEN?: string;
  NOTION_DATA_SOURCE_ID?: string;
}

export function isConfigured(env: NotionEnv): boolean {
  return Boolean(env.NOTION_TOKEN && env.NOTION_DATA_SOURCE_ID);
}

// ---------- HTTP ----------

function headers(env: NotionEnv): Record<string, string> {
  const token = env.NOTION_TOKEN;
  if (!token) throw new NotionPublishError("Thiếu NOTION_TOKEN.");
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json; charset=utf-8",
  };
}

async function call(url: string, env: NotionEnv, payload?: unknown, method = "GET"): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: headers(env),
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
  } catch (exc) {
    throw new NotionPublishError(`Không kết nối được tới Notion: ${(exc as Error).message}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new NotionPublishError(`Notion API lỗi ${res.status}: ${detail}`);
  }
  return res.json();
}

// ---------- rich text / block builders ----------

type RichText = { type: "text"; text: { content: string } };
type Block = Record<string, unknown>;

// JS string length already counts UTF-16 code units — matches what Notion
// counts against the 2000-char limit, no per-codepoint workaround needed.
function textChunks(content: string): RichText[] {
  const chunks: RichText[] = [];
  for (let i = 0; i < content.length; i += MAX_TEXT_LEN) {
    chunks.push({ type: "text", text: { content: content.slice(i, i + MAX_TEXT_LEN) } });
  }
  return chunks;
}

function text(content: string | null | undefined): RichText[] {
  const trimmed = (content || "").trim();
  if (!trimmed) return [];
  return textChunks(trimmed).slice(0, 1);
}

function plainText(block: any): string {
  const body = block[block.type] || {};
  return (body.rich_text || []).map((rt: any) => rt.plain_text || "").join("");
}

function heading(level: number, content: string): Block | null {
  const rich = text(content);
  if (!rich.length) return null;
  const key = `heading_${level}`;
  return { object: "block", type: key, [key]: { rich_text: rich } };
}

function paragraph(content: string, color = "default"): Block | null {
  const rich = text(content);
  if (!rich.length) return null;
  return { object: "block", type: "paragraph", paragraph: { rich_text: rich, color } };
}

function bulleted(content: string): Block | null {
  const rich = text(content);
  if (!rich.length) return null;
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rich } };
}

function bookmark(url: string): Block | null {
  if (!url.startsWith("http")) return null;
  return { object: "block", type: "bookmark", bookmark: { url } };
}

function factBlock(claim: string, confidence: string): Block | null {
  const rich = text(claim);
  if (!rich.length) return null;
  const label = CONFIDENCE_LABEL[confidence] || confidence.toUpperCase();
  const color = CONFIDENCE_COLOR[confidence] || "default";
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        { type: "text", text: { content: `[${label}] ` }, annotations: { bold: true, color } },
        ...rich,
      ],
    },
  };
}

function callout(content: string): Block | null {
  const rich = text(content);
  if (!rich.length) return null;
  return {
    object: "block",
    type: "callout",
    callout: { rich_text: rich, icon: { type: "emoji", emoji: "⚠️" }, color: "yellow_background" },
  };
}

function rawBlocks(payload: Record<string, unknown>): Block[] {
  const raw = JSON.stringify(payload);
  return [
    heading(3, RAW_MARKER) as Block,
    { object: "block", type: "code", code: { rich_text: textChunks(raw), language: "json" } },
  ];
}

// ---------- properties ----------

export function buildProperties(brief: VideoBrief, summary: Record<string, any>): Record<string, any> {
  const usage = summary.usage || {};
  const duration = summary.duration || {};
  const stageModels: Record<string, string> = usage.stage_models || {};

  const props: Record<string, any> = {
    Video: { title: text(summary.working_title || brief.topic) },
    "Chủ đề": { rich_text: text(brief.topic) },
    "Nền tảng": { select: { name: brief.platform } },
    "Model chính": { rich_text: text(usage.model) },
    "Model bước phụ": {
      rich_text: text(Object.entries(stageModels).map(([stage, model]) => `${stage}=${model}`).join(", ")),
    },
    Backend: { select: { name: usage.backend || "api" } },
    "Có cảnh báo": { checkbox: Boolean(summary.warnings && summary.warnings.length) },
  };
  if (duration.target_sec != null) props["Thời lượng mục tiêu (s)"] = { number: duration.target_sec };
  if (duration.spoken_estimate_sec != null) {
    props["Thời lượng đọc thử (s)"] = { number: duration.spoken_estimate_sec };
  }
  if (duration.drift_pct != null) props["Lệch %"] = { number: duration.drift_pct };
  const cost = usage.total_cost_usd;
  if (cost != null) props["Chi phí quy đổi"] = { number: Math.round(cost * 10000) / 10000 };
  return props;
}

export function buildTagProperties(metadata: VideoMetadata): Record<string, any> {
  const props: Record<string, any> = {};
  if (metadata.tags.length) {
    props.Tags = { multi_select: metadata.tags.slice(0, 20).map((t) => ({ name: t.slice(0, 100) })) };
  }
  if (metadata.hashtags.length) {
    props.Hashtag = { multi_select: metadata.hashtags.slice(0, 20).map((h) => ({ name: h.slice(0, 100) })) };
  }
  return props;
}

// ---------- page content ----------

export function buildBlocks(
  outline: OutlineDraft,
  research: ResearchNotes,
  timeline: TimedSection[],
  broll: BrollList,
  metadata: VideoMetadata,
  warnings: string[],
  rawPayload: Record<string, unknown>
): Block[] {
  const pretty: (Block | null)[] = [];

  if (warnings.length) pretty.push(callout(warnings.join("\n")));

  pretty.push(heading(2, "Outline"));
  for (const section of outline.structure) {
    pretty.push(bulleted(`${section.section} (${section.duration_sec}s) — ${section.goal}`));
  }

  pretty.push(heading(2, "Kịch bản"));
  for (const section of timeline) {
    const span = `[${formatTimestamp(section.start_sec)}–${formatTimestamp(section.end_sec)}] ${section.name}`;
    pretty.push(heading(3, span));
    pretty.push(paragraph(section.narration));
    pretty.push(paragraph(`🎬 ${section.visual_cue}`, "gray_background"));
  }

  if (broll.items.length) {
    pretty.push(heading(2, "B-roll"));
    // Khớp theo vị trí mảng với timeline, không theo tên — xem schemas.ts.
    broll.items.forEach((item, i) => {
      const section = timeline[i];
      const label = section
        ? `[${formatTimestamp(section.start_sec)}–${formatTimestamp(section.end_sec)}] ${item.section}`
        : item.section;
      pretty.push(heading(3, label));
      pretty.push(paragraph(`${item.shot_type} — ${item.search_keywords.join(", ")}`));
      if (item.note) pretty.push(paragraph(`📝 ${item.note}`, "gray_background"));
    });
  }

  pretty.push(heading(2, "Nghiên cứu"));
  pretty.push(paragraph(research.topic_summary));
  for (const fact of research.facts) {
    pretty.push(factBlock(fact.claim, fact.confidence));
    pretty.push(bookmark(fact.source_url));
  }
  const lists: [string, string[]][] = [
    ["Góc kể chuyện", research.angle_suggestions],
    ["Ý tưởng hook", research.hook_ideas],
    ["Còn bỏ ngỏ", research.open_questions],
  ];
  for (const [title, items] of lists) {
    if (!items.length) continue;
    pretty.push(heading(3, title));
    for (const item of items) pretty.push(bulleted(item));
  }

  pretty.push(heading(2, "Metadata"));
  pretty.push(heading(3, "Title gợi ý"));
  for (const t of metadata.title_options) pretty.push(bulleted(t));
  pretty.push(heading(3, "Description"));
  pretty.push(paragraph(metadata.description));

  const raw = rawBlocks(rawPayload).filter((b): b is Block => b !== null);
  // Raw JSON is the only real data source, always kept; pretty blocks are cut
  // first if the run would blow through the 100-block ceiling.
  const budget = Math.max(0, MAX_BLOCKS - raw.length);
  return [...pretty.filter((b): b is Block => b !== null).slice(0, budget), ...raw];
}

// ---------- write ----------

export interface RunSummary {
  working_title: string;
  sections: number;
  facts: number;
  duration: ReturnType<typeof durationReport>;
  warnings: string[];
  usage: Record<string, unknown>;
  notion_url?: string;
  notion_page_id?: string;
}

export async function publishRun(
  brief: VideoBrief,
  research: ResearchNotes,
  outline: OutlineDraft,
  script: ScriptDraft,
  broll: BrollList,
  timeline: TimedSection[],
  metadata: VideoMetadata,
  summary: RunSummary,
  env: NotionEnv
): Promise<{ id: string; url: string }> {
  const dataSourceId = env.NOTION_DATA_SOURCE_ID;
  if (!dataSourceId) throw new NotionPublishError("Thiếu NOTION_DATA_SOURCE_ID.");

  const rawPayload = { brief, research, outline, script, broll, metadata, meta: summary };
  const properties = { ...buildProperties(brief, summary), ...buildTagProperties(metadata) };

  const page = await call(
    `${NOTION_API}/pages`,
    env,
    {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties,
      children: buildBlocks(outline, research, timeline, broll, metadata, summary.warnings || [], rawPayload),
    },
    "POST"
  );
  const pageId = page.id as string;
  return { id: pageId, url: page.url || `https://notion.so/${pageId.replace(/-/g, "")}` };
}

// ---------- read ----------

function prop(props: Record<string, any>, name: string): unknown {
  const p = props[name] || {};
  const kind = p.type;
  if (kind === "title" || kind === "rich_text") {
    return ((p[kind] || []) as any[]).map((rt) => rt.plain_text || "").join("");
  }
  if (kind === "select") return (p.select || {}).name ?? null;
  if (kind === "number") return p.number ?? null;
  if (kind === "checkbox") return p.checkbox ?? null;
  return null;
}

export async function fetchPageBlocks(pageId: string, env: NotionEnv): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | null = null;
  while (true) {
    let url = `${NOTION_API}/blocks/${pageId}/children?page_size=100`;
    if (cursor) url += `&start_cursor=${cursor}`;
    const data = await call(url, env);
    blocks.push(...(data.results || []));
    if (!data.has_more) return blocks;
    cursor = data.next_cursor;
  }
}

export function extractRawPayload(blocks: any[]): Record<string, unknown> | null {
  const chunks: string[] = [];
  let collecting = false;
  for (const block of blocks) {
    if (!collecting) {
      if (block.type === "heading_3" && plainText(block) === RAW_MARKER) collecting = true;
      continue;
    }
    if (block.type !== "code") break;
    chunks.push(plainText(block));
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(chunks.join(""));
  } catch {
    return null;
  }
}

export function pageIdFromUrl(url: string | null | undefined): string | null {
  const match = /([0-9a-fA-F]{32})/.exec((url || "").replace(/-/g, ""));
  return match ? match[1] : null;
}

export interface ReadRunResult {
  notion_page_id: string;
  brief: VideoBrief;
  research: ResearchNotes;
  // null cho các run đã xuất bản trước khi có Outline/B-roll Agent — raw JSON
  // của run cũ không có hai trường này, không được coi là lỗi đọc.
  outline: OutlineDraft | null;
  script: ScriptDraft;
  broll: BrollList | null;
  title_options: string[];
  tags: { tags: string[]; hashtags: string[] };
  meta: Record<string, unknown>;
  description: string;
  script_md: string;
}

export async function readRun(pageId: string, env: NotionEnv): Promise<ReadRunResult | null> {
  const page = await call(`${NOTION_API}/pages/${pageId}`, env);
  const raw = extractRawPayload(await fetchPageBlocks(pageId, env));
  if (raw === null) return null;

  const brief = makeBrief(raw.brief as any);
  const research = validateResearchNotes(raw.research);
  const outline = raw.outline != null ? validateOutlineDraft(raw.outline) : null;
  const script = validateScriptDraft(raw.script);
  const broll = raw.broll != null ? validateBrollList(raw.broll) : null;
  const metadata = validateVideoMetadata(raw.metadata);

  // timeline/report are pure, deterministic arithmetic over script+brief, so
  // they're recomputed here instead of being stored redundantly in raw JSON.
  const timeline = buildTimeline(script, brief);
  const report = durationReport(timeline, brief);

  const meta = { ...((raw.meta as Record<string, unknown>) || {}) };
  meta.notion_url = page.url;

  return {
    notion_page_id: pageId,
    brief,
    research,
    outline,
    script,
    broll,
    title_options: metadata.title_options,
    tags: { tags: metadata.tags, hashtags: metadata.hashtags },
    meta,
    description: metadata.description,
    script_md: renderScriptMd(brief, script, timeline, report, research),
  };
}

export interface RunListItem {
  page_id: string;
  notion_url: string | null;
  title: unknown;
  topic: unknown;
  platform: unknown;
  model: unknown;
  duration: unknown;
  spoken_sec: unknown;
  _sort_ts: number;
}

export async function queryRuns(
  env: NotionEnv,
  pageSize = 100,
  startCursor?: string | null
): Promise<{ runs: RunListItem[]; next_cursor: string | null }> {
  const dataSourceId = env.NOTION_DATA_SOURCE_ID;
  if (!dataSourceId) return { runs: [], next_cursor: null };

  const payload: Record<string, unknown> = {
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: pageSize,
  };
  if (startCursor) payload.start_cursor = startCursor;
  const data = await call(`${NOTION_API}/data_sources/${dataSourceId}/query`, env, payload, "POST");

  const runs: RunListItem[] = (data.results || []).map((page: any) => {
    const props = page.properties || {};
    const created = page.created_time || "";
    // Notion returns UTC ISO timestamps; keep epoch, let the UI convert to a
    // display timezone.
    const stamp = Date.parse(created);
    return {
      page_id: page.id,
      notion_url: page.url ?? null,
      title: prop(props, "Video"),
      topic: prop(props, "Chủ đề"),
      platform: prop(props, "Nền tảng"),
      model: prop(props, "Model chính"),
      duration: prop(props, "Thời lượng mục tiêu (s)"),
      spoken_sec: prop(props, "Thời lượng đọc thử (s)"),
      _sort_ts: Number.isNaN(stamp) ? 0 : stamp / 1000,
    };
  });
  return { runs, next_cursor: data.has_more ? data.next_cursor : null };
}
