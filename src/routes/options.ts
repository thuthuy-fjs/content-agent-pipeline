// GET /api/options — which LLM platforms/models are usable with the keys present.

import { LIGHT_STAGES, PLATFORM_MODELS, PLATFORMS, defaultModel } from "../config";
import { jsonResponse } from "../http";
import { DEFAULT_DURATION_SEC, DURATION_UNITS, MAX_DURATION_SEC, MIN_DURATION_SEC, PLATFORM_LABELS } from "../webConfig";

export interface OptionsEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  CONTENT_AGENT_MODEL?: string;
}

export function handleOptions(env: OptionsEnv): Response {
  const availPlatforms: string[] = [];
  if (env.ANTHROPIC_API_KEY) availPlatforms.push("claude");
  if (env.OPENAI_API_KEY) availPlatforms.push("chatgpt");
  if (env.GEMINI_API_KEY) availPlatforms.push("gemini");
  if (!availPlatforms.length) availPlatforms.push("claude");

  return jsonResponse({
    light_stages: LIGHT_STAGES,
    platforms: PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABELS[p] || p })),
    avail_platforms: availPlatforms,
    platform_models: PLATFORM_MODELS,
    default_model: defaultModel(env),
    default_duration: DEFAULT_DURATION_SEC,
    duration_units: DURATION_UNITS,
    duration_range_sec: [MIN_DURATION_SEC, MAX_DURATION_SEC],
  });
}
