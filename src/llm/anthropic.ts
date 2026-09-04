// Anthropic Messages API backend, called directly over fetch() rather than
// through an SDK. output_config (structured output format + effort) is sent as a
// top-level body field.

import type { ContentBlock, CreateParams, LlmResponse, ProviderSecrets } from "./types";
import { providerError } from "./errors";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export async function callAnthropic(params: CreateParams, secrets: ProviderSecrets): Promise<LlmResponse> {
  const apiKey = secrets.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw providerError("Anthropic: thiếu ANTHROPIC_API_KEY.");
  }

  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: params.messages,
  };
  if (params.tools && params.tools.length) body.tools = params.tools;
  if (params.outputConfig) body.output_config = params.outputConfig;

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
  if (secrets.ANTHROPIC_WORKSPACE_ID) {
    headers["anthropic-workspace-id"] = secrets.ANTHROPIC_WORKSPACE_ID;
  }

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: params.signal,
    });
  } catch (exc) {
    throw providerError(`Anthropic: không kết nối được tới API: ${(exc as Error).message}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 401) {
      throw providerError("Anthropic: xác thực thất bại, kiểm tra ANTHROPIC_API_KEY.");
    }
    if (res.status === 404) {
      throw providerError(`Anthropic: model không tồn tại: ${params.model}`);
    }
    if (res.status === 429) {
      throw providerError("Anthropic: rate limit.");
    }
    throw providerError(`Anthropic: HTTP ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    content: ContentBlock[];
    stop_reason: string;
    stop_details?: { category?: string } | null;
    usage: { input_tokens?: number; output_tokens?: number };
  };

  return {
    content: data.content || [],
    stopReason: data.stop_reason,
    stopDetails: data.stop_details ?? null,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      costUsd: null,
    },
  };
}
