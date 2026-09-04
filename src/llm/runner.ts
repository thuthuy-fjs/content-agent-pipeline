// The only place that talks to a model. text()/structured() dispatch to whichever
// provider client the platform selects, and centralize pause_turn resumption,
// schema-violation retries, refusal/max_tokens hard stops, per-stage model
// overrides, the stop check, and usage/cost accounting.

import { estimateCostUsd, supportsModernFeatures } from "../config";
import type { PipelineEvent } from "../events";
import { callAnthropic } from "./anthropic";
import { providerError } from "./errors";
import { callFake } from "./fake";
import { callGemini } from "./gemini";
import { callOpenAI } from "./openai";
import type { CreateParams, LlmMessage, LlmResponse, OutputConfig, ProviderSecrets } from "./types";

const MAX_PAUSE_RESTARTS = 5;

/* Một lượt gọi model có thể kéo dài hàng phút (research kèm web search), nhưng
   không phải là vô hạn: không có mốc này thì một request treo giữ nguyên bản ghi
   ở "running" cho tới khi Worker chết, và không ai biết. */
const PROVIDER_TIMEOUT_MS = 5 * 60 * 1000;
/* Nhịp hỏi lại KV xem người dùng đã bấm Dừng chưa, trong lúc request đang bay.
   Chỉ là read nên rẻ; trình duyệt vốn đã poll /api/status mỗi 700ms. */
const STOP_POLL_MS = 5000;

export type LlmPlatform = "claude" | "chatgpt" | "gemini";

export interface UsageRecord {
  stage: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}

export interface RunnerOptions {
  platform: LlmPlatform;
  model: string;
  maxTokens: number;
  verbose: boolean;
  stageModels: Record<string, string>;
  isDryRun: boolean;
  secrets: ProviderSecrets;
  /** Awaited before the next event fires, so KV read-modify-writes never race each other. */
  onEvent: (event: PipelineEvent) => Promise<void>;
  /** Stop check: hỏi trước mỗi lượt gọi model và lặp lại trong lúc request đang bay. */
  shouldStop?: () => Promise<boolean>;
}

export class StoppedError extends Error {}

export class LLMRunner {
  readonly platform: LlmPlatform;
  readonly model: string;
  readonly maxTokens: number;
  readonly verbose: boolean;
  readonly stageModels: Record<string, string>;
  readonly backend: string;
  readonly usageLog: UsageRecord[] = [];
  private readonly isDryRun: boolean;
  private readonly secrets: ProviderSecrets;
  private readonly onEvent: (event: PipelineEvent) => Promise<void>;
  private readonly shouldStop?: () => Promise<boolean>;

  constructor(opts: RunnerOptions) {
    this.platform = opts.platform;
    this.model = opts.model;
    this.maxTokens = opts.maxTokens;
    this.verbose = opts.verbose;
    this.stageModels = opts.stageModels;
    this.isDryRun = opts.isDryRun;
    this.secrets = opts.secrets;
    this.onEvent = opts.onEvent;
    this.shouldStop = opts.shouldStop;
    // Mirrors ClaudeRunner.__post_init__: dry-run wins regardless of platform,
    // else backend = platform ("claude" -> "api", chatgpt/gemini -> themselves).
    this.backend = this.isDryRun ? "dry-run" : this.platform === "claude" ? "api" : this.platform;
  }

  modelFor(stage: string): string {
    const base = stage.split("#")[0];
    return this.stageModels[base] || this.model;
  }

  async text(
    stage: string,
    system: string,
    prompt: string,
    opts?: { tools?: { type: string; name: string; max_uses: number }[]; effort?: string }
  ): Promise<string> {
    const response = await this.create(stage, system, [{ role: "user", content: prompt }], opts?.tools, opts?.effort);
    return this.firstText(response);
  }

  async structured<T>(
    stage: string,
    system: string,
    prompt: string,
    schema: Record<string, unknown>,
    validate: (data: unknown) => T,
    opts?: { effort?: string; retries?: number }
  ): Promise<T> {
    const retries = opts?.retries ?? 2;
    const outputConfig: OutputConfig = { format: { type: "json_schema", schema } };
    let messages: LlmMessage[] = [{ role: "user", content: prompt }];
    let lastError = "";

    for (let attempt = 0; attempt <= retries; attempt++) {
      const response = await this.create(
        attempt ? `${stage}#${attempt}` : stage,
        system,
        messages,
        undefined,
        opts?.effort,
        outputConfig
      );
      const text = this.firstText(response);
      try {
        return validate(JSON.parse(text));
      } catch (exc) {
        lastError = (exc as Error).message;
        if (this.verbose) {
          await this.onEvent({
            type: "retry",
            message: `${stage}: output sai schema, thử lại (${attempt + 1}/${retries})`,
          });
        }
        messages = [
          ...messages,
          { role: "assistant", content: text },
          {
            role: "user",
            content:
              `Output vừa rồi không hợp lệ so với schema. Lỗi:\n${lastError}\n\n` +
              "Trả lại JSON đúng schema, không kèm giải thích.",
          },
        ];
      }
    }
    throw providerError(`${stage}: không lấy được JSON hợp lệ sau ${retries + 1} lần. ${lastError}`);
  }

  totalCostUsd(): number | null {
    if (this.usageLog.some((r) => r.cost_usd === null)) return null;
    return this.usageLog.reduce((sum, r) => sum + (r.cost_usd as number), 0);
  }

  usageSummary(): Record<string, unknown> {
    return {
      model: this.model,
      stage_models: { ...this.stageModels },
      backend: this.backend,
      calls: this.usageLog,
      total_input_tokens: this.usageLog.reduce((s, r) => s + r.input_tokens, 0),
      total_output_tokens: this.usageLog.reduce((s, r) => s + r.output_tokens, 0),
      total_cost_usd: this.totalCostUsd(),
    };
  }

  // ---------- internal ----------

  private async create(
    stage: string,
    system: string,
    initialMessages: LlmMessage[],
    tools?: { type: string; name: string; max_uses: number }[],
    effort?: string,
    outputConfig?: OutputConfig
  ): Promise<LlmResponse> {
    const model = this.modelFor(stage);
    const anthropicShape = this.isDryRun || this.platform === "claude";

    const config: OutputConfig | undefined = outputConfig ? { ...outputConfig } : undefined;
    if (config && effort && supportsModernFeatures(model)) {
      config.effort = effort;
    }

    const params: CreateParams = {
      model,
      maxTokens: this.maxTokens,
      system,
      messages: initialMessages,
      tools: tools && tools.length && anthropicShape ? tools : undefined,
      outputConfig: config,
    };

    let restarts = 0;
    while (true) {
      if (this.shouldStop && (await this.shouldStop())) {
        throw new StoppedError("Đã dừng theo yêu cầu.");
      }

      const response = await this.callProvider(stage, params);

      await this.recordUsage(stage, response, model);

      if (response.stopReason === "refusal") {
        const category = response.stopDetails?.category || "không rõ lý do";
        throw providerError(`${stage}: model từ chối yêu cầu (${category}).`);
      }
      if (response.stopReason === "max_tokens") {
        throw providerError(
          `${stage}: output bị cắt vì chạm max_tokens (${this.maxTokens}). Tăng --max-tokens hoặc rút ngắn brief.`
        );
      }
      if (response.stopReason === "pause_turn") {
        // Server tool (web search) is still running: append the turn and continue.
        restarts += 1;
        if (restarts > MAX_PAUSE_RESTARTS) {
          throw providerError(`${stage}: pause_turn quá ${MAX_PAUSE_RESTARTS} lần.`);
        }
        params.messages = [...params.messages, { role: "assistant", content: response.content }];
        continue;
      }
      return response;
    }
  }

  /* Gọi provider nhưng vẫn cắt được nửa chừng: một watcher hỏi shouldStop mỗi
     STOP_POLL_MS và abort request, cộng một timeout cứng. Trước đây cờ dừng chỉ
     được đọc giữa hai lượt gọi, nên bấm Dừng giữa bước Research phải chờ hết cả
     lượt gọi đó — với request treo thì chờ vô hạn. */
  private async callProvider(stage: string, params: CreateParams): Promise<LlmResponse> {
    if (this.isDryRun) return callFake(params);

    const controller = new AbortController();
    let done = false;
    let stopped = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PROVIDER_TIMEOUT_MS);

    const watcher = (async () => {
      while (!done && this.shouldStop) {
        await new Promise((r) => setTimeout(r, STOP_POLL_MS));
        if (done) return;
        if (await this.shouldStop()) {
          stopped = true;
          controller.abort();
          return;
        }
      }
    })();

    const withSignal: CreateParams = { ...params, signal: controller.signal };
    try {
      if (this.platform === "chatgpt") return await callOpenAI(withSignal, this.secrets);
      if (this.platform === "gemini") return await callGemini(withSignal, this.secrets);
      return await callAnthropic(withSignal, this.secrets);
    } catch (exc) {
      // Request bị chính ta cắt: lý do thật nằm ở cờ, không phải ở message của fetch.
      if (stopped) throw new StoppedError("Đã dừng theo yêu cầu.");
      if (timedOut) {
        throw providerError(`${stage}: không phản hồi sau ${PROVIDER_TIMEOUT_MS / 1000}s.`);
      }
      throw exc;
    } finally {
      done = true;
      clearTimeout(timer);
      await watcher;
    }
  }

  private async recordUsage(stage: string, response: LlmResponse, model: string): Promise<void> {
    const inputTokens = response.usage.inputTokens;
    const outputTokens = response.usage.outputTokens;
    const cost = response.usage.costUsd ?? estimateCostUsd(model, inputTokens, outputTokens);
    this.usageLog.push({ stage, model, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost });
    if (this.verbose) {
      await this.onEvent({
        type: "usage",
        stage,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: cost,
        model: model !== this.model ? model : null,
      });
    }
  }

  private firstText(response: LlmResponse): string {
    for (const block of response.content) {
      if (block.type === "text" && typeof block.text === "string") return block.text;
    }
    throw providerError("Response không có text block nào.");
  }
}
