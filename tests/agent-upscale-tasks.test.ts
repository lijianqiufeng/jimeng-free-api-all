import { describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import axios from "axios";
import { database, createApiKey, validateApiKey } from "@/lib/database.ts";
import accountPool, { encrypt } from "@/lib/account-pool.ts";
import { upscaleTaskInput } from "@/api/controllers/upscale-task-contract.ts";
import { createUpscaleTask, queryUpscaleTask, cancelUpscaleTask } from "@/api/controllers/upscale-tasks.ts";

globalThis.fetch = async () => { throw Error("unmocked network forbidden"); };

const SOURCE_SIGNED_URL = "https://fixture.invalid/original.webp";
const RESULT_URL = "https://fixture.invalid/result-8k.webp";

let agentConversationSubmissions = 0;
let workspaceCreations = 0;
let paidConversationIds: string[] = [];
let observedAccountIds: string[] = [];
let paidPostTimeout = false;
let conversationRet = "0";
let hangStreams = false;
let streamHistoryId = false;
let holdHistory = false;
let historyAborted = false;
let hangingStreams: PassThrough[] = [];
let hangSubscribeHandshake = false;
let hangConversationHandshake: Promise<void> | null = null;
let hangConversationBody = false;
let subscribeCalls = 0;
let subscribeThrow = false;
let historyRet = "0";
let uploads = 0;
let imageByUriMode: "ok" | "empty" | "nested" = "ok";
let lastConversationId = "";
let lastPaidPrompt = "";
let rowAtPaidPost: any = null;
let inspectTaskId = "";
let historyIdLookups: string[][] = [];
let recoveryAssets: unknown | undefined;
let recoveryHistories: Record<string, unknown> | undefined;
let assetQueries = 0;
const sessionToAccount = new Map<string, string>();

function header(config: any, name: string): string {
  const headers = config.headers || {};
  if (typeof headers.get === "function") {
    return String(headers.get(name) || headers.get(name.toLowerCase()) || "");
  }
  return String(headers[name] || headers[name.toLowerCase()] || "");
}

function cookieSession(config: any): string {
  const cookie = header(config, "Cookie");
  const match = /(?:^|; )sessionid=([^;]+)/.exec(`; ${cookie}`);
  return match?.[1] || "";
}

function body(config: any): any {
  const data = config.data;
  if (data == null || data === "") return {};
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch { return {}; }
  }
  if (Buffer.isBuffer(data) || ArrayBuffer.isView(data)) return {};
  return data;
}

function recordAccount(config: any) {
  const accountId = sessionToAccount.get(cookieSession(config));
  if (accountId) observedAccountIds.push(accountId);
}

function subscribeSse() {
  const ids = [...new Set([lastConversationId, "conv-server-test-001"].filter(Boolean))];
  return ids.flatMap((id) => [
    "event: system",
    `data: ${JSON.stringify({ type: "conversation_created", conversation_id: id, history_record_id: "history-test-001" })}`,
    "",
  ]).join("\n") + "\n";
}

axios.defaults.adapter = async (config) => {
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
  if (url.includes("/mweb/v1/workspace/list")) {
    return ok({ workspaces: [] });
  }
  if (url.includes("/mweb/v1/get_asset_list")) {
    assetQueries++;
    return ok(recoveryAssets || { asset_list: [] });
  }
  if (url.includes("/mweb/v1/workspace/create")) {
    workspaceCreations++;
    const session = cookieSession(config);
    return ok({ workspace_id: session.replace(/^session-/, "workspace-account-") });
  }
  if (url.includes("/mweb/v1/get_image_by_uri")) {
    uploads++;
    recordAccount(config);
    if (imageByUriMode === "empty") return ok({ uri2image: {} });
    if (imageByUriMode === "nested") {
      return ok({
        data: {
          uri2image: {
            "tos-upload-test~tplv": {
              url: SOURCE_SIGNED_URL,
              image_width: 768,
              image_height: 1024,
            },
          },
        },
      });
    }
    return ok({
      uri2image: {
        "tos-upload-test": {
          image_url: SOURCE_SIGNED_URL,
          width: 768,
          height: 1024,
          item_id: "must-not-be-copied",
        },
      },
    });
  }
  if (url.includes("/submit_audit_job")) {
    return { data: { ret: "1", errmsg: "audit failed" }, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/creation_agent/v2/conversation")) {
    agentConversationSubmissions++;
    recordAccount(config);
    lastConversationId = String(body(config).conversation_id || "");
    paidConversationIds.push(lastConversationId);
    lastPaidPrompt = String(body(config).messages?.[0]?.content?.content_parts?.[1]?.text || "");
    if (inspectTaskId) rowAtPaidPost = readRow(inspectTaskId);
    if (hangConversationHandshake) await hangConversationHandshake;
    if (paidPostTimeout) throw Object.assign(Error("timeout"), { code: "ETIMEDOUT" });
    if (conversationRet === "4013") {
      throw Object.assign(Error("[请求失败]: 生成失败，疑似存在异常行为 private-token-not-for-client (错误码: 4013)"));
    }
    const stream = new PassThrough();
    if (hangStreams || hangConversationBody) {
      if (hangStreams) hangingStreams.push(stream);
      return { data: stream, status: 200, statusText: "OK", headers: {}, config };
    }
    stream.end(fs.readFileSync("tests/fixtures/agent-8k-success.sse"));
    return { data: stream, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/creation_agent/v2/subscribe_session")) {
    subscribeCalls++;
    if (subscribeThrow) throw Object.assign(Error("HTTP 401 Unauthorized"));
    if (hangSubscribeHandshake) await new Promise((resolve) => setTimeout(resolve, 2000));
    recordAccount(config);
    const stream = new PassThrough();
    if (hangStreams) {
      hangingStreams.push(stream);
      if (streamHistoryId) queueMicrotask(() => stream.write(subscribeSse()));
      return { data: stream, status: 200, statusText: "OK", headers: {}, config };
    }
    queueMicrotask(() => stream.end(subscribeSse()));
    return { data: stream, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/get_history_by_ids")) {
    const ids = body(config).history_ids;
    historyIdLookups.push(Array.isArray(ids) ? ids.map(String) : []);
    if (holdHistory) await new Promise((_, reject) => config.signal?.addEventListener?.("abort", () => {
      historyAborted = true;
      reject(Object.assign(Error("canceled"), { code: "ERR_CANCELED" }));
    }));
    if (historyRet === "1015") return { data: { ret: "1015", errmsg: "登录失效" }, status: 200, statusText: "OK", headers: {}, config };
    if (recoveryHistories) return ok(recoveryHistories[String(ids?.[0])] || {});
    const history = JSON.parse(fs.readFileSync("tests/fixtures/agent-8k-history-success.json", "utf8"));
    return ok(history);
  }
  if (url.includes("/passport/account/info/v2")) {
    return ok({ user_info: { is_vip: false } });
  }
  if (url.endsWith("/user_credit") || url.endsWith("/get_common_config")) {
    return ok(url.endsWith("/user_credit") ? { credit: { gift_credit: 500, purchase_credit: 0, vip_credit: 0 } } : {});
  }
  throw Error("unmocked axios network forbidden");
};

const managed = createApiKey("isolated upscale");
const owner = validateApiKey(managed.key).apiKeyId!;
const otherManaged = createApiKey("other isolated upscale");
const otherOwner = validateApiKey(otherManaged.key).apiKeyId!;
const authorization = `Bearer ${managed.key}`;
const input = { id: "upscale_test_1234567890", image: "data:image/png;base64,YQ==" };

function rememberAccount(account: { id: string }, sessionId: string) {
  sessionToAccount.set(sessionId, account.id);
  return account;
}

function isolateAccount(sessionId: string) {
  const account = rememberAccount(accountPool.create({ name: `upscale ${sessionId}`, sessionId }), sessionId);
  for (const item of accountPool.list()) accountPool.setEnabled(item.id, item.id === account.id);
  return account;
}

function resetNetwork() {
  // Stop this isolated fixture's prior monitors before resetting adapter counters.
  for (const row of database.prepare("SELECT id,owner FROM agent_upscale_tasks WHERE status IN ('submitting','running')").all() as any[]) cancelUpscaleTask(row.owner, row.id);
  agentConversationSubmissions = 0;
  workspaceCreations = 0;
  paidConversationIds = [];
  observedAccountIds = [];
  paidPostTimeout = false;
  conversationRet = "0";
  hangStreams = false;
  streamHistoryId = false;
  holdHistory = false;
  historyAborted = false;
  hangingStreams = [];
  hangSubscribeHandshake = false;
  hangConversationHandshake = null;
  hangConversationBody = false;
  subscribeCalls = 0;
  subscribeThrow = false;
  historyRet = "0";
  uploads = 0;
  imageByUriMode = "ok";
  lastConversationId = "";
  lastPaidPrompt = "";
  rowAtPaidPost = null;
  inspectTaskId = "";
  historyIdLookups = [];
  recoveryAssets = recoveryHistories = undefined;
  assetQueries = 0;
}

function readRow(id: string) {
  return database.prepare("SELECT * FROM agent_upscale_tasks WHERE id = ?").get(id) as any;
}

function readStatus(id: string) {
  return readRow(id)?.status;
}

async function until(predicate: () => boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate());
}

function assertPublicBodySafe(payload: unknown, row?: any) {
  const text = JSON.stringify(payload);
  assert.equal(text.includes("session-"), false);
  assert.equal(text.includes(managed.key), false);
  assert.equal(text.includes(otherManaged.key), false);
  assert.equal(text.includes(SOURCE_SIGNED_URL), false);
  assert.equal("workspace_id" in ((payload as any)?.body || payload || {}), false);
  assert.equal("conversation_id" in ((payload as any)?.body || payload || {}), false);
  assert.equal("conversationId" in ((payload as any)?.body || payload || {}), false);
  if (row?.workspace_id) assert.equal(text.includes(row.workspace_id), false);
  if (row?.conversation_id) assert.equal(text.includes(row.conversation_id), false);
}

describe("agent upscale tasks", { concurrency: 1 }, () => {
test("strict upscale input accepts one safe image only", () => {
  const valid = upscaleTaskInput({ id: "upscale_test_1234567890", image: "data:image/png;base64,YQ==" });
  assert.equal(valid.id, "upscale_test_1234567890");
  assert.equal(valid.resolution, "8k");
  assert.equal(upscaleTaskInput({ ...valid, resolution: "4k" }).resolution, "4k");
  assert.throws(() => upscaleTaskInput({ ...valid, resolution: "2k" }));
  assert.throws(() => upscaleTaskInput({ ...valid, image: "file:///etc/passwd" }));
  assert.throws(() => upscaleTaskInput({ ...valid, image: "https://127.0.0.1/a.png" }));
});

test("custom detail survives storage and idempotent requests without a second paid POST", async () => {
  resetNetwork(); isolateAccount("session-detail");
  const payload = { ...input, id: "upscale_detail_123456789", detailStrength: 0 };
  const first = await createUpscaleTask(owner, authorization, payload); assert.equal(first.status, 202);
  await until(() => readStatus(payload.id) === "succeeded", 8000);
  assert.equal(lastPaidPrompt, "帮我8k高清放大，细节生成程度0");
  assert.equal(readRow(payload.id).detail_strength, 0);
  assert.equal((await createUpscaleTask(owner, authorization, payload)).status, 200);
  assert.equal((await createUpscaleTask(owner, authorization, { ...payload, detailStrength: 100 })).status, 409);
  assert.equal(agentConversationSubmissions, 1);
  for (const detailStrength of [-1, 101, 1.5, "50", null]) assert.throws(() => upscaleTaskInput({ ...payload, detailStrength }));
});

test("separate generations reuse an account workspace with independent task conversations", async () => {
  resetNetwork(); isolateAccount("session-workspace-reuse");
  const first = { ...input, id: "upscale_reuse_first_123456" };
  const second = { ...input, id: "upscale_reuse_second_123456", resolution: "4k" };
  await createUpscaleTask(owner, authorization, first);
  await until(() => readStatus(first.id) === "succeeded", 8000);
  const workspaceId = readRow(first.id).workspace_id;
  await createUpscaleTask(owner, authorization, second);
  await until(() => readStatus(second.id) === "succeeded", 8000);
  assert.equal(readRow(second.id).workspace_id, workspaceId);
  assert.equal(workspaceCreations, 1);
  assert.equal(agentConversationSubmissions, 2);
  assert.equal(new Set(paidConversationIds).size, 2);
});

test("duplicate POST never sends another paid Agent conversation", async () => {
  resetNetwork();
  isolateAccount("session-duplicate");
  const payload = { ...input, id: "upscale_dup_12345678901" };
  const first = await createUpscaleTask(owner, authorization, payload);
  assert.equal(first.status, 202);
  await until(() => ["running", "succeeded", "failed"].includes(String(readStatus(payload.id))), 8000);
  const second = await createUpscaleTask(owner, authorization, { ...payload, resolution: "8k" });
  assert.equal(second.status, 200);
  assert.equal(agentConversationSubmissions, 1);
  await until(() => readStatus(payload.id) === "succeeded", 8000);
  assert.equal(agentConversationSubmissions, 1);
  const row = readRow(payload.id);
  assert.equal(row.credential, "");
  assert.equal(row.reference_item_id, "");
  assert.equal(row.reference_uri, "tos-upload-test");
  const result = await queryUpscaleTask(owner, payload.id);
  assert.equal(result.body.status, "succeeded");
  assert.equal(result.body.providerLabel, "8K");
  assert.equal(result.body.creditsUsed, 4);
  assert.equal(result.body.data[0].url, RESULT_URL);
  assert.equal((await queryUpscaleTask(otherOwner, payload.id)).status, 404);
  assert.equal((await createUpscaleTask(owner, authorization, { ...payload, image: "data:image/jpeg;base64,Yg==" })).status, 409);
  assertPublicBodySafe(first, row);
  assertPublicBodySafe(second, row);
  assertPublicBodySafe(result, row);
  assert.equal(JSON.stringify(result).includes("private-token"), false);
});

test("cancel-before-create tombstone blocks upload and paid dispatch", async () => {
  resetNetwork();
  isolateAccount("session-cancel");
  const id = "upscale_cancel_1234567890";
  assert.equal(cancelUpscaleTask(owner, id).status, 200);
  assert.equal((await createUpscaleTask(owner, authorization, { ...input, id })).status, 409);
  assert.equal(agentConversationSubmissions, 0);
  assert.equal(uploads, 0);
});

test("one task keeps one account through upload, conversation and subscription", async () => {
  resetNetwork();
  const pinnedAccount = isolateAccount("session-pinned");
  await createUpscaleTask(owner, authorization, { ...input, id: "upscale_pinned_1234567890" });
  await until(() => observedAccountIds.length >= 3);
  assert.deepEqual(observedAccountIds.slice(0, 3), [pinnedAccount.id, pinnedAccount.id, pinnedAccount.id]);
  assert.equal(readRow("upscale_pinned_1234567890").account_id, pinnedAccount.id);
});

test("empty get_image_by_uri surfaces the parse error and does not start a paid conversation", async () => {
  resetNetwork();
  isolateAccount("session-parse");
  imageByUriMode = "empty";
  const id = "upscale_parse_1234567890";
  await createUpscaleTask(owner, authorization, { ...input, id });
  await until(() => readStatus(id) === "failed", 20000);
  assert.equal(agentConversationSubmissions, 0);
  const result = await queryUpscaleTask(owner, id);
  assert.equal(result.body.error, "即梦参考图信息解析失败");
  assert.equal(readRow(id).reference_uri, "");
  assertPublicBodySafe(result, readRow(id));
});

test("nested get_image_by_uri still reaches paid conversation", async () => {
  resetNetwork();
  isolateAccount("session-nested");
  imageByUriMode = "nested";
  const id = "upscale_nested_1234567890";
  await createUpscaleTask(owner, authorization, { ...input, id });
  await until(() => ["running", "succeeded"].includes(String(readStatus(id))));
  assert.equal(agentConversationSubmissions, 1);
  assert.equal(readRow(id).reference_uri, "tos-upload-test");
});

test("empty get_image_by_uri with a real PNG still does not start a paid conversation", async () => {
  resetNetwork();
  isolateAccount("session-local-png");
  imageByUriMode = "empty";
  const id = "upscale_localpng_12345678";
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await createUpscaleTask(owner, authorization, { ...input, id, image });
  await until(() => readStatus(id) === "failed", 20000);
  assert.equal(agentConversationSubmissions, 0);
  const result = await queryUpscaleTask(owner, id);
  assert.equal(result.body.error, "即梦参考图信息解析失败");
});

test("open conversation stream still finishes when subscribe returns the history id", async () => {
  resetNetwork();
  isolateAccount("session-open-stream");
  hangConversationBody = true;
  const id = "upscale_open_stream_1234";
  try {
    await createUpscaleTask(owner, authorization, { ...input, id });
    await until(() => readStatus(id) === "succeeded", 8000);
    assert.equal(agentConversationSubmissions, 1);
    assert.ok(subscribeCalls >= 1);
    assert.deepEqual(historyIdLookups[0], ["history-test-001"]);
  } finally {
    hangConversationBody = false;
  }
});

test("history polling completes while both SSE streams stay open, without a browser refresh or paid retry", async () => {
  resetNetwork();
  isolateAccount("session-history-parallel");
  hangStreams = true;
  streamHistoryId = true;
  const id = "upscale_history_parallel_1";
  try {
    await createUpscaleTask(owner, authorization, { ...input, id });
    await until(() => hangingStreams.length === 2);
    assert.ok(hangingStreams.every((stream) => !stream.destroyed));
    await until(() => readStatus(id) === "succeeded", 4000);
    assert.equal(agentConversationSubmissions, 1);
    assert.deepEqual(historyIdLookups, [["history-test-001"]]);
    assert.equal((await queryUpscaleTask(owner, id)).body.data[0].url, RESULT_URL);
    await until(() => hangingStreams.every((stream) => stream.destroyed));
  } finally {
    cancelUpscaleTask(owner, id);
  }
});

test("cancel aborts an independent history read and never revives the task", async () => {
  resetNetwork();
  isolateAccount("session-history-cancel");
  hangStreams = true;
  streamHistoryId = true;
  holdHistory = true;
  const id = "upscale_history_cancel_12";
  await createUpscaleTask(owner, authorization, { ...input, id });
  await until(() => historyIdLookups.length === 1);
  cancelUpscaleTask(owner, id);
  await until(() => historyAborted && hangingStreams.every((stream) => stream.destroyed));
  assert.equal(readStatus(id), "canceled");
  assert.equal(historyIdLookups.length, 1);
  assert.equal(agentConversationSubmissions, 1);
});

test("ambiguous paid POST is not replayed", async () => {
  resetNetwork();
  isolateAccount("session-ambiguous");
  paidPostTimeout = true;
  try {
    await createUpscaleTask(owner, authorization, { ...input, id: "upscale_ambiguous_123456" });
    await until(() => readStatus("upscale_ambiguous_123456") === "succeeded", 8000);
    assert.equal(agentConversationSubmissions, 1);
    const result = await queryUpscaleTask(owner, "upscale_ambiguous_123456");
    assert.equal(result.body.status, "succeeded");
    assert.ok(subscribeCalls >= 1);
    assert.equal(readRow("upscale_ambiguous_123456").credential, "");
    assert.equal((await createUpscaleTask(owner, authorization, { ...input, id: "upscale_ambiguous_123456" })).status, 200);
    assert.equal(agentConversationSubmissions, 1);
    assertPublicBodySafe(result, readRow("upscale_ambiguous_123456"));
  } finally {
    paidPostTimeout = false;
  }
});

test("4013 cools the pinned account and does not switch accounts", async () => {
  resetNetwork();
  const riskAccount = isolateAccount("session-risk");
  conversationRet = "4013";
  try {
    const id = "upscale_risk_1234567890";
    await createUpscaleTask(owner, authorization, { ...input, id });
    await until(() => readStatus(id) === "failed");
    const row = readRow(id);
    assert.equal(row.account_id, riskAccount.id);
    assert.equal(row.credential, "");
    assert.equal(agentConversationSubmissions, 1);
    const cooldown = accountPool.get(riskAccount.id).cooldownUntil;
    assert.ok(!cooldown, "request risk must not cool the shared account");
    const result = await queryUpscaleTask(owner, id);
    assert.match(String(result.body.error), /4013/);
    assert.equal(JSON.stringify(result).includes("private-token"), false);
    assertPublicBodySafe(result, row);
    assert.equal((await createUpscaleTask(owner, authorization, { ...input, id })).status, 200);
    assert.equal(agentConversationSubmissions, 1);
    assert.equal(readRow(id).account_id, riskAccount.id);
  } finally {
    conversationRet = "0";
  }
});

test("query returns the current row without waiting for subscribe", async () => {
  resetNetwork();
  isolateAccount("session-query");
  hangStreams = true;
  try {
    const id = "upscale_query_1234567890";
    await createUpscaleTask(owner, authorization, { ...input, id });
    await until(() => readStatus(id) === "running");
    const started = Date.now();
    const result = await queryUpscaleTask(owner, id);
    assert.ok(Date.now() - started < 400);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "running");
    assertPublicBodySafe(result, readRow(id));
  } finally {
    hangStreams = false;
  }
});

test("restored query looks up history with the saved history id", async () => {
  resetNetwork();
  const account = isolateAccount("session-restore");
  const id = "upscale_restore_1234567890";
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ id, image: input.image })).digest("hex");
  database.prepare(`INSERT INTO agent_upscale_tasks (
    id, owner, fingerprint, status, account_id, credential, workspace_id, conversation_id,
    provider_task_id, history_id, deadline
  ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`).run(
    id, owner, fingerprint, account.id, encrypt("session-restore"), "workspace-account-restore",
    "conv-restore-001", "submit-test-001", "history-test-001", Date.now() + 60_000,
  );
  await queryUpscaleTask(owner, id);
  await until(() => historyIdLookups.length > 0);
  assert.deepEqual(historyIdLookups[0], ["history-test-001"]);
  const row = readRow(id);
  assert.equal(row.provider_task_id, "submit-test-001");
  assert.equal(row.history_id, "history-test-001");
});

test("query at deadline returns without waiting for subscribe", async () => {
  resetNetwork();
  isolateAccount("session-deadline");
  hangStreams = true;
  hangSubscribeHandshake = true;
  try {
    const id = "upscale_deadline_1234567";
    await createUpscaleTask(owner, authorization, { ...input, id });
    await until(() => readStatus(id) === "running");
    database.prepare("UPDATE agent_upscale_tasks SET deadline = ? WHERE id = ?").run(Date.now() - 1, id);
    const started = Date.now();
    const result = await queryUpscaleTask(owner, id);
    assert.ok(Date.now() - started < 400);
    assert.equal(result.status, 200);
    assertPublicBodySafe(result, readRow(id));
  } finally {
    hangStreams = false;
    hangSubscribeHandshake = false;
  }
});

test("query during paid POST does not promote or subscribe", async () => {
  resetNetwork();
  isolateAccount("session-inflight-query");
  let release: () => void = () => {};
  hangConversationHandshake = new Promise((resolve) => { release = resolve; });
  const id = "upscale_inflight_query_12";
  try {
    await createUpscaleTask(owner, authorization, { ...input, id });
    await until(() => agentConversationSubmissions === 1);
    const result = await queryUpscaleTask(owner, id);
    assert.equal(result.status, 200);
    assert.equal(readStatus(id), "submitting");
    assert.equal(subscribeCalls, 0);
  } finally {
    release();
    hangConversationHandshake = null;
  }
  await until(() => ["running", "succeeded", "failed"].includes(String(readStatus(id))));
});

test("conversation_id is persisted before the paid POST and restart does not replay it", async () => {
  resetNetwork();
  isolateAccount("session-before-post");
  const id = "upscale_before_post_1234";
  inspectTaskId = id;
  await createUpscaleTask(owner, authorization, { ...input, id });
  await until(() => agentConversationSubmissions === 1);
  assert.ok(rowAtPaidPost?.conversation_id);
  assert.equal(rowAtPaidPost.conversation_id, lastConversationId);
  assert.ok(rowAtPaidPost.paid_started_at > 0);

  const restartId = "upscale_restart_ro_12345";
  const account = isolateAccount("session-restart-ro");
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ id: restartId, image: input.image })).digest("hex");
  database.prepare(`INSERT INTO agent_upscale_tasks (
    id, owner, fingerprint, status, account_id, credential, workspace_id, conversation_id, deadline
  ) VALUES (?, ?, ?, 'submitting', ?, ?, ?, ?, ?)`).run(
    restartId, owner, fingerprint, account.id, encrypt("session-restart-ro"), "workspace-account-restart-ro",
    "conv-restart-readonly-1", Date.now() + 60_000,
  );
  const before = agentConversationSubmissions;
  const queried = await queryUpscaleTask(owner, restartId);
  assert.equal(queried.status, 200);
  assert.equal(readStatus(restartId), "running");
  assert.equal(readRow(restartId).error, "");
  const created = await createUpscaleTask(owner, authorization, { ...input, id: restartId });
  assert.equal(created.status, 200);
  assert.equal(agentConversationSubmissions, before);
});

test("query after deadline keeps an unconfirmed original task without opening a subscription", async () => {
  resetNetwork();
  const account = isolateAccount("session-deadline-throw");
  const id = "upscale_deadline_throw_12";
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ id, image: input.image })).digest("hex");
  database.prepare(`INSERT INTO agent_upscale_tasks (
      id, owner, fingerprint, status, account_id, credential, workspace_id, conversation_id, deadline
    ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`).run(
    id, owner, fingerprint, account.id, encrypt("session-deadline-throw"), "workspace-account-deadline-throw",
    "conv-deadline-throw-1", Date.now() - 1,
  );
  const started = Date.now();
  const result = await queryUpscaleTask(owner, id);
  assert.ok(Date.now() - started < 400);
  assert.equal(result.status, 200);
  await until(() => Boolean(readRow(id).error));
  const row = readRow(id);
  assert.equal(row.status, "running");
  assert.ok(row.credential);
  assert.equal(row.conversation_id, "conv-deadline-throw-1");
  assert.match(String(row.error), /上游可能继续运行/);
  assert.equal(subscribeCalls, 0);
  assert.equal(accountPool.get(account.id).cooldownUntil || "", "");
  assertPublicBodySafe(result, row);
});

test("canceling a running task closes its paid and subscription streams", async () => {
  resetNetwork();
  isolateAccount("session-cancel-streams");
  hangStreams = true;
  const id = "upscale_cancel_streams_123";
  try {
    await createUpscaleTask(owner, authorization, { ...input, id });
    await until(() => readStatus(id) === "running" && hangingStreams.length === 2);
    assert.equal(cancelUpscaleTask(owner, id).body.status, "canceled");
    await until(() => hangingStreams.every((stream) => stream.destroyed), 3000);
    assert.equal(agentConversationSubmissions, 1);
  } finally {
    hangStreams = false;
  }
});

test("conversation without a provider id stops waiting after 10 minutes and keeps recovery evidence", async () => {
  resetNetwork();
  const account = isolateAccount("session-no-progress");
  const id = "upscale_no_progress_12345";
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ id, image: input.image })).digest("hex");
  database.prepare(`INSERT INTO agent_upscale_tasks (
    id, owner, fingerprint, status, account_id, credential, workspace_id, conversation_id, paid_started_at, deadline
  ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`).run(
    id, owner, fingerprint, account.id, encrypt("session-no-progress"), "workspace-account-no-progress",
    "conv-no-progress-1", Date.now() - 10 * 60_000 - 1, Date.now() + 40 * 60_000,
  );
  const result = await queryUpscaleTask(owner, id);
  assert.equal(result.status, 200);
  await until(() => Boolean(readRow(id).error));
  assert.equal(readStatus(id), "running");
  assert.match(String(readRow(id).error), /10分钟/);
  assert.ok(readRow(id).credential);
  assert.equal(subscribeCalls, 0);
  assert.equal(agentConversationSubmissions, 0);
});

function seedExpiredOriginal(id: string, status = "running") {
  const session = "session-original-recovery-" + id;
  const account = isolateAccount(session);
  database.prepare(`INSERT INTO agent_upscale_tasks (id,owner,fingerprint,status,account_id,credential,workspace_id,conversation_id,provider_task_id,history_id,deadline)
    VALUES (?,?,?, ?,?,?,?,?,?,?,?)`).run(id, owner, "fixture", status, account.id, encrypt(session), "workspace-original", "conversation-original", "submit-original", "history-unrelated", Date.now() - 1);
}

test("expired wrong history uses original receipt and saves confirmed success without a paid POST", async () => {
  resetNetwork();
  const id = "upscale_recover_expired_123"; seedExpiredOriginal(id);
  recoveryAssets = JSON.parse(fs.readFileSync("tests/fixtures/agent-original-history-recovery.json", "utf8"));
  recoveryHistories = { "history-unrelated": {}, "history-original": { history_list: [{ history_record_id: "history-original", task: { submit_id: "submit-original" }, status: 50, item_list: [{ image: { image_url: RESULT_URL } }] }] } };
  await queryUpscaleTask(owner, id);
  await until(() => readStatus(id) === "succeeded");
  const row = readRow(id);
  assert.equal(row.history_id, "history-original");
  assert.equal(row.provider_task_id, "submit-original");
  assert.equal(row.credits_used, 4);
  assert.equal(row.credential, "");
  assert.deepEqual(JSON.parse(row.result), [{ url: RESULT_URL }]);
  assert.deepEqual(historyIdLookups, [["history-unrelated"], ["history-original"]]);
  assert.equal(assetQueries, 1);
  assert.equal(subscribeCalls + workspaceCreations + agentConversationSubmissions + uploads, 0);
  await queryUpscaleTask(owner, id);
  assert.equal(historyIdLookups.length, 2);
});

test("expired mismatched tool receipt remains unconfirmed with original IDs and credential", async () => {
  resetNetwork();
  const id = "upscale_recover_mismatch_123"; seedExpiredOriginal(id);
  recoveryAssets = JSON.parse(fs.readFileSync("tests/fixtures/agent-original-history-recovery.json", "utf8").replaceAll("submit-original", "submit-other"));
  recoveryHistories = { "history-unrelated": {} };
  const credential = readRow(id).credential;
  await queryUpscaleTask(owner, id);
  await until(() => Boolean(readRow(id).error));
  assert.equal(readStatus(id), "running");
  assert.equal(readRow(id).credential, credential);
  assert.equal(readRow(id).history_id, "history-unrelated");
  assert.equal(readRow(id).provider_task_id, "submit-original");
  assert.match(readRow(id).error, /上游可能继续运行/);
  assert.deepEqual(historyIdLookups, [["history-unrelated"]]);
  assert.equal(assetQueries, 1);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(historyIdLookups.length, 1);
  assert.equal(subscribeCalls + workspaceCreations + agentConversationSubmissions + uploads, 0);
});

test("deadline final read aborts within one 15 second budget and retains original evidence", async () => {
  resetNetwork();
  const id = "upscale_recover_budget_123"; seedExpiredOriginal(id);
  holdHistory = true;
  const started = Date.now();
  try {
    await queryUpscaleTask(owner, id);
    await until(() => Boolean(readRow(id).error), 16_500);
    assert.ok(Date.now() - started < 16_500);
    assert.equal(historyAborted, true);
    assert.equal(readStatus(id), "running");
    assert.ok(readRow(id).credential);
    assert.equal(readRow(id).history_id, "history-unrelated");
    assert.equal(historyIdLookups.length, 1);
    assert.equal(subscribeCalls + workspaceCreations + agentConversationSubmissions + uploads, 0);
  } finally { holdHistory = false; }
});

test("explicitly failed and canceled tasks remain terminal and are never recovered", async () => {
  resetNetwork();
  for (const status of ["failed", "canceled"]) {
    const id = "upscale_terminal_" + status + "_123"; seedExpiredOriginal(id, status);
    const before = readRow(id);
    assert.equal((await queryUpscaleTask(owner, id)).body.status, status);
    assert.deepEqual(readRow(id), before);
  }
  assert.equal(historyIdLookups.length + assetQueries + subscribeCalls + agentConversationSubmissions + uploads + workspaceCreations, 0);
});

test("4K task persists its mode and cannot reuse the same ID as 8K", async () => {
  resetNetwork();
  isolateAccount("session-4k");
  const payload = { ...input, id: "upscale_4k_task_123456", resolution: "4k" };
  const first = await createUpscaleTask(owner, authorization, payload);
  assert.equal(first.status, 202);
  assert.equal(first.body.resolution, "4k");
  await until(() => agentConversationSubmissions === 1);
  assert.equal(lastPaidPrompt, "帮我4k高清放大");
  assert.equal(readRow(payload.id).resolution, "4k");
  assert.equal((await createUpscaleTask(owner, authorization, payload)).status, 200);
  assert.equal((await createUpscaleTask(owner, authorization, { ...payload, resolution: "8k" })).status, 409);
  assert.equal(agentConversationSubmissions, 1);
  await until(() => readStatus(payload.id) === "succeeded", 8000);
});

test("terminal result refresh reads the exact original account and receipt without mutating history or resubmitting", async () => {
  resetNetwork();
  const account = isolateAccount("session-original-result-refresh");
  const payload = { ...input, id: "upscale_original_refresh_123" };
  await createUpscaleTask(owner, authorization, payload);
  await until(() => readStatus(payload.id) === "succeeded", 8000);
  database.prepare("UPDATE agent_upscale_tasks SET result=?,deadline=0 WHERE id=?").run(JSON.stringify([{ url: "https://fixture.invalid/expired.png" }]), payload.id);
  const before = readRow(payload.id);
  const accountBefore = database.prepare("SELECT last_used_at,selection_seq,cooldown_until,updated_at FROM jimeng_accounts WHERE id=?").get(account.id);
  const submissions = agentConversationSubmissions;
  const firstQueries = historyIdLookups.length;
  assert.equal((await queryUpscaleTask(otherOwner, payload.id, true, account.id)).status, 404);
  assert.equal((await queryUpscaleTask(owner, payload.id, true, "wrong-original-account")).status, 404);
  assert.equal(historyIdLookups.length, firstQueries);
  const fresh = await queryUpscaleTask(owner, payload.id, true, account.id);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.status, "succeeded");
  assert.equal(fresh.body.data[0].url, RESULT_URL);
  assert.equal(agentConversationSubmissions, submissions);
  assert.deepEqual(readRow(payload.id), before);
  assert.deepEqual(database.prepare("SELECT last_used_at,selection_seq,cooldown_until,updated_at FROM jimeng_accounts WHERE id=?").get(account.id), accountBefore);
  database.prepare("UPDATE agent_upscale_tasks SET status='failed',error='等待超时，未重新生成' WHERE id=?").run(payload.id);
  const failedBefore = readRow(payload.id);
  assert.equal((await queryUpscaleTask(owner, payload.id, true, account.id)).body.status, "succeeded");
  assert.deepEqual(readRow(payload.id), failedBefore);
  assert.equal(agentConversationSubmissions, submissions);
});

test("submitting row past deadline without conversation is fail-closed without a paid POST", async () => {
  resetNetwork();
  const account = isolateAccount("session-stale-submit");
  const id = "upscale_stale_submit_123";
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ id, image: input.image })).digest("hex");
  database.prepare(`INSERT INTO agent_upscale_tasks (
    id, owner, fingerprint, status, account_id, credential, deadline
  ) VALUES (?, ?, ?, 'submitting', ?, ?, ?)`).run(
    id, owner, fingerprint, account.id, encrypt("session-stale-submit"), Date.now() - 1,
  );
  const before = agentConversationSubmissions;
  const started = Date.now();
  const result = await queryUpscaleTask(owner, id);
  assert.ok(Date.now() - started < 400);
  assert.equal(result.status, 200);
  await until(() => readStatus(id) === "failed");
  assert.equal(agentConversationSubmissions, before);
  assert.equal(uploads, 0);
  assert.match(String(readRow(id).error), /超时|未确认/);
  assert.equal(readRow(id).credential, "");
});
});
