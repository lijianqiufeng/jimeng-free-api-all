import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import axios from "axios";
import { database, createApiKey, setApiKeyEnabled } from "@/lib/database.ts";
import accountPool from "@/lib/account-pool.ts";
import routes from "@/api/routes/upscale-tasks.ts";
import registered from "@/api/routes/index.ts";

globalThis.fetch = async () => { throw Error("unmocked network forbidden"); };

const SAFE_CREATE_ERROR = "智能高清参数无效或暂无可用账号，请检查原图与账号状态";

let agentConversationSubmissions = 0;
let lastConversationId = "";

function header(config: any, name: string): string {
  const headers = config.headers || {};
  if (typeof headers.get === "function") {
    return String(headers.get(name) || headers.get(name.toLowerCase()) || "");
  }
  return String(headers[name] || headers[name.toLowerCase()] || "");
}

function body(config: any): any {
  const data = config.data;
  if (data == null || data === "") return {};
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch { return {}; }
  }
  return data;
}

function subscribeSse() {
  const ids = [...new Set([lastConversationId, "conv-server-test-001"].filter(Boolean))];
  return ids.flatMap((id) => [
    "event: system",
    `data: ${JSON.stringify({ type: "conversation_created", conversation_id: id, history_record_id: "history-test-001" })}`,
    "",
  ]).join("\n") + "\n";
}

const previousAdapter = axios.defaults.adapter;
const previousIsTestMock = typeof previousAdapter === "function"
  && Function.prototype.toString.call(previousAdapter).includes("unmocked axios network forbidden");

const routeAdapter = async (config: any) => {
  const url = String(config.url);
  const ok = (data: unknown) => ({ data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config });
  if (url.includes("Action=ApplyImageUpload")) {
    return { data: { Result: { UploadAddress: { UploadHosts: ["upload.test"], StoreInfos: [{ StoreUri: "tos-upload-test", Auth: "fake" }], SessionKey: "fake" } } }, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.startsWith("https://upload.test/")) {
    return { data: { code: 2000 }, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("Action=CommitImageUpload")) {
    return { data: { Result: { Results: [{ Uri: "tos-upload-test" }] } }, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/get_upload_token?")) return ok({ access_key_id: "fake", secret_access_key: "fake", session_token: "fake" });
  if (url.includes("/mweb/v1/workspace/list")) return ok({ workspaces: [] });
  if (url.includes("/mweb/v1/workspace/create")) {
    const cookie = header(config, "Cookie");
    const session = /(?:^|; )sessionid=([^;]+)/.exec(`; ${cookie}`)?.[1] || "default";
    return ok({ workspace_id: session.replace(/^session-/, "workspace-account-") });
  }
  if (url.includes("/mweb/v1/get_image_by_uri")) {
    return ok({ uri2image: { "tos-upload-test": { image_url: "https://fixture.invalid/original.webp", width: 768, height: 1024, item_id: "must-not-be-copied" } } });
  }
  if (url.includes("/submit_audit_job")) {
    return { data: { ret: "1", errmsg: "audit failed" }, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/creation_agent/v2/conversation")) {
    agentConversationSubmissions++;
    lastConversationId = String(body(config).conversation_id || "");
    const stream = new PassThrough();
    stream.end(fs.readFileSync("tests/fixtures/agent-8k-success.sse"));
    return { data: stream, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/creation_agent/v2/subscribe_session")) {
    const stream = new PassThrough();
    queueMicrotask(() => stream.end(subscribeSse()));
    return { data: stream, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/get_history_by_ids")) {
    return ok(JSON.parse(fs.readFileSync("tests/fixtures/agent-8k-history-success.json", "utf8")));
  }
  if (url.includes("/passport/account/info/v2")) return ok({ user_info: { is_vip: false } });
  if (url.endsWith("/user_credit") || url.endsWith("/get_common_config")) {
    return ok(url.endsWith("/user_credit") ? { credit: { gift_credit: 500, purchase_credit: 0, vip_credit: 0 } } : {});
  }
  throw Error("unmocked axios network forbidden");
};

axios.defaults.adapter = previousIsTestMock ? previousAdapter : routeAdapter;

const managed = createApiKey("isolated upscale routes");
const disabled = createApiKey("disabled upscale routes");
setApiKeyEnabled(disabled.apiKey.id, false);
const authorization = `Bearer ${managed.key}`;
const input = { id: "upscale_route_status_12", image: "data:image/png;base64,YQ==" };
accountPool.create({ name: "upscale route default", sessionId: "session-route-default" });

function readRow(id: string) {
  return database.prepare("SELECT * FROM agent_upscale_tasks WHERE id = ?").get(id) as any;
}

function fakeRequest({ authorization, body, id, method = "POST" }: { authorization?: string; body?: unknown; id?: string; method?: string } = {}) {
  return { method, headers: { authorization }, body, params: { id } } as any;
}

function managedRequest(body?: unknown, id?: string) {
  return fakeRequest({ authorization, body, id, method: body !== undefined ? "POST" : "GET" });
}

function assertSafeCreateError(response: any) {
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, SAFE_CREATE_ERROR);
  const text = JSON.stringify(response);
  assert.equal(text.includes("任务 ID 无效"), false);
  assert.equal(text.includes("原图只接受"), false);
  assert.equal(text.includes("没有可用的即梦账号"), false);
  assert.equal(text.includes("Error:"), false);
  assert.equal(text.includes("at "), false);
  assert.equal(text.includes(".ts:"), false);
  assert.equal(text.includes("upscale-task-contract"), false);
  assert.equal(text.includes("file:///"), false);
  assert.equal(text.includes("/etc/passwd"), false);
  assert.equal(text.includes("C:\\"), false);
  assert.equal(text.includes("stack"), false);
}

async function until(predicate: () => boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate());
}

describe("agent upscale routes", { concurrency: 1 }, () => {
test("upscale routes require an enabled managed key", async () => {
  const response = await routes.post[""](fakeRequest({ authorization: "Bearer raw-session", body: input }));
  assert.equal(response.statusCode, 401);
});

test("disabled, missing, and unknown jm_ keys are rejected with 401", async () => {
  assert.equal((await routes.post[""](fakeRequest({ body: input }))).statusCode, 401);
  assert.equal((await routes.post[""](fakeRequest({ authorization: `Bearer ${disabled.key}`, body: input }))).statusCode, 401);
  assert.equal((await routes.post[""](fakeRequest({ authorization: "Bearer jm_unknownkey_000000000000", body: input }))).statusCode, 401);
  assert.equal((await routes.get["/:id"](fakeRequest({ authorization: "Bearer raw-session", id: input.id, method: "GET" }))).statusCode, 401);
  assert.equal((await routes.delete["/:id"](fakeRequest({ authorization: "Bearer raw-session", id: input.id, method: "DELETE" }))).statusCode, 401);
  assert.equal((await routes.get["/:id"](fakeRequest({ id: input.id, method: "GET" }))).statusCode, 401);
  assert.equal((await routes.delete["/:id"](fakeRequest({ authorization: `Bearer ${disabled.key}`, id: input.id, method: "DELETE" }))).statusCode, 401);
});

test("route preserves controller status codes", async () => {
  assert.equal((await routes.post[""](managedRequest(input))).statusCode, 202);
  assert.equal((await routes.get["/:id"](managedRequest(undefined, input.id))).statusCode, 200);
  assert.equal((await routes.delete["/:id"](managedRequest(undefined, input.id))).statusCode, 200);
});

test("malformed JSON fields return one safe HTTP 400", async () => {
  for (const body of [
    { id: "short", image: input.image },
    { id: "upscale_malformed_1234", image: "file:///etc/passwd" },
    { id: "upscale_malformed_http1", image: "https://127.0.0.1/a.png" },
    { id: "upscale_malformed_miss1" },
    null,
    "not-json-object",
  ]) {
    const response = await routes.post[""](managedRequest(body));
    assertSafeCreateError(response);
  }
});

test("GET and DELETE do not start a paid conversation POST", async () => {
  const id = "upscale_route_readonly12";
  const before = agentConversationSubmissions;
  assert.equal((await routes.get["/:id"](fakeRequest({ authorization, id, method: "GET" }))).statusCode, 404);
  const canceled = await routes.delete["/:id"](fakeRequest({ authorization, id, method: "DELETE" }));
  assert.equal(canceled.statusCode, 200);
  assert.equal(canceled.body.status, "canceled");
  assert.equal((await routes.post[""](fakeRequest({ authorization, body: { ...input, id } }))).statusCode, 409);
  assert.equal(agentConversationSubmissions, before);
  assert.equal(readRow(id)?.conversation_id || "", "");
});

test("polling GET and DELETE never send another paid conversation", async () => {
  const id = "upscale_route_poll_12345";
  assert.equal((await routes.post[""](fakeRequest({ authorization, body: { ...input, id } }))).statusCode, 202);
  await until(() => Boolean(readRow(id)?.conversation_id));
  const conversationId = readRow(id).conversation_id;
  const afterCreate = agentConversationSubmissions;
  assert.equal((await routes.get["/:id"](fakeRequest({ authorization, id, method: "GET" }))).statusCode, 200);
  assert.equal((await routes.delete["/:id"](fakeRequest({ authorization, id, method: "DELETE" }))).statusCode, 200);
  assert.equal(agentConversationSubmissions, afterCreate);
  assert.equal(readRow(id).conversation_id, conversationId);
});

test("upscale tasks route is registered last", () => {
  assert.equal(routes.prefix, "/v1/upscale/tasks");
  assert.equal(registered[registered.length - 1].prefix, "/v1/upscale/tasks");
  assert.equal(registered[registered.length - 2].prefix, "/v1/tasks");
});
});
