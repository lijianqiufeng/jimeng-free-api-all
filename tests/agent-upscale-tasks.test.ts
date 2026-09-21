import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import axios from "axios";
import { database, createApiKey, validateApiKey } from "@/lib/database.ts";
import accountPool from "@/lib/account-pool.ts";
import { upscaleTaskInput } from "@/api/controllers/upscale-task-contract.ts";
import { createUpscaleTask, queryUpscaleTask, cancelUpscaleTask } from "@/api/controllers/upscale-tasks.ts";

globalThis.fetch = async () => { throw Error("unmocked network forbidden"); };

const SOURCE_SIGNED_URL = "https://fixture.invalid/original.webp";
const RESULT_URL = "https://fixture.invalid/result-8k.webp";

let agentConversationSubmissions = 0;
let observedAccountIds: string[] = [];
let paidPostTimeout = false;
let conversationRet = "0";
let hangStreams = false;
let uploads = 0;
let lastConversationId = "";
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
  if (url.includes("/mweb/v1/workspace/create")) {
    const session = cookieSession(config);
    return ok({ workspace_id: session.replace(/^session-/, "workspace-account-") });
  }
  if (url.includes("/mweb/v1/get_image_by_uri")) {
    uploads++;
    recordAccount(config);
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
    if (paidPostTimeout) throw Object.assign(Error("timeout"), { code: "ETIMEDOUT" });
    if (conversationRet === "4013") {
      throw Object.assign(Error("[请求失败]: 生成失败，疑似存在异常行为 private-token-not-for-client (错误码: 4013)"));
    }
    const stream = new PassThrough();
    if (hangStreams) return { data: stream, status: 200, statusText: "OK", headers: {}, config };
    stream.end(fs.readFileSync("tests/fixtures/agent-8k-success.sse"));
    return { data: stream, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/creation_agent/v2/subscribe_session")) {
    recordAccount(config);
    const stream = new PassThrough();
    if (hangStreams) return { data: stream, status: 200, statusText: "OK", headers: {}, config };
    queueMicrotask(() => stream.end(subscribeSse()));
    return { data: stream, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/get_history_by_ids")) {
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
  agentConversationSubmissions = 0;
  observedAccountIds = [];
  paidPostTimeout = false;
  conversationRet = "0";
  hangStreams = false;
  uploads = 0;
  lastConversationId = "";
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
  assert.throws(() => upscaleTaskInput({ ...valid, image: "file:///etc/passwd" }));
  assert.throws(() => upscaleTaskInput({ ...valid, image: "https://127.0.0.1/a.png" }));
});

test("duplicate POST never sends another paid Agent conversation", async () => {
  resetNetwork();
  isolateAccount("session-duplicate");
  const first = await createUpscaleTask(owner, authorization, input);
  assert.equal(first.status, 202);
  await until(() => ["running", "succeeded", "failed"].includes(String(readStatus(input.id))));
  const second = await createUpscaleTask(owner, authorization, input);
  assert.equal(second.status, 200);
  assert.equal(agentConversationSubmissions, 1);
  await until(() => readStatus(input.id) === "succeeded");
  assert.equal(agentConversationSubmissions, 1);
  const row = readRow(input.id);
  assert.equal(row.credential, "");
  assert.equal(row.reference_item_id, "");
  assert.equal(row.reference_uri, "tos-upload-test");
  const result = await queryUpscaleTask(owner, input.id);
  assert.equal(result.body.status, "succeeded");
  assert.equal(result.body.providerLabel, "8K");
  assert.equal(result.body.creditsUsed, 4);
  assert.equal(result.body.data[0].url, RESULT_URL);
  assert.equal((await queryUpscaleTask(otherOwner, input.id)).status, 404);
  assert.equal((await createUpscaleTask(owner, authorization, { ...input, image: "data:image/jpeg;base64,Yg==" })).status, 409);
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

test("ambiguous paid POST is not replayed", async () => {
  resetNetwork();
  isolateAccount("session-ambiguous");
  paidPostTimeout = true;
  try {
    await createUpscaleTask(owner, authorization, { ...input, id: "upscale_ambiguous_123456" });
    await until(() => readStatus("upscale_ambiguous_123456") === "failed");
    assert.equal(agentConversationSubmissions, 1);
    const result = await queryUpscaleTask(owner, "upscale_ambiguous_123456");
    assert.equal(result.body.error, "提交结果未确认；为避免重复扣积分未自动重提");
    assert.match(String(result.body.error), /未确认/);
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
    assert.ok(cooldown && Date.parse(cooldown) - Date.now() > 55 * 60_000);
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
});
