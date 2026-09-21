# Agent 8K Intelligent Upscale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable CPA API for Jimeng Agent automatic 8K upscale and a management-console before/after comparison UI without changing the deployed Canvas image-task contract.

**Architecture:** Keep `/v1/tasks` unchanged and add a separate `/v1/upscale/tasks` state machine. Pure protocol code builds Agent conversation requests and parses SSE/history fixtures; an account-scoped client resolves workspace and uploaded image metadata; a durable controller pins one account and never retries the paid conversation POST. The console stores the original Blob in IndexedDB and polls the same task ID until it can render a comparison slider.

**Tech Stack:** Node.js 22+, TypeScript ESM, Koa, axios streams, eventsource-parser, better-sqlite3, node:test, esbuild, vanilla HTML/CSS/JavaScript.

---

## File Structure

New backend units:

- `src/api/controllers/agent-upscale-protocol.ts` — pure request builder, SSE reducer, result/commerce extraction and redaction.
- `src/api/controllers/agent-upscale-client.ts` — workspace, upload metadata, Agent conversation stream and read-only subscription/history calls.
- `src/api/controllers/upscale-task-contract.ts` — strict public input and task-result validation.
- `src/api/controllers/upscale-tasks.ts` — SQLite task state machine, account pinning, monitors, cancellation and recovery.
- `src/api/routes/upscale-tasks.ts` — `jm_`-only HTTP contract.

New test assets:

- `tests/fixtures/agent-8k-success.sse` — source-derived Agent SSE fixture with test-only IDs.
- `tests/fixtures/agent-8k-history-success.json` — source-derived history companion fixture.
- `tests/agent-upscale-protocol.test.ts` — request/SSE/result protocol tests.
- `tests/agent-upscale-tasks.test.ts` — persistence, idempotency, account and paid-POST safety tests.
- `tests/agent-upscale-routes.test.ts` — route status/auth/error contract.
- `tests/upscale-ui.test.ts` — browser helper state and comparison-boundary tests.
- `tools/test-agent-upscale.mjs` — isolated bundled test runner.

Console units:

- `public/upscale-ui.js` — browser-safe task ID, terminal-state, comparison clamp and IndexedDB Blob helpers.
- `public/index.html` — new Smart HD tab, polling flow and comparison UI.

Existing files touched:

- `src/api/routes/index.ts` — register the API route and serve `upscale-ui.js`.
- `API.md` — document the new async contract and “provider-marked 8K” boundary.
- `README.md` — add the feature and safety notes.

## Task 0: Freeze and Commit the Existing Codex Prerequisite

**Files:**
- Modify already present: `public/index.html`
- Modify already present: `src/api/controllers/auth.ts`
- Modify already present: `src/api/controllers/tasks.ts`
- Modify already present: `src/api/routes/account-status.ts`
- Modify already present: `src/api/routes/tasks.ts`
- Modify already present: `src/lib/account-pool.ts`
- Modify already present: `tests/canvas-tasks.test.ts`

- [ ] **Step 1: Confirm only the seven content-bearing prerequisite files are in the diff**

Run:

```powershell
git diff --name-only
```

Expected output contains exactly the seven files listed above. `src/api/controllers/account-pool.ts`, `src/api/controllers/videos.ts`, `src/api/routes/account-pool.ts`, and `yarn.lock` may appear in `git status` because of racy-clean/line-ending metadata, but must not be staged when `git diff --name-only` does not list them.

- [ ] **Step 2: Re-run the prerequisite build and isolated Canvas tests**

Run:

```powershell
npm run build
node tools/test-canvas-tasks.mjs
git diff --check
```

Expected:

- tsup CJS/ESM/DTS builds succeed.
- `tests 9`, `pass 9`, `fail 0`.
- `git diff --check` prints no errors.

- [ ] **Step 3: Commit only the prerequisite**

```powershell
git add -- public/index.html src/api/controllers/auth.ts src/api/controllers/tasks.ts src/api/routes/account-status.ts src/api/routes/tasks.ts src/lib/account-pool.ts tests/canvas-tasks.test.ts
git -c user.name="lijianqiufeng" -c user.email="lijianqiufeng@users.noreply.github.com" commit -m "feat: pin canvas tasks to Jimeng accounts"
```

Expected: one commit containing the account-binding, credit-snapshot and cooldown prerequisite; `portable-release/` remains untracked.

## Task 1: Lock the Agent Request and SSE Protocol with Fixtures

**Files:**
- Create: `tests/fixtures/agent-8k-success.sse`
- Create: `tests/fixtures/agent-8k-history-success.json`
- Create: `tests/agent-upscale-protocol.test.ts`
- Create: `tools/test-agent-upscale.mjs`
- Create: `src/api/controllers/agent-upscale-protocol.ts`

- [ ] **Step 1: Add the source-derived SSE fixture**

Create `tests/fixtures/agent-8k-success.sse` with test-only IDs:

```text
event: system
data: {"type":"conversation_created","conversation_id":"conv-server-test-001"}

event: message
data: {"author":{"role":"assistant"},"metadata":{"conversation_id":"conv-server-test-001","parent_message_id":"msg-user-test-001"},"status":"in_progress","id":"msg-assistant-test-001","content":{"content_type":"","content_parts":[{"generate_args":{"image_args":{"image_resolution_type":"8k"}}}]},"create_time":1700000000000,"tool_calls":[{"id":"call-sr-test-001","type":"server_function","streaming":true,"func":{"name":"creative_agent_mcp_gen_image_super_resolution_v3","arguments":"{}"}}]}

event: message
data: {"author":{"role":"tool"},"metadata":{"conversation_id":"conv-server-test-001","parent_message_id":"msg-assistant-test-001","tool_call_id":"call-sr-test-001"},"status":"in_progress","id":"msg-tool-result-test-001","content":{"content_type":"","content_parts":[{"text":"{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"data\\\":{\\\"submit_id\\\":\\\"submit-test-001\\\",\\\"result_code\\\":0,\\\"submit_info\\\":{\\\"code\\\":0},\\\"commerce_info\\\":{\\\"credit_count\\\":4,\\\"credit_display_info\\\":{\\\"actual_credits\\\":4,\\\"original_credits\\\":4,\\\"has_discount\\\":false,\\\"is_free\\\":false}}}}\"}]}"}]},"create_time":1700000001000}

event: delta
data: {"conversation_id":"conv-server-test-001","message_id":"msg-tool-result-test-001","path":"/messages/msg-tool-result-test-001/status","op":"replace","value":"finished_successfully"}

event: system
data: {"type":"stream_complete","conversation_id":"conv-server-test-001","request_message_id":"msg-user-test-001"}
```

- [ ] **Step 2: Add the companion history fixture**

Create `tests/fixtures/agent-8k-history-success.json`:

```json
{
  "history-test-001": {
    "history_record_id": "history-test-001",
    "status": 50,
    "forecast_resolution": "8k",
    "task": { "submit_id": "submit-test-001" },
    "item_list": [
      {
        "image": {
          "large_images": [
            {
              "image_uri": "uri-test-result-001",
              "image_url": "https://fixture.invalid/result-8k.webp",
              "width": 6144,
              "height": 8192
            }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 3: Write failing protocol tests**

Create `tests/agent-upscale-protocol.test.ts` with these exact public expectations:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AGENT_UPSCALE_PROMPT,
  buildAgentConversation,
  createAgentObservation,
  feedAgentSse,
  mergeAgentHistory,
} from "@/api/controllers/agent-upscale-protocol.ts";

const attachment = {
  uri: "tos-test-original",
  url: "https://fixture.invalid/original.webp",
  width: 768,
  height: 1024,
};

test("automatic 8K request keeps IDs consistent and has no manual image args", () => {
  const request = buildAgentConversation({
    workspaceId: "10001",
    conversationId: "conv-client-test-001",
    messageId: "msg-user-test-001",
    fileId: "file-test-001",
    createdAt: 1700000000000,
    attachment,
  });
  assert.equal(request.conversation_id, "conv-client-test-001");
  assert.equal(request.messages[0].metadata.conversation_id, request.conversation_id);
  assert.equal(request.messages[0].content.content_parts[1].text, AGENT_UPSCALE_PROMPT);
  assert.equal(request.extra_info, JSON.stringify({ dreamina_agent_opt_mode: true }));
  assert.equal(JSON.stringify(request).includes("generate_args"), false);
  const metrics = JSON.parse(request.messages[0].metadata.metrics_extra);
  assert.equal(metrics.prompt, AGENT_UPSCALE_PROMPT);
  assert.equal(metrics.userMessageId, request.messages[0].id);
  assert.equal(metrics.conversationId, request.conversation_id);
  assert.equal("imageId" in metrics, false);
});

test("SSE and history merge into one provider-marked 8K outcome", () => {
  const state = createAgentObservation("conv-client-test-001");
  feedAgentSse(state, fs.readFileSync("tests/fixtures/agent-8k-success.sse", "utf8"));
  assert.equal(state.conversationId, "conv-server-test-001");
  assert.equal(state.submitId, "submit-test-001");
  assert.equal(state.providerLabel, "8K");
  assert.equal(state.creditsUsed, 4);
  const history = JSON.parse(fs.readFileSync("tests/fixtures/agent-8k-history-success.json", "utf8"));
  const result = mergeAgentHistory(state, history);
  assert.deepEqual(result, {
    status: "succeeded",
    providerLabel: "8K",
    creditsUsed: 4,
    historyId: "history-test-001",
    urls: ["https://fixture.invalid/result-8k.webp"],
  });
});
```

- [ ] **Step 4: Add the isolated test runner and verify RED**

Create `tools/test-agent-upscale.mjs` by following the existing isolated runner, but bundle all new test entries:

```js
import { build } from "esbuild";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const isolated = mkdtempSync(join(tmpdir(), "jimeng-agent-upscale-tests-"));
const entries = process.argv.slice(2);
if (!entries.length) entries.push("tests/agent-upscale-protocol.test.ts");
const files = [];
for (const [index, entry] of entries.entries()) {
  const outfile = join(isolated, `test-${index}.mjs`);
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile, absWorkingDir: root });
  files.push(outfile);
}
symlinkSync(join(root, "node_modules"), join(isolated, "node_modules"), process.platform === "win32" ? "junction" : "dir");
const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
Object.assign(env, { NODE_PATH: join(root, "node_modules"), DATA_DIR: isolated, DB_PATH: join(isolated, "test.sqlite"), MEDIA_DIR: join(isolated, "media"), JIMENG_ACCOUNT_POOL_KEY: "isolated-fake-key", VERCEL: "1", SERVER_ENV: "isolated-test" });
const result = spawnSync(process.execPath, ["--test", "--test-force-exit", ...files], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exitCode = result.status ?? 1;
```

Run:

```powershell
node tools/test-agent-upscale.mjs
```

Expected: FAIL because `agent-upscale-protocol.ts` does not exist.

- [ ] **Step 5: Implement the minimal pure protocol module**

Create `src/api/controllers/agent-upscale-protocol.ts` with these exports and rules:

```ts
import { createParser, type ParseEvent } from "eventsource-parser";

export const AGENT_UPSCALE_PROMPT = "帮我8k高清放大";
export const SUPER_RESOLUTION_TOOL = "creative_agent_mcp_gen_image_super_resolution_v3";

export type AgentAttachment = {
  uri: string;
  url: string;
  width: number;
  height: number;
  itemId?: string;
  sourceGenerateId?: string;
};

export type AgentObservation = {
  conversationId: string;
  submitId?: string;
  historyId?: string;
  providerLabel?: string;
  creditsUsed?: number;
  urls: string[];
  failed?: string;
  complete: boolean;
};

export function createAgentObservation(conversationId: string): AgentObservation {
  return { conversationId, urls: [], complete: false };
}

export function buildAgentConversation(input: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  fileId: string;
  createdAt: number;
  attachment: AgentAttachment;
}) {
  const itemId = input.attachment.itemId;
  const metrics = {
    userMessageId: input.messageId,
    prompt: AGENT_UPSCALE_PROMPT,
    isAddImage: 1,
    conversationId: input.conversationId,
    hasRejectedAudit: 0,
    ...(itemId ? { imageId: itemId, lastPictureId: itemId } : {}),
    ...(input.attachment.sourceGenerateId ? { lastGenerateId: input.attachment.sourceGenerateId } : {}),
    enterFrom: "click",
    referenceCnt: 1,
    position: "page_bottom_box",
  };
  return {
    conversation_id: input.conversationId,
    messages: [{
      author: { role: "user" },
      metadata: {
        is_visually_hidden_from_conversation: false,
        conversation_id: input.conversationId,
        parent_message_id: "",
        metrics_extra: JSON.stringify(metrics),
      },
      id: input.messageId,
      content: {
        content_type: "",
        content_parts: [
          {
            file: {
              uri: input.attachment.uri,
              file_type: 5,
              url: input.attachment.url,
              image_metadata: {
                image_width: input.attachment.width,
                image_height: input.attachment.height,
                ...(itemId ? { item_id: itemId } : {}),
              },
              id: input.fileId,
            },
          },
          { text: AGENT_UPSCALE_PROMPT, is_referenced: false },
        ],
      },
      create_time: input.createdAt,
      tools: [POINTS_CONSUMPTION_TOOL],
    }],
    version: "3.0.0",
    workspace_id: Number(input.workspaceId),
    extra_info: JSON.stringify({ dreamina_agent_opt_mode: true }),
  };
}
```

Define the captured reminder tool in the same file:

```ts
const POINTS_REMINDER_DESCRIPTION = `该工具用于向用户发出提示，提醒用户后续的生视频链路可能会消耗较多积分。**发出提示一定要通过该工具进行，不可以通过自然语言进行。**
    
      ## 使用条件（满足任意一个条件就应该调用该工具提醒用户）
      1. 当用户消息里蕴含了**生成大于等于2个视频片段**的要求时
      2. 当用户消息里蕴含了**生成超过20秒的视频**的要求是
      ## 注意
      1. 每轮对话最多向用户发出一次提示即可，不需要重复提示。禁止重复多次调用该工具。
      2. 调用该工具之后应该立刻停止，等待工具返回结果后再调用生成工具，而不应该将该工具和其他工具一次性连续调用
      3. 调用该工具的时机在用户提出需求之后、调用其他任何工具之前。在一轮对话中，一旦调用了其他任何工具，例如“handoff_to_planner_agent”或者“canvas_open_new_canvas”，则绝不可以再调用该工具
      ## 例子
      * 用户说要生成20张图片，此时不要向用户发出提醒
      * 用户说要生成2个视频片段，此时需要向用户发出提醒
      * 用户要生成一个30秒的视频片段，由于每次调用生视频工具最多生成10秒的视频，因此至少要调用3次生视频工具，此时需要发出提醒`;

const POINTS_CONSUMPTION_TOOL = {
  id: "consumption_reminder",
  type: "client_function",
  name: "points_consumption_reminder",
  description: POINTS_REMINDER_DESCRIPTION,
  parameters: "{\"type\":\"object\",\"properties\":{\"reason\":{\"type\":\"string\",\"description\":\"用20字以内简述调用该工具的原因\"}},\"required\":[\"reason\"],\"additionalProperties\":false,\"$schema\":\"http://json-schema.org/draft-07/schema#\"}",
};
```

Implement `feedAgentSse()` with `eventsource-parser`; for every JSON event recursively inspect:

- `conversation_created.conversation_id`
- `generate_args.image_args.image_resolution_type`
- server tool name `creative_agent_mcp_gen_image_super_resolution_v3`
- twice-encoded tool result `data.submit_id` and `data.commerce_info`
- terminal/system errors and `stream_complete`

Implement `mergeAgentHistory()` by matching `history.task.submit_id` to `state.submitId`, accepting status `21` or `50`, mapping `forecast_resolution === "8k"` to `providerLabel: "8K"`, extracting only HTTPS image URLs, and mapping status `30` to a sanitized failure.

- [ ] **Step 6: Run protocol tests and commit**

Run:

```powershell
node tools/test-agent-upscale.mjs
```

Expected: all protocol tests pass.

Commit:

```powershell
git add src/api/controllers/agent-upscale-protocol.ts tests/fixtures/agent-8k-success.sse tests/fixtures/agent-8k-history-success.json tests/agent-upscale-protocol.test.ts tools/test-agent-upscale.mjs
git -c user.name="lijianqiufeng" -c user.email="lijianqiufeng@users.noreply.github.com" commit -m "test: lock Jimeng agent upscale protocol"
```

## Task 2: Implement Account-Scoped Workspace and Fresh-Upload Metadata

**Files:**
- Create: `src/api/controllers/agent-upscale-client.ts`
- Create: `tests/agent-upscale-client.test.ts`
- Modify: `src/api/controllers/core.ts`
- Modify: `tools/test-agent-upscale.mjs`

- [ ] **Step 1: Write failing workspace and attachment tests**

Add tests that mock axios in the same style as `canvas-tasks.test.ts`:

```ts
test("workspace cache is isolated by account", async () => {
  const a = await ensureAgentWorkspace("account-a", "session-a");
  const b = await ensureAgentWorkspace("account-b", "session-b");
  assert.equal(a, "workspace-account-a");
  assert.equal(b, "workspace-account-b");
  assert.notEqual(a, b);
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
});
```

The axios adapter must assert:

- `/mweb/v1/workspace/list` is called under the selected session.
- an empty list causes `/mweb/v1/workspace/create` with `{ name: "CPA 智能高清" }`.
- `get_image_by_uri` receives the uploaded URI.
- `submit_audit_job` receives `uri_list`, but its failure does not fabricate success or an item ID.
- a timeout from `/mweb/v1/creation_agent/v2/conversation` causes exactly one axios request.

- [ ] **Step 2: Run the client tests to verify RED**

Run:

```powershell
node tools/test-agent-upscale.mjs tests/agent-upscale-client.test.ts
```

Expected: FAIL because `agent-upscale-client.ts` does not exist.

- [ ] **Step 3: Implement workspace and attachment preparation**

Create `src/api/controllers/agent-upscale-client.ts`:

```ts
import { PassThrough } from "node:stream";
import { database } from "@/lib/database.ts";
import util from "@/lib/util.ts";
import { request, uploadFile } from "./core.ts";
import {
  buildAgentConversation,
  createAgentObservation,
  feedAgentSse,
  mergeAgentHistory,
  type AgentAttachment,
  type AgentObservation,
} from "./agent-upscale-protocol.ts";

database.exec(`CREATE TABLE IF NOT EXISTS jimeng_agent_workspaces (
  account_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);

export async function ensureAgentWorkspace(accountId: string, token: string): Promise<string> {
  const cached = database.prepare("SELECT workspace_id FROM jimeng_agent_workspaces WHERE account_id = ?").get(accountId) as { workspace_id: string } | undefined;
  if (cached?.workspace_id) return cached.workspace_id;
  const listed = await request("post", "/mweb/v1/workspace/list", token, { params: { os: "windows" }, data: { offset: 0, limit: 20 } });
  const existing = listed?.workspaces?.[0]?.workspace_id ?? listed?.workspaces?.[0]?.workspaceId;
  const created = existing ? undefined : await request("post", "/mweb/v1/workspace/create", token, { params: { os: "windows" }, data: { name: "CPA 智能高清" } });
  const workspaceId = String(existing ?? created?.workspace_id ?? created?.workspaceId ?? "");
  if (!/^\d+$/.test(workspaceId)) throw Error("即梦 Agent 工作区初始化失败");
  database.prepare("INSERT OR REPLACE INTO jimeng_agent_workspaces(account_id, workspace_id, updated_at) VALUES(?,?,?)").run(accountId, workspaceId, Date.now());
  return workspaceId;
}

export async function prepareAgentAttachment(image: string, token: string): Promise<AgentAttachment> {
  const uploaded = await uploadFile(token, image);
  void request("post", "/mweb/v1/imagex/submit_audit_job", token, { data: { uri_list: [uploaded.uri] } }).catch(() => undefined);
  const resolved = await request("post", "/mweb/v1/get_image_by_uri", token, { data: { uris: [uploaded.uri] } });
  const info = resolved?.uri2image?.[uploaded.uri];
  if (!info || typeof info.image_url !== "string" || !Number.isFinite(Number(info.width)) || !Number.isFinite(Number(info.height))) {
    throw Error("即梦参考图信息解析失败");
  }
  return { uri: uploaded.uri, url: info.image_url, width: Number(info.width), height: Number(info.height) };
}
```

In the same file implement:

- `startAgentConversation()` — create unique conversation/message/file IDs, send one POST to `/mweb/v1/creation_agent/v2/conversation` with `responseType: "stream"`, `Accept: text/event-stream`, `region: "cn"`, `da_version: "3.1.3"`, and the fixed `babi_param`; return the stream and observation.
- `subscribeAgentWorkspace()` — read-only POST `/mweb/v1/creation_agent/v2/subscribe_session` with `{ workspace_id }`, parse only events whose conversation ID matches the task.
- `queryAgentHistory()` — if observation has a history ID, call `/mweb/v1/get_history_by_ids`; otherwise retain the same task and wait for further subscription events.
- `consumeAgentStream()` — accept a Node readable stream, feed arbitrary chunk boundaries into the pure parser, enforce the task deadline, and never log event bodies.

The paid `conversation` POST must be called directly once. Read-only workspace list, metadata, subscription and history calls may retry through the existing helper.

Update the retry guard in `src/api/controllers/core.ts` so both paid creation endpoints are never replayed:

```ts
const NON_RETRYABLE_PAID_POSTS = new Set([
  "/mweb/v1/aigc_draft/generate",
  "/mweb/v1/creation_agent/v2/conversation",
]);
const maxRetries = NON_RETRYABLE_PAID_POSTS.has(uri) ? 0 : 3;
```

- [ ] **Step 4: Run client tests and commit**

```powershell
node tools/test-agent-upscale.mjs tests/agent-upscale-protocol.test.ts tests/agent-upscale-client.test.ts
```

Expected: all protocol/client tests pass.

Commit:

```powershell
git add src/api/controllers/agent-upscale-client.ts src/api/controllers/core.ts tests/agent-upscale-client.test.ts tools/test-agent-upscale.mjs
git -c user.name="lijianqiufeng" -c user.email="lijianqiufeng@users.noreply.github.com" commit -m "feat: add account-scoped Jimeng agent client"
```

## Task 3: Add the Durable Upscale Task Contract and State Machine

**Files:**
- Create: `src/api/controllers/upscale-task-contract.ts`
- Create: `src/api/controllers/upscale-tasks.ts`
- Create: `tests/agent-upscale-tasks.test.ts`

- [ ] **Step 1: Write failing contract and state-machine tests**

Cover these exact cases:

```ts
test("strict upscale input accepts one safe image only", () => {
  const valid = upscaleTaskInput({ id: "upscale_test_1234567890", image: "data:image/png;base64,YQ==" });
  assert.equal(valid.id, "upscale_test_1234567890");
  assert.throws(() => upscaleTaskInput({ ...valid, image: "file:///etc/passwd" }));
  assert.throws(() => upscaleTaskInput({ ...valid, image: "https://127.0.0.1/a.png" }));
});

test("duplicate POST never sends another paid Agent conversation", async () => {
  const first = await createUpscaleTask(owner, authorization, input);
  assert.equal(first.status, 202);
  const second = await createUpscaleTask(owner, authorization, input);
  assert.equal(second.status, 200);
  assert.equal(agentConversationSubmissions, 1);
});

test("cancel-before-create tombstone blocks upload and paid dispatch", async () => {
  const id = "upscale_cancel_1234567890";
  assert.equal(cancelUpscaleTask(owner, id).status, 200);
  assert.equal((await createUpscaleTask(owner, authorization, { ...input, id })).status, 409);
  assert.equal(agentConversationSubmissions, 1);
});

test("one task keeps one account through upload, conversation and subscription", async () => {
  await createUpscaleTask(owner, authorization, { ...input, id: "upscale_pinned_1234567890" });
  assert.deepEqual(observedAccountIds, ["bound-account", "bound-account", "bound-account"]);
});

test("ambiguous paid POST is not replayed", async () => {
  paidPostTimeout = true;
  await createUpscaleTask(owner, authorization, { ...input, id: "upscale_ambiguous_123456" });
  await until(() => readStatus("upscale_ambiguous_123456") === "failed");
  assert.equal(agentConversationSubmissions, 2);
  assert.match(String((await queryUpscaleTask(owner, "upscale_ambiguous_123456")).body.error), /未确认/);
});
```

Also assert:

- terminal rows have empty `credential`;
- another API Key owner receives 404;
- changed input on the same ID receives 409;
- no response contains the test session, management key, workspace ID, conversation ID or source signed URL;
- 4013 marks the pinned account with a long cooldown and does not switch accounts.

- [ ] **Step 2: Run the task tests to verify RED**

```powershell
node tools/test-agent-upscale.mjs tests/agent-upscale-tasks.test.ts
```

Expected: FAIL because the task contract and controller do not exist.

- [ ] **Step 3: Implement the strict input contract**

Create `src/api/controllers/upscale-task-contract.ts`:

```ts
export function upscaleTaskInput(value: any) {
  if (!value || typeof value !== "object" || !/^[A-Za-z0-9_-]{16,100}$/.test(value.id || "")) throw Error("任务 ID 无效");
  if (typeof value.image !== "string" || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image)) {
    throw Error("原图只接受 PNG、JPEG 或 WebP data URL");
  }
  const bytes = Buffer.byteLength(value.image.slice(value.image.indexOf(",") + 1), "base64");
  if (!bytes || bytes > 25 * 1024 * 1024) throw Error("原图须小于 25MB");
  return { id: String(value.id), image: value.image };
}
```

- [ ] **Step 4: Implement persistence and orchestration**

Create `src/api/controllers/upscale-tasks.ts` with:

```ts
type UpscaleTask = {
  id: string;
  owner: number;
  fingerprint: string;
  status: "submitting" | "running" | "succeeded" | "failed" | "canceled";
  account_id: string;
  credential: string;
  workspace_id: string;
  conversation_id: string;
  provider_task_id: string;
  provider_label: string;
  credits_used: number | null;
  result: string;
  error: string;
  deadline: number;
  checked_at: number;
};

database.exec(`CREATE TABLE IF NOT EXISTS agent_upscale_tasks (
  id TEXT PRIMARY KEY,
  owner INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  credential TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  provider_task_id TEXT NOT NULL DEFAULT '',
  provider_label TEXT NOT NULL DEFAULT '',
  credits_used INTEGER,
  result TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  deadline INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0
)`);
```

Public functions:

```ts
export async function createUpscaleTask(owner: number, authorization: string, body: unknown)
export async function queryUpscaleTask(owner: number, id: string)
export function cancelUpscaleTask(owner: number, id: string)
```

Implementation rules:

- Hash the full normalized input before discarding it.
- Use `INSERT OR IGNORE` before upload or Agent calls.
- Resolve one account once and persist `account_id` plus encrypted session.
- Run upload/workspace/conversation asynchronously.
- Update `conversation_id` before the paid POST.
- Once the paid response stream is established, set `running` and consume it in a deduplicated background monitor.
- Save submit/history IDs as soon as observed.
- On terminal success save only HTTPS result URLs, `provider_label`, explicit `credits_used`, clear credential, and save the result in `media`.
- On 4013 call `markFailure(accountId, 60 * 60_000)`; on 1015/401/403 call the ordinary failure cooldown.
- On ambiguous POST failure store the exact safe message from the design and never restart submission.
- `queryUpscaleTask()` may start a read-only workspace subscription monitor when no monitor exists; it must return the current row without waiting for a long-lived stream.
- On deadline, perform one final read-only history/subscription attempt and then fail without creating.
- `cancelUpscaleTask()` uses a tombstone row exactly like Canvas tasks.

- [ ] **Step 5: Run task tests and commit**

```powershell
node tools/test-agent-upscale.mjs tests/agent-upscale-protocol.test.ts tests/agent-upscale-client.test.ts tests/agent-upscale-tasks.test.ts
```

Expected: all protocol/client/task tests pass.

Commit:

```powershell
git add src/api/controllers/upscale-task-contract.ts src/api/controllers/upscale-tasks.ts tests/agent-upscale-tasks.test.ts
git -c user.name="lijianqiufeng" -c user.email="lijianqiufeng@users.noreply.github.com" commit -m "feat: add durable agent upscale tasks"
```

## Task 4: Expose the `jm_`-Only HTTP Routes

**Files:**
- Create: `src/api/routes/upscale-tasks.ts`
- Create: `tests/agent-upscale-routes.test.ts`
- Modify: `src/api/routes/index.ts`

- [ ] **Step 1: Write failing route tests**

Construct plain `Request`-shaped fixtures and assert:

```ts
test("upscale routes require an enabled managed key", async () => {
  const response = await routes.post[""](fakeRequest({ authorization: "Bearer raw-session", body: input }));
  assert.equal(response.statusCode, 401);
});

test("route preserves controller status codes", async () => {
  assert.equal((await routes.post[""](managedRequest(input))).statusCode, 202);
  assert.equal((await routes.get["/:id"](managedRequest(undefined, input.id))).statusCode, 200);
  assert.equal((await routes.delete["/:id"](managedRequest(undefined, input.id))).statusCode, 200);
});
```

Also test malformed JSON fields return HTTP 400 with one safe message and do not expose the thrown validation details.

- [ ] **Step 2: Run route tests to verify RED**

```powershell
node tools/test-agent-upscale.mjs tests/agent-upscale-routes.test.ts
```

Expected: FAIL because the route module is missing.

- [ ] **Step 3: Implement and register the route**

Create `src/api/routes/upscale-tasks.ts` following the existing tasks route:

```ts
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
      const result = await createUpscaleTask(auth.apiKeyId, request.headers.authorization, request.body);
      return new Response(result.body, { statusCode: result.status });
    } catch {
      return new Response({ error: "智能高清参数无效或暂无可用账号，请检查原图与账号状态" }, { statusCode: 400 });
    }
  }
  const id = String(request.params.id);
  const result = request.method.toUpperCase() === "DELETE"
    ? cancelUpscaleTask(auth.apiKeyId, id)
    : await queryUpscaleTask(auth.apiKeyId, id);
  return new Response(result.body, { statusCode: result.status });
}

export default {
  prefix: "/v1/upscale/tasks",
  post: { "": async (request: Request) => handle(request, true) },
  get: { "/:id": async (request: Request) => handle(request, false) },
  delete: { "/:id": async (request: Request) => handle(request, false) },
};
```

Import and append `upscaleTasks` in `src/api/routes/index.ts`. Keep existing route ordering unchanged except for the new final entry.

- [ ] **Step 4: Run backend tests and commit**

```powershell
node tools/test-agent-upscale.mjs tests/agent-upscale-protocol.test.ts tests/agent-upscale-client.test.ts tests/agent-upscale-tasks.test.ts tests/agent-upscale-routes.test.ts
```

Expected: all backend Agent upscale tests pass.

Commit:

```powershell
git add src/api/routes/upscale-tasks.ts src/api/routes/index.ts tests/agent-upscale-routes.test.ts
git -c user.name="lijianqiufeng" -c user.email="lijianqiufeng@users.noreply.github.com" commit -m "feat: expose agent upscale task API"
```

## Task 5: Add Testable Browser State and IndexedDB Storage

**Files:**
- Create: `public/upscale-ui.js`
- Create: `tests/upscale-ui.test.ts`
- Modify: `src/api/routes/index.ts`

- [ ] **Step 1: Write failing browser-helper tests**

Load `public/upscale-ui.js` through `node:vm` and assert:

```ts
test("comparison position is clamped", () => {
  assert.equal(ui.clampComparison(-1), 0);
  assert.equal(ui.clampComparison(50), 50);
  assert.equal(ui.clampComparison(101), 100);
});

test("only terminal states stop polling", () => {
  assert.equal(ui.isTerminalStatus("running"), false);
  assert.equal(ui.isTerminalStatus("submitting"), false);
  assert.equal(ui.isTerminalStatus("succeeded"), true);
  assert.equal(ui.isTerminalStatus("failed"), true);
  assert.equal(ui.isTerminalStatus("canceled"), true);
});

test("task IDs satisfy the backend contract", () => {
  assert.match(ui.createTaskId(() => new Uint8Array(16).fill(7)), /^[A-Za-z0-9_-]{16,100}$/);
});
```

- [ ] **Step 2: Run UI helper tests to verify RED**

```powershell
node tools/test-agent-upscale.mjs tests/upscale-ui.test.ts
```

Expected: FAIL because `public/upscale-ui.js` does not exist.

- [ ] **Step 3: Implement the browser helper**

Create `public/upscale-ui.js` as a browser global:

```js
(function (global) {
  const DB_NAME = "jimeng-upscale-ui";
  const STORE = "originals";

  function clampComparison(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 50;
  }

  function isTerminalStatus(status) {
    return ["succeeded", "failed", "canceled"].includes(status);
  }

  function createTaskId(random = (array) => crypto.getRandomValues(array)) {
    const bytes = random(new Uint8Array(16));
    return `upscale_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function putOriginal(id, blob) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(blob, id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  }

  async function getOriginal(id) {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  }

  async function deleteOriginal(id) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  }

  global.JimengUpscaleUI = { clampComparison, isTerminalStatus, createTaskId, putOriginal, getOriginal, deleteOriginal };
})(globalThis);
```

Serve it in the root route:

```ts
"/upscale-ui.js": async () => new Response(await fs.readFile("public/upscale-ui.js"), {
  type: "application/javascript",
  headers: { "Cache-Control": "no-store" },
})
```

- [ ] **Step 4: Run UI helper tests and commit**

```powershell
node tools/test-agent-upscale.mjs tests/upscale-ui.test.ts
```

Expected: all UI helper tests pass.

Commit:

```powershell
git add public/upscale-ui.js tests/upscale-ui.test.ts src/api/routes/index.ts
git -c user.name="lijianqiufeng" -c user.email="lijianqiufeng@users.noreply.github.com" commit -m "feat: add upscale browser state helpers"
```

## Task 6: Build the Smart HD Console and Comparison Slider

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add the Smart HD tab markup**

Add one navigation button after “生图测试”:

```html
<button class="tab-btn" data-tab="upscale"><span class="tab-icon">清</span>智能高清</button>
```

Add `tab-upscale` with:

- one API Key password input;
- one file input accepting `image/png,image/jpeg,image/webp`;
- one drag/drop zone and original preview;
- one “开始智能高清” button;
- status text;
- comparison container with original/enhanced stacked images, clipped overlay, range input and accessible labels;
- links for original and enhanced images.

Load the helper before the existing inline script:

```html
<script src="/upscale-ui.js"></script>
<script>
```

- [ ] **Step 2: Add comparison and responsive styles**

Use the existing CSS variables. The central elements must be:

```css
.upscale-compare { position: relative; overflow: hidden; min-height: 420px; border: 1px solid var(--line); border-radius: 14px; background: #070b15; }
.upscale-compare img { display: block; width: 100%; height: 100%; min-height: 420px; object-fit: contain; }
.upscale-after { position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 0 0 var(--compare-position, 50%)); }
.upscale-divider { position: absolute; inset: 0 auto 0 var(--compare-position, 50%); width: 2px; transform: translateX(-1px); background: var(--cyan); pointer-events: none; }
.upscale-range { width: 100%; margin-top: 14px; }
```

Do not add gradients or shadows beyond the page’s existing style language.

- [ ] **Step 3: Implement selection, creation, polling and recovery**

Inside the existing script:

```js
const UPSCALE_TASK_KEY = "jimengUpscaleTaskId";
let upscaleOriginalUrl = "", upscalePollTimer = 0;

async function fileToDataUrl(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("只支持 PNG、JPEG 或 WebP");
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error("原图须小于 25MB");
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("原图读取失败"));
    reader.readAsDataURL(file);
  });
}
```

`startUpscale()` must:

1. read the same `jimengTestApiKey` session key used by the image page;
2. validate a selected Blob;
3. create one stable task ID;
4. persist the Blob in IndexedDB before POST;
5. POST `{ id, image }`;
6. save the task ID only after HTTP 200/202;
7. poll that exact ID.

`pollUpscale(id)` must:

- GET the task every five seconds;
- stop only for terminal states;
- never POST again;
- restore the original Blob from IndexedDB;
- render `providerLabel` as “上游标记 8K”;
- show the safe failure message plus “未自动重提”.

`setUpscaleComparison(value)` must call `clampComparison`, update both the CSS variable and range `aria-valuenow`, and support ArrowLeft/ArrowRight by one percentage point.

`restoreUpscaleTask()` runs when the tab is activated and after login; it reloads the task ID from session storage and the Blob from IndexedDB before polling.

- [ ] **Step 4: Run static and helper verification**

Run:

```powershell
npm run build
node tools/test-agent-upscale.mjs tests/upscale-ui.test.ts
```

Expected: build and UI helper tests pass.

- [ ] **Step 5: Commit the console**

```powershell
git add public/index.html
git -c user.name="lijianqiufeng" -c user.email="lijianqiufeng@users.noreply.github.com" commit -m "feat: add smart HD comparison console"
```

## Task 7: Document the API and Run the Full Regression

**Files:**
- Modify: `API.md`
- Modify: `README.md`

- [ ] **Step 1: Document the async API**

Add to `API.md`:

- POST/GET/DELETE examples;
- single data URL input and 25 MB limit;
- `jm_` Key requirement;
- provider-marked 8K boundary;
- no automatic retry/account switch/4K fallback;
- cancel-after-submit semantics.

Add to `README.md`:

- “Agent 智能高清” feature;
- management-console comparison UI;
- explicit statement that real pixels are not independently verified;
- warning that the current community session path is not the official Volcengine API.

- [ ] **Step 2: Run all isolated tests**

```powershell
node tools/test-canvas-tasks.mjs
node tools/test-agent-upscale.mjs tests/agent-upscale-protocol.test.ts tests/agent-upscale-client.test.ts tests/agent-upscale-tasks.test.ts tests/agent-upscale-routes.test.ts tests/upscale-ui.test.ts
```

Expected:

- existing Canvas tests: 9/9 pass;
- all new Agent protocol/client/task/route/UI tests pass;
- no real network request occurs.

- [ ] **Step 3: Run build and repository checks**

```powershell
npm run build
git diff --check
git status --short
```

Expected:

- tsup build succeeds;
- no whitespace errors;
- `portable-release/` remains untracked and unstaged;
- no credential, database, runtime or private research artifact is staged.

- [ ] **Step 4: Commit documentation**

```powershell
git add API.md README.md
git -c user.name="lijianqiufeng" -c user.email="lijianqiufeng@users.noreply.github.com" commit -m "docs: describe agent 8k upscale API"
```

## Task 8: Review and Final Handoff

**Files:**
- Review all files changed by Tasks 0–7.

- [ ] **Step 1: Run a defect-first code review**

Review:

- paid POST is reachable only once per task ID;
- task/account/workspace/conversation IDs never cross owners;
- fresh uploads do not invent `item_id`;
- event bodies, signed source URLs and credentials never reach logs or public errors;
- `GET`/`DELETE` cannot start a paid request;
- stream reconnect is read-only and bounded by the original deadline;
- UI refresh never creates a second task;
- comparison labels say “上游标记 8K”.

- [ ] **Step 2: Re-run verification after review fixes**

```powershell
node tools/test-canvas-tasks.mjs
node tools/test-agent-upscale.mjs tests/agent-upscale-protocol.test.ts tests/agent-upscale-client.test.ts tests/agent-upscale-tasks.test.ts tests/agent-upscale-routes.test.ts tests/upscale-ui.test.ts
npm run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Report the unverified production boundary**

The handoff must explicitly state:

- no real 8K request was sent;
- no NAS deployment occurred;
- the new-upload Agent path is source-derived and mock-verified, not live-verified;
- a later paid acceptance requires an explicit account and point budget;
- Infinite Canvas integration remains a separate task after CPA verification.
