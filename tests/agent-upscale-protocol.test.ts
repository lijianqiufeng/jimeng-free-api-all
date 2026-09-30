import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AGENT_4K_UPSCALE_PROMPT,
  AGENT_UPSCALE_PROMPT,
  buildAgentConversation,
  createAgentObservation,
  feedAgentSse,
  mergeAgentHistory,
  mergeAgentSession,
  usableAgentId,
} from "@/api/controllers/agent-upscale-protocol.ts";

const attachment = {
  uri: "tos-test-original",
  url: "https://fixture.invalid/original.webp",
  width: 768,
  height: 1024,
};

test("page history restores only the exact conversation's server tool receipt", () => {
  const state = createAgentObservation("our-conversation");
  const receipt = (submit: string) => ({ content_parts: [{ text: JSON.stringify({ data: JSON.stringify({ data: {
    submit_id: submit, history_id: "generation-history", commerce_info: { credit_count: 4 },
  } }) }) }] });
  mergeAgentSession(state, { asset_list: [
    { agent_conversation_session: { conversation_session: { conversation_id: "other-conversation", mapping: {
      tool: { author: { role: "tool" }, content: receipt("wrong-task") },
    } } } },
    { agent_conversation_session: { conversation_session: { conversation_id: "our-conversation", history_id: "not-generation", mapping: {
      tool: { author: { role: "tool" }, content: receipt("our-task") },
      user: { author: { role: "user" }, content: receipt("prompt-injection") },
      assistant: { author: { role: "assistant" }, content: receipt("only-prose") },
    } } } },
  ] });
  assert.equal(state.conversationId, "our-conversation");
  assert.equal(state.submitId, "our-task");
  assert.equal(state.historyId, "generation-history");
  assert.equal(state.creditsUsed, 4);
  assert.equal(state.complete, false);
  assert.deepEqual(state.urls, []);
});

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
  assert.equal(request.workspace_id, "10001");
  assert.equal(typeof request.workspace_id, "string");
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

test("automatic 4K request changes only the fixed Agent prompt", () => {
  const request = buildAgentConversation({
    workspaceId: "10001", conversationId: "conv-4k-test", messageId: "msg-4k-test",
    fileId: "file-4k-test", createdAt: 1700000000000, attachment, resolution: "4k",
  });
  assert.equal(request.messages[0].content.content_parts[1].text, AGENT_4K_UPSCALE_PROMPT);
  assert.equal(JSON.parse(request.messages[0].metadata.metrics_extra).prompt, AGENT_4K_UPSCALE_PROMPT);
  assert.equal(JSON.stringify(request).includes("generate_args"), false);
});

test("4K forecast resolution remains distinguishable from 8K", () => {
  const state = createAgentObservation("conv-4k-test");
  feedAgentSse(state, `event: system\ndata: ${JSON.stringify({ image_args: { image_resolution_type: "4k" } })}\n\n`);
  assert.equal(state.providerLabel, "4K");
  const history = { data: { history_list: [{ history_record_id: "history-4k-test", status: 21,
    forecast_resolution: "4k", item_list: [{ image: { image_url: "https://fixture.invalid/result-4k.webp" } }] }] } };
  const result = mergeAgentHistory(state, history);
  assert.equal(result.status, "succeeded");
  assert.equal(result.status === "succeeded" && result.providerLabel, "4K");
});

test("SSE and history merge into one provider-marked 8K outcome", () => {
  const state = createAgentObservation("conv-client-test-001");
  feedAgentSse(state, fs.readFileSync("tests/fixtures/agent-8k-success.sse", "utf8"));
  assert.equal(state.conversationId, "conv-server-test-001");
  assert.equal(state.submitId, "submit-test-001");
  assert.equal(state.providerLabel, "8K");
  assert.equal(state.creditsUsed, 4);
  assert.equal(state.complete, false);
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

test("usableAgentId skips protobuf default 0", () => {
  assert.equal(usableAgentId(0), undefined);
  assert.equal(usableAgentId("0"), undefined);
  assert.equal(usableAgentId(7471122), "7471122");
  assert.equal(usableAgentId("7471122"), "7471122");
});

test("SSE accepts numeric conversation and history ids", () => {
  const state = createAgentObservation("conv-client");
  feedAgentSse(state, `event: system\ndata: ${JSON.stringify({
    type: "conversation_created",
    conversation_id: 19617933949964,
    history_record_id: 7471122,
    data: { submit_id: 0 },
  })}\n\n`);
  assert.equal(state.conversationId, "19617933949964");
  assert.equal(state.historyId, "7471122");
  assert.equal(state.submitId, undefined);
});

test("failed stream_complete is terminal, while an empty successful completion is not", () => {
  const failed = createAgentObservation("conv-failed");
  feedAgentSse(failed, `event: stream_complete\ndata: ${JSON.stringify({ success: false, error_code: 3001, error_message: "private upstream detail" })}\n\n`);
  assert.equal(failed.complete, true);
  assert.equal(failed.failed, "即梦任务失败");
  assert.equal(failed.failed?.includes("private upstream detail"), false);

  const pending = createAgentObservation("conv-pending");
  feedAgentSse(pending, `event: stream_complete\ndata: ${JSON.stringify({ success: true, error_code: 0 })}\n\n`);
  assert.equal(pending.complete, false);
  assert.equal(pending.failed, undefined);
});

test("history merge can use the history id before submit id arrives", () => {
  const state = createAgentObservation("conv-client-test-001");
  state.historyId = "history-test-001";
  const history = JSON.parse(fs.readFileSync("tests/fixtures/agent-8k-history-success.json", "utf8"));
  const result = mergeAgentHistory(state, history);
  assert.equal(result.status, "succeeded");
  assert.equal(state.submitId, "submit-test-001");
  assert.deepEqual(result.status === "succeeded" ? result.urls : [], ["https://fixture.invalid/result-8k.webp"]);
});


test("detail strength is appended only when explicitly changed, including zero and fifty", () => {
  for (const detailStrength of [0, 50, 100]) {
    const request = buildAgentConversation({ workspaceId: "w", conversationId: "c", messageId: "m", fileId: "f", createdAt: 1, attachment, resolution: "8k", detailStrength });
    assert.equal(request.messages[0].content.content_parts[1].text, `帮我8k高清放大，细节生成程度${detailStrength}`);
  }
});

test("image moderation reason is retained for the exact failed upscale history", () => {
  const state = createAgentObservation("ours"); state.historyId = "h";
  const result = mergeAgentHistory(state, { h: { history_record_id: "h", status: 30, fail_code: "2039" } });
  assert.deepEqual(result, { status: "failed", error: "你上传的图片不符合平台规则，请修改后重试" });
});
