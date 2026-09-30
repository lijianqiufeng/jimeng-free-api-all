import crypto from "node:crypto";
import { database, saveMedia } from "@/lib/database.ts";
import { encrypt, decrypt, markFailure, markSuccess } from "@/lib/account-pool.ts";
import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import { accountFailureCooldown, resolveAuthorization } from "./auth.ts";
import { agentUpscalePrompt, createAgentObservation, usableAgentId, type AgentObservation, type AgentUpscaleResolution } from "./agent-upscale-protocol.ts";
import {
  consumeAgentStream,
  ensureAgentWorkspace,
  prepareAgentAttachment,
  queryAgentHistory,
  recoverAgentSession,
  startAgentConversation,
  subscribeAgentWorkspace,
} from "./agent-upscale-client.ts";
import { upscaleTaskInput } from "./upscale-task-contract.ts";

const UNCONFIRMED = "提交结果未确认；为避免重复扣积分未自动重提";
const RISK_4013 = "即梦安全风控拒绝了本次请求（4013：疑似存在异常行为）；未自动重提，请前往即梦网页检查账号安全验证或联系即梦支持";
const GENERIC_FAIL = "即梦提交失败或结果未确认；未自动重提，请检查账号积分、权限和即梦生成记录";
const WAIT_TIMEOUT = "即梦任务等待超时，未重新生成；上游可能继续运行，请检查即梦记录";
const NO_PROGRESS_TIMEOUT = "即梦会话等待超时：10分钟内未返回任务编号或结果，已停止等待；未自动重提，请检查即梦记录与积分";

function attachmentHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}
const CANCELED = "已停止等待；即梦已接收的任务可能继续运行，积分以即梦结算为准";
const CONFLICT = "任务 ID 已使用，不能替换参数或归属";
const NOT_FOUND = "任务不存在";
const DEADLINE_MS = 10 * 60_000;
const NO_PROGRESS_DEADLINE_MS = 10 * 60_000;
const QUERY_THROTTLE_MS = 5000;
const HISTORY_POLL_MS = 30_000;
const RISK_COOLDOWN_MS = 60 * 60_000;

type UpscaleTask = {
  id: string;
  owner: number;
  fingerprint: string;
  resolution: AgentUpscaleResolution;
  detail_strength: number | null;
  status: "submitting" | "running" | "succeeded" | "failed" | "canceled";
  account_id: string;
  credential: string;
  workspace_id: string;
  conversation_id: string;
  reference_uri: string;
  reference_item_id: string;
  provider_task_id: string;
  history_id: string;
  provider_label: string;
  credits_used: number | null;
  result: string;
  error: string;
  deadline: number;
  paid_started_at: number;
  checked_at: number;
};

database.exec(`CREATE TABLE IF NOT EXISTS agent_upscale_tasks (
  id TEXT PRIMARY KEY,
  owner INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT '8k',
  status TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  credential TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  reference_uri TEXT NOT NULL DEFAULT '',
  reference_item_id TEXT NOT NULL DEFAULT '',
  provider_task_id TEXT NOT NULL DEFAULT '',
  history_id TEXT NOT NULL DEFAULT '',
  provider_label TEXT NOT NULL DEFAULT '',
  credits_used INTEGER,
  result TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  deadline INTEGER NOT NULL,
  paid_started_at INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL DEFAULT 0
)`);

const taskColumns = new Set((database.prepare("PRAGMA table_info(agent_upscale_tasks)").all() as Array<{ name: string }>).map((column) => column.name));
if (!taskColumns.has("reference_uri")) database.exec("ALTER TABLE agent_upscale_tasks ADD COLUMN reference_uri TEXT NOT NULL DEFAULT ''");
if (!taskColumns.has("reference_item_id")) database.exec("ALTER TABLE agent_upscale_tasks ADD COLUMN reference_item_id TEXT NOT NULL DEFAULT ''");
if (!taskColumns.has("account_id")) database.exec("ALTER TABLE agent_upscale_tasks ADD COLUMN account_id TEXT NOT NULL DEFAULT ''");
if (!taskColumns.has("history_id")) database.exec("ALTER TABLE agent_upscale_tasks ADD COLUMN history_id TEXT NOT NULL DEFAULT ''");
if (!taskColumns.has("resolution")) database.exec("ALTER TABLE agent_upscale_tasks ADD COLUMN resolution TEXT NOT NULL DEFAULT '8k'");
if (!taskColumns.has("detail_strength")) database.exec("ALTER TABLE agent_upscale_tasks ADD COLUMN detail_strength INTEGER");
if (!taskColumns.has("paid_started_at")) database.exec("ALTER TABLE agent_upscale_tasks ADD COLUMN paid_started_at INTEGER NOT NULL DEFAULT 0");

database.prepare("UPDATE agent_upscale_tasks SET status = 'failed', credential = '', error = ? WHERE status = 'submitting' AND conversation_id = '' AND provider_task_id = ''").run(UNCONFIRMED);
database.prepare("UPDATE agent_upscale_tasks SET status = 'running' WHERE status = 'submitting' AND (conversation_id != '' OR provider_task_id != '')").run();

const monitors = new Map<string, Promise<void>>();
const inflightPaid = new Set<string>();
const liveObservations = new Map<string, AgentObservation>();
const historyReads = new Map<string, { controller: AbortController; work: Promise<void> }>();

const get = (id: string) => database.prepare("SELECT * FROM agent_upscale_tasks WHERE id = ?").get(id) as UpscaleTask | undefined;
const active = (task?: UpscaleTask | null) => Boolean(task && (task.status === "submitting" || task.status === "running"));

function publicTask(task: UpscaleTask) {
  const body: Record<string, unknown> = {
    id: task.id,
    status: task.status === "submitting" ? "running" : task.status,
    resolution: task.resolution,
    detailStrength: task.detail_strength ?? undefined,
    providerLabel: task.provider_label || null,
  };
  // Tool submission commerce is a price quote; a failed generation can refund it.
  if (task.status === "succeeded" && task.credits_used != null) body.creditsUsed = task.credits_used;
  if (task.result) body.data = JSON.parse(task.result);
  if (task.error) body.error = task.error;
  return body;
}

function isAmbiguousNetworkError(error: unknown) {
  const value = error as { code?: string; message?: string };
  const code = String(value?.code || "");
  if (code === "ETIMEDOUT" || code === "ECONNABORTED" || code === "ECONNRESET" || code === "EPIPE") return true;
  const message = String(value?.message || "");
  return /(?:ETIMEDOUT|ECONNABORTED|ECONNRESET)\b/.test(message) || /(?:^|\s)timeout(?:\s|$)/i.test(message);
}

function isRisk4013(error: unknown) {
  return /\b4013\b/.test(String((error as { message?: string })?.message || error || ""));
}

function restoreObservation(task: UpscaleTask): AgentObservation {
  const observation = createAgentObservation(task.conversation_id);
  const submitId = usableAgentId(task.provider_task_id);
  const historyId = usableAgentId(task.history_id);
  if (submitId) observation.submitId = submitId;
  if (historyId) observation.historyId = historyId;
  if (task.provider_label) observation.providerLabel = task.provider_label;
  if (task.credits_used != null) observation.creditsUsed = Number(task.credits_used);
  return observation;
}

function persistObservation(id: string, observation: AgentObservation) {
  const task = get(id);
  if (!active(task)) return;
  const submitId = usableAgentId(observation.submitId) || usableAgentId(task!.provider_task_id) || "";
  const historyId = usableAgentId(observation.historyId) || usableAgentId(task!.history_id) || "";
  const conversationId = usableAgentId(observation.conversationId) || task!.conversation_id || "";
  const label = observation.providerLabel || task!.provider_label || "";
  const credits = observation.creditsUsed != null ? observation.creditsUsed : task!.credits_used;
  database.prepare("UPDATE agent_upscale_tasks SET conversation_id = ?, provider_task_id = ?, history_id = ?, provider_label = ?, credits_used = ? WHERE id = ? AND status IN ('submitting', 'running')")
    .run(conversationId, submitId, historyId, label, credits ?? null, id);
}

function watchObservation(id: string, observation: AgentObservation): AgentObservation {
  const proxy = new Proxy(observation, {
    set(target, prop, value) {
      Reflect.set(target, prop, value);
      if (prop === "submitId" || prop === "historyId" || prop === "providerLabel" || prop === "creditsUsed" || prop === "conversationId") {
        persistObservation(id, target);
      }
      return true;
    },
  });
  liveObservations.set(id, proxy);
  return proxy;
}

function stopLiveObservation(id: string): void {
  historyReads.get(id)?.controller.abort();
  const observation = liveObservations.get(id);
  if (observation) observation.complete = true;
  liveObservations.delete(id);
}

function failTask(id: string, error: string, cause?: unknown, cooldownMs?: number | null) {
  stopLiveObservation(id);
  const task = get(id);
  if (!active(task)) return;
  const updated = database.prepare("UPDATE agent_upscale_tasks SET status = 'failed', credential = '', error = ? WHERE id = ? AND status IN ('submitting', 'running')").run(error, id);
  if (!updated.changes || !task!.account_id) return;
  if (cooldownMs != null) markFailure(task!.account_id, cooldownMs);
  else {
    const classified = accountFailureCooldown(cause);
    if (classified != null) markFailure(task!.account_id, classified);
  }
}

function deadlineFailMessage(task: UpscaleTask) {
  if (!task.conversation_id && !task.provider_task_id) return UNCONFIRMED;
  return WAIT_TIMEOUT;
}

function failClosedIfPastDeadline(id: string, cause?: unknown) {
  const task = get(id);
  if (!task || !active(task) || Date.now() < task.deadline) return false;
  failTask(id, deadlineFailMessage(task), cause);
  return true;
}

function noProgressDeadline(task: UpscaleTask): number {
  if (!task.conversation_id || task.provider_task_id || task.history_id) return task.deadline;
  const started = task.paid_started_at || task.deadline - DEADLINE_MS;
  return Math.min(task.deadline, started + NO_PROGRESS_DEADLINE_MS);
}

function failClosedIfNoProgress(id: string): boolean {
  const task = get(id);
  if (!task || !active(task) || !task.conversation_id || task.provider_task_id || task.history_id || Date.now() < noProgressDeadline(task)) return false;
  failTask(id, NO_PROGRESS_TIMEOUT);
  return true;
}

function succeedTask(id: string, observation: AgentObservation) {
  const task = get(id);
  if (!active(task)) return false;
  const urls = observation.urls.filter((url) => /^https:\/\//i.test(url));
  if (!urls.length) return false;
  const label = observation.providerLabel || task!.provider_label || "";
  const credits = observation.creditsUsed != null ? observation.creditsUsed : task!.credits_used;
  const updated = database.prepare("UPDATE agent_upscale_tasks SET status = 'succeeded', result = ?, provider_label = ?, credits_used = ?, credential = '', error = '' WHERE id = ? AND status IN ('submitting', 'running')")
    .run(JSON.stringify(urls.map((url) => ({ url }))), label, credits, id);
  if (!updated.changes) return false;
  stopLiveObservation(id);
  for (const url of urls) saveMedia("image", url, `jimeng-agent-${task!.resolution}`, agentUpscalePrompt(task!.resolution, task!.detail_strength ?? undefined), "");
  if (task!.account_id) markSuccess(task!.account_id);
  return true;
}

function applyTerminal(id: string, observation: AgentObservation) {
  persistObservation(id, observation);
  if (observation.failed) {
    failTask(id, observation.failed);
    return true;
  }
  if (observation.urls.length) return succeedTask(id, observation);
  return false;
}

function refreshHistory(id: string, token: string, observation: AgentObservation): Promise<void> {
  const pending = historyReads.get(id);
  if (pending) return pending.work;
  const task = get(id);
  if (!active(task) || failClosedIfPastDeadline(id)) return Promise.resolve();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(15_000, task!.deadline - Date.now()));
  const work = readHistory(id, token, observation, controller.signal).finally(() => {
    clearTimeout(timer);
    if (historyReads.get(id)?.work === work) historyReads.delete(id);
  });
  historyReads.set(id, { controller, work });
  return work;
}

async function readHistory(id: string, token: string, observation: AgentObservation, signal: AbortSignal) {
  const task = get(id);
  if (!observation.submitId && task?.workspace_id && observation.conversationId) {
    await recoverAgentSession(token, task.workspace_id, observation, signal);
  }
  if (signal.aborted || !active(get(id)) || failClosedIfPastDeadline(id)) return;
  const result = await queryAgentHistory(token, observation, signal);
  if (signal.aborted || !active(get(id)) || failClosedIfPastDeadline(id)) return;
  if (result.status === "succeeded") {
    observation.urls = result.urls;
    observation.historyId = result.historyId;
    observation.complete = true;
    if (result.providerLabel) observation.providerLabel = result.providerLabel;
    if (result.creditsUsed != null) observation.creditsUsed = result.creditsUsed;
  } else if (result.status === "failed") {
    observation.failed = result.error;
    observation.complete = true;
  }
  persistObservation(id, observation);
}

function classifySubmitFailure(id: string, error: unknown, paidAttempted: boolean) {
  const task = get(id);
  if (!active(task)) return;
  if (isRisk4013(error)) {
    failTask(id, RISK_4013, error, RISK_COOLDOWN_MS);
    return;
  }
  if (paidAttempted && isAmbiguousNetworkError(error) && !task!.provider_task_id) {
    // The Agent may have accepted the conversation before resetting the socket.
    // Preserve its IDs and credential for read-only subscription; never resend.
    database.prepare("UPDATE agent_upscale_tasks SET status = 'running' WHERE id = ? AND status = 'submitting'").run(id);
    ensureMonitor(id);
    return;
  }
  const cooldown = accountFailureCooldown(error);
  failTask(id, publicSubmitFailure(error), error, cooldown);
}

function publicSubmitFailure(error: unknown) {
  const message = String((error as { message?: unknown })?.message || "").trim();
  if (/^即梦/.test(message) && message.length <= 160 && !/https?:|sessionid|jm_|Cookie|token=/i.test(message)) {
    return message;
  }
  return GENERIC_FAIL;
}

function promoteReadOnly(task: UpscaleTask) {
  if (inflightPaid.has(task.id) || task.status !== "submitting" || !task.conversation_id) return task;
  database.prepare("UPDATE agent_upscale_tasks SET status = 'running' WHERE id = ? AND status = 'submitting' AND conversation_id != ''").run(task.id);
  return get(task.id) || task;
}

async function runMonitor(id: string, context?: { observation?: AgentObservation; token: string; workspaceId: string }) {
  let task = get(id);
  if (!task || !active(task)) return;
  if (!task.conversation_id && !task.provider_task_id && Date.now() >= task.deadline) {
    failTask(id, UNCONFIRMED);
    return;
  }
  if (!task.credential) {
    failClosedIfPastDeadline(id);
    return;
  }
  task = promoteReadOnly(task);
  if (task.status !== "running") {
    failClosedIfPastDeadline(id);
    return;
  }
  const token = context?.token || decrypt(task.credential);
  const workspaceId = context?.workspaceId || task.workspace_id;
  const observation = liveObservations.get(id) || context?.observation || watchObservation(id, restoreObservation(task));
  let nextHistoryAt = 0;
  let checkingHistory = false;
  // A healthy subscription can stay open for the entire job. History lookup
  // must run independently, including when an ID first arrives on either SSE.
  const historyPoll = setInterval(() => {
    if (!active(get(id)) || failClosedIfNoProgress(id) || failClosedIfPastDeadline(id)) return;
    if (checkingHistory || Date.now() < nextHistoryAt) return;
    checkingHistory = true;
    nextHistoryAt = Date.now() + HISTORY_POLL_MS;
    void refreshHistory(id, token, observation).then(() => applyTerminal(id, observation)).catch((error) => {
      if (isRisk4013(error)) failTask(id, RISK_4013, error, RISK_COOLDOWN_MS);
      else {
        const current = get(id);
        const cooldown = accountFailureCooldown(error);
        if (active(current) && current!.account_id && cooldown != null) markFailure(current!.account_id, cooldown);
      }
    }).finally(() => { checkingHistory = false; });
  }, 1000);
  try {
    if (observation.historyId) nextHistoryAt = Date.now() + HISTORY_POLL_MS;
    try { if (observation.historyId || !context) await refreshHistory(id, token, observation); } catch (error) {
      if (isRisk4013(error)) {
        failTask(id, RISK_4013, error, RISK_COOLDOWN_MS);
        return;
      }
      if (failClosedIfPastDeadline(id, error)) return;
      const cooldown = accountFailureCooldown(error);
      if (task.account_id && cooldown != null) markFailure(task.account_id, cooldown);
    }
    if (applyTerminal(id, observation)) return;
    if (!active(get(id))) return;
    if (failClosedIfNoProgress(id)) return;
    if (workspaceId && observation.conversationId) {
      await subscribeAgentWorkspace(token, workspaceId, observation, noProgressDeadline(get(id) || task));
      persistObservation(id, observation);
      try { await refreshHistory(id, token, observation); } catch (error) {
        if (isRisk4013(error)) {
          failTask(id, RISK_4013, error, RISK_COOLDOWN_MS);
          return;
        }
        if (failClosedIfPastDeadline(id, error)) return;
        const cooldown = accountFailureCooldown(error);
        if (task.account_id && cooldown != null) markFailure(task.account_id, cooldown);
      }
      if (applyTerminal(id, observation)) return;
    }
    if (failClosedIfNoProgress(id)) return;
    const current = get(id);
    if (current && active(current) && Date.now() >= current.deadline) failTask(id, WAIT_TIMEOUT);
  } catch (error) {
    if (isRisk4013(error)) {
      classifySubmitFailure(id, error, true);
      return;
    }
    if (failClosedIfPastDeadline(id, error)) return;
    const current = get(id);
    if (!current || !active(current)) return;
    const cooldown = accountFailureCooldown(error);
    if (current.account_id && cooldown != null) markFailure(current.account_id, cooldown);
  } finally {
    clearInterval(historyPoll);
  }
}

function ensureMonitor(id: string, context?: { observation?: AgentObservation; token: string; workspaceId: string }) {
  if (monitors.has(id)) return;
  const work = runMonitor(id, context).finally(() => {
    if (monitors.get(id) === work) monitors.delete(id);
  });
  monitors.set(id, work);
}

async function consumePaidStream(
  id: string,
  stream: NodeJS.ReadableStream,
  observation: AgentObservation,
  token: string,
  workspaceId: string,
) {
  const task = get(id);
  if (!task || !active(task)) return;
  try {
    ensureMonitor(id, { observation, token, workspaceId });
    await consumeAgentStream(stream, observation, task.deadline);
    persistObservation(id, observation);
    if (applyTerminal(id, observation)) return;
    if (!active(get(id))) return;
    try { await refreshHistory(id, token, observation); } catch (error) {
      const cooldown = accountFailureCooldown(error);
      if (task.account_id && cooldown != null) markFailure(task.account_id, cooldown);
      if (isRisk4013(error)) {
        failTask(id, RISK_4013, error, RISK_COOLDOWN_MS);
        return;
      }
    }
    if (applyTerminal(id, observation)) return;
    ensureMonitor(id, { observation, token, workspaceId });
  } catch (error) {
    classifySubmitFailure(id, error, true);
  }
}

async function orchestrate(input: { id: string; image: string; resolution: AgentUpscaleResolution; detailStrength?: number }, token: string, accountId: string) {
  const id = input.id;
  const stillSubmitting = () => {
    const current = get(id);
    if (!current || current.status !== "submitting") return current;
    if (Date.now() >= current.deadline) {
      failTask(id, WAIT_TIMEOUT);
      return get(id);
    }
    return current;
  };
  if (stillSubmitting()?.status !== "submitting") return;
  const attachment = await prepareAgentAttachment(input.image, token);
  logger.info(`即梦参考图已解析 host=${attachmentHost(attachment.url)} width=${attachment.width} height=${attachment.height}`);
  database.prepare("UPDATE agent_upscale_tasks SET reference_uri = ?, reference_item_id = ? WHERE id = ? AND status = 'submitting'")
    .run(attachment.uri, attachment.itemId || "", id);
  if (stillSubmitting()?.status !== "submitting") return;
  // Reuse this account's last upscale workspace; task conversation IDs isolate receipts.
  const previousWorkspace = accountId ? database.prepare("SELECT workspace_id FROM agent_upscale_tasks WHERE account_id = ? AND workspace_id != '' ORDER BY rowid DESC LIMIT 1").get(accountId) as { workspace_id: string } | undefined : undefined;
  const workspaceId = previousWorkspace?.workspace_id || await ensureAgentWorkspace(accountId, token);
  database.prepare("UPDATE agent_upscale_tasks SET workspace_id = ? WHERE id = ? AND status = 'submitting'").run(workspaceId, id);
  if (stillSubmitting()?.status !== "submitting") return;
  inflightPaid.add(id);
  const conversationId = util.uuid();
  database.prepare("UPDATE agent_upscale_tasks SET conversation_id = ?, paid_started_at = ? WHERE id = ? AND status = 'submitting'").run(conversationId, Date.now(), id);
  let paidAttempted = false;
  try {
    const pending = stillSubmitting();
    if (pending?.status !== "submitting") return;
    paidAttempted = true;
    const started = await startAgentConversation(token, workspaceId, attachment, conversationId, pending.deadline, input.resolution, input.detailStrength);
    database.prepare("UPDATE agent_upscale_tasks SET status = 'running' WHERE id = ? AND status = 'submitting'").run(id);
    const observation = watchObservation(id, started.observation);
    persistObservation(id, observation);
    void consumePaidStream(id, started.stream, observation, token, workspaceId);
  } catch (error) {
    classifySubmitFailure(id, error, paidAttempted);
  } finally {
    inflightPaid.delete(id);
  }
}

export async function createUpscaleTask(owner: number, authorization: string, body: unknown, requestedAccountId?: string) {
  const input = upscaleTaskInput(body);
  // Legacy 8K task IDs hashed only id and image. Preserve that fingerprint across upgrades.
  const fingerprintInput = input.resolution === "8k" && input.detailStrength === undefined ? { id: input.id, image: input.image } : input;
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
  const previous = get(input.id);
  if (previous) {
    if (previous.owner !== owner || previous.fingerprint !== fingerprint) return { status: 409, body: { error: CONFLICT } };
    return { status: 200, body: publicTask(previous) };
  }
  const credential = await resolveAuthorization(authorization, requestedAccountId, `jimeng-${input.resolution}`, true);
  const reserved = database.prepare("INSERT OR IGNORE INTO agent_upscale_tasks (id, owner, fingerprint, resolution, detail_strength, status, credential, account_id, deadline) VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?, ?)")
    .run(input.id, owner, fingerprint, input.resolution, input.detailStrength ?? null, encrypt(credential.token), credential.accountId || "", Date.now() + DEADLINE_MS);
  if (!reserved.changes) return createUpscaleTask(owner, authorization, body, requestedAccountId);
  void orchestrate(input, credential.token, credential.accountId || "").catch((error) => classifySubmitFailure(input.id, error, false));
  return { status: 202, body: publicTask(get(input.id)!) };
}

export async function queryUpscaleTask(owner: number, id: string) {
  let task = get(id);
  if (!task || task.owner !== owner) return { status: 404, body: { error: NOT_FOUND } };
  if (task.status === "submitting" && task.conversation_id && !inflightPaid.has(id)) task = promoteReadOnly(task);
  if (active(task) && !inflightPaid.has(id) && (Date.now() >= task.deadline || (task.credential && Date.now() - task.checked_at >= QUERY_THROTTLE_MS))) {
    database.prepare("UPDATE agent_upscale_tasks SET checked_at = ? WHERE id = ?").run(Date.now(), id);
    ensureMonitor(id);
  }
  return { status: 200, body: publicTask(get(id)!) };
}

export function cancelUpscaleTask(owner: number, id: string) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return { status: 400, body: { error: "任务 ID 无效" } };
  const previous = get(id);
  if (previous && previous.owner !== owner) return { status: 404, body: { error: NOT_FOUND } };
  stopLiveObservation(id);
  database.prepare("INSERT OR IGNORE INTO agent_upscale_tasks (id, owner, fingerprint, status, deadline) VALUES (?, ?, '', 'canceled', ?)").run(id, owner, Date.now());
  database.prepare("UPDATE agent_upscale_tasks SET status = 'canceled', credential = '', error = ? WHERE id = ? AND status IN ('submitting', 'running', 'canceled')").run(CANCELED, id);
  return { status: 200, body: publicTask(get(id)!) };
}
