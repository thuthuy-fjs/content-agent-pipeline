// Gemini generateContent backend.

import type { ContentBlock, CreateParams, LlmMessage, LlmResponse, ProviderSecrets } from "./types";
import { providerError } from "./errors";

function firstTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return String(content);
}

// Gemini's responseSchema doesn't support additionalProperties.
function removeAdditionalProperties(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(removeAdditionalProperties);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "additionalProperties") continue;
      out[k] = removeAdditionalProperties(v);
    }
    return out;
  }
  return node;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callGemini(params: CreateParams, secrets: ProviderSecrets): Promise<LlmResponse> {
  const apiKey = secrets.GEMINI_API_KEY;
  if (!apiKey) throw providerError("Gemini: thiếu GEMINI_API_KEY");

  const contents = (params.messages as LlmMessage[]).map((msg) => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: firstTextFromContent(msg.content) }],
  }));

  const generationConfig: Record<string, unknown> = { maxOutputTokens: params.maxTokens || 8000 };
  const payload: Record<string, unknown> = { contents, generationConfig };
  if (params.system) {
    payload.systemInstruction = { parts: [{ text: params.system }] };
  }

  const schema = params.outputConfig?.format?.schema;
  if (schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = removeAdditionalProperties(schema);
  }

  // Model path Gemini actually serves, minus the UI-facing effort-tier suffix.
  const modelStr = params.model.replace("-high", "").replace("-medium", "").replace("-low", "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelStr}:generateContent?key=${apiKey}`;

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: params.signal,
      });
    } catch (exc) {
      throw providerError(`Gemini: không kết nối được: ${(exc as Error).message}`);
    }

    if (!res.ok) {
      if ((res.status === 429 || res.status === 503) && attempt < maxRetries - 1) {
        await sleep(2 ** attempt * 1000);
        if (params.signal?.aborted) throw providerError(`Gemini: request bị huỷ.`);
        continue;
      }
      const err = await res.text().catch(() => "");
      throw providerError(`Gemini: HTTP ${res.status}: ${err}`);
    }

    try {
      const data: any = await res.json();
      const text: string = data.candidates[0].content.parts[0].text;
      const usage = data.usageMetadata || {};
      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        usage: {
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
          costUsd: null,
        },
      };
    } catch (exc) {
      throw providerError(`Gemini: response không đúng định dạng: ${(exc as Error).message}`);
    }
  }
  throw providerError("Gemini: hết lượt retry.");
}
