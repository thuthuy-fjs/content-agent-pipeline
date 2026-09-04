import { jsonResponse } from "./http";
import type { PipelineEnv } from "./pipeline";
import { handleHistory, handleResult } from "./routes/history";
import { handleOptions } from "./routes/options";
import { handleActive, handleRunStart, handleStatus, handleStop } from "./routes/run";

export interface Env extends PipelineEnv {
  RUNS_KV: KVNamespace;
  ASSETS: Fetcher;
  CONTENT_AGENT_MODEL?: string;
  // "true" => mỗi lượt truy cập chỉ được chạy pipeline một lần (xem webConfig).
  SINGLE_RUN_PER_VISIT?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET") {
      if (path === "/api/options") return handleOptions(env);
      if (path === "/api/runs") return handleHistory(request, env, env.RUNS_KV);
      if (path === "/api/active") return handleActive(env.RUNS_KV);
      if (path === "/api/result") return handleResult(env, url.searchParams.get("page_id") || "");
      if (path === "/api/status") {
        const id = url.searchParams.get("id") || "";
        const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
        return handleStatus(env.RUNS_KV, id, since);
      }
      if (path.startsWith("/api/")) return jsonResponse({ error: "not found" }, 404);
      return env.ASSETS.fetch(request);
    }

    if (request.method === "POST") {
      if (path === "/api/run") return handleRunStart(request, env, ctx, env.RUNS_KV);
      if (path === "/api/stop") return handleStop(request, env.RUNS_KV);
      return jsonResponse({ error: "not found" }, 404);
    }

    return jsonResponse({ error: "method not allowed" }, 405);
  },
};
