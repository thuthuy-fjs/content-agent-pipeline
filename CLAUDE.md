# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker (TypeScript) that turns one video topic into production documents:
research notes with sources, a timed script with visual cues, and publishing metadata
(title/description/tags). [SPEC.md](SPEC.md) is the design doc for the full pipeline;
what exists today is MVP v0.1 — Research → Script → Metadata only. B-roll Agent, a
separate Outline Agent, and the outline-approval checkpoint are specced but not built.

The repo used to be a Python CLI + stdlib web server; that was fully replaced by this
port. Nothing Python remains, and the CLI entry point is gone — the HTTP API is the
only way in.

## Commands

```bash
# Local dev. MUST go through Docker on this box — see the constraint below.
docker compose up                                # → http://localhost:8787

# Deploy (runs natively on the host, no Docker needed)
npm run deploy
npx wrangler tail        # logs, including the "[provider] " detail lines

npm run typecheck        # tsc --noEmit; there is no test suite
npx wrangler deploy --dry-run --outdir=/tmp/out   # verify the bundle builds
```

To exercise the whole pipeline with no API cost, tick **"Chạy thử"** in the UI (or
POST `/api/run` with `dry_run: true`) — it routes every model call through
[src/llm/fake.ts](src/llm/fake.ts), which generates data from whatever JSON Schema the
request carries, so it's a real check of the schema and packaging path.

## Environment constraint that shapes local dev

This box is Ubuntu 20.04 (glibc 2.31), but `workerd` — the runtime behind
`wrangler dev` — needs glibc ≥ 2.35. So **`npm run dev` cannot run directly here**;
`docker-compose.yml` runs the same command inside `node:20-bookworm` (glibc 2.36),
with `node_modules` and the npm cache in named volumes so the host's copies aren't
shadowed. `--remote` does not sidestep this on wrangler 3.x — it still spawns a local
`workerd` proxy. `wrangler deploy` is unaffected (esbuild bundle + upload only).

## Architecture

`public/index.html` (vanilla DOM, no build step) → [src/worker.ts](src/worker.ts)
(routing + static assets via the `ASSETS` binding) → `src/routes/*` →
[src/pipeline.ts](src/pipeline.ts), which calls three agents in order and pushes the
result to Notion.

- **Run state lives in Workers KV, not process memory.** A Worker keeps nothing between
  requests, so `POST /api/run` writes a `run:{id}` record and kicks the pipeline off via
  `ctx.waitUntil()`; the browser polls `/api/status?id&since` every 700ms.
  [src/kv-store.ts](src/kv-store.ts) owns that record. Per-key `metadata` carries the
  fields `/api/active` needs, so listing active runs costs a `list()` and no reads.
  Budget roughly 10-15 KV writes per run (one per event) — that's what keeps this inside
  the free tier, so don't add per-token writes.
- **Workers KV rejects `expirationTtl` below 60 seconds.** The history cache TTL is
  pinned at 60 for exactly this reason; anything lower is a 400 at runtime, not a
  compile error.
- **Lỗi bên thứ ba chỉ có một câu.** Every failure calling Anthropic/OpenAI/Gemini/Notion
  goes through `providerError()` in [src/llm/errors.ts](src/llm/errors.ts): the real
  detail goes to `console.error` with a `[provider] ` prefix (visible in `wrangler tail`),
  while `ProviderError` only ever carries `PROVIDER_UNAVAILABLE` from
  [src/config.ts](src/config.ts). `pipeline.ts`'s outer catch re-sanitizes anything that
  is *not* a `ProviderError` before it reaches KV — never let a raw exception message
  reach the client.
- **One backend per platform.** `LLMRunner.platform` picks it: `claude` hits the
  Anthropic Messages API, `chatgpt`/`gemini` hand-roll their own request shapes in
  `src/llm/openai.ts` / `src/llm/gemini.ts` and normalize the reply into the same
  `LlmResponse`. Anything added to `create()`'s params must be translated in those two
  too, or the non-Claude platforms silently ignore it.
- **[src/llm/runner.ts](src/llm/runner.ts)** is the only place that talks to a model.
  Every agent goes through `.text()` or `.structured()`, which centralize: `pause_turn`
  resumption (web search is a server tool and can pause mid-turn, max 5 restarts),
  schema-violation retries (2, feeding the bad output plus the error back into the
  conversation), `refusal`/`max_tokens` as hard stops, the best-effort stop check, and
  per-stage token/cost accounting.
- **[src/schemas.ts](src/schemas.ts)** holds hand-written JSON Schemas *and* hand-written
  runtime validators — deliberately not generated from each other. The schemas must stay
  strict (every `$ref` inlined, `required` listing every property, `additionalProperties:
  false`) or structured output rejects them; the validators must stay in sync by hand when
  a field changes.
- **Per-stage models.** `LLMRunner.stageModels` maps a stage name to a model that
  overrides `model` for that call only; `modelFor()` strips the `#N` retry suffix before
  lookup. Every model-dependent decision must go through the per-call model, not
  `this.model` — `supportsModernFeatures` (effort), `estimateCostUsd`, and `webSearchTool()`
  in the research agent all do. `PIPELINE_STAGES`/`LIGHT_STAGES` in `src/config.ts` are
  the source of truth for valid stage names.
- **[src/timeline.ts](src/timeline.ts)** owns all arithmetic the model must not do: the
  model only emits `duration_sec` per section, and timestamps, syllable-based
  spoken-duration estimates, and the ±15% drift check are computed here. `countSyllables`
  must use a Unicode-aware alnum test (`\p{L}\p{N}`) or Vietnamese diacritics undercount.
- **Notion is the only store.** [src/notion.ts](src/notion.ts) does both directions.
  Writing: one page per real run, whose blocks are a one-way human-readable rendering
  *plus* a `code` block holding the run's raw JSON. Reading: `readRun()` parses that JSON
  block — never the pretty blocks, which lose data (confidence becomes a text colour,
  timestamps become headings) and break the moment someone edits the page by hand. When
  the 100-block ceiling is hit, pretty blocks are dropped first; the raw JSON block is
  never sacrificed. `timeline`/`duration_report`/`script_md` are recomputed from
  `script`+`brief` on read rather than stored, since they're deterministic.
- **A failed Notion push is fatal.** With no local copy to fall back on, `pipeline.ts`
  dumps the full raw JSON into the run's event log before failing — last-resort recovery
  for a run that already spent quota. Unlike the Python original this is unconditional;
  a Worker has no terminal to fall back to. Don't "simplify" that dump away.
- **`STEP_PLAN` in `public/index.html` is coupled to the step names `pipeline.ts` emits**
  (`"Research"`, `"Script"`, `"Metadata"`). Change one, change both.

## Secrets

Two separate stores, and confusing them is the most common failure:

- Local `wrangler dev` reads `.dev.vars` (gitignored; template at `.dev.vars.example`).
- The deployed Worker reads secrets set via `wrangler secret put`.

Setting one does nothing for the other. `env` is passed into the fetch handler, so there
is no import-order concern like the old Python `dotenv` module had — but `DEFAULT_MODEL`
is therefore a function (`defaultModel(env)`), not a module constant.

Agent prompts live next to their agent in [src/agents/](src/agents/) and are written in
Vietnamese, matching the default output language.
