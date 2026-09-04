// Structured progress events. The pipeline appends these to a run's event log in
// KV; public/index.html switches on `type` to drive the stepper and raw log.

export type PipelineEvent =
  | { type: "step"; index: number; total: number; name: string }
  | {
      type: "usage";
      stage: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number | null;
      model: string | null;
    }
  | { type: "notion"; url: string }
  | { type: "error"; message: string }
  | { type: "retry"; message: string }
  | { type: "warning"; message: string }
  | { type: "log"; message: string };
