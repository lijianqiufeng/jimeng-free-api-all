import crypto from "node:crypto";
import { database, saveMedia } from "@/lib/database.ts";
import { encrypt, decrypt, markFailure, markSuccess } from "@/lib/account-pool.ts";
import util from "@/lib/util.ts";
import { accountFailureCooldown, resolveAuthorization } from "./auth.ts";
import { AGENT_UPSCALE_PROMPT, createAgentObservation, type AgentObservation } from "./agent-upscale-protocol.ts";
import {
  consumeAgentStream,
  ensureAgentWorkspace,
  prepareAgentAttachment,
  queryAgentHistory,
  startAgentConversation,
  subscribeAgentWorkspace,
} from "./agent-upscale-client.ts";
import { upscaleTaskInput } from "./upscale-task-contract.ts";

const UNCONFIRMED = "提交结果未确认；为避免重复扣积分未自动重提";
const RISK_4013 = "即梦安全风控拒绝了本次请求（4013：疑似存在异常行为）；未自动重提，请前往即梦网页检查账号安全验证或联系即梦支持";
const GENERIC_FAIL = "即梦提交失败或结果未确认；未自动重提，请检查账号积分、权限和即梦生成记录";
const WAIT_TIMEOUT = "即梦任务等待超时，未重新生成；上游可能继续运行，请检查即梦记录";
const CANCELED = "已停止等待；即梦已接收的任务可能继续运行，积分以即梦结算为准";
const CONFLICT = "任务 ID 已使用，不能替换参数或归属";
const NOT_FOUND = "任务不存在";
const DEADLINE_MS = 60 * 60_000;
const QUERY_THROTTLE_MS = 5000;
const RISK_COOLDOWN_MS = 60 * 60_000;

type UpscaleTask = {
  id: string;
  owner: number;
  fingerprint: string;
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
  reference_uri TEXT NOT NULL DEFAULT '',
  reference_item_id TEXT NOT NULL DEFAULT '',
  provider_task_id TEXT NOT NULL DEFAULT '',
  history_id TEXT NOT NULL DEFAULT '',
  provider_label TEXT NOT NULL DEFAULT '',
  credits_used INTEGER,
  result TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  deadline INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0
)`);

const taskColumns = new Set((database.prepare("PRAGMA table_info(agent_upscale_tasks)").all() as Array<{ name: string }>).map((column) => column.name));
if (!taskColumns.has("reference_uri")) database.exec("ALTER TABLE agent_upscale_tasks ADD COLUMN reference_uri TEXT NOT NULL DEFAULT ''");
if (!taskColumns.has("reference_item_id")) database.exec("ALTER TABLE agent_upscale_tasks ADD COLUMN reference_item_id TEXT NOT NULL DEFAULT ''");
if (!taskColumns.has("account_id")) database.exec("ALTER TABLE agent_upscale_tasks ADD COLUMN account_id TEXT NOT NULL DEFAULT ''");
if (!taskColumns.has("history_id")) database.exec("ALTER TABLE agent_upscale_tasks ADD COLUMN history_id TEXT NOT NULL DEFAULT ''");

database.prepare("UPDATE agent_upscale_tasks SET status = 'failed', credential = '', error = ? WHERE status = 'submitting' AND conversation_id = '' AND provider_task_id = ''").run(UNCONFIRMED);
database.prepare("UPDATE agent_upscale_tasks SET status = 'running' WHERE status = 'submitting' AND (conversation_id != '' OR provider_task_id != '')").run();

const monitors = new Map<string, Promise<void>>();

const get = (id: string) => database.prepare("SELECT * FROM agent_upscale_tasks WHERE id = ?").get(id) as UpscaleTask | undefined;
const active = (task?: UpscaleTask | null) => Boolean(task && (task.status === "submitting" || task.status === "running"));

function publicTask(task: UpscaleTask) {
  const body: Record<string, unknown> = {
    id: task.id,
    status: task.status === "submitting" ? "running" : task.status,
    providerLabel: task.provider_label || null,
  };
  if (task.credits_used != null) body.creditsUsed = task.credits_used;
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
  if (task.provider_task_id) observation.submitId = task.provider_task_id;
  if (task.history_id) observation.historyId = task.history_id;
  if (task.provider_label) observation.providerLabel = task.provider_label;
  if (task.credits_used != null) observation.creditsUsed = Number(task.credits_used);
  return observation;
}

function persistObservation(id: string, observation: AgentObservation) {
  const task = get(id);
  if (!active(task)) return;
  const submitId = observation.submitId || task!.provider_task_id;
  const historyId = observation.historyId || task!.history_id;
  const conversationId = observation.conversationId || task!.conversation_id;
  const label = observation.providerLabel || task!.provider_label || "";
  const credits = observation.creditsUsed != null ? observation.creditsUsed : task!.credits_used;
  database.prepare("UPDATE agent_upscale_tasks SET conversation_id = ?, provider_task_id = ?, history_id = ?, provider_label = ?, credits_used = ? WHERE id = ? AND status IN ('submitting', 'running')")
    .run(conversationId, submitId, historyId, label, credits, id);
}

function watchObservation(id: string, observation: AgentObservation): AgentObservation {
  return new Proxy(observation, {
    set(target, prop, value) {
      Reflect.set(target, prop, value);
      if (prop === "submitId" || prop === "historyId" || prop === "providerLabel" || prop === "creditsUsed" || prop === "conversationId") {
        persistObservation(id, target);
      }
      return true;
    },
  });
}

function failTask(id: string, error: string, cause?: unknown, cooldownMs?: number | null) {
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
  for (const url of urls) saveMedia("image", url, "jimeng-agent-8k", AGENT_UPSCALE_PROMPT, "");
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

async function refreshHistory(id: string, token: string, observation: AgentObservation) {
  const result = await queryAgentHistory(token, observation);
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
    failTask(id, UNCONFIRMED);
    return;
  }
  const cooldown = accountFailureCooldown(error);
  failTask(id, GENERIC_FAIL, error, cooldown);
}

function promoteReadOnly(task: UpscaleTask) {
  if (task.status !== "submitting" || !task.conversation_id) return task;
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
  const observation = context?.observation || watchObservation(id, restoreObservation(task));
  try {
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
    if (workspaceId && observation.conversationId) {
      await subscribeAgentWorkspace(token, workspaceId, observation, task.deadline);
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
    await consumeAgentStream(stream, observation, task.deadline);
    persistObservation(id, observation);
    if (applyTerminal(id, observation)) return;
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

async function orchestrate(input: { id: string; image: string }, token: string, accountId: string) {
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
  database.prepare("UPDATE agent_upscale_tasks SET reference_uri = ?, reference_item_id = ? WHERE id = ? AND status = 'submitting'")
    .run(attachment.uri, attachment.itemId || "", id);
  if (stillSubmitting()?.status !== "submitting") return;
  const workspaceId = await ensureAgentWorkspace(accountId, token);
  database.prepare("UPDATE agent_upscale_tasks SET workspace_id = ? WHERE id = ? AND status = 'submitting'").run(workspaceId, id);
  if (stillSubmitting()?.status !== "submitting") return;
  const conversationId = util.uuid();
  database.prepare("UPDATE agent_upscale_tasks SET conversation_id = ? WHERE id = ? AND status = 'submitting'").run(conversationId, id);
  if (stillSubmitting()?.status !== "submitting") return;
  let paidAttempted = false;
  try {
    paidAttempted = true;
    const started = await startAgentConversation(token, workspaceId, attachment, conversationId);
    const observation = watchObservation(id, started.observation);
    persistObservation(id, observation);
    database.prepare("UPDATE agent_upscale_tasks SET status = 'running' WHERE id = ? AND status = 'submitting'").run(id);
    void consumePaidStream(id, started.stream, observation, token, workspaceId);
  } catch (error) {
    classifySubmitFailure(id, error, paidAttempted);
  }
}

export async function createUpscaleTask(owner: number, authorization: string, body: unknown) {
  const input = upscaleTaskInput(body);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const previous = get(input.id);
  if (previous) {
    if (previous.owner !== owner || previous.fingerprint !== fingerprint) return { status: 409, body: { error: CONFLICT } };
    return { status: 200, body: publicTask(previous) };
  }
  const credential = await resolveAuthorization(authorization);
  const reserved = database.prepare("INSERT OR IGNORE INTO agent_upscale_tasks (id, owner, fingerprint, status, credential, account_id, deadline) VALUES (?, ?, ?, 'submitting', ?, ?, ?)")
    .run(input.id, owner, fingerprint, encrypt(credential.token), credential.accountId || "", Date.now() + DEADLINE_MS);
  if (!reserved.changes) return createUpscaleTask(owner, authorization, body);
  void orchestrate(input, credential.token, credential.accountId || "").catch((error) => classifySubmitFailure(input.id, error, false));
  return { status: 202, body: publicTask(get(input.id)!) };
}

export async function queryUpscaleTask(owner: number, id: string) {
  let task = get(id);
  if (!task || task.owner !== owner) return { status: 404, body: { error: NOT_FOUND } };
  if (task.status === "submitting" && task.conversation_id) task = promoteReadOnly(task);
  if (active(task) && (Date.now() >= task.deadline || (task.credential && Date.now() - task.checked_at >= QUERY_THROTTLE_MS))) {
    database.prepare("UPDATE agent_upscale_tasks SET checked_at = ? WHERE id = ?").run(Date.now(), id);
    ensureMonitor(id);
  }
  return { status: 200, body: publicTask(get(id)!) };
}

export function cancelUpscaleTask(owner: number, id: string) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return { status: 400, body: { error: "任务 ID 无效" } };
  const previous = get(id);
  if (previous && previous.owner !== owner) return { status: 404, body: { error: NOT_FOUND } };
  database.prepare("INSERT OR IGNORE INTO agent_upscale_tasks (id, owner, fingerprint, status, deadline) VALUES (?, ?, '', 'canceled', ?)").run(id, owner, Date.now());
  database.prepare("UPDATE agent_upscale_tasks SET status = 'canceled', credential = '', error = ? WHERE id = ? AND status IN ('submitting', 'running', 'canceled')").run(CANCELED, id);
  return { status: 200, body: publicTask(get(id)!) };
}
