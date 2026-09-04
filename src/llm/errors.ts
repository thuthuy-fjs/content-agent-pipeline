// Every third-party failure funnels through here. The real detail goes to
// console.error with a "[provider] " prefix (visible via `wrangler tail`); the
// exception surfaced to the rest of the app — and eventually the browser — is
// always the same generic message.
//
// Bật SHOW_PROVIDER_ERRORS thì `detail` cũng được đổ thêm vào log thô của lần
// chạy (xem pipeline.ts); `message` vẫn luôn là câu chung chung, nên khung báo
// lỗi đỏ và trường `error` trong KV không đổi.

import { PROVIDER_UNAVAILABLE } from "../config";

// Cắt bớt để một body lỗi dài ngoằng không phình event log trong KV.
const MAX_DETAIL_CHARS = 4000;

export class ProviderError extends Error {
  /** Nguyên văn lỗi nhà cung cấp, đã che secret. Chỉ hiện khi bật cờ debug. */
  readonly detail: string;

  constructor(detail: string) {
    super(PROVIDER_UNAVAILABLE);
    this.detail = detail;
  }
}

/* Body lỗi và message của fetch đôi khi kèm luôn URL có `?key=…` (Gemini) hoặc
   header Authorization. Che trước khi cho ra khỏi Worker — log thô nằm trong
   /api/status nên ai có link run là đọc được. */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&](?:key|api_key|access_token)=)[^&\s"']+/gi, "$1***")
    .replace(/\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, "$1***")
    .replace(/\b(AIza[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, "$1***")
    .replace(/\b((?:ntn|secret)_[A-Za-z0-9]{4})[A-Za-z0-9]+/g, "$1***");
}

/* Chắc ăn hơn regex: xoá thẳng giá trị secret đang dùng ra khỏi chuỗi. Định dạng
   key đổi theo từng nhà cung cấp (Gemini có cả "AIza…" lẫn "AQ.Ab8…"), khớp mẫu
   không thể theo kịp, nhưng giá trị thật thì luôn nằm sẵn trong env. */
const SECRET_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "NOTION_TOKEN",
  "ANTHROPIC_WORKSPACE_ID",
] as const;

export function stripSecretValues(text: string, env: Record<string, unknown>): string {
  let out = text;
  for (const name of SECRET_VARS) {
    const value = env[name];
    // Chỉ xoá giá trị đủ dài — biến ngắn như "true" mà thay hết thì log thành rác.
    if (typeof value === "string" && value.length >= 8) out = out.split(value).join("***");
  }
  return out;
}

export function clampDetail(text: string): string {
  const clean = redactSecrets(text.trim());
  return clean.length > MAX_DETAIL_CHARS
    ? clean.slice(0, MAX_DETAIL_CHARS) + `\n… (cắt bớt, còn ${clean.length - MAX_DETAIL_CHARS} ký tự — xem wrangler tail)`
    : clean;
}

export function providerError(detail: string): ProviderError {
  console.error(`[provider] ${detail}`);
  return new ProviderError(clampDetail(detail));
}
