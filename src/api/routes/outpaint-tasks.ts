import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import { validateApiKey } from "@/lib/database.ts";
import { createOutpaintTask, queryOutpaintTask, cancelOutpaintTask } from "@/api/controllers/outpaint-tasks.ts";

async function handle(request: Request, create: boolean) {
  const key = /^Bearer (jm_[A-Za-z0-9_-]+)$/.exec(request.headers.authorization || "")?.[1], auth = key ? validateApiKey(key) : undefined;
  if (!auth?.valid || !auth.apiKeyId) return new Response({ error: "API Key 无效", errorCode: "unauthorized" }, { statusCode: 401 });
  const accountId = request.headers["x-jimeng-account-id"];
  try {
    const result = create ? await createOutpaintTask(auth.apiKeyId, request.headers.authorization, request.body, accountId) : request.method.toUpperCase() === "DELETE" ? cancelOutpaintTask(auth.apiKeyId, String(request.params.id), accountId) : await queryOutpaintTask(auth.apiKeyId, String(request.params.id), accountId);
    return new Response(result.body, { statusCode: result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return new Response({ error: /^扩图/.test(message) && message.length < 100 && !/https?:|token|cookie|jm_/i.test(message) ? message : "即梦原生扩图参数无效或暂无可用账号，未提交生成", errorCode: "invalid_request" }, { statusCode: 400 });
  }
}

export default { prefix: "/v1/outpaint/tasks", post: { "": async (request: Request) => handle(request, true) }, get: { "/:id": async (request: Request) => handle(request, false) }, delete: { "/:id": async (request: Request) => handle(request, false) } };
