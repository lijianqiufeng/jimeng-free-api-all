import { createParser, type ParseEvent } from "eventsource-parser";
import { database } from "@/lib/database.ts";
import util from "@/lib/util.ts";
import { request, uploadFile } from "./core.ts";
import {
  buildAgentConversation,
  createAgentObservation,
  feedAgentSse,
  mergeAgentHistory,
  type AgentAttachment,
  type AgentHistoryResult,
  type AgentObservation,
} from "./agent-upscale-protocol.ts";

const BABI_PARAM = JSON.stringify({
  feature_entrance: "to-generate",
  feature_entrance_detail: "to-generate-creation_agent",
  feature_key: "creation_agent",
  scenario: "image_video_generation",
  edit_type: "agent",
});

const STREAM_REQUEST = {
  headers: { Accept: "text/event-stream", "Accept-Encoding": "identity" },
  responseType: "stream" as const,
  timeout: 0,
};

database.exec(`CREATE TABLE IF NOT EXISTS jimeng_agent_sessions (
  account_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);

export async function ensureAgentWorkspace(accountId: string, token: string): Promise<string> {
  const cached = database.prepare("SELECT workspace_id FROM jimeng_agent_sessions WHERE account_id = ?").get(accountId) as { workspace_id: string } | undefined;
  if (cached?.workspace_id) return cached.workspace_id;
  const listed = await request("post", "/mweb/v1/workspace/list", token, { params: { os: "windows" }, data: { offset: 0, limit: 20 } });
  const existing = listed?.workspaces?.[0]?.workspace_id ?? listed?.workspaces?.[0]?.workspaceId;
  const created = existing ? undefined : await request("post", "/mweb/v1/workspace/create", token, { params: { os: "windows" }, data: { name: "CPA 智能高清" } });
  const workspaceId = String(existing ?? created?.workspace_id ?? created?.workspaceId ?? "");
  if (!workspaceId) throw Error("即梦 Agent 工作区初始化失败");
  database.prepare("INSERT OR REPLACE INTO jimeng_agent_sessions(account_id, workspace_id, updated_at) VALUES(?,?,?)").run(accountId, workspaceId, Date.now());
  return workspaceId;
}

export async function prepareAgentAttachment(image: string, token: string): Promise<AgentAttachment> {
  const uploaded = await uploadFile(token, image);
  try {
    await request("post", "/mweb/v1/imagex/submit_audit_job", token, { data: { uri_list: [uploaded.uri] } });
  } catch {
    // Audit failure must not invent success or an item ID.
  }
  const resolved = await request("post", "/mweb/v1/get_image_by_uri", token, { data: { uris: [uploaded.uri] } });
  const info = resolved?.uri2image?.[uploaded.uri];
  if (!info || typeof info.image_url !== "string" || !Number.isFinite(Number(info.width)) || !Number.isFinite(Number(info.height))) {
    throw Error("即梦参考图信息解析失败");
  }
  return { uri: uploaded.uri, url: info.image_url, width: Number(info.width), height: Number(info.height) };
}

export async function startAgentConversation(
  token: string,
  workspaceId: string,
  attachment: AgentAttachment,
  conversationId = util.uuid(),
): Promise<{ stream: NodeJS.ReadableStream; observation: AgentObservation }> {
  const observation = createAgentObservation(conversationId);
  const response = await request("post", "/mweb/v1/creation_agent/v2/conversation", token, {
    params: {
      region: "cn",
      da_version: "3.1.3",
      babi_param: BABI_PARAM,
    },
    data: buildAgentConversation({
      workspaceId,
      conversationId,
      messageId: util.uuid(),
      fileId: util.uuid(),
      createdAt: Date.now(),
      attachment,
    }),
    ...STREAM_REQUEST,
  });
  return { stream: requireStreamOk(response), observation };
}

export async function subscribeAgentWorkspace(
  token: string,
  workspaceId: string,
  observation: AgentObservation,
  deadline: number,
): Promise<void> {
  const response = await request("post", "/mweb/v1/creation_agent/v2/subscribe_session", token, {
    data: { workspace_id: workspaceId },
    ...STREAM_REQUEST,
  });
  await consumeAgentStream(requireStreamOk(response), observation, deadline, { matchConversation: true });
}

export async function queryAgentHistory(token: string, observation: AgentObservation): Promise<AgentHistoryResult> {
  if (!observation.historyId) return { status: "running" };
  const history = await request("post", "/mweb/v1/get_history_by_ids", token, {
    data: { history_ids: [observation.historyId] },
  });
  return mergeAgentHistory(observation, history);
}

export async function consumeAgentStream(
  stream: NodeJS.ReadableStream,
  observation: AgentObservation,
  deadline: number,
  options: { matchConversation?: boolean } = {},
): Promise<void> {
  if (Date.now() >= deadline) return;
  const conversationId = observation.conversationId;
  const feeder = options.matchConversation
    ? createParser((event: ParseEvent) => {
      if (event.type !== "event") return;
      if (sseConversationId(event.data) !== conversationId) return;
      const lines = [];
      if (event.event) lines.push(`event: ${event.event}`);
      lines.push(`data: ${event.data}`, "");
      feedAgentSse(observation, `${lines.join("\n")}\n`);
    })
    : undefined;

  let timedOut = false;
  const decoder = new TextDecoder();
  const timer = setTimeout(() => {
    timedOut = true;
    destroyStream(stream);
  }, Math.max(0, deadline - Date.now()));

  const feed = (text: string) => {
    if (!text) return;
    if (feeder) feeder.feed(text);
    else feedAgentSse(observation, text);
  };

  try {
    for await (const chunk of stream) {
      if (timedOut || Date.now() >= deadline) break;
      feed(decodeStreamChunk(decoder, chunk));
      if (observation.complete) break;
    }
    if (!timedOut && Date.now() < deadline) feed(decoder.decode());
  } catch (error) {
    if (timedOut || Date.now() >= deadline || observation.complete) return;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requireStreamOk(response: { status: number; statusText: string; data: NodeJS.ReadableStream }): NodeJS.ReadableStream {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.data;
}

function decodeStreamChunk(decoder: TextDecoder, chunk: unknown): string {
  if (typeof chunk === "string") return decoder.decode(Buffer.from(chunk), { stream: true });
  if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) return decoder.decode(chunk, { stream: true });
  if (chunk == null) return "";
  return decoder.decode(Buffer.from(String(chunk)), { stream: true });
}

function sseConversationId(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as { conversation_id?: unknown; metadata?: { conversation_id?: unknown } };
    if (typeof record.conversation_id === "string" && record.conversation_id) return record.conversation_id;
    if (typeof record.metadata?.conversation_id === "string" && record.metadata.conversation_id) {
      return record.metadata.conversation_id;
    }
  } catch {
    return undefined;
  }
}

function destroyStream(stream: NodeJS.ReadableStream): void {
  const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void };
  if (typeof destroyable.destroy === "function") destroyable.destroy();
}
