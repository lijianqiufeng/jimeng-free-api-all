import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import { validateApiKey } from "@/lib/database.ts";
import { createTask, queryTask, cancelTask } from "@/api/controllers/tasks.ts";
import { publicAccountError } from "@/api/controllers/auth.ts";

async function handle(request: Request, create: boolean) {
  const key = /^Bearer (jm_[A-Za-z0-9_-]+)$/.exec(request.headers.authorization || "")?.[1];
  const auth = key ? validateApiKey(key) : undefined;
  if (!auth?.valid || !auth.apiKeyId) return new Response({ error: "API Key 无效" }, { statusCode: 401 });
  if (create) {
    try {
      const result = await createTask(auth.apiKeyId, request.headers.authorization, request.body, request.headers["x-jimeng-account-id"]);
      return new Response(result.body, { statusCode: result.status });
    } catch (error) {
      return new Response({ error: publicAccountError(error) || "即梦参数无效或暂无可用账号，请检查模型、比例、清晰度、时长及参考图" }, { statusCode: 400 });
    }
  }
  const result = request.method.toUpperCase() === "DELETE" ? cancelTask(auth.apiKeyId, String(request.params.id)) : await queryTask(auth.apiKeyId, String(request.params.id));
  return new Response(result.body, { statusCode: result.status });
}

export default { prefix: "/v1/tasks", post: { "": async (request: Request) => handle(request, true) }, get: { "/:id": async (request: Request) => handle(request, false) }, delete: { "/:id": async (request: Request) => handle(request, false) } };
