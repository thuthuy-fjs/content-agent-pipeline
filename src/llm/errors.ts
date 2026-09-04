// Every third-party failure funnels through here. The real detail goes to
// console.error with a "[provider] " prefix (visible via `wrangler tail`); the
// exception surfaced to the rest of the app — and eventually the browser — is
// always the same generic message.

import { PROVIDER_UNAVAILABLE } from "../config";

export class ProviderError extends Error {}

export function providerError(detail: string): ProviderError {
  console.error(`[provider] ${detail}`);
  return new ProviderError(PROVIDER_UNAVAILABLE);
}
