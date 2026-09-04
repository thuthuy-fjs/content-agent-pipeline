// POST /api/run (validate brief, start pipeline), GET /api/status, POST /api/stop.

import { makeBrief } from "../brief";
import { DEFAULT_MAX_TOKENS, LIGHT_STAGES, PLATFORMS, defaultModel } from "../config";
import { ValidationError, jsonResponse } from "../http";
import {
  STOP_MESSAGE,
  claimVisit,
  createRun,
  getRun,
  listActiveRuns,
  requestStop,
  snapshot,
  updateRun,
  type RunBrief,
} from "../kv-store";
import type { LlmPlatform } from "../llm/runner";
import { isConfigured } from "../notion";
import type { PipelineEnv, PipelineOptions } from "../pipeline";
import { runPipeline } from "../pipeline";
import {
  DEFAULT_DURATION_SEC,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  PLATFORM_LABELS,
  UNIT_SECONDS,
  VISIT_QUOTA_MESSAGE,
  VISIT_QUOTA_TTL_SEC,
  singleRunPerVisit,
} from "../webConfig";

interface BuiltRun {
  brief: RunBrief;
  videoBrief: ReturnType<typeof makeBrief>;
  llmPlatform: LlmPlatform;
  model: string;
  stageModels: Record<string, string>;
}

function stageModelsFromLight(model: string, light: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (light && light !== model) {
    for (const stage of LIGHT_STAGES) out[stage] = light;
  }
  return out;
}

function buildRunRequest(payload: any, env: { CONTENT_AGENT_MODEL?: string }): BuiltRun {
  const topic = String(payload.topic || "").trim();
  if (!topic) throw new ValidationError("Thiếu chủ đề.");

  const platform = payload.platform || "youtube_shorts";
  if (!PLATFORMS.includes(platform)) throw new ValidationError(`Nền tảng không hợp lệ: ${platform}`);

  const unit = payload.duration_unit || "sec";
  if (!(unit in UNIT_SECONDS)) throw new ValidationError(`Đơn vị thời lượng không hợp lệ: ${unit}`);

  let duration: number;
  const raw = payload.duration;
  if (raw === null || raw === undefined || raw === "") {
    duration = DEFAULT_DURATION_SEC;
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new ValidationError("Thời lượng phải là số.");
    duration = Math.round(n * UNIT_SECONDS[unit]);
  }
  if (duration < MIN_DURATION_SEC || duration > MAX_DURATION_SEC) {
    throw new ValidationError(
      `Thời lượng nên trong khoảng ${MIN_DURATION_SEC} giây - ${Math.floor(MAX_DURATION_SEC / 60)} phút.`
    );
  }

  const model = String(payload.model || "").trim() || defaultModel(env);
  const light = String(payload.light_model || "").trim();
  const llmPlatform = (String(payload.llm_platform || "").trim() || "claude") as LlmPlatform;
  const tone = String(payload.tone || "").trim();
  const audience = String(payload.audience || "").trim();
  const dryRun = Boolean(payload.dry_run);

  const videoBrief = makeBrief({
    topic,
    platform,
    duration_target_sec: duration,
    ...(tone ? { tone } : {}),
    ...(audience ? { audience } : {}),
  });

  const brief: RunBrief = {
    topic,
    platform,
    platform_label: PLATFORM_LABELS[platform] || platform,
    duration,
    llm_platform: llmPlatform,
    model,
    light_model: light && light !== model ? light : null,
    dry_run: dryRun,
  };

  return { brief, videoBrief, llmPlatform, model, stageModels: stageModelsFromLight(model, light || null) };
}

export async function handleRunStart(
  request: Request,
  env: PipelineEnv & { CONTENT_AGENT_MODEL?: string; SINGLE_RUN_PER_VISIT?: string },
  ctx: ExecutionContext,
  kv: KVNamespace
): Promise<Response> {
  let payload: any;
  try {
    payload = await request.json();
  } catch (exc) {
    return jsonResponse({ error: (exc as Error).message }, 400);
  }

  let built: BuiltRun;
  try {
    built = buildRunRequest(payload, env);
  } catch (exc) {
    if (exc instanceof ValidationError) return jsonResponse({ error: exc.message }, 400);
    throw exc;
  }

  // Pre-flight guard: refuse a real run before spending any model budget if
  // there's nowhere to save the result.
  if (!built.brief.dry_run && !isConfigured(env)) {
    return jsonResponse(
      {
        error:
          "Chưa cấu hình Notion (cần NOTION_TOKEN và NOTION_DATA_SOURCE_ID). " +
          "Pipeline không ghi file local nữa nên không có chỗ nào để lưu kết quả.",
      },
      400
    );
  }

  // Chỉ cho mỗi lượt truy cập một lần chạy, nếu bật SINGLE_RUN_PER_VISIT. Vé
  // được lấy sau khi mọi kiểm tra đã qua, để một brief sai không đốt mất lượt.
  if (singleRunPerVisit(env)) {
    const visitId = String(payload.visit_id || "").trim();
    if (!visitId) return jsonResponse({ error: VISIT_QUOTA_MESSAGE, quota_exhausted: true }, 429);
    if (!(await claimVisit(kv, visitId, VISIT_QUOTA_TTL_SEC))) {
      return jsonResponse({ error: VISIT_QUOTA_MESSAGE, quota_exhausted: true }, 429);
    }
  }

  const runId = crypto.randomUUID();
  await createRun(kv, runId, built.brief);

  const options: PipelineOptions = {
    llmPlatform: built.llmPlatform,
    model: built.model,
    stageModels: built.stageModels,
    maxTokens: DEFAULT_MAX_TOKENS,
    dryRun: built.brief.dry_run,
  };
  ctx.waitUntil(runPipeline(kv, runId, built.videoBrief, options, env));

  return jsonResponse({ run_id: runId });
}

export async function handleStatus(kv: KVNamespace, id: string, since: number): Promise<Response> {
  const record = await getRun(kv, id);
  if (!record) return jsonResponse({ error: "Không tìm thấy lần chạy này." }, 404);
  return jsonResponse(snapshot(record, since));
}

export async function handleStop(request: Request, kv: KVNamespace): Promise<Response> {
  let payload: any;
  try {
    payload = await request.json();
  } catch (exc) {
    return jsonResponse({ error: (exc as Error).message }, 400);
  }
  const id = String(payload.id || "");
  // Cờ ở key riêng phải được ghi TRƯỚC bản ghi: nếu bản ghi bị một emit() ghi
  // đè, pipeline vẫn thấy cờ này ở lần kiểm tra kế tiếp và tự thoát.
  await requestStop(kv, id);
  let wasRunning = false;
  const record = await updateRun(kv, id, (r) => {
    wasRunning = r.status === "running";
    if (!wasRunning) return;
    r.stopRequested = true;
    /* Chốt sổ ngay tại đây chứ không chỉ đặt cờ rồi chờ pipeline tự đổi trạng
       thái. Pipeline sống trong ctx.waitUntil() của một tiến trình Worker: chỉ
       cần Worker reload/deploy/crash là nó chết ngang, không ai còn đọc cờ, và
       bản ghi kẹt "running" vĩnh viễn — nút Dừng trông như vô tác dụng. Nếu
       pipeline vẫn sống thì nó tự thoát ở lần kiểm tra kế tiếp và ghi đúng cùng
       trạng thái này, nên chốt trước không sai lệch gì. */
    r.status = "stopped";
    r.error = STOP_MESSAGE;
  });
  if (!record) return jsonResponse({ error: "Không tìm thấy lần chạy này." }, 404);
  return jsonResponse({ stopped: wasRunning, status: record.status });
}

export async function handleActive(kv: KVNamespace): Promise<Response> {
  return jsonResponse({ runs: await listActiveRuns(kv) });
}
