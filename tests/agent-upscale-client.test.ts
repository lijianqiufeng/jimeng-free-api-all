import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import axios from "axios";
import { createAgentObservation } from "@/api/controllers/agent-upscale-protocol.ts";
import {
  consumeAgentStream,
  ensureAgentWorkspace,
  prepareAgentAttachment,
  queryAgentHistory,
  startAgentConversation,
  subscribeAgentWorkspace,
} from "@/api/controllers/agent-upscale-client.ts";

globalThis.fetch = async () => { throw Error("unmocked network forbidden"); };

const BABI_PARAM = {
  feature_entrance: "to-generate",
  feature_entrance_detail: "to-generate-creation_agent",
  feature_key: "creation_agent",
  scenario: "image_video_generation",
  edit_type: "agent",
};

const attachmentFixture = {
  uri: "tos-upload-test",
  url: "https://fixture.invalid/original.webp",
  width: 768,
  height: 1024,
};

let workspaceListSessions: string[] = [];
let workspaceCreateBodies: Array<{ name: string }> = [];
let getImageUris: unknown[] = [];
let auditUriLists: unknown[] = [];
let conversationPosts = 0;
let timeoutConversation = false;
let lastConversation: any;
let historyQueries = 0;
let subscribeBodies: unknown[] = [];
let subscribePayload = "";

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

function queryParam(config: any, key: string): string {
  const params = config.params || {};
  if (params[key] != null) return String(params[key]);
  try {
    return new URL(String(config.url), "https://jimeng.jianying.com").searchParams.get(key) || "";
  } catch {
    return "";
  }
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
    const session = cookieSession(config);
    if (!session) throw Error("workspace/list must run under the selected session");
    workspaceListSessions.push(session);
    return ok({ workspaces: [] });
  }
  if (url.includes("/mweb/v1/workspace/create")) {
    const payload = body(config);
    if (payload.name !== "CPA 智能高清") throw Error("workspace/create must send the CPA workspace name");
    const session = cookieSession(config);
    if (!session) throw Error("workspace/create must run under the selected session");
    workspaceCreateBodies.push({ name: payload.name });
    return ok({ workspace_id: session.replace(/^session-/, "workspace-account-") });
  }
  if (url.includes("/mweb/v1/get_image_by_uri")) {
    const uris = body(config).uris;
    if (!Array.isArray(uris) || !uris.includes("tos-upload-test")) throw Error("get_image_by_uri must receive the uploaded URI");
    getImageUris.push(uris);
    return ok({
      uri2image: {
        "tos-upload-test": {
          image_url: "https://fixture.invalid/original.webp",
          width: 768,
          height: 1024,
          item_id: "must-not-be-copied",
        },
      },
    });
  }
  if (url.includes("/submit_audit_job")) {
    const uriList = body(config).uri_list;
    if (!Array.isArray(uriList) || !uriList.includes("tos-upload-test")) throw Error("submit_audit_job must receive uri_list");
    auditUriLists.push(uriList);
    return { data: { ret: "1", errmsg: "audit failed" }, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/creation_agent/v2/conversation")) {
    conversationPosts++;
    lastConversation = config;
    if (timeoutConversation) throw Object.assign(Error("timeout"), { code: "ETIMEDOUT" });
    const stream = new PassThrough();
    stream.end(fs.readFileSync("tests/fixtures/agent-8k-success.sse"));
    return { data: stream, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/creation_agent/v2/subscribe_session")) {
    const payload = body(config);
    if (payload.workspace_id == null || payload.workspace_id === "") throw Error("subscribe_session must send workspace_id");
    subscribeBodies.push(payload);
    const stream = new PassThrough();
    queueMicrotask(() => stream.end(subscribePayload));
    return { data: stream, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/get_history_by_ids")) {
    historyQueries++;
    const history = JSON.parse(fs.readFileSync("tests/fixtures/agent-8k-history-success.json", "utf8"));
    return ok(history);
  }
  throw Error("unmocked axios network forbidden");
};

test("workspace cache is isolated by account", async () => {
  const a = await ensureAgentWorkspace("account-a", "session-a");
  const b = await ensureAgentWorkspace("account-b", "session-b");
  assert.equal(a, "workspace-account-a");
  assert.equal(b, "workspace-account-b");
  assert.notEqual(a, b);
  assert.deepEqual(workspaceListSessions, ["session-a", "session-b"]);
  assert.deepEqual(workspaceCreateBodies, [{ name: "CPA 智能高清" }, { name: "CPA 智能高清" }]);
  const cached = await ensureAgentWorkspace("account-a", "session-a");
  assert.equal(cached, a);
  assert.equal(workspaceListSessions.length, 2);
});

test("fresh upload resolves URL and dimensions without inventing item_id", async () => {
  const attachment = await prepareAgentAttachment("data:image/png;base64,YQ==", "session-a");
  assert.deepEqual(attachment, {
    uri: "tos-upload-test",
    url: "https://fixture.invalid/original.webp",
    width: 768,
    height: 1024,
  });
  assert.equal("itemId" in attachment, false);
  assert.deepEqual(getImageUris, [["tos-upload-test"]]);
  assert.deepEqual(auditUriLists, [["tos-upload-test"]]);
});

test("paid conversation timeout is not automatically retried", async () => {
  const before = conversationPosts;
  timeoutConversation = true;
  try {
    await assert.rejects(startAgentConversation("session-a", "workspace-account-a", attachmentFixture));
    assert.equal(conversationPosts, before + 1);
  } finally {
    timeoutConversation = false;
  }
});

test("paid conversation POST sends stream headers, babi_param and unique IDs", async () => {
  const first = await startAgentConversation("session-a", "workspace-account-a", attachmentFixture);
  const second = await startAgentConversation("session-a", "workspace-account-a", attachmentFixture);
  assert.ok(first.stream);
  assert.ok(first.observation.conversationId);
  assert.notEqual(first.observation.conversationId, second.observation.conversationId);
  assert.equal(lastConversation.responseType, "stream");
  assert.match(header(lastConversation, "Accept"), /text\/event-stream/);
  assert.equal(queryParam(lastConversation, "region"), "cn");
  assert.equal(queryParam(lastConversation, "da_version"), "3.1.3");
  assert.deepEqual(JSON.parse(queryParam(lastConversation, "babi_param")), BABI_PARAM);
  const payload = body(lastConversation);
  assert.equal(payload.conversation_id, second.observation.conversationId);
  assert.equal(JSON.stringify(payload).includes("item_id"), false);
  assert.equal(payload.messages[0].content.content_parts[1].text, "帮我8k高清放大");
  await consumeAgentStream(first.stream, first.observation, Date.now() + 1000);
  assert.equal(first.observation.submitId, "submit-test-001");
  assert.equal(first.observation.providerLabel, "8K");
});

test("subscribe parses only events for the task conversation", async () => {
  subscribePayload = [
    "event: system",
    `data: ${JSON.stringify({ type: "conversation_created", conversation_id: "conv-other", history_record_id: "history-other" })}`,
    "",
    "event: system",
    `data: ${JSON.stringify({ type: "conversation_created", conversation_id: "conv-keep", history_record_id: "history-keep" })}`,
    "",
    "event: system",
    `data: ${JSON.stringify({ type: "stream_complete", conversation_id: "conv-other" })}`,
    "",
  ].join("\n");
  const observation = createAgentObservation("conv-keep");
  await subscribeAgentWorkspace("session-a", "workspace-account-a", observation, Date.now() + 1000);
  assert.deepEqual(subscribeBodies, [{ workspace_id: "workspace-account-a" }]);
  assert.equal(observation.historyId, "history-keep");
  assert.equal(observation.complete, false);
  assert.equal(observation.conversationId, "conv-keep");
});

test("history lookup is skipped until a history ID exists", async () => {
  const pending = createAgentObservation("conv-client-test-001");
  const running = await queryAgentHistory("session-a", pending);
  assert.deepEqual(running, { status: "running" });
  assert.equal(historyQueries, 0);
  pending.historyId = "history-test-001";
  pending.submitId = "submit-test-001";
  const result = await queryAgentHistory("session-a", pending);
  assert.equal(historyQueries, 1);
  assert.deepEqual(result, {
    status: "succeeded",
    providerLabel: "8K",
    creditsUsed: undefined,
    historyId: "history-test-001",
    urls: ["https://fixture.invalid/result-8k.webp"],
  });
});

test("stream consume accepts split chunks and stops at the deadline", async () => {
  const sse = fs.readFileSync("tests/fixtures/agent-8k-success.sse", "utf8");
  const stream = new PassThrough();
  const observation = createAgentObservation("conv-client-test-001");
  const consuming = consumeAgentStream(stream, observation, Date.now() + 1000);
  for (let index = 0; index < sse.length; index += 7) stream.write(sse.slice(index, index + 7));
  stream.end();
  await consuming;
  assert.equal(observation.submitId, "submit-test-001");
  assert.equal(observation.complete, true);

  const hanging = new PassThrough();
  const timedOut = createAgentObservation("conv-deadline");
  const started = Date.now();
  await consumeAgentStream(hanging, timedOut, Date.now() + 30);
  assert.ok(Date.now() - started < 400);
  assert.equal(timedOut.complete, false);
});
