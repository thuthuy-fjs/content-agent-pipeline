// Shared shapes between the provider clients (anthropic/openai/gemini/fake) and
// the runner. Every backend normalizes its reply into LlmResponse so runner.ts
// can treat them identically.

export type ContentBlock = { type: string; text?: string; [key: string]: unknown };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface StopDetails {
  category?: string;
  [key: string]: unknown;
}

export type StopReason = "end_turn" | "refusal" | "max_tokens" | "pause_turn" | string;

export interface LlmResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  stopDetails?: StopDetails | null;
  usage: LlmUsage;
}

export interface OutputConfig {
  format: { type: "json_schema"; schema: Record<string, unknown> };
  effort?: string;
}

export interface CreateParams {
  model: string;
  maxTokens: number;
  system: string;
  messages: LlmMessage[];
  tools?: { type: string; name: string; max_uses: number }[];
  outputConfig?: OutputConfig;
  /** Cắt request đang bay: người dùng bấm Dừng, hoặc chạm timeout của runner. */
  signal?: AbortSignal;
}

export interface ProviderSecrets {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_WORKSPACE_ID?: string;
}
