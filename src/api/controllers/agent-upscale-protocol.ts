import { publicJimengFailure } from "./task-errors.ts";
import { createParser, type ParseEvent } from "eventsource-parser";

export const AGENT_UPSCALE_PROMPT = "帮我8k高清放大";
export const AGENT_4K_UPSCALE_PROMPT = "帮我4k高清放大";
export type AgentUpscaleResolution = "4k" | "8k";
export const agentUpscalePrompt = (resolution: AgentUpscaleResolution, detailStrength?: number) =>
  (resolution === "4k" ? AGENT_4K_UPSCALE_PROMPT : AGENT_UPSCALE_PROMPT) + (detailStrength === undefined ? "" : `，细节生成程度${detailStrength}`);
export const SUPER_RESOLUTION_TOOL = "creative_agent_mcp_gen_image_super_resolution_v3";

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

const SANITIZED_STREAM_FAILURE = "即梦任务失败";
const sseParsers = new WeakMap<AgentObservation, ReturnType<typeof createParser>>();

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

export type AgentHistoryResult =
  | { status: "running" }
  | {
      status: "succeeded";
      providerLabel?: string;
      creditsUsed?: number;
      historyId: string;
      urls: string[];
    }
  | { status: "failed"; error: string };

export function usableAgentId(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value === 0) return undefined;
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "0") return undefined;
  return trimmed;
}

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
  resolution?: AgentUpscaleResolution;
  detailStrength?: number;
}) {
  const itemId = input.attachment.itemId;
  const prompt = agentUpscalePrompt(input.resolution || "8k", input.detailStrength);
  const metrics = {
    userMessageId: input.messageId,
    prompt,
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
          { text: prompt, is_referenced: false },
        ],
      },
      create_time: input.createdAt,
      tools: [POINTS_CONSUMPTION_TOOL],
    }],
    version: "3.0.0",
    workspace_id: input.workspaceId,
    extra_info: JSON.stringify({ dreamina_agent_opt_mode: true }),
  };
}

export function feedAgentSse(state: AgentObservation, chunk: string): void {
  let parser = sseParsers.get(state);
  if (!parser) {
    parser = createParser((event: ParseEvent) => applySseEvent(state, event));
    sseParsers.set(state, parser);
  }
  parser.feed(String(chunk ?? ""));
}

export function mergeAgentHistory(state: AgentObservation, history: unknown): AgentHistoryResult {
  const matched = findHistoryRecord(history, state.submitId, state.historyId);
  if (!matched) return { status: "running" };
  const nestedSubmit = usableAgentId(matched.task?.submit_id);
  if (nestedSubmit) state.submitId = nestedSubmit;
  const status = Number(matched.status);
  if (status === 30) {
    const error = sanitizedHistoryFailure(matched);
    state.failed = error;
    state.complete = true;
    const failedHistoryId = usableAgentId(matched.history_record_id) || usableAgentId(matched.id);
    if (failedHistoryId) state.historyId = failedHistoryId;
    return { status: "failed", error };
  }
  if (status !== 21 && status !== 50) return { status: "running" };
  const urls = httpsImageUrls(matched);
  if (!urls.length) return { status: "running" };
  const forecastResolution = providerResolutionLabel(matched.forecast_resolution);
  if (forecastResolution) state.providerLabel = forecastResolution;
  const historyId = usableAgentId(matched.history_record_id) || usableAgentId(matched.id) || "";
  if (historyId) state.historyId = historyId;
  state.urls = urls;
  state.complete = true;
  return {
    status: "succeeded",
    providerLabel: state.providerLabel,
    creditsUsed: state.creditsUsed,
    historyId,
    urls,
  };
}

function applySseEvent(state: AgentObservation, event: ParseEvent): void {
  if (event.type !== "event") return;
  if (event.event === "error") markStreamFailure(state);
  const payload = parseJsonValue(event.data);
  if (payload === undefined) return;
  inspectJson(state, payload, new Set());
  if (event.event === "stream_complete" && payload && typeof payload === "object" && !Array.isArray(payload) && isFailedCompletion(payload as Record<string, unknown>)) {
    markStreamFailure(state);
  }
}

function inspectJson(state: AgentObservation, value: unknown, seen: Set<object>): void {
  if (typeof value === "string") {
    const nested = parseJsonValue(value);
    if (nested !== undefined && nested !== value) inspectJson(state, nested, seen);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  const conversationId = usableAgentId(record.conversation_id);
  if (conversationId) state.conversationId = conversationId;
  const resolution = nestedResolutionType(record);
  const resolutionLabel = providerResolutionLabel(resolution);
  if (resolutionLabel) state.providerLabel = resolutionLabel;
  const toolName = typeof record.name === "string" ? record.name : typeof (record.func as { name?: unknown } | undefined)?.name === "string" ? (record.func as { name: string }).name : undefined;
  if (toolName === SUPER_RESOLUTION_TOOL && resolutionLabel) state.providerLabel = resolutionLabel;
  const submitId = usableAgentId(record.submit_id);
  if (submitId) state.submitId = submitId;
  if (record.data && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>;
    const nestedSubmitId = usableAgentId(data.submit_id);
    if (nestedSubmitId) state.submitId = nestedSubmitId;
    applyCommerce(state, data.commerce_info);
  }
  applyCommerce(state, record.commerce_info);
  const historyId = usableAgentId(record.history_record_id) || usableAgentId(record.history_id);
  if (historyId) state.historyId = historyId;
  if (record.type === "stream_complete" && (state.urls.length > 0 || state.failed)) state.complete = true;
  if (isTerminalError(record)) markStreamFailure(state);
  for (const nested of Array.isArray(value) ? value : Object.values(record)) inspectJson(state, nested, seen);
}

function nestedResolutionType(record: Record<string, unknown>): string | undefined {
  const direct = record.image_resolution_type;
  const fromArgs = (record.image_args as { image_resolution_type?: unknown } | undefined)?.image_resolution_type;
  const fromGenerate = (record.generate_args as { image_args?: { image_resolution_type?: unknown } } | undefined)?.image_args?.image_resolution_type;
  const value = fromGenerate ?? fromArgs ?? direct;
  return typeof value === "string" ? value : undefined;
}

export function mergeAgentSession(state: AgentObservation, assets: unknown): void {
  const list = (assets as { asset_list?: any[] })?.asset_list;
  if (!Array.isArray(list)) return;
  const session = list.map((item) => item?.agent_conversation_session?.conversation_session)
    .find((item) => item?.conversation_id === state.conversationId);
  if (!session?.mapping || typeof session.mapping !== "object") return;
  // Only server tool replies contain generation receipts. User prompts and
  // assistant prose (including "已提交") cannot establish a submitted task.
  for (const message of Object.values(session.mapping) as any[]) {
    if (message?.author?.role !== "tool") continue;
    for (const part of message.content?.content_parts || []) {
      if (typeof part.text === "string") inspectJson(state, part.text, new Set());
    }
  }
}

function providerResolutionLabel(value: unknown): "4K" | "8K" | undefined {
  const resolution = String(value || "").toLowerCase();
  if (resolution === "4k") return "4K";
  if (resolution === "8k") return "8K";
  return undefined;
}

function applyCommerce(state: AgentObservation, commerce: unknown): void {
  if (!commerce || typeof commerce !== "object") return;
  const info = commerce as { credit_count?: unknown; credit_display_info?: { actual_credits?: unknown } };
  const credits = Number(info.credit_display_info?.actual_credits ?? info.credit_count);
  if (Number.isFinite(credits)) state.creditsUsed = credits;
}

function isTerminalError(record: Record<string, unknown>): boolean {
  const type = String(record.type || "");
  if (type === "error" || type === "system_error" || type.endsWith("_error")) return true;
  if (type === "stream_complete" && isFailedCompletion(record)) return true;
  if (typeof record.result_code === "number" && record.result_code !== 0) return true;
  const submit = record.submit_info as { code?: unknown } | undefined;
  if (typeof submit?.code === "number" && submit.code !== 0) return true;
  return false;
}

function isFailedCompletion(record: Record<string, unknown>): boolean {
  if (record.success === false || record.success === 0) return true;
  const code = record.error_code;
  if (typeof code === "number") return code !== 0;
  if (typeof code === "string") return code.trim() !== "" && code.trim() !== "0";
  return false;
}

function markStreamFailure(state: AgentObservation): void {
  state.failed = SANITIZED_STREAM_FAILURE;
  state.complete = true;
}

function parseJsonValue(text: string): unknown {
  const trimmed = String(text).trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[" && trimmed[0] !== "\"")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function findHistoryRecord(history: unknown, submitId: string | undefined, historyId?: string): Record<string, any> | undefined {
  const records = historyRecords(history);
  if (submitId) {
    const matched = records.find((record) => String(record?.task?.submit_id || "") === submitId);
    if (matched) return matched;
  }
  if (historyId) {
    const matched = records.find((record) => usableAgentId(record?.history_record_id) === historyId || usableAgentId(record?.id) === historyId);
    if (matched) return matched;
  }
  return records.length === 1 ? records[0] : undefined;
}

function historyRecords(history: unknown): Array<Record<string, any>> {
  if (!history || typeof history !== "object") return [];
  if (Array.isArray(history)) return history.filter((item) => item && typeof item === "object");
  const record = history as Record<string, unknown>;
  const collected: Array<Record<string, any>> = [];
  if (record.data && typeof record.data === "object") collected.push(...historyRecords(record.data));
  for (const list of [record.history_list, record.history_records]) {
    if (Array.isArray(list)) collected.push(...list.filter((item) => item && typeof item === "object"));
  }
  for (const value of Object.values(record)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, any>;
    if (item.task || item.item_list || item.history_record_id || item.forecast_resolution || item.status !== undefined) {
      collected.push(item);
    }
  }
  return collected;
}

function httpsImageUrls(record: Record<string, any>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const items = Array.isArray(record.item_list) ? record.item_list : [];
  for (const item of items) {
    const largeImages = item?.image?.large_images;
    const candidates = [
      ...(Array.isArray(largeImages) ? largeImages.map((image: { image_url?: unknown }) => image?.image_url) : []),
      item?.image?.image_url,
    ];
    for (const url of candidates) {
      if (typeof url !== "string" || !/^https:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function sanitizedHistoryFailure(record: Record<string, any>): string {
  return publicJimengFailure(record);
}
