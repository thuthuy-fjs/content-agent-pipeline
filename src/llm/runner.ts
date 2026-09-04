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
  /** Best-effort stop check, polled between pause_turn resumption iterations. */
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

      let response: LlmResponse;
      if (this.isDryRun) {
        response = await callFake(params);
      } else if (this.platform === "chatgpt") {
        response = await callOpenAI(params, this.secrets);
      } else if (this.platform === "gemini") {
        response = await callGemini(params, this.secrets);
      } else {
        response = await callAnthropic(params, this.secrets);
      }

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
