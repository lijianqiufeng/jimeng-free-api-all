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
