// OpenAI chat-completions backend.

import type { ContentBlock, CreateParams, LlmMessage, LlmResponse, ProviderSecrets } from "./types";
import { providerError } from "./errors";

function firstTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return String(content);
}

function toChatMessages(params: CreateParams): { role: string; content: string }[] {
  const messages: { role: string; content: string }[] = [];
  if (params.system) messages.push({ role: "system", content: params.system });
  for (const msg of params.messages as LlmMessage[]) {
    messages.push({ role: msg.role, content: firstTextFromContent(msg.content) });
  }
  return messages;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callOpenAI(params: CreateParams, secrets: ProviderSecrets): Promise<LlmResponse> {
  const apiKey = secrets.OPENAI_API_KEY;
  if (!apiKey) throw providerError("OpenAI: thiếu OPENAI_API_KEY");

  const payload: Record<string, unknown> = {
    model: params.model,
    messages: toChatMessages(params),
    max_tokens: params.maxTokens || 4000,
  };
  const schema = params.outputConfig?.format?.schema;
  if (schema) {
    payload.response_format = {
      type: "json_schema",
      json_schema: { name: "structured_output", schema, strict: true },
    };
  }

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: params.signal,
      });
    } catch (exc) {
      throw providerError(`OpenAI: không kết nối được: ${(exc as Error).message}`);
    }

    if (!res.ok) {
      if ((res.status === 429 || res.status === 503) && attempt < maxRetries - 1) {
        await sleep(2 ** attempt * 1000);
        if (params.signal?.aborted) throw providerError(`OpenAI: request bị huỷ.`);
        continue;
      }
      const err = await res.text().catch(() => "");
      throw providerError(`OpenAI: HTTP ${res.status}: ${err}`);
    }

    let data: any;
    try {
      data = await res.json();
      const choice = data.choices[0];
      const text: string = choice.message.content || "";
      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          costUsd: null,
        },
      };
    } catch (exc) {
      throw providerError(`OpenAI: response không đúng định dạng: ${(exc as Error).message}`);
    }
  }
  throw providerError("OpenAI: hết lượt retry.");
}
