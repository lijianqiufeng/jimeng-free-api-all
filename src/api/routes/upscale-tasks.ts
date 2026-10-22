import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import { validateApiKey } from "@/lib/database.ts";
import { cancelUpscaleTask, createUpscaleTask, queryUpscaleTask } from "@/api/controllers/upscale-tasks.ts";

async function handle(request: Request, create: boolean) {
  const key = /^Bearer (jm_[A-Za-z0-9_-]+)$/.exec(request.headers.authorization || "")?.[1];
  const auth = key ? validateApiKey(key) : undefined;
  if (!auth?.valid || !auth.apiKeyId) return new Response({ error: "API Key 无效" }, { statusCode: 401 });
  if (create) {
    try {
      const result = await createUpscaleTask(auth.apiKeyId, request.headers.authorization, request.body, request.headers["x-jimeng-account-id"]);
      return new Response(result.body, { statusCode: result.status });
    } catch {
      return new Response({ error: "智能高清参数无效或暂无可用账号，请检查原图与账号状态" }, { statusCode: 400 });
    }
  }
  const id = String(request.params.id);
  const result = request.method.toUpperCase() === "DELETE"
    ? cancelUpscaleTask(auth.apiKeyId, id)
    : await queryUpscaleTask(auth.apiKeyId, id, String(request.query?.refresh || "") === "1", request.headers["x-jimeng-account-id"]);
  return new Response(result.body, { statusCode: result.status });
}

export default {
  prefix: "/v1/upscale/tasks",
  post: { "": async (request: Request) => handle(request, true) },
  get: { "/:id": async (request: Request) => handle(request, false) },
  delete: { "/:id": async (request: Request) => handle(request, false) },
};
