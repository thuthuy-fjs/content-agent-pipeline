// Orchestration: Research -> Outline -> [checkpoint] -> Script -> (B-roll ‖
// Metadata) -> Notion (SPEC.md §3, §4).
//
// Two entry points, not one continuous run, because of the checkpoint: a human
// approval can take minutes to hours, and a Worker cannot hold a ctx.waitUntil()
// open that long.
//   - runPipeline()     Phase A. Started by POST /api/run. Research -> Outline,
//                        then STOPS: writes outline + resume state into KV,
//                        status -> "awaiting_outline", and returns.
//   - continuePipeline() Phase B. Started by POST /api/outline {action:"approve"}
//                        from a fresh ctx.waitUntil(). Reads Phase A's leftover
//                        state back out of KV (no params carried across) and
//                        runs Script -> B-roll ‖ Metadata -> Notion.
//   - regenerateOutline() Phase A'. POST /api/outline {action:"regenerate"} —
//                        re-runs just the Outline Agent with feedback, stays in
//                        "awaiting_outline".
// All three share the same event-log/finalize/error-handling scaffold below.

import { runBroll } from "./agents/broll";
import { runMetadata } from "./agents/metadata";
import { runOutline } from "./agents/outline";
import { runResearch } from "./agents/research";
import { runScript } from "./agents/script";
import type { VideoBrief } from "./brief";
import { MAX_LOW_CONFIDENCE_RATIO, PROVIDER_UNAVAILABLE, showProviderErrors } from "./config";
import type { PipelineEvent } from "./events";
import { STOP_MESSAGE, getRun, isStopRequested, updateRun, type RunRecord } from "./kv-store";
import { ProviderError, clampDetail, stripSecretValues } from "./llm/errors";
import { LLMRunner, StoppedError, type LlmPlatform } from "./llm/runner";
import { NotionPublishError, publishRun, readRun, type NotionEnv, type RunSummary } from "./notion";
import { lowConfidenceRatio, type OutlineDraft, type ResearchNotes } from "./schemas";
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
  SHOW_PROVIDER_ERRORS?: string;
}

const TOTAL_STEPS = 4; // Research, Outline, Script, "Hoàn thiện" (B-roll ‖ Metadata)

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

interface RunContext {
  runner: LLMRunner;
  emit: (event: PipelineEvent) => Promise<void>;
  emitDetail: (detail: string) => Promise<void>;
  finalize: (mutate: (r: RunRecord) => void) => Promise<void>;
  shouldStop: () => Promise<boolean>;
}

function makeContext(kv: KVNamespace, runId: string, env: PipelineEnv, opts: PipelineOptions): RunContext {
  // Xâu chuỗi mọi lần ghi event qua một promise chain: updateRun() là đọc-sửa-ghi
  // KV không nguyên tử (xem doc comment kv-store.ts), và Phase B chạy B-roll +
  // Metadata song song — hai emit() chồng lên nhau có thể mất event của nhau
  // nếu không tuần tự hoá thủ công ở đây.
  let chain: Promise<void> = Promise.resolve();
  const emit = (event: PipelineEvent): Promise<void> => {
    chain = chain.then(() => updateRun(kv, runId, (r: RunRecord) => r.events.push(event))).then(() => undefined);
    return chain;
  };

  /* Nguyên văn lỗi, chỉ khi bật SHOW_PROVIDER_ERRORS. Đi vào event log nên hiện
     thẳng trong ô "Log thô" của màn tiến trình. */
  const emitDetail = async (detail: string) => {
    if (!showProviderErrors(env)) return;
    const safe = clampDetail(stripSecretValues(detail, env as unknown as Record<string, unknown>));
    await emit({ type: "log", message: `[chi tiết lỗi] ${safe}` });
  };

  const shouldStop = () => isStopRequested(kv, runId);

  /* Ghi trạng thái cuối. Đọc lại cờ dừng ngay trước khi ghi: người dùng có thể
     đã bấm Dừng trong lúc bước cuối chạy, và bản ghi thì có thể vừa bị một
     emit() ghi đè mất cờ — cờ ở key riêng mới là nguồn đúng. */
  const finalize = async (mutate: (r: RunRecord) => void) => {
    const stopped = await shouldStop();
    await updateRun(kv, runId, (r) => {
      mutate(r);
      if (stopped || r.stopRequested) {
        r.stopRequested = true;
        r.status = "stopped";
        r.error = STOP_MESSAGE;
      }
    });
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

  return { runner, emit, emitDetail, finalize, shouldStop };
}

/** Bọc try/catch dùng chung cho cả 3 pha: StoppedError -> "stopped", mọi lỗi
    khác -> "error" với thông điệp đã sanitize (xem llm/errors.ts). */
async function guarded(kv: KVNamespace, runId: string, ctx: RunContext, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (exc) {
    if (exc instanceof StoppedError) {
      await updateRun(kv, runId, (r) => {
        r.stopRequested = true;
        r.status = "stopped";
        r.error = STOP_MESSAGE;
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
    await ctx.emitDetail(exc instanceof ProviderError ? exc.detail : String((exc as Error)?.stack || exc));
    await ctx.finalize((r) => {
      r.status = "error";
      r.error = message;
    });
    await ctx.emit({ type: "error", message });
  }
}

// ---------- Phase A: Research -> Outline -> checkpoint ----------

export async function runPipeline(
  kv: KVNamespace,
  runId: string,
  brief: VideoBrief,
  opts: PipelineOptions,
  env: PipelineEnv
): Promise<void> {
  const ctx = makeContext(kv, runId, env, opts);
  await guarded(kv, runId, ctx, async () => {
    await ctx.emit({ type: "step", index: 1, total: TOTAL_STEPS, name: "Research" });
    const research = await runResearch(ctx.runner, brief);
    for (const w of factCheckWarnings(research)) await ctx.emit({ type: "warning", message: w });

    await ctx.emit({ type: "step", index: 2, total: TOTAL_STEPS, name: "Outline" });
    const outline = await runOutline(ctx.runner, brief, research);

    await updateRun(kv, runId, (r) => {
      r.status = "awaiting_outline";
      r.outline = outline;
      r.resume = { videoBrief: brief, research, options: opts };
    });
    await ctx.emit({ type: "outline", outline });
  });
}

// ---------- Phase A': regenerate outline, stay at the checkpoint ----------

export async function regenerateOutline(
  kv: KVNamespace,
  runId: string,
  env: PipelineEnv,
  feedback?: string
): Promise<void> {
  const record = await getRun(kv, runId);
  if (!record || !record.resume) return; // stale double-click hoặc run đã đi tiếp — bỏ qua
  const { videoBrief: brief, research, options: opts } = record.resume;
  const ctx = makeContext(kv, runId, env, opts);
  await guarded(kv, runId, ctx, async () => {
    const outline = await runOutline(ctx.runner, brief, research, feedback);
    await updateRun(kv, runId, (r) => {
      r.outline = outline;
    });
    await ctx.emit({ type: "outline", outline });
  });
}

// ---------- Phase B: Script -> B-roll ‖ Metadata -> Notion ----------

export async function continuePipeline(kv: KVNamespace, runId: string, env: PipelineEnv): Promise<void> {
  const record = await getRun(kv, runId);
  if (!record || !record.resume || !record.outline) return; // stale — không có gì để chạy tiếp
  const { videoBrief: brief, research, options: opts } = record.resume;
  const outline: OutlineDraft = record.outline;
  const ctx = makeContext(kv, runId, env, opts);

  await guarded(kv, runId, ctx, async () => {
    // Xoá resume ngay khi bắt đầu dùng — double-click "Duyệt" không nên chạy lại
    // Script từ cùng state cũ trong khi lần đầu vẫn đang chạy.
    await updateRun(kv, runId, (r) => {
      r.status = "running";
      r.resume = null;
    });

    const warnings: string[] = [];

    await ctx.emit({ type: "step", index: 3, total: TOTAL_STEPS, name: "Script" });
    const script = await runScript(ctx.runner, brief, research, outline);
    const timeline = buildTimeline(script, brief);
    const report = durationReport(timeline, brief);
    if (!report.within_tolerance) {
      warnings.push(
        `Thời lượng đọc thử ${report.spoken_estimate_sec}s lệch ` +
          `${report.drift_pct >= 0 ? "+" : ""}${report.drift_pct.toFixed(1)}% so với mục tiêu ${report.target_sec}s.`
      );
    }

    await ctx.emit({ type: "step", index: 4, total: TOTAL_STEPS, name: "Hoàn thiện" });
    const [broll, metadata] = await Promise.all([
      runBroll(ctx.runner, brief, timeline),
      runMetadata(ctx.runner, brief, script, timeline),
    ]);

    const summary: RunSummary = {
      working_title: script.working_title,
      sections: timeline.length,
      facts: research.facts.length,
      duration: report,
      warnings,
      usage: ctx.runner.usageSummary(),
    };

    for (const w of warnings) await ctx.emit({ type: "warning", message: w });

    if (opts.dryRun) {
      await ctx.finalize((r) => {
        r.status = "done";
      });
      return;
    }

    let page: { id: string; url: string };
    try {
      page = await publishRun(brief, research, outline, script, broll, timeline, metadata, summary, env);
    } catch (exc) {
      if (exc instanceof NotionPublishError) {
        // No local copy to fall back to — dump the full raw JSON into the event
        // log before failing, as a last-resort recovery for quota already spent.
        // A Worker has no terminal to fall back to, so the KV event log is the
        // only place this could ever be recovered from.
        const rawDump = JSON.stringify({ brief, research, outline, script, broll, metadata, meta: summary });
        await ctx.emit({ type: "log", message: "=== NOTION LỖI — JSON GỐC ĐỔ RA ĐÂY ĐỂ BẠN COPY LẠI ===" });
        await ctx.emit({ type: "log", message: rawDump });
        await ctx.emit({ type: "log", message: "=== HẾT JSON GỐC ===" });
        console.error(`[provider] Notion: không lưu được: ${exc.message}`);
        await ctx.emitDetail(`Notion: không lưu được: ${exc.message}`);
        await ctx.finalize((r) => {
          r.status = "error";
          r.error = PROVIDER_UNAVAILABLE;
        });
        await ctx.emit({ type: "error", message: PROVIDER_UNAVAILABLE });
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

    await ctx.emit({ type: "notion", url: page.url });
    // Đã lên Notion rồi thì giữ lại link kể cả khi người dùng vừa bấm dừng —
    // chỉ có trạng thái là không được lật ngược về "done".
    await ctx.finalize((r) => {
      r.status = "done";
      r.notion_url = page.url;
      r.result = result;
    });
  });
}
