import { createParser, type ParseEvent } from "eventsource-parser";
import { database } from "@/lib/database.ts";
import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import { request, uploadFile } from "./core.ts";
import {
  buildAgentConversation,
  createAgentObservation,
  feedAgentSse,
  findHistoryRecord,
  mergeAgentHistory,
  mergeAgentSession,
  usableAgentId,
  type AgentAttachment,
  type AgentHistoryResult,
  type AgentObservation,
  type AgentUpscaleResolution,
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

const PAID_HANDSHAKE_TIMEOUT_MS = 120_000;
const SUBSCRIBE_HANDSHAKE_TIMEOUT_MS = 30_000;

async function requestAgentStream(
  uri: string,
  token: string,
  options: Parameters<typeof request>[3],
  handshakeTimeoutMs: number,
): Promise<NodeJS.ReadableStream> {
  if (handshakeTimeoutMs <= 0) throw Object.assign(new Error("Agent SSE handshake timeout"), { code: "ETIMEDOUT" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), handshakeTimeoutMs);
  try {
    const response = await request("post", uri, token, { ...options, ...STREAM_REQUEST, signal: controller.signal });
    return requireStreamOk(response);
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error("Agent SSE handshake timeout"), { code: "ETIMEDOUT" });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const URI_RESOLVE_ATTEMPTS = 8;
const URI_RESOLVE_DELAY_MS = 400;
const URI_RESOLVE_PARAMS = {
  da_version: "3.1.3",
  web_version: "7.5.0",
  aigc_features: "app_lip_sync",
  os: "windows",
};

database.exec(`CREATE TABLE IF NOT EXISTS jimeng_agent_sessions (
  account_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);

export function usableWorkspaceId(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value === 0) return undefined;
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "0") return undefined;
  return trimmed;
}

export function readWorkspaceId(value: unknown): string | undefined {
  const named = usableWorkspaceId(value);
  if (named) return named;
  const record = asRecord(value);
  if (!record) return undefined;
  const direct = usableWorkspaceId(record.workspace_id) || usableWorkspaceId(record.workspaceId);
  if (direct) return direct;
  const nested = asRecord(record.workspace);
  const nestedId = nested && (usableWorkspaceId(nested.workspace_id) || usableWorkspaceId(nested.workspaceId) || usableWorkspaceId(nested.id));
  if (nestedId) return nestedId;
  const generic = usableWorkspaceId(record.id);
  if (generic) return generic;
  for (const key of ["workspaces", "workspace_list", "list"]) {
    const items = record[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const found = readWorkspaceId(item);
      if (found) return found;
    }
  }
  return readWorkspaceId(record.data);
}

const workspaceInitializations = new Map<string, Promise<string>>();

export async function ensureAgentWorkspace(accountId: string, token: string): Promise<string> {
  accountId ||= `token:${util.md5(token)}`;
  const cached = database.prepare("SELECT workspace_id FROM jimeng_agent_sessions WHERE account_id = ?").get(accountId) as { workspace_id: string } | undefined;
  const cachedId = usableWorkspaceId(cached?.workspace_id);
  if (cachedId) return cachedId;
  const pending = workspaceInitializations.get(accountId);
  if (pending) return pending;
  const work = initializeAgentWorkspace(accountId, token);
  workspaceInitializations.set(accountId, work);
  try { return await work; } finally { workspaceInitializations.delete(accountId); }
}

async function initializeAgentWorkspace(accountId: string, token: string): Promise<string> {
  const listed = await request("post", "/mweb/v1/workspace/list", token, { params: { os: "windows" }, data: { offset: 0, limit: 20 } });
  const existing = readWorkspaceId(listed);
  const created = existing ? undefined : await request("post", "/mweb/v1/workspace/create", token, { params: { os: "windows" }, data: { name: "图片高清放大" } });
  const workspaceId = existing || readWorkspaceId(created);
  if (!workspaceId) {
    logger.warn(`即梦工作区 ID 无效 list=${summarizeResolve(listed)} create=${summarizeResolve(created)}`);
    throw Error("即梦 Agent 工作区初始化失败");
  }
  database.prepare("INSERT OR REPLACE INTO jimeng_agent_sessions(account_id, workspace_id, updated_at) VALUES(?,?,?)").run(accountId, workspaceId, Date.now());
  return workspaceId;
}

export function readAgentImageInfo(resolved: unknown, uri: string): { url: string; width?: number; height?: number } | undefined {
  const map = readUri2ImageMap(resolved);
  if (!map) return undefined;
  const raw = pickImageEntry(map, uri);
  const info = asRecord(raw) || asRecord(asRecord(raw)?.image);
  if (!info) return undefined;
  const nested = asRecord(info.image) || asRecord(info.metadata) || asRecord(info.image_metadata);
  const url = firstHttpUrl(info.image_url, info.url, info.origin_url, info.cover_url, nested?.image_url, nested?.url);
  if (!url) return undefined;
  const width = firstPositiveInt(info.width, info.image_width, nested?.width, nested?.image_width);
  const height = firstPositiveInt(info.height, info.image_height, nested?.height, nested?.image_height);
  return { url, ...(width != null ? { width } : {}), ...(height != null ? { height } : {}) };
}

export async function prepareAgentAttachment(
  image: string,
  token: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<AgentAttachment> {
  const uploaded = await uploadFile(token, image);
  const local = readDataUrlDimensions(image);
  try {
    await request("post", "/mweb/v1/imagex/submit_audit_job", token, { data: { uri_list: [uploaded.uri] }, params: URI_RESOLVE_PARAMS });
  } catch {
    // Audit failure must not invent success or an item ID.
  }
  const attempts = Math.max(1, options.attempts ?? URI_RESOLVE_ATTEMPTS);
  const delayMs = Math.max(0, options.delayMs ?? URI_RESOLVE_DELAY_MS);
  let lastResolved: unknown;
  const shapes: string[] = [];
  const bodies = [
    { uris: [uploaded.uri] },
    {
      uris: [uploaded.uri],
      image_info: {
        width: local?.width || uploaded.width || 4096,
        height: local?.height || uploaded.height || 4096,
        format: "webp",
      },
      http_common_info: { aid: 513695 },
    },
  ];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const data of bodies) {
      const resolved = await request("post", "/mweb/v1/get_image_by_uri", token, { params: URI_RESOLVE_PARAMS, data });
      shapes.push(redactShape(resolved));
      if (resolved != null) lastResolved = resolved;
      const parsed = completeAttachment(uploaded, resolved, local);
      if (parsed) return parsed;
      if (resolved != null) break;
    }
    if (attempt < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  const fallback = completeAttachment(uploaded, lastResolved, local);
  if (fallback) return fallback;
  logger.warn(`即梦参考图信息解析失败 shapes=${[...new Set(shapes)].slice(0, 4).join(" || ") || "none"} local=${local ? `${local.width}x${local.height}` : "none"}`);
  throw Error("即梦参考图信息解析失败");
}

export async function startAgentConversation(
  token: string,
  workspaceId: string,
  attachment: AgentAttachment,
  conversationId = util.uuid(),
  deadline = Date.now() + PAID_HANDSHAKE_TIMEOUT_MS,
  resolution: AgentUpscaleResolution = "8k",
  detailStrength?: number,
): Promise<{ stream: NodeJS.ReadableStream; observation: AgentObservation }> {
  const observation = createAgentObservation(conversationId);
  const stream = await requestAgentStream("/mweb/v1/creation_agent/v2/conversation", token, {
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
      resolution,
      detailStrength,
    }),
  }, Math.min(PAID_HANDSHAKE_TIMEOUT_MS, deadline - Date.now()));
  return { stream, observation };
}

export async function subscribeAgentWorkspace(
  token: string,
  workspaceId: string,
  observation: AgentObservation,
  deadline: number,
): Promise<void> {
  const stream = await requestAgentStream("/mweb/v1/creation_agent/v2/subscribe_session", token, {
    data: { workspace_id: workspaceId },
  }, Math.min(SUBSCRIBE_HANDSHAKE_TIMEOUT_MS, deadline - Date.now()));
  await consumeAgentStream(stream, observation, deadline, { matchConversation: true });
}

export async function queryAgentHistory(token: string, observation: AgentObservation, signal?: AbortSignal, workspaceId?: string): Promise<AgentHistoryResult> {
  if (!observation.historyId) return { status: "running" };
  const historyId = observation.historyId;
  const read = (id: string) => request("post", "/mweb/v1/get_history_by_ids", token, {
    data: { history_ids: [id] },
    timeout: 15_000,
    signal,
  });
  const history = await read(historyId);
  if (findHistoryRecord(history, observation.submitId, historyId) || !workspaceId || !observation.conversationId || signal?.aborted) {
    return mergeAgentHistory(observation, history);
  }
  // Repair only from this original conversation's tool receipt; never resubmit.
  await recoverAgentSession(token, workspaceId, observation, signal);
  if (!signal?.aborted && observation.historyId && observation.historyId !== historyId) {
    return mergeAgentHistory(observation, await read(observation.historyId));
  }
  return mergeAgentHistory(observation, history);
}

export async function consumeAgentStream(
  stream: NodeJS.ReadableStream,
  observation: AgentObservation,
  deadline: number,
  options: { matchConversation?: boolean } = {},
): Promise<void> {
  if (Date.now() >= deadline) return;
  const feeder = options.matchConversation
    ? createParser((event: ParseEvent) => {
      if (event.type !== "event") return;
      if (!eventMatchesConversation(event.data, observation)) return;
      const lines = [];
      if (event.event) lines.push(`event: ${event.event}`);
      lines.push(`data: ${event.data}`, "");
      feedAgentSse(observation, `${lines.join("\n")}\n`);
    })
    : undefined;

  let timedOut = false;
  let bytes = 0;
  let lines = 0;
  let events = 0;
  const digest = createParser((event: ParseEvent) => {
    if (event.type !== "event" || events >= 12) return;
    events += 1;
    logger.info(`agent-sse ${summarizeSse(event)}`);
  });
  const decoder = new TextDecoder();
  const timer = setTimeout(() => {
    timedOut = true;
    destroyStream(stream);
  }, Math.max(0, deadline - Date.now()));
  const completeWatch = setInterval(() => {
    if (observation.complete || Date.now() >= deadline) destroyStream(stream);
  }, 500);

  const feed = (text: string) => {
    if (!text) return;
    bytes += text.length;
    lines += text.split("\n").length - 1;
    digest.feed(text);
    if (feeder) feeder.feed(text);
    else feedAgentSse(observation, text);
  };
  const pulse = setInterval(() => {
    logger.info(`agent-sse pulse bytes=${bytes} lines=${lines} events=${events} complete=${observation.complete ? 1 : 0} submit=${observation.submitId ? 1 : 0} history=${observation.historyId ? 1 : 0} failed=${observation.failed ? 1 : 0}`);
  }, 10000);

  try {
    for await (const chunk of stream) {
      if (timedOut || observation.complete || Date.now() >= deadline) break;
      feed(decodeStreamChunk(decoder, chunk));
      if (observation.complete) break;
    }
    if (!timedOut && !observation.complete && Date.now() < deadline) feed(decoder.decode());
    if (!timedOut && !observation.complete && Date.now() < deadline) feed("\n\n");
  } catch (error) {
    if (timedOut || Date.now() >= deadline || observation.complete) return;
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(completeWatch);
    clearInterval(pulse);
    logger.info(`agent-sse end bytes=${bytes} lines=${lines} events=${events} complete=${observation.complete ? 1 : 0} submit=${observation.submitId ? 1 : 0} history=${observation.historyId ? 1 : 0} failed=${observation.failed ? 1 : 0}`);
  }
}

function summarizeSse(event: ParseEvent): string {
  if (event.type !== "event") return "interval";
  const data = event.data || "";
  let keys = "raw";
  let type = "-";
  let tool = "-";
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      keys = Object.keys(parsed).slice(0, 8).join("/") || "empty";
      if (typeof parsed.type === "string" && /^[a-z0-9_]{1,40}$/i.test(parsed.type)) type = parsed.type;
      const call = Array.isArray(parsed.tool_calls) ? asRecord(parsed.tool_calls[0]) : undefined;
      const func = asRecord(call?.func) || asRecord(parsed.func);
      const name = typeof func?.name === "string" ? func.name : typeof parsed.name === "string" ? parsed.name : "";
      if (/^[a-z0-9_]{1,80}$/i.test(name)) tool = name;
    }
  } catch {
    keys = "raw";
  }
  const submit = /"submit_id"\s*:/.test(data) ? 1 : 0;
  const history = /"history_(?:record_)?id"\s*:/.test(data) ? 1 : 0;
  const url = /https?:\/\//.test(data) ? 1 : 0;
  return `event=${event.event || "-"} type=${type} keys=${keys} tool=${tool} submit=${submit} history=${history} url=${url} bytes=${data.length}`;
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

function eventMatchesConversation(data: string, observation: AgentObservation): boolean {
  const ids = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
      try { visit(JSON.parse(trimmed), depth + 1); } catch { /* Non-JSON tool text. */ }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const candidate of [record.conversation_id, record.conversationId]) {
      const id = usableAgentId(candidate);
      if (id) ids.add(id);
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(data, 0);
  return ids.size === 1 && ids.has(observation.conversationId);
}

export async function recoverAgentSession(token: string, workspaceId: string, observation: AgentObservation, signal?: AbortSignal): Promise<void> {
  const assets = await request("post", "/mweb/v1/get_asset_list", token, {
    timeout: 15_000,
    signal,
    data: {
      count: 20, asset_type_list: [1, 2, 5, 6, 7, 8, 9, 10, 12], direction: 1,
      mode: "workbench", workspace_id: workspaceId, search_keyword: "",
      extra_info: JSON.stringify({ dreamina_agent_opt_mode: true }),
      option: { order_by: 0, only_favorited: false, end_time_stamp: 0, hide_story_agent_result: true },
    },
  });
  if (!signal?.aborted) mergeAgentSession(observation, assets);
}

function destroyStream(stream: NodeJS.ReadableStream): void {
  const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void };
  if (typeof destroyable.destroy === "function") destroyable.destroy();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readUri2ImageMap(resolved: unknown): Record<string, unknown> | undefined {
  const root = asRecord(resolved);
  if (!root) return undefined;
  const nested = asRecord(root.data);
  const deeper = asRecord(nested?.data);
  const candidates = [root.uri2image, root.uri2Image, nested?.uri2image, nested?.uri2Image, deeper?.uri2image, deeper?.uri2Image];
  for (const candidate of candidates) {
    const map = normalizeUri2Image(candidate);
    if (map) return map;
  }
  return undefined;
}

function normalizeUri2Image(candidate: unknown): Record<string, unknown> | undefined {
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { return undefined; }
  }
  const map = asRecord(candidate);
  if (map && Object.keys(map).length) return map;
  if (!Array.isArray(candidate) || !candidate.length) return undefined;
  const converted: Record<string, unknown> = {};
  for (const item of candidate) {
    const record = asRecord(item);
    const key = String(record?.uri || record?.image_uri || "");
    if (key) converted[key] = record;
  }
  return Object.keys(converted).length ? converted : undefined;
}

function pickImageEntry(map: Record<string, unknown>, uri: string): unknown {
  if (map[uri] != null) return map[uri];
  const match = Object.keys(map).find((key) => key === uri || key.startsWith(`${uri}~`) || key.startsWith(`${uri}/`) || key.includes(uri) || uri.includes(key));
  if (match) return map[match];
  const keys = Object.keys(map);
  return keys.length === 1 ? map[keys[0]] : undefined;
}

function firstHttpUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
    const nested = asRecord(value);
    if (!nested) continue;
    for (const key of ["url", "image_url", "origin_url", "cover_url"]) {
      if (typeof nested[key] === "string" && /^https?:\/\//i.test(String(nested[key]))) return String(nested[key]);
    }
  }
}

function firstPositiveInt(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
}

function completeAttachment(
  uploaded: { uri: string; url?: string; width?: number; height?: number },
  resolved: unknown,
  local: { width: number; height: number } | undefined,
): AgentAttachment | undefined {
  const info = readAgentImageInfo(resolved, uploaded.uri);
  const width = info?.width ?? firstPositiveInt(uploaded.width) ?? local?.width;
  const height = info?.height ?? firstPositiveInt(uploaded.height) ?? local?.height;
  const url = info?.url ?? (typeof uploaded.url === "string" && /^https?:\/\//i.test(uploaded.url) ? uploaded.url : undefined);
  if (!url || width == null || height == null) return undefined;
  return { uri: uploaded.uri, url, width, height };
}

export function readDataUrlDimensions(image: string): { width: number; height: number } | undefined {
  const comma = image.indexOf(",");
  if (comma < 0) return undefined;
  try {
    return readImageDimensions(Buffer.from(image.slice(comma + 1), "base64"));
  } catch {
    return undefined;
  }
}

function readImageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes.toString("ascii", 1, 4) === "PNG") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length - 8) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      const length = bytes.readUInt16BE(offset + 2);
      offset += 2 + length;
    }
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
    if (kind === "VP8 " && bytes.length >= 30) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (kind === "VP8L" && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
}

function redactShape(value: unknown, depth = 0): string {
  if (value == null) return String(value);
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? `url:${value.length}` : `str:${value.length}`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return depth >= 2 ? `arr:${value.length}` : `arr:${value.length}${value.length ? `[${redactShape(value[0], depth + 1)}]` : ""}`;
  if (typeof value === "object") {
    const keys = Object.keys(value).slice(0, 8);
    const safeKey = (key: string) => /^(?:data|ret|uri2image|uri2Image|image|image_url|url|width|height|metadata|image_metadata|code|message)$/.test(key) ? key : `key:${key.length}`;
    if (depth >= 2) return keys.map(safeKey).join("/");
    return `{${keys.map((key) => `${safeKey(key)}:${redactShape((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
  }
  return typeof value;
}

function summarizeResolve(resolved: unknown): string {
  const root = asRecord(resolved);
  if (!root) return String(resolved);
  const map = readUri2ImageMap(resolved);
  return `root=${Object.keys(root).slice(0, 12).join("/")} map=${map ? Object.keys(map).length : 0}`;
}
