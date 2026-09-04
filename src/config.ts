// Shared constants: model gating, pricing, platform hints, speech rate.

export const DEFAULT_MAX_TOKENS = 16000;

// Bon luot goi model cua pipeline, dung thu tu chay.
export const PIPELINE_STAGES = ["research.search", "research.structure", "script", "metadata"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// Hai buoc chi bien doi du lieu co san (ghi chu -> JSON, kich ban -> title/tag),
// khong can suy luan sau nen ha model duoc ma chat luong gan nhu khong doi.
export const LIGHT_STAGES: PipelineStage[] = ["research.structure", "metadata"];

// Cac model ho tro web search ban dynamic-filtering va output_config.effort.
export const MODERN_MODELS = new Set([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
]);

// Moi loi goi API ben thu ba (Anthropic/OpenAI/Gemini/Notion) chi hien dung cau
// nay cho nguoi dung; chi tiet that di ra console.error (wrangler tail) de debug.
export const PROVIDER_UNAVAILABLE = "Hệ thống hiện không khả dụng. Vui lòng thử lại sau.";

export const MODERN_WEB_SEARCH_TYPE = "web_search_20260209";
export const BASIC_WEB_SEARCH_TYPE = "web_search_20250305";

// USD / 1 trieu token (input, output).
export const PRICING_USD_PER_MTOK: Record<string, [number, number]> = {
  // Claude
  "claude-fable-5-1": [10.0, 50.0],
  "claude-fable-5": [10.0, 50.0],
  "claude-opus-5": [5.0, 25.0],
  "claude-opus-4-8": [5.0, 25.0],
  "claude-opus-4-7": [5.0, 25.0],
  "claude-opus-4-6": [5.0, 25.0],
  "claude-sonnet-5": [2.0, 10.0],
  "claude-sonnet-4-6": [3.0, 15.0],
  "claude-haiku-4-5": [1.0, 5.0],

  // ChatGPT
  "gpt-5.6-sol": [15.0, 75.0],
  "gpt-5.6-terra": [5.0, 25.0],
  "gpt-5.6-luna": [1.0, 5.0],
  "gpt-5.5-pro": [10.0, 30.0],
  "gpt-5.5": [2.5, 12.5],
  "gpt-5.4-pro": [5.0, 15.0],
  "gpt-5.4": [1.0, 5.0],

  // Gemini
  "gemini-3.6-flash-high": [1.5, 7.5],
  "gemini-3.6-flash-medium": [1.0, 5.0],
  "gemini-3.6-flash-low": [0.5, 2.5],
  "gemini-3.1-pro-high": [5.0, 20.0],
  "gemini-3.1-pro-low": [2.0, 10.0],
};

export type ModelOption = { value: string; label: string };

export const PLATFORM_MODELS: Record<string, ModelOption[]> = {
  claude: [
    { value: "claude-opus-5", label: "Claude Opus 5" },
    { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    { value: "claude-fable-5-1", label: "Claude Fable 5.1" },
  ],
  chatgpt: [
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { value: "gpt-5.5-pro", label: "GPT 5.5 Pro" },
    { value: "gpt-5.5", label: "GPT 5.5" },
    { value: "gpt-5.4-pro", label: "GPT 5.4 Pro" },
    { value: "gpt-5.4", label: "GPT 5.4" },
  ],
  gemini: [
    { value: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
    { value: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
    { value: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
    { value: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
    { value: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  ],
};

// Toc do noi trung binh (am tiet/giay) dung de uoc luong thoi luong tu loi thoai.
export const SPEECH_RATE_PER_SEC: Record<string, number> = { vi: 2.5, en: 2.6 };
export const DEFAULT_SPEECH_RATE = 2.5;

// Nguong canh bao (SPEC.md §7).
export const MAX_DURATION_DRIFT_PCT = 15.0;
export const MAX_LOW_CONFIDENCE_RATIO = 0.3;

export const PLATFORM_HINTS: Record<string, string> = {
  youtube_shorts:
    "Video dọc dưới 60 giây. Hook phải nằm trong 2 giây đầu. " +
    "Title ưu tiên gây tò mò, description ngắn kèm 3-5 hashtag.",
  youtube_long:
    "Video ngang dài. Title ưu tiên SEO (từ khoá đứng đầu), " +
    "description dài có tóm tắt và mốc thời gian chương.",
  tiktok:
    "Video dọc, nhịp nhanh, giọng nói đời thường. " +
    "Caption ngắn dưới 150 ký tự, hashtag đặt cuối.",
  reels:
    "Video dọc, hình ảnh bắt mắt, lời thoại cô đọng. " +
    "Caption ngắn, có 1 câu hỏi để kéo bình luận.",
};

export const PLATFORMS = Object.keys(PLATFORM_HINTS);

export function supportsModernFeatures(model: string): boolean {
  return MODERN_MODELS.has(model);
}

export function webSearchTool(model: string, maxUses = 8): { type: string; name: string; max_uses: number } {
  const toolType = supportsModernFeatures(model) ? MODERN_WEB_SEARCH_TYPE : BASIC_WEB_SEARCH_TYPE;
  return { type: toolType, name: "web_search", max_uses: maxUses };
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICING_USD_PER_MTOK[model];
  if (!price) return null;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}

export function speechRate(language: string): number {
  return SPEECH_RATE_PER_SEC[language] ?? DEFAULT_SPEECH_RATE;
}

export function defaultModel(env: { CONTENT_AGENT_MODEL?: string }): string {
  return env.CONTENT_AGENT_MODEL || "claude-opus-5";
}
