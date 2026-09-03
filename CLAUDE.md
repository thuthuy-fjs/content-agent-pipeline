# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A pipeline that turns one video topic into production documents: research notes with sources, a timed script with visual cues, and publishing metadata (title/description/tags). [SPEC.md](SPEC.md) is the design doc for the full pipeline; what exists today is MVP v0.1 — Research → Script → Metadata only. B-roll Agent, a separate Outline Agent, and the outline-approval checkpoint are specced but not built.

## Commands

```bash
# Dry run — exercises the whole pipeline against a fake client, no API calls, no cost.
# Use this to verify plumbing changes; there is no test suite.
.venv/bin/python run.py --topic "bất kỳ chủ đề nào" --dry-run

# Real run. Mặc định đi qua `claude -p` (hạn mức thuê bao, không tốn credit API);
# đặt CONTENT_AGENT_USE_API=true trong .env để gọi thẳng Messages API.
.venv/bin/python run.py --topic "..." --platform tiktok --duration 45

# Dependencies (ensurepip is broken on this box, hence --without-pip + --target)
python3 -m venv --without-pip .venv
pip3 install --target .venv/lib/python3.8/site-packages -r requirements.txt
```

Always use `.venv/bin/python` — the system `python3` has no `anthropic`/`pydantic`.

## Environment constraint that shapes the code

Ubuntu 20.04 / Python 3.8, so pip can only resolve `anthropic` 0.72 (1.x needs Python ≥ 3.10). That SDK has no `messages.parse` and no `output_config` parameter. `ClaudeRunner` in [content_agent/llm.py](content_agent/llm.py) therefore inspects `messages.create`'s signature at init and routes `output_config` (structured output format + effort) through `extra_body` when the parameter isn't native. Keep new API features behind that same check rather than assuming a modern SDK.

## Architecture

`run.py` → [cli.py](content_agent/cli.py) → [pipeline.py](content_agent/pipeline.py), which calls three agents in order and writes to `output/<YYYYMMDD>/<slug>-<HHMMSS>/` — the date lives in the parent directory, the run folder carries only the time. `run_started_at()` in `web.py` therefore reconstructs a run's timestamp from parent-dir date + name suffix, falling back to the older `<slug>-<YYYYMMDD-HHMMSS>` form and then to mtime; `list_runs()` also still reads runs sitting directly under `output/`. Don't assume a fixed depth or a single naming scheme there.

`serve.py` → [web.py](content_agent/web.py) is a second, independent entry point: a stdlib-only local web UI that spawns `run.py` as a subprocess and parses its stdout into structured events. It never imports the agents, so the CLI stays the single execution path — but that also means **the stdout format is a contract**: the regexes at the top of `web.py` (`[i/n] Name...`, `  · stage: N in / M out ($X)[ · model]`, `Xong -> path`, `Dừng pipeline: ...`) must be updated together with any change to what `cli.py`/`llm.py` print. The ` · model` suffix on a usage line appears only when that stage ran a model other than `--model`.

- **Two backends.** `use_api_backend()` in [llm.py](content_agent/llm.py) reads `CONTENT_AGENT_USE_API`; unset means the default `claude -p` path. [claude_cli.py](content_agent/claude_cli.py) fakes the `client.messages.create(**params)` surface so `ClaudeRunner` needs no branching — structured output maps to `--json-schema`, web search to `--allowed-tools WebSearch`, and the response is normalized to `end_turn` (the CLI only returns after the turn completes, so `pause_turn` never reaches the runner). Anything added to `_create`'s params must be translated there too, or the CLI path silently ignores it.
- **[llm.py](content_agent/llm.py)** is the only place that talks to the API. Every agent goes through `ClaudeRunner.text()` or `.structured()`, which centralize: `pause_turn` resumption (web search is a server tool and can pause mid-turn), schema-violation retries, `refusal`/`max_tokens` handling as hard stops, and per-stage token/cost accounting.
- **[schemas.py](content_agent/schemas.py)** holds the pydantic output contracts plus `strict_json_schema()`, which inlines `$defs`/`$ref`, marks every property required, and sets `additionalProperties: false` — the API's structured-output format rejects the raw pydantic schema otherwise.
- **Per-stage models.** `ClaudeRunner.stage_models` maps a stage name to a model that overrides `model` for that call only; `model_for()` strips the `#N` retry suffix before lookup. Every model-dependent decision must go through the per-call model, not `self.model` — `supports_modern_features` (effort), `estimate_cost_usd`, and `web_search_tool()` in the research agent all do. `PIPELINE_STAGES`/`LIGHT_STAGES` in [config.py](content_agent/config.py) are the source of truth for valid stage names; the CLI's `--light-model` is sugar for `--stage-model` over `LIGHT_STAGES`.
- **[timeline.py](content_agent/timeline.py)** owns all arithmetic the model must not do: the model only emits `duration_sec` per section, and timestamps, syllable-based spoken-duration estimates, and the ±15% drift check are computed here.
- **[dotenv.py](content_agent/dotenv.py)** loads `.env` from the package `__init__` — it must run before `config`/`llm` import, since both read `os.environ` at import time. Exported vars win over the file.
- **[config.py](content_agent/config.py)** gates model-dependent features. `supports_modern_features()` decides between the two web-search tool types and whether `effort` is sent at all — older models error on `effort`, so never send it unconditionally.
- **[fake.py](content_agent/fake.py)** generates responses from whatever JSON Schema the request carries, which is what makes `--dry-run` a real check of the schema and packaging path.

- **Notion (optional).** [notion_publish.py](content_agent/notion_publish.py) pushes one page per real run into a Notion data source, gated by `notion_publish.is_configured()` (`NOTION_TOKEN` + `NOTION_DATA_SOURCE_ID` both set) — called from `pipeline.py` right before `run_meta.json` is written, so a successful push's URL lands in `summary["notion_url"]` and persists to disk with everything else. Skipped for `--dry-run` via the same `runner.backend == "dry-run"` signal `llm.py` already sets; failures are caught into `warnings`, never raised past `run_pipeline()` — Notion is a copy, not a source of truth, so it must never take down a run that already wrote local output. `cli.py` prints the URL as `  Notion: <url>` only when present; `web.py`'s `NOTION_RE` regex is part of the same stdout contract as the other prefixes.

Prompts live next to their agent in [content_agent/agents/](content_agent/agents/) and are written in Vietnamese, matching the default output language.
