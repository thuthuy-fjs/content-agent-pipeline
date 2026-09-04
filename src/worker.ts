import { jsonResponse } from "./http";
import type { PipelineEnv } from "./pipeline";
import { handleHistory, handleResult } from "./routes/history";
import { handleOptions } from "./routes/options";
import { handleActive, handleOutlineDecision, handleRunStart, handleStatus, handleStop } from "./routes/run";
import { ACCESS_DENIED_MESSAGE, ACCESS_TOKEN_HEADER, requiredAccessToken } from "./webConfig";

export interface Env extends PipelineEnv {
  RUNS_KV: KVNamespace;
  ASSETS: Fetcher;
  CONTENT_AGENT_MODEL?: string;
  // "true" => mỗi lượt truy cập chỉ được chạy pipeline một lần (xem webConfig).
  SINGLE_RUN_PER_VISIT?: string;
  // Đặt thì mọi /api/* cần header X-Access-Token khớp giá trị này (xem webConfig).
  ACCESS_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Trang tĩnh (public/index.html) luôn mở — nó chỉ là một cái form, không có
    // gì bí mật để giấu. Cổng chặn nằm ở /api/*, nơi thật sự tốn quota/lộ dữ
    // liệu run. Không đặt ACCESS_TOKEN thì requiredToken là null, bỏ qua hẳn
    // bước này — đúng quy ước "trống = tắt" của SINGLE_RUN_PER_VISIT/
    // SHOW_PROVIDER_ERRORS.
    const requiredToken = requiredAccessToken(env);
    if (requiredToken && path.startsWith("/api/")) {
      const given = request.headers.get(ACCESS_TOKEN_HEADER) || "";
      if (given !== requiredToken) {
        return jsonResponse({ error: ACCESS_DENIED_MESSAGE }, 401);
      }
    }

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
      if (path === "/api/outline") return handleOutlineDecision(request, env, ctx, env.RUNS_KV);
      return jsonResponse({ error: "not found" }, 404);
    }

    return jsonResponse({ error: "method not allowed" }, 405);
  },
};
