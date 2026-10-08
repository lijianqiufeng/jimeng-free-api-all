import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PassThrough, Readable } from "node:stream";
import axios from "axios";
import { createAgentObservation } from "@/api/controllers/agent-upscale-protocol.ts";
import {
  consumeAgentStream,
  ensureAgentWorkspace,
  prepareAgentAttachment,
  queryAgentHistory,
  readAgentImageInfo,
  readDataUrlDimensions,
  readWorkspaceId,
  startAgentConversation,
  subscribeAgentWorkspace,
} from "@/api/controllers/agent-upscale-client.ts";
import { database } from "@/lib/database.ts";

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
let hangConversationHandshake = false;
let hangSubscribeHandshake = false;
let conversationHttpStatus = 200;
let lastConversation: any;
let lastSubscribe: any;
let historyQueries = 0;
let subscribeBodies: unknown[] = [];
let subscribePayload = "";
let imageByUriBodies: unknown[] | undefined;
let siblingUri2Image = false;
let lastGetImage: any;
let workspaceCreateData: unknown | undefined;
let recoveryAssets: unknown | undefined;
let recoveryHistories: Record<string, unknown> | undefined;
let recoveryRequests: Array<{ path: string; body: any }> = [];

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

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(Object.assign(Error("canceled"), { code: "ERR_CANCELED" }));
    signal.addEventListener("abort", () => reject(Object.assign(Error("canceled"), { code: "ERR_CANCELED" })), { once: true });
  });
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
    if (payload.name !== "图片高清放大") throw Error("workspace/create must send a product-facing name");
    const session = cookieSession(config);
    if (!session) throw Error("workspace/create must run under the selected session");
    workspaceCreateBodies.push({ name: payload.name });
    if (workspaceCreateData !== undefined) return ok(workspaceCreateData);
    return ok({ workspace_id: session.replace(/^session-/, "workspace-account-") });
  }
  if (url.includes("/mweb/v1/get_image_by_uri")) {
    const uris = body(config).uris;
    if (!Array.isArray(uris) || !uris.includes("tos-upload-test")) throw Error("get_image_by_uri must receive the uploaded URI");
    getImageUris.push(uris);
    lastGetImage = config;
    if (siblingUri2Image) {
      return {
        data: {
          ret: "0",
          errmsg: "success",
          logid: "log",
          uri2image: { "tos-upload-test": { image_url: "https://fixture.invalid/original.webp", width: 1536, height: 2752 } },
        },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    }
    if (imageByUriBodies) {
      if (!imageByUriBodies.length) throw Error("get_image_by_uri exhausted");
      return ok(imageByUriBodies.shift());
    }
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
    if (hangConversationHandshake) return waitForAbort(config.signal!);
    const stream = new PassThrough();
    stream.end(fs.readFileSync("tests/fixtures/agent-8k-success.sse"));
    if (conversationHttpStatus !== 200) {
      return { data: stream, status: conversationHttpStatus, statusText: "Unauthorized", headers: {}, config };
    }
    return { data: stream, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/creation_agent/v2/subscribe_session")) {
    const payload = body(config);
    if (payload.workspace_id == null || payload.workspace_id === "") throw Error("subscribe_session must send workspace_id");
    lastSubscribe = config;
    subscribeBodies.push(payload);
    if (hangSubscribeHandshake) return waitForAbort(config.signal!);
    const stream = new PassThrough();
    queueMicrotask(() => stream.end(subscribePayload));
    return { data: stream, status: 200, statusText: "OK", headers: {}, config };
  }
  if (url.includes("/get_history_by_ids")) {
    historyQueries++;
    if (recoveryHistories) {
      recoveryRequests.push({ path: "history", body: body(config) });
      return ok(recoveryHistories[String(body(config).history_ids?.[0])] || {});
    }
    const history = JSON.parse(fs.readFileSync("tests/fixtures/agent-8k-history-success.json", "utf8"));
    return ok(history);
  }
  if (url.includes("/get_asset_list") && recoveryAssets) {
    recoveryRequests.push({ path: "session", body: body(config) });
    return ok(recoveryAssets);
  }
  throw Error("unmocked axios network forbidden");
};

test("readWorkspaceId skips protobuf default 0", () => {
  assert.equal(readWorkspaceId({ workspace_id: 0, id: "7471122" }), "7471122");
  assert.equal(readWorkspaceId({ workspace_id: 0, workspace: { workspace_id: "7471122" } }), "7471122");
  assert.equal(readWorkspaceId({ workspaces: [{ workspace_id: 0 }, { workspace_id: "7473333" }] }), "7473333");
  assert.equal(readWorkspaceId({ workspace_id: 0 }), undefined);
  assert.equal(readWorkspaceId({ workspace_id: "0" }), undefined);
  assert.equal(readWorkspaceId({ workspace_id: "workspace-account-a" }), "workspace-account-a");
});

test("workspace create ignores default 0 and uses the real id", async () => {
  workspaceCreateData = { workspace_id: 0, id: "7471122" };
  try {
    assert.equal(await ensureAgentWorkspace("account-create-zero", "session-create-zero"), "7471122");
  } finally {
    workspaceCreateData = undefined;
  }
});

test("cached workspace id 0 is ignored and recreated", async () => {
  database.prepare("INSERT OR REPLACE INTO jimeng_agent_sessions(account_id, workspace_id, updated_at) VALUES(?,?,?)")
    .run("account-zero", "0", Date.now());
  const id = await ensureAgentWorkspace("account-zero", "session-zero");
  assert.equal(id, "workspace-account-zero");
  const cached = await ensureAgentWorkspace("account-zero", "session-zero");
  assert.equal(cached, id);
});

test("workspace cache is isolated by account", async () => {
  workspaceListSessions = [];
  workspaceCreateBodies = [];
  const a = await ensureAgentWorkspace("account-a", "session-a");
  const b = await ensureAgentWorkspace("account-b", "session-b");
  assert.equal(a, "workspace-account-a");
  assert.equal(b, "workspace-account-b");
  assert.notEqual(a, b);
  assert.deepEqual(workspaceListSessions, ["session-a", "session-b"]);
  assert.deepEqual(workspaceCreateBodies, [{ name: "图片高清放大" }, { name: "图片高清放大" }]);
  const cached = await ensureAgentWorkspace("account-a", "session-a");
  assert.equal(cached, a);
  assert.equal(workspaceListSessions.length, 2);
});

test("upscale reuses the account workspace without creating another sidebar item", async () => {
  const before = workspaceCreateBodies.length;
  workspaceCreateData = { workspace_id: "new-upscale-workspace" };
  try {
    assert.equal(await ensureAgentWorkspace("account-a", "session-a"), "workspace-account-a");
    assert.equal(workspaceCreateBodies.length, before);
    assert.equal(await ensureAgentWorkspace("account-a", "session-a"), "workspace-account-a");
  } finally { workspaceCreateData = undefined; }
});

test("concurrent initialization creates once and raw credentials never share a workspace", async () => {
  const before = workspaceCreateBodies.length;
  const ids = await Promise.all([ensureAgentWorkspace("", "session-raw-a"), ensureAgentWorkspace("", "session-raw-a"), ensureAgentWorkspace("", "session-raw-b")]);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  assert.equal(workspaceCreateBodies.length, before + 2);
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
  assert.equal(queryParam(lastGetImage, "da_version"), "3.1.3");
  assert.equal(body(lastGetImage).image_info, undefined);
  assert.deepEqual(body(lastGetImage).uris, ["tos-upload-test"]);
});

test("empty get_image_by_uri data falls back to the image_info request", async () => {
  getImageUris = [];
  imageByUriBodies = [undefined, {
    uri2image: { "tos-upload-test": { image_url: "https://fixture.invalid/original.webp", width: 1536, height: 2752 } },
  }];
  try {
    const attachment = await prepareAgentAttachment("data:image/png;base64,YQ==", "session-a", { attempts: 1, delayMs: 0 });
    assert.equal(attachment.url, "https://fixture.invalid/original.webp");
    assert.equal(attachment.width, 1536);
    assert.equal(body(lastGetImage).image_info.format, "webp");
    assert.equal(body(lastGetImage).image_info.width, 4096);
  } finally {
    imageByUriBodies = undefined;
  }
});

test("readAgentImageInfo accepts nested maps, key suffixes and field aliases", () => {
  const url = "https://fixture.invalid/original.webp";
  assert.deepEqual(readAgentImageInfo({ data: { uri2image: { "tos-upload-test": { image_url: url, width: 768, height: 1024 } } } }, "tos-upload-test"), { url, width: 768, height: 1024 });
  assert.deepEqual(readAgentImageInfo({ uri2image: { "tos-upload-test~tplv": { url, image_width: "768", image_height: "1024" } } }, "tos-upload-test"), { url, width: 768, height: 1024 });
  assert.deepEqual(readAgentImageInfo({ uri2image: { other: { image_url: url, width: 12, height: 34 } } }, "tos-upload-test"), { url, width: 12, height: 34 });
  assert.deepEqual(readAgentImageInfo({ uri2image: { "tos-upload-test": { image_url: { url }, width: 9, height: 8 } } }, "tos-upload-test"), { url, width: 9, height: 8 });
  assert.equal(readAgentImageInfo({ uri2image: {} }, "tos-upload-test"), undefined);
});

test("fresh upload waits for delayed get_image_by_uri metadata", async () => {
  getImageUris = [];
  auditUriLists = [];
  imageByUriBodies = [{ uri2image: {} }, { uri2image: { "tos-upload-test": { image_url: "https://fixture.invalid/original.webp", width: 768, height: 1024 } } }];
  try {
    const attachment = await prepareAgentAttachment("data:image/png;base64,YQ==", "session-a", { delayMs: 0 });
    assert.equal(attachment.url, "https://fixture.invalid/original.webp");
    assert.equal(getImageUris.length, 2);
  } finally {
    imageByUriBodies = undefined;
  }
});

test("fresh upload reads nested uri2image when Jimeng wraps the map", async () => {
  getImageUris = [];
  imageByUriBodies = [{ data: { uri2image: { "tos-upload-test~tplv": { url: "https://fixture.invalid/original.webp", image_width: 768, image_height: 1024 } } } }];
  try {
    const attachment = await prepareAgentAttachment("data:image/png;base64,YQ==", "session-a", { attempts: 1, delayMs: 0 });
    assert.deepEqual(attachment, {
      uri: "tos-upload-test",
      url: "https://fixture.invalid/original.webp",
      width: 768,
      height: 1024,
    });
  } finally {
    imageByUriBodies = undefined;
  }
});

const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("get_image_by_uri reads uri2image when Jimeng places it beside ret", async () => {
  siblingUri2Image = true;
  try {
    const attachment = await prepareAgentAttachment(PNG_1X1, "session-a", { attempts: 1, delayMs: 0 });
    assert.equal(attachment.url, "https://fixture.invalid/original.webp");
    assert.deepEqual([attachment.width, attachment.height], [1536, 2752]);
  } finally {
    siblingUri2Image = false;
  }
});

test("zero uri2image dimensions keep the signed URL and use local pixels", async () => {
  getImageUris = [];
  imageByUriBodies = [{
    uri2image: {
      "tos-cn-i-tb4s082cfz/uploaded": {
        image_uri: "tos-cn-i-tb4s082cfz/uploaded",
        image_url: "https://fixture.invalid/original.webp",
        width: 0,
        height: 0,
        format: "webp",
        smart_crop_loc: null,
      },
    },
  }];
  try {
    const info = readAgentImageInfo(imageByUriBodies[0], "tos-upload-test");
    assert.deepEqual(info, { url: "https://fixture.invalid/original.webp" });
    const attachment = await prepareAgentAttachment(PNG_1X1, "session-a", { attempts: 1, delayMs: 0 });
    assert.deepEqual(attachment, {
      uri: "tos-upload-test",
      url: "https://fixture.invalid/original.webp",
      width: 1,
      height: 1,
    });
  } finally {
    imageByUriBodies = undefined;
  }
});

test("empty get_image_by_uri still fails even when local PNG size is known", async () => {
  getImageUris = [];
  imageByUriBodies = [{ uri2image: {} }];
  try {
    assert.deepEqual(readDataUrlDimensions(PNG_1X1), { width: 1, height: 1 });
    await assert.rejects(prepareAgentAttachment(PNG_1X1, "session-a", { attempts: 1, delayMs: 0 }), /即梦参考图信息解析失败/);
  } finally {
    imageByUriBodies = undefined;
  }
});

test("stream consume flushes a final SSE event that has no trailing blank line", async () => {
  const stream = new PassThrough();
  const observation = createAgentObservation("conv-flush");
  const body = `event: message\ndata: ${JSON.stringify({ conversation_id: "conv-flush", data: { submit_id: "submit-flush-001" } })}`;
  const consuming = consumeAgentStream(stream, observation, Date.now() + 1000);
  stream.end(body);
  await consuming;
  assert.equal(observation.submitId, "submit-flush-001");
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

test("paid and subscription stream handshakes stop at their deadlines", async () => {
  const before = conversationPosts;
  hangConversationHandshake = true;
  try {
    await assert.rejects(
      startAgentConversation("session-a", "workspace-account-a", attachmentFixture, "conv-handshake-deadline", Date.now() + 25),
      (error: any) => error.code === "ETIMEDOUT",
    );
    assert.equal(conversationPosts, before + 1);
  } finally {
    hangConversationHandshake = false;
  }
  hangSubscribeHandshake = true;
  try {
    await assert.rejects(
      subscribeAgentWorkspace("session-a", "workspace-account-a", createAgentObservation("conv-subscribe-deadline"), Date.now() + 25),
      (error: any) => error.code === "ETIMEDOUT",
    );
  } finally {
    hangSubscribeHandshake = false;
    subscribeBodies = [];
  }
});

test("paid conversation POST sends stream headers, babi_param and unique IDs", async () => {
  const first = await startAgentConversation("session-a", "workspace-account-a", attachmentFixture);
  const second = await startAgentConversation("session-a", "workspace-account-a", attachmentFixture);
  assert.ok(first.stream);
  assert.ok(first.observation.conversationId);
  assert.notEqual(first.observation.conversationId, second.observation.conversationId);
  assert.equal(lastConversation.responseType, "stream");
  assert.equal(lastConversation.timeout, 0);
  assert.match(header(lastConversation, "Accept"), /text\/event-stream/);
  assert.equal(header(lastConversation, "Accept-Encoding"), "identity");
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
    `data: ${JSON.stringify({ payload: { metadata: { conversation_id: "conv-keep" }, history_record_id: "history-nested-keep" } })}`,
    "",
    "event: system",
    `data: ${JSON.stringify({ payload: { metadata: { conversation_id: "conv-other" }, history_record_id: "history-nested-other" } })}`,
    "",
    "event: system",
    `data: ${JSON.stringify({ type: "stream_complete", conversation_id: "conv-other" })}`,
    "",
  ].join("\n");
  const observation = createAgentObservation("conv-keep");
  await subscribeAgentWorkspace("session-a", "workspace-account-a", observation, Date.now() + 1000);
  assert.equal(lastSubscribe.timeout, 0);
  assert.equal(header(lastSubscribe, "Accept-Encoding"), "identity");
  assert.deepEqual(subscribeBodies, [{ workspace_id: "workspace-account-a" }]);
  // A nested asset ID without its exact tool submit is not a task receipt.
  assert.equal(observation.historyId, "history-keep");
  assert.equal(observation.complete, false);
  assert.equal(observation.conversationId, "conv-keep");
});

test("shared workspace ignores unscoped receipts and terminal events", async () => {
  subscribePayload = [
    "event: stream_complete",
    `data: ${JSON.stringify({ success: false, error_code: 3001 })}`,
    "",
    "event: system",
    `data: ${JSON.stringify({ type: "stream_complete", success: false, error_code: 3001 })}`,
    "",
    "event: system",
    `data: ${JSON.stringify({ type: "conversation_created", conversation_id: "conv-keep", history_record_id: "history-keep" })}`,
    "",
    "event: system",
    `data: ${JSON.stringify({ history_record_id: "history-unscoped", submit_id: "submit-unscoped" })}`,
    "",
  ].join("\n");
  const observation = createAgentObservation("conv-keep");
  await subscribeAgentWorkspace("session-a", "workspace-account-a", observation, Date.now() + 1000);
  assert.equal(observation.failed, undefined);
  assert.equal(observation.historyId, "history-keep");
});

test("subscribe matches numeric conversation ids", async () => {
  subscribePayload = [
    "event: system",
    `data: ${JSON.stringify({ type: "conversation_created", conversation_id: 19617933949964, history_record_id: 7471122 })}`,
    "",
    "event: system",
    `data: ${JSON.stringify({ type: "stream_complete", conversation_id: 19617933949964 })}`,
    "",
  ].join("\n");
  const observation = createAgentObservation("19617933949964");
  await subscribeAgentWorkspace("session-a", "workspace-account-a", observation, Date.now() + 1000);
  assert.equal(observation.historyId, "7471122");
  assert.equal(observation.conversationId, "19617933949964");
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

test("empty wrong history recovers only the original conversation and reads corrected history once", async () => {
  recoveryAssets = JSON.parse(fs.readFileSync("tests/fixtures/agent-original-history-recovery.json", "utf8"));
  recoveryHistories = { "history-unrelated": {}, "history-original": { history_list: [{ history_record_id: "history-original", task: { submit_id: "submit-original" }, status: 50, item_list: [{ image: { image_url: "https://fixture.invalid/recovered.webp" } }] }] } };
  recoveryRequests = [];
  const before = [conversationPosts, workspaceCreateBodies.length];
  try {
    const state = createAgentObservation("conversation-original");
    state.submitId = "submit-original"; state.historyId = "history-unrelated";
    const result = await queryAgentHistory("session-original", state, undefined, "workspace-original");
    assert.equal(result.status, "succeeded");
    assert.equal(state.historyId, "history-original");
    assert.deepEqual(recoveryRequests.map(x => x.path), ["history", "session", "history"]);
    assert.deepEqual(recoveryRequests.filter(x => x.path === "history").map(x => x.body.history_ids), [["history-unrelated"], ["history-original"]]);
    assert.equal(recoveryRequests[1].body.workspace_id, "workspace-original");
    assert.equal(state.creditsUsed, 4);
    assert.deepEqual([conversationPosts, workspaceCreateBodies.length], before);
    recoveryRequests = [];
    const other = createAgentObservation("conversation-other");
    other.submitId = "submit-original"; other.historyId = "history-unrelated";
    assert.deepEqual(await queryAgentHistory("session-original", other, undefined, "workspace-original"), { status: "running" });
    assert.equal(other.historyId, "history-unrelated");
    assert.deepEqual(recoveryRequests.map(x => x.path), ["history", "session"]);
  } finally { recoveryAssets = recoveryHistories = undefined; }
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
  assert.equal(observation.complete, false);

  const hanging = new PassThrough();
  const timedOut = createAgentObservation("conv-deadline");
  const started = Date.now();
  await consumeAgentStream(hanging, timedOut, Date.now() + 30);
  assert.ok(Date.now() - started < 400);
  assert.equal(timedOut.complete, false);
});

test("paid conversation POST uses a caller-provided conversation id", async () => {
  const provided = "conv-provided-test-001";
  const started = await startAgentConversation("session-a", "workspace-account-a", attachmentFixture, provided);
  assert.equal(started.observation.conversationId, provided);
  assert.equal(body(lastConversation).conversation_id, provided);
});

test("paid conversation POST keeps the account workspace id as a string", async () => {
  const workspaceId = await ensureAgentWorkspace("account-a", "session-a");
  await startAgentConversation("session-a", workspaceId, attachmentFixture);
  assert.equal(workspaceId, "workspace-account-a");
  assert.equal(body(lastConversation).workspace_id, workspaceId);
  assert.equal(typeof body(lastConversation).workspace_id, "string");
});

test("conversation HTTP 401 does not yield a readable success stream", async () => {
  conversationHttpStatus = 401;
  try {
    await assert.rejects(
      startAgentConversation("session-a", "workspace-account-a", attachmentFixture),
      (error: any) => {
        assert.match(String(error?.message), /^HTTP 401 Unauthorized$/);
        assert.equal(error?.response, undefined);
        return true;
      },
    );
  } finally {
    conversationHttpStatus = 200;
  }
});

test("stream consume decodes a UTF-8 character split across chunks", async () => {
  const sse = "event: system\ndata: {\"type\":\"conversation_created\",\"conversation_id\":\"conv-utf8\",\"history_record_id\":\"记录-001\"}\n\n";
  const bytes = Buffer.from(sse, "utf8");
  const splitAt = bytes.indexOf(Buffer.from("记录", "utf8")) + 1;
  const stream = Readable.from([bytes.subarray(0, splitAt), bytes.subarray(splitAt)]);
  const observation = createAgentObservation("conv-utf8");
  await consumeAgentStream(stream, observation, Date.now() + 1000);
  assert.equal(observation.historyId, "记录-001");
  assert.equal(observation.conversationId, "conv-utf8");
});
