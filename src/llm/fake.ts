// Dry-run backend. Generates data conforming to whatever JSON Schema the request
// carries, so `dry_run: true` exercises the real schema + packaging path with
// zero API calls and zero cost.

import type { CreateParams, LlmResponse } from "./types";

function sampleFor(schema: any, key = ""): unknown {
  if (schema && Array.isArray(schema.enum)) return schema.enum[0];
  if (schema?.type === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties || {})) {
      out[k] = sampleFor(v, k);
    }
    return out;
  }
  if (schema?.type === "array") {
    const itemSchema = schema.items || { type: "string" };
    return [0, 1, 2].map(() => sampleFor(itemSchema, key));
  }
  if (schema?.type === "integer") {
    return key.includes("duration") ? 20 : 3;
  }
  if (schema?.type === "number") return 1.0;
  if (schema?.type === "boolean") return true;
  if (key.includes("url")) return "https://example.com/nguon-mau";
  return `[dry-run] nội dung mẫu cho ${key || "trường này"}`;
}

const FALLBACK_TEXT =
  "- [độ tin cậy: cao] Đây là thông tin mẫu cho chế độ chạy thử — Nguồn: https://example.com/nguon-mau\n" +
  "- [độ tin cậy: thấp] Thông tin mẫu chưa kiểm chứng — Nguồn: https://example.com/nguon-mau-2";

export async function callFake(params: CreateParams): Promise<LlmResponse> {
  const schema = params.outputConfig?.format?.schema;
  const text = schema ? JSON.stringify(sampleFor(schema)) : FALLBACK_TEXT;
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    stopDetails: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
  };
}
