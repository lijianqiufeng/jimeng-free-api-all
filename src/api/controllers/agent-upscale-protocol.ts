import { createParser, type ParseEvent } from "eventsource-parser";

export const AGENT_UPSCALE_PROMPT = "帮我8k高清放大";
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
  const matched = findHistoryRecord(history, state.submitId);
  if (!matched) return { status: "running" };
  const status = Number(matched.status);
  if (status === 30) {
    const error = sanitizedHistoryFailure(matched);
    state.failed = error;
    state.complete = true;
    if (typeof matched.history_record_id === "string" && matched.history_record_id) {
      state.historyId = matched.history_record_id;
    }
    return { status: "failed", error };
  }
  if (status !== 21 && status !== 50) return { status: "running" };
  const urls = httpsImageUrls(matched);
  if (!urls.length) return { status: "running" };
  if (String(matched.forecast_resolution) === "8k") state.providerLabel = "8K";
  const historyId = String(matched.history_record_id || matched.id || "");
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
  if (record.type === "conversation_created" && typeof record.conversation_id === "string" && record.conversation_id) {
    state.conversationId = record.conversation_id;
  } else if (typeof record.conversation_id === "string" && record.conversation_id) {
    state.conversationId = record.conversation_id;
  }
  const resolution = nestedResolutionType(record);
  if (resolution === "8k") state.providerLabel = "8K";
  const toolName = typeof record.name === "string" ? record.name : typeof (record.func as { name?: unknown } | undefined)?.name === "string" ? (record.func as { name: string }).name : undefined;
  if (toolName === SUPER_RESOLUTION_TOOL && resolution === "8k") state.providerLabel = "8K";
  if (typeof record.submit_id === "string" && record.submit_id) state.submitId = record.submit_id;
  if (record.data && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>;
    if (typeof data.submit_id === "string" && data.submit_id) state.submitId = data.submit_id;
    applyCommerce(state, data.commerce_info);
  }
  applyCommerce(state, record.commerce_info);
  if (typeof record.history_record_id === "string" && record.history_record_id) state.historyId = record.history_record_id;
  if (record.type === "stream_complete") state.complete = true;
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

function applyCommerce(state: AgentObservation, commerce: unknown): void {
  if (!commerce || typeof commerce !== "object") return;
  const info = commerce as { credit_count?: unknown; credit_display_info?: { actual_credits?: unknown } };
  const credits = Number(info.credit_display_info?.actual_credits ?? info.credit_count);
  if (Number.isFinite(credits)) state.creditsUsed = credits;
}

function isTerminalError(record: Record<string, unknown>): boolean {
  const type = String(record.type || "");
  if (type === "error" || type === "system_error" || type.endsWith("_error")) return true;
  if (typeof record.result_code === "number" && record.result_code !== 0) return true;
  const submit = record.submit_info as { code?: unknown } | undefined;
  if (typeof submit?.code === "number" && submit.code !== 0) return true;
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

function findHistoryRecord(history: unknown, submitId: string | undefined): Record<string, any> | undefined {
  if (!submitId) return undefined;
  for (const record of historyRecords(history)) {
    if (String(record?.task?.submit_id || "") === submitId) return record;
  }
  return undefined;
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
  return String(record.fail_code) === "2038"
    ? "即梦内容审核未通过，请调整素材或提示词"
    : `即梦生成失败（${String(record.fail_code || "unknown").replace(/[^\w-]/g, "").slice(0, 40)}）`;
}
