// Orchestration: Research -> Script -> Metadata -> Notion (SPEC.md §3, §4).
//
// Started by POST /api/run via ctx.waitUntil(), so it keeps running after that
// request returns; progress is written into the run's KV event log, which is
// what GET /api/status serves.

import { runMetadata } from "./agents/metadata";
import { runResearch } from "./agents/research";
import { runScript } from "./agents/script";
import type { VideoBrief } from "./brief";
import { MAX_LOW_CONFIDENCE_RATIO, PROVIDER_UNAVAILABLE } from "./config";
import type { PipelineEvent } from "./events";
import { getRun, updateRun, type RunRecord } from "./kv-store";
import { ProviderError } from "./llm/errors";
import { LLMRunner, StoppedError, type LlmPlatform } from "./llm/runner";
import { NotionPublishError, publishRun, readRun, type NotionEnv, type RunSummary } from "./notion";
import { lowConfidenceRatio, type ResearchNotes } from "./schemas";
import { buildTimeline, durationReport } from "./timeline";

export interface PipelineOptions {
  llmPlatform: LlmPlatform;
  model: string;
  stageModels: Record<string, string>;
  maxTokens: number;
  dryRun: boolean;
}

export interface PipelineEnv extends NotionEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_WORKSPACE_ID?: string;
}

function factCheckWarnings(research: ResearchNotes): string[] {
  const warnings: string[] = [];
  const ratio = lowConfidenceRatio(research);
  if (ratio > MAX_LOW_CONFIDENCE_RATIO) {
    warnings.push(
      `${Math.round(ratio * 100)}% thông tin nghiên cứu có độ tin cậy thấp ` +
        `(ngưỡng ${Math.round(MAX_LOW_CONFIDENCE_RATIO * 100)}%). Nên kiểm tra lại trước khi quay.`
    );
  }
  const missing = research.facts.filter((f) => !f.source_url);
  if (missing.length) warnings.push(`${missing.length} thông tin không có URL nguồn.`);
  return warnings;
}

export async function runPipeline(
  kv: KVNamespace,
  runId: string,
  brief: VideoBrief,
  opts: PipelineOptions,
  env: PipelineEnv
): Promise<void> {
  const emit = async (event: PipelineEvent) => {
    await updateRun(kv, runId, (r: RunRecord) => r.events.push(event));
  };
  const shouldStop = async () => {
    const record = await getRun(kv, runId);
    return Boolean(record?.stopRequested);
  };

  const runner = new LLMRunner({
    platform: opts.llmPlatform,
    model: opts.model,
    maxTokens: opts.maxTokens,
    verbose: true,
    stageModels: opts.stageModels,
    isDryRun: opts.dryRun,
    secrets: env,
    onEvent: emit,
    shouldStop,
  });

  try {
    const warnings: string[] = [];

    await emit({ type: "step", index: 1, total: 3, name: "Research" });
    const research = await runResearch(runner, brief);
    warnings.push(...factCheckWarnings(research));

    await emit({ type: "step", index: 2, total: 3, name: "Script" });
    const script = await runScript(runner, brief, research);
    const timeline = buildTimeline(script, brief);
    const report = durationReport(timeline, brief);
    if (!report.within_tolerance) {
      warnings.push(
        `Thời lượng đọc thử ${report.spoken_estimate_sec}s lệch ` +
          `${report.drift_pct >= 0 ? "+" : ""}${report.drift_pct.toFixed(1)}% so với mục tiêu ${report.target_sec}s.`
      );
    }

    await emit({ type: "step", index: 3, total: 3, name: "Metadata" });
    const metadata = await runMetadata(runner, brief, script, timeline);

    const summary: RunSummary = {
      working_title: script.working_title,
      sections: timeline.length,
      facts: research.facts.length,
      duration: report,
      warnings,
      usage: runner.usageSummary(),
    };

    for (const w of warnings) await emit({ type: "warning", message: w });

    if (opts.dryRun) {
      await updateRun(kv, runId, (r) => {
        r.status = "done";
      });
      return;
    }

    let page: { id: string; url: string };
    try {
      page = await publishRun(brief, research, script, timeline, metadata, summary, env);
    } catch (exc) {
      if (exc instanceof NotionPublishError) {
        // No local copy to fall back to — dump the full raw JSON into the event
        // log before failing, as a last-resort recovery for quota already spent.
        // A Worker has no terminal to fall back to, so the KV event log is the
        // only place this could ever be recovered from.
        const rawDump = JSON.stringify({
          brief,
          research,
          script,
          metadata,
          meta: summary,
        });
        await emit({ type: "log", message: "=== NOTION LỖI — JSON GỐC ĐỔ RA ĐÂY ĐỂ BẠN COPY LẠI ===" });
        await emit({ type: "log", message: rawDump });
        await emit({ type: "log", message: "=== HẾT JSON GỐC ===" });
        console.error(`[provider] Notion: không lưu được: ${exc.message}`);
        await updateRun(kv, runId, (r) => {
          r.status = "error";
          r.error = PROVIDER_UNAVAILABLE;
        });
        await emit({ type: "error", message: PROVIDER_UNAVAILABLE });
        return;
      }
      throw exc;
    }

    let result = null;
    try {
      result = await readRun(page.id, env);
    } catch (exc) {
      console.error(`[provider] Notion: đọc lại thất bại: ${(exc as Error).message}`);
    }

    await emit({ type: "notion", url: page.url });
    await updateRun(kv, runId, (r) => {
      r.status = "done";
      r.notion_url = page.url;
      r.result = result;
    });
  } catch (exc) {
    if (exc instanceof StoppedError) {
      await updateRun(kv, runId, (r) => {
        r.status = "stopped";
        r.error = "Đã dừng theo yêu cầu.";
      });
      return;
    }
    // ProviderError's message is already the sanitized generic string (see
    // providerError()); anything else is a genuine bug — log the detail
    // server-side and never let its raw message reach KV/the client.
    if (!(exc instanceof ProviderError)) {
      console.error("[provider] unexpected pipeline error:", exc);
    }
    const message = exc instanceof ProviderError ? exc.message : PROVIDER_UNAVAILABLE;
    await updateRun(kv, runId, (r) => {
      r.status = "error";
      r.error = message;
    });
    await emit({ type: "error", message });
  }
}
