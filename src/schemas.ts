// Output contracts for each agent stage.
//
// The JSON Schemas below are hand-written and must stay strict: every $ref
// inlined, every object carrying additionalProperties:false and required =
// every property key. Structured output rejects anything looser. They are
// deliberately not generated from the validators (or via a zod-to-json-schema
// library) — there are only five small models, and hand-writing both keeps the
// exact shape sent to the API under our control. Change one, change the other.

export type Confidence = "high" | "medium" | "low";

export interface Fact {
  claim: string;
  source_url: string;
  confidence: Confidence;
}

export interface ResearchNotes {
  topic_summary: string;
  facts: Fact[];
  angle_suggestions: string[];
  hook_ideas: string[];
  open_questions: string[];
}

export function lowConfidenceRatio(research: ResearchNotes): number {
  if (!research.facts.length) return 1.0;
  const low = research.facts.filter((f) => f.confidence === "low").length;
  return low / research.facts.length;
}

export interface ScriptSection {
  name: string;
  goal: string;
  duration_sec: number;
  narration: string;
  visual_cue: string;
}

export interface ScriptDraft {
  working_title: string;
  sections: ScriptSection[];
}

export interface VideoMetadata {
  title_options: string[];
  description: string;
  tags: string[];
  hashtags: string[];
}

const FACT_SCHEMA = {
  type: "object",
  properties: {
    claim: { type: "string" },
    source_url: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["claim", "source_url", "confidence"],
  additionalProperties: false,
};

export const RESEARCH_NOTES_SCHEMA = {
  type: "object",
  properties: {
    topic_summary: { type: "string" },
    facts: { type: "array", items: FACT_SCHEMA },
    angle_suggestions: { type: "array", items: { type: "string" } },
    hook_ideas: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
  },
  required: ["topic_summary", "facts", "angle_suggestions", "hook_ideas", "open_questions"],
  additionalProperties: false,
};

const SCRIPT_SECTION_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    goal: { type: "string" },
    duration_sec: { type: "integer" },
    narration: { type: "string" },
    visual_cue: { type: "string" },
  },
  required: ["name", "goal", "duration_sec", "narration", "visual_cue"],
  additionalProperties: false,
};

export const SCRIPT_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    working_title: { type: "string" },
    sections: { type: "array", items: SCRIPT_SECTION_SCHEMA },
  },
  required: ["working_title", "sections"],
  additionalProperties: false,
};

export const VIDEO_METADATA_SCHEMA = {
  type: "object",
  properties: {
    title_options: { type: "array", items: { type: "string" } },
    description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    hashtags: { type: "array", items: { type: "string" } },
  },
  required: ["title_options", "description", "tags", "hashtags"],
  additionalProperties: false,
};

// ---------- runtime validation ----------

export class SchemaValidationError extends Error {}

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}
function fail(msg: string): never {
  throw new SchemaValidationError(msg);
}

export function validateResearchNotes(data: unknown): ResearchNotes {
  if (typeof data !== "object" || data === null) fail("research notes: not an object");
  const d = data as Record<string, unknown>;
  if (!isString(d.topic_summary)) fail("research notes: topic_summary must be a string");
  if (!Array.isArray(d.facts)) fail("research notes: facts must be an array");
  const facts: Fact[] = d.facts.map((f, i) => {
    if (typeof f !== "object" || f === null) fail(`research notes: facts[${i}] not an object`);
    const fo = f as Record<string, unknown>;
    if (!isString(fo.claim)) fail(`research notes: facts[${i}].claim must be a string`);
    if (!isString(fo.source_url)) fail(`research notes: facts[${i}].source_url must be a string`);
    if (fo.confidence !== "high" && fo.confidence !== "medium" && fo.confidence !== "low") {
      fail(`research notes: facts[${i}].confidence must be high|medium|low`);
    }
    return { claim: fo.claim, source_url: fo.source_url, confidence: fo.confidence };
  });
  if (!isStringArray(d.angle_suggestions)) fail("research notes: angle_suggestions must be string[]");
  if (!isStringArray(d.hook_ideas)) fail("research notes: hook_ideas must be string[]");
  if (!isStringArray(d.open_questions)) fail("research notes: open_questions must be string[]");
  return {
    topic_summary: d.topic_summary,
    facts,
    angle_suggestions: d.angle_suggestions,
    hook_ideas: d.hook_ideas,
    open_questions: d.open_questions,
  };
}

export function validateScriptDraft(data: unknown): ScriptDraft {
  if (typeof data !== "object" || data === null) fail("script draft: not an object");
  const d = data as Record<string, unknown>;
  if (!isString(d.working_title)) fail("script draft: working_title must be a string");
  if (!Array.isArray(d.sections)) fail("script draft: sections must be an array");
  const sections: ScriptSection[] = d.sections.map((s, i) => {
    if (typeof s !== "object" || s === null) fail(`script draft: sections[${i}] not an object`);
    const so = s as Record<string, unknown>;
    if (!isString(so.name)) fail(`script draft: sections[${i}].name must be a string`);
    if (!isString(so.goal)) fail(`script draft: sections[${i}].goal must be a string`);
    if (typeof so.duration_sec !== "number" || !Number.isFinite(so.duration_sec)) {
      fail(`script draft: sections[${i}].duration_sec must be a number`);
    }
    if (!isString(so.narration)) fail(`script draft: sections[${i}].narration must be a string`);
    if (!isString(so.visual_cue)) fail(`script draft: sections[${i}].visual_cue must be a string`);
    return {
      name: so.name,
      goal: so.goal,
      duration_sec: so.duration_sec,
      narration: so.narration,
      visual_cue: so.visual_cue,
    };
  });
  return { working_title: d.working_title, sections };
}

export function validateVideoMetadata(data: unknown): VideoMetadata {
  if (typeof data !== "object" || data === null) fail("video metadata: not an object");
  const d = data as Record<string, unknown>;
  if (!isString(d.description)) fail("video metadata: description must be a string");
  if (!isStringArray(d.title_options)) fail("video metadata: title_options must be string[]");
  if (!isStringArray(d.tags)) fail("video metadata: tags must be string[]");
  if (!isStringArray(d.hashtags)) fail("video metadata: hashtags must be string[]");
  return {
    title_options: d.title_options,
    description: d.description,
    tags: d.tags,
    hashtags: d.hashtags,
  };
}
