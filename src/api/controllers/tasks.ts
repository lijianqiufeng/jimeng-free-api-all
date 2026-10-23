import crypto from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { database, validateApiKey } from "@/lib/database.ts";
import accountPool, { accountTier, accountSupportsModel, isVideoSubmissionAccount, encrypt, decrypt, markFailure, markSuccess, readAccountSessionById, reserveVideoAccount, videoAccountUsage, videoSubmissionReconciled, videoReservedCredits, VIDEO_ACCOUNT_SUBMISSION_CONCURRENCY } from "@/lib/account-pool.ts";
import { accountFailureCooldown, refreshVideoAccountBalances, resolveAuthorization } from "./auth.ts";
import { generateImages } from "./images.ts";
import { request, videoSubmissionReceipt, withVideoRequestSignal, drainVideoRequests } from "./core.ts";
import { taskHistory, taskInput, taskResult } from "./task-contract.ts";
import { quoteSeedanceDraftUpgrade, submitSeedanceDraftUpgrade, submitSeedanceVideo, type SeedanceSubmitHooks } from "./seedance.ts";
import { assertDraftSourceAvailable, readDraftSource } from "./seedance-draft-protocol.ts";
import { UploadError } from "./seedance-upload.ts";
import { videoAccountMinimumCredits } from "./video-quote.ts";
import { readVideoBilling } from "./video-billing.ts";
import logger from "@/lib/logger.ts";
import { readVideoQueueSettings } from "@/lib/video-queue-settings.ts";
import { isLongVideo } from "./seedance-contract.ts";

type Task = { id: string; owner: number; kind: "image" | "video"; model: string; fingerprint: string; status: string; credential: string; account_id: string; history_id: string; result: string; error: string; deadline: number; checked_at: number; payload_path: string; requested_account_id: string; provider_hold: number; paid_started_at: number; provider_status: string; credit_before: number | null; quote_json: string | null; source_task_id: string; sample_snapshot_json: string | null; billing_json: string | null };
database.exec(`CREATE TABLE IF NOT EXISTS canvas_tasks (
  id TEXT PRIMARY KEY, owner INTEGER NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
  fingerprint TEXT NOT NULL, status TEXT NOT NULL, credential TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  history_id TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  deadline INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0
)`);
database.pragma("synchronous = FULL");
database.transaction(() => {
  const columns = new Set((database.prepare("PRAGMA table_info(canvas_tasks)").all() as Array<{ name: string }>).map(column => column.name));
  for (const [name, definition] of [["account_id", "TEXT NOT NULL DEFAULT ''"], ["payload_path", "TEXT NOT NULL DEFAULT ''"], ["requested_account_id", "TEXT NOT NULL DEFAULT ''"], ["provider_hold", "INTEGER NOT NULL DEFAULT 0"], ["provider_status", "TEXT NOT NULL DEFAULT ''"], ["credit_before", "INTEGER"], ["quote_json", "TEXT"], ["source_task_id", "TEXT NOT NULL DEFAULT ''"], ["sample_snapshot_json", "TEXT"], ["billing_json", "TEXT"], ["paid_started_at", "INTEGER NOT NULL DEFAULT 0"]]) {
    if (!columns.has(name)) database.exec(`ALTER TABLE canvas_tasks ADD COLUMN ${name} ${definition}`);
  }
  if (!columns.has("provider_hold")) database.prepare("UPDATE canvas_tasks SET provider_hold=1 WHERE kind='video' AND account_id!='' AND (status IN ('submitting','running') OR status='canceled' OR error LIKE '%提交结果未确认%' OR error LIKE '%提交失败或结果未确认%')").run();
  // Only a persisted pre-submission preparation may resume; paid requests are never replayed.
  database.prepare("UPDATE canvas_tasks SET status='queued', provider_status='queued', account_id='', credential='', provider_hold=0 WHERE kind='video' AND status='preparing' AND paid_started_at=0 AND payload_path!=''").run();
  // A canceled upload no longer has a dispatcher after restart, and its paid-send marker was never set.
  database.prepare("UPDATE canvas_tasks SET provider_status='canceled', provider_hold=0, credential='' WHERE kind='video' AND status='canceled' AND provider_status='preparing' AND provider_hold=1 AND paid_started_at=0 AND history_id=''").run();
  database.prepare("UPDATE canvas_tasks SET status='uncertain', provider_status='uncertain', provider_hold=1, error='服务重启时提交结果未确认；账号保持占用，未自动重提，请检查即梦记录' WHERE kind='video' AND status IN ('submitting','preparing')").run();
  database.prepare("UPDATE canvas_tasks SET status=CASE WHEN history_id!='' AND credential!='' THEN 'running' ELSE 'uncertain' END, error='服务重启时提交结果未确认；保留原账号与凭据，未自动重提，请检查即梦记录' WHERE kind='image' AND status='submitting'").run();
}).immediate();
database.exec("CREATE INDEX IF NOT EXISTS idx_canvas_video_hold ON canvas_tasks(kind, provider_hold, account_id)");
const polling = new Map<string, Promise<void>>();
const resultRefreshing = new Map<string, Promise<boolean>>();
const videoDispatches = new Map<string, { controller: AbortController; done: Promise<void> }>();
const get = (id: string) => database.prepare("SELECT * FROM canvas_tasks WHERE id = ?").get(id) as Task | undefined;

function readTaskResult(response: any, task: Task) {
  const longQuote = isLongVideo(task.model) && task.quote_json ? JSON.parse(task.quote_json) : undefined;
  return taskResult(response, task.history_id, task.kind, isLongVideo(task.model) ? { model: task.model, submitId: longQuote?.mode === "long" && longQuote.taskId === task.id && longQuote.accountId === task.account_id ? longQuote.submitId : undefined } : undefined);
}

/** Refresh only the signed media URL of a successful video through its original account/history. */
async function refreshSucceededVideoResult(task: Task) {
  if (resultRefreshing.has(task.id)) return resultRefreshing.get(task.id)!;
  const work = (async () => {
    try {
      const response = await request("post", "/mweb/v1/get_history_by_ids", readAccountSessionById(task.account_id), { timeout: 15_000, data: { history_ids: [task.history_id] } });
      const result = readTaskResult(response, task);
      if (result.status !== "succeeded") return false;
      const media = JSON.stringify(result.urls.map((url) => ({ url })));
      return database.prepare("UPDATE canvas_tasks SET result=?, checked_at=? WHERE id=? AND owner=? AND kind='video' AND status='succeeded' AND account_id=? AND history_id=?").run(media, Date.now(), task.id, task.owner, task.account_id, task.history_id).changes === 1;
    } catch {
      return false;
    }
  })().finally(() => resultRefreshing.delete(task.id));
  resultRefreshing.set(task.id, work);
  return work;
}
function sourceForUpgrade(id: string, owner: number) {
  const task = get(id);
  if (!task || task.owner !== owner || task.kind !== "video" || task.model !== "jimeng-video-seedance-2.5-draft" || task.source_task_id || task.status !== "succeeded" || task.provider_hold || !task.history_id || !task.account_id || !task.sample_snapshot_json || !task.quote_json) throw Error("原样片缺少完整来源或尚未成功，未提交高清生成");
  if (!isVideoSubmissionAccount(accountPool.get(task.account_id).name)) throw Error("原样片账号已暂停新视频提交，不能转换高清；原样片保留，未更换账号或提交生成");
  const snapshot = JSON.parse(decrypt(task.sample_snapshot_json)), quote = JSON.parse(task.quote_json);
  assertDraftSourceAvailable(snapshot);
  if (snapshot.historyId !== task.history_id || quote.taskId !== task.id || quote.accountId !== task.account_id || quote.model !== task.model || quote.resolution !== "480p" || quote.operation || snapshot.duration !== quote.duration || snapshot.hasVideo !== quote.hasVideo || snapshot.referenceVideoSeconds !== quote.referenceVideoSeconds || !Number.isInteger(quote.duration) || quote.duration < 4 || quote.duration > 30 || typeof quote.hasVideo !== "boolean" || !Number.isFinite(quote.referenceVideoSeconds) || quote.referenceVideoSeconds < 0 || quote.referenceVideoSeconds > 30.2 || !quote.hasVideo && quote.referenceVideoSeconds !== 0) throw Error("原样片身份或冻结配置不匹配，未提交高清生成");
  return { task, snapshot, quote };
}
function draftUpgradeState(task: Task) {
  if (task.model !== "jimeng-video-seedance-2.5-draft" || task.source_task_id || task.status !== "succeeded") return {};
  try { const { snapshot } = sourceForUpgrade(task.id, task.owner); return { draftUpgrade: { available: true, expiresAt: snapshot.finishedTime + 7 * 86400_000 } }; }
  catch { return { draftUpgrade: { available: false } }; }
}
function videoBillingState(task: Task) {
  return task.billing_json ? { billing: JSON.parse(task.billing_json), creditsUsed: JSON.parse(task.billing_json).amount } : task.kind === "video" && task.status === "succeeded" ? { billingPending: true } : {};
}
function videoQueueReason(task: Task) {
  const accounts = accountPool.list().filter(account => account.enabled && accountSupportsModel(account.name, task.model, true) && (!task.requested_account_id || account.id === task.requested_account_id));
  if (!accounts.length) return "等待可用超级账号，本视频尚未提交即梦";
  const usage = videoAccountUsage();
  if (accounts.every(account => (usage.get(account.id)?.active || 0) >= VIDEO_ACCOUNT_SUBMISSION_CONCURRENCY)) {
    const unknown = database.prepare("SELECT id,kind,account_id,status,provider_status,provider_hold,paid_started_at,history_id,result,quote_json FROM canvas_tasks WHERE kind='video' AND account_id=? AND provider_hold=1 AND (provider_status='uncertain' OR status='uncertain')");
    return accounts.some(account => (unknown.all(account.id) as Task[]).some(item => !videoSubmissionReconciled(item))) ? "前序视频提交回执待确认，需核对原任务后释放账号；本视频尚未提交即梦" : "等待账号当前素材上传与提交完成，本视频尚未提交即梦";
  }
  return "等待账号余额、官方报价或提交名额确认，本视频尚未提交即梦";
}
function publicVideoQuote(task: Task) {
  const quote = JSON.parse(task.quote_json || "null");
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) return quote;
  // submitId is part of the service-to-service long-video billing contract.
  // Keep account labels, draft internals and retained raw evidence private.
  for (const key of ["accountName", "accountTier", "draftId", "submissionReceipt", "submissionReconciliation"]) delete quote[key];
  return quote;
}
const publicTask = (task: Task) => {
  const queueReason = task.kind === "video" && task.status === "queued" ? videoQueueReason(task) : undefined;
  const error = videoSubmissionReconciled(task) ? "已人工确认官网无对应记录并解除提交占槽；原任务与积分预留仍待核对，未重新生成" : task.error || queueReason;
  return { id: task.id, status: task.kind === "video" && task.provider_hold && task.status === "failed" ? "uncertain" : ["submitting", "preparing"].includes(task.status) ? "running" : task.status, model: task.model, ...(task.result && task.status !== "canceled" ? { data: JSON.parse(task.result).map((item: any) => ({ ...item, ...(task.model === "jimeng-video-seedance-2.5-draft" ? { jimengMode: task.source_task_id ? "final" : "draft" } : {}) })) } : {}), ...draftUpgradeState(task), ...videoBillingState(task), ...(error ? { error } : {}), ...(queueReason ? { queueReason } : {}), ...(task.kind === "video" ? { accountId: task.account_id || null, ...(task.paid_started_at > 0 && task.quote_json ? { quote: publicVideoQuote(task) } : {}), creditBefore: task.credit_before, deadlineAt: task.deadline, providerStatus: task.provider_status || task.status, providerHold: Boolean(task.provider_hold) } : task.status === "canceled" && !task.fingerprint && !task.account_id ? { providerHold: false, providerStatus: "canceled" } : {}) };
};
const videoQueueRoot = path.join(path.dirname(process.env.DB_PATH || "./data/jimeng.db"), "private", "video-queue");
const payloadPath = (task: Pick<Task, "owner" | "id" | "fingerprint">) => path.join(videoQueueRoot, `${crypto.createHash("sha256").update(`${task.owner}:${task.id}:${task.fingerprint}`).digest("hex")}.json.enc`);
const clearPayload = (task: Task) => task.payload_path && task.payload_path === payloadPath(task) ? unlink(task.payload_path).catch(() => undefined) : Promise.resolve();
readVideoQueueSettings();
let videoTick: Promise<void> | undefined;
let videoPollingTick: Promise<void> | undefined;

function pollHeldVideoTasks() {
  if (videoPollingTick) return;
  const held = database.prepare("SELECT owner,id FROM canvas_tasks WHERE kind='video' AND provider_hold=1 AND history_id!='' AND credential!=''").all() as Array<{ owner: number; id: string }>;
  let index = 0;
  videoPollingTick = Promise.all(Array.from({ length: Math.min(4, held.length) }, async () => {
    while (index < held.length) {
      const task = held[index++];
      try { await queryTask(task.owner, task.id); } catch { /* Original holds remain until their own confirmed result. */ }
    }
  })).then(() => undefined).finally(() => { videoPollingTick = undefined; });
}

async function persistVideoPayload(file: string, input: unknown) {
  await mkdir(videoQueueRoot, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(encrypt(JSON.stringify(input))); await handle.sync(); } finally { await handle.close(); }
    // Linking a fully synced file publishes it atomically without replacing concurrent input.
    await link(temporary, file).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (process.platform !== "win32") {
      for (const directoryPath of [videoQueueRoot, path.dirname(videoQueueRoot), path.dirname(path.dirname(videoQueueRoot))]) {
        const directory = await open(directoryPath, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    }
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function enqueueVideo(owner: number, authorization: string, input: ReturnType<typeof taskInput>, fingerprint: string, requestedAccountId?: string) {
  const key = validateApiKey(authorization.replace(/^Bearer\s+/i, ""));
  if (!key.valid || key.apiKeyId !== owner) throw Error("API Key 无效");
  const source = "sourceTaskId" in input ? sourceForUpgrade(input.sourceTaskId, owner) : null;
  if (!accountPool.list().some(account => account.enabled && accountSupportsModel(account.name, input.model, true))) throw Error("没有可用于视频生成的 _超级账号；须启用、未冷却且至少 5 积分，未提交生成");
  if (source && requestedAccountId && requestedAccountId !== source.task.account_id) throw Error("原样片账号绑定不匹配，未提交高清生成");
  if (source) requestedAccountId = source.task.account_id;
  if (requestedAccountId) {
    const account = accountPool.get(requestedAccountId);
    if (!isVideoSubmissionAccount(account.name)) throw Error("指定账号已暂停新视频提交，仅可使用超级账号；本次未提交生成");
    if (!source && !accountPool.hasLease(owner, requestedAccountId)) throw Error("该 API Key 没有此视频账号的有效租约绑定");
  }
  const file = payloadPath({ owner, id: input.id, fingerprint });
  const { kind: _kind, ...queuedInput } = input;
  await persistVideoPayload(file, queuedInput);
  try { database.transaction(() => {
    if (source) {
      const current = sourceForUpgrade(source.task.id, owner);
      if (current.task.account_id !== source.task.account_id || current.task.sample_snapshot_json !== source.task.sample_snapshot_json) throw Error("原样片来源已变化，未提交高清生成");
      if (database.prepare("SELECT 1 FROM canvas_tasks WHERE owner=? AND source_task_id=? AND id!=? AND (paid_started_at>0 OR status IN ('queued','preparing','submitting','running','uncertain','succeeded'))").get(owner, source.task.id, input.id)) throw Error("此原样片已有高清任务，请查询原任务，未重复提交");
    }
    database.prepare("INSERT OR IGNORE INTO canvas_tasks(id,owner,kind,model,fingerprint,status,deadline,payload_path,requested_account_id,source_task_id) VALUES(?,?,'video',?,?,'queued',?,?,?,?)").run(input.id, owner, input.model, fingerprint, Date.now() + 30 * 60_000, file, requestedAccountId || "", source?.task.id || "");
  }).immediate(); } catch (error) {
    if (get(input.id)?.payload_path !== file) await unlink(file).catch(() => undefined);
    throw error;
  }
  const task = get(input.id)!;
  if (task.owner !== owner || task.fingerprint !== fingerprint) {
    if (task.payload_path !== file) await unlink(file).catch(() => undefined);
    return { status: 409, body: { error: "任务 ID 已使用，不能替换参数或归属" } };
  }
  if (!["queued", "preparing", "submitting"].includes(task.status)) await clearPayload(task);
  void runVideoQueueTick().catch(() => undefined);
  return { status: 202, body: publicTask(task) };
}

function startVideoDispatch(task: Task, token: string) {
  if (videoDispatches.has(task.id)) return;
  const controller = new AbortController();
  const done = Promise.resolve().then(() => withVideoRequestSignal(controller.signal, () => dispatchVideo(task, token, controller.signal))).catch(() => {
    logger.warn(`视频派发清理未完成，保留原任务 ${task.id}`);
  }).finally(() => {
    videoDispatches.delete(task.id);
    void runVideoQueueTick().catch(() => undefined);
  });
  videoDispatches.set(task.id, { controller, done });
}

async function dispatchVideo(task: Task, token: string, signal: AbortSignal) {
  let paid = false;
  try {
    signal.throwIfAborted();
    if (task.payload_path !== payloadPath(task)) throw Error("视频队列输入不可读取，未提交生成");
    const input = taskInput(JSON.parse(decrypt(await readFile(task.payload_path, "utf8"))));
    if (input.kind !== "video" || crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex") !== task.fingerprint) throw Error("视频队列输入不匹配，未提交生成");
    const beforeSubmit = () => {
      signal.throwIfAborted();
      const current = get(task.id);
      if (!current || !["preparing", "submitting"].includes(current.status) || Date.now() >= current.deadline) throw Error("任务已取消或超时");
      if (!isVideoSubmissionAccount(accountPool.get(task.account_id).name)) throw Error("当前账号已暂停新视频提交，仅可使用超级账号；本次未提交生成");
    };
    const hooks: SeedanceSubmitHooks = { beforeSubmit, onQuoted: async quote => {
      try { await accountPool.refreshStatus(task.account_id); }
      catch { throw Error("当前账号积分余额未确认，未提交生成；请稍后重试"); }
      beforeSubmit();
      database.transaction(() => {
        const account = accountPool.get(task.account_id);
        if (!account.enabled || !accountSupportsModel(account.name, task.model, true) || account.cooldownUntil && Date.parse(account.cooldownUntil) > Date.now() || account.status.error || !Number.isFinite(account.status.totalCredit) || !(Date.now() - Date.parse(account.status.checkedAt || "") < 10_000)) throw Error("当前账号积分余额未确认，未提交生成；请稍后重试");
        const snapshot = JSON.stringify({ ...quote, taskId: task.id, accountId: task.account_id, accountName: account.name, accountTier: accountTier(account.name), ...(task.source_task_id ? { operation: "generate-from-draft", sourceTaskId: task.source_task_id } : {}) });
        // Conservatively retain other frozen reservations until their original tasks finish.
        const held = database.prepare("SELECT id,account_id,quote_json FROM canvas_tasks WHERE kind='video' AND provider_hold=1 AND account_id=? AND id!=?").all(task.account_id, task.id) as Array<Pick<Task, "id" | "account_id" | "quote_json">>;
        const reserved = held.reduce((sum, item) => sum + videoReservedCredits(item), 0);
        const available = Math.max(0, account.status.totalCredit! - reserved);
        if (available < Math.max(5, quote.estimatedCredits)) throw Error(`当前账号可用积分 ${available}，本次视频报价 ${quote.estimatedCredits}，积分不足，未提交生成`);
        if (!database.prepare("UPDATE canvas_tasks SET quote_json=?, credit_before=? WHERE id=? AND status='preparing' AND paid_started_at=0 AND account_id=?").run(snapshot, account.status.totalCredit, task.id, task.account_id).changes) throw Error("原账号报价保存失败，未提交生成");
      }).immediate();
    }, onSubmitting: () => {
      beforeSubmit();
      const quote = JSON.parse(get(task.id)?.quote_json || "null");
      if (!quote || typeof quote.submitId !== "string" || !quote.submitId || typeof quote.draftId !== "string" || !quote.draftId) throw Error("官方报价或原提交身份未保存，未提交生成");
      if (!database.prepare("UPDATE canvas_tasks SET status='submitting', provider_status='submitting', paid_started_at=? WHERE id=? AND status='preparing'").run(Date.now(), task.id).changes) throw Error("任务已取消，未提交生成");
      paid = true;
    }, onSubmitted: historyId => {
      if (!historyId || historyId.length > 160 || /\s/.test(historyId)) throw Error("即梦原任务编号未确认；未自动重提");
      if (!database.prepare("UPDATE canvas_tasks SET history_id=?, provider_status='running', status=CASE WHEN status='canceled' THEN status ELSE 'running' END WHERE id=? AND provider_hold=1 AND account_id=? AND history_id=''").run(historyId, task.id, task.account_id).changes) throw Error("即梦原任务编号保存未确认；未自动重提");
    } };
    if ("sourceTaskId" in input) {
      const source = sourceForUpgrade(input.sourceTaskId, task.owner);
      if (task.account_id !== source.task.account_id || task.source_task_id !== source.task.id) throw Error("原样片账号绑定不匹配，未提交高清生成");
      await submitSeedanceDraftUpgrade(source.snapshot, source.quote, token, hooks);
    } else await submitSeedanceVideo(input, token, hooks);
    await clearPayload(task);
  } catch (error) {
    await drainVideoRequests();
    const message = String(error?.message || ""), code = Number(error?.upstreamCode ?? /\(错误码: (\d+)\)$/.exec(message)?.[1]);
    const current = get(task.id);
    // A late error must never overwrite an accepted identity or an existing result.
    if (!current || current.history_id || current.result || current.status === "succeeded" || current.account_id !== task.account_id || paid && !current.provider_hold) return;
    const receipt = videoSubmissionReceipt(error);
    const rejected = paid && Boolean(receipt && !receipt.acceptanceIdentity && current.paid_started_at > 0 && current.provider_hold);
    const hold = paid && !rejected;
    const diagnostic = String(error?.code || error?.cause?.code || code || "");
    const observation = receipt || { kind: "unconfirmed", code: /^[A-Za-z0-9_.-]{1,60}$/.test(diagnostic) ? diagnostic : "unknown", receivedAt: Date.now() };
    logger.warn(`视频任务失败 ${JSON.stringify({ id: task.id, model: task.model, phase: paid ? "submission" : "preparation", code: Number.isInteger(error?.upstreamCode) ? error.upstreamCode : /^[A-Za-z0-9_.-]{1,60}$/.test(diagnostic) ? diagnostic : "unknown", receipt: observation, ...(/^web_risk_control_[a-z_]{1,100}$/.test(error?.riskReason) ? { riskReason: error.riskReason } : {}), ...(/^[a-fA-F0-9]{16,64}$/.test(error?.upstreamLogId) ? { upstreamLogId: error.upstreamLogId } : {}) })}`);
    const cooldown = accountFailureCooldown(error);
    if (task.account_id && cooldown !== null) markFailure(task.account_id, cooldown);
    const preparation = /^(?:当前账号|原账号).*(?:报价|积分余额|暂停新视频提交|超长视频).*未提交生成/.test(message) || /^原样片[^\r\n]{0,120}(?:未提交高清(?:生成|正片)|未更换账号或提交生成)$/.test(message) ? message : error instanceof UploadError ? error.message : message === "任务已取消或超时" ? "即梦视频准备已取消或超时，尚未提交生成" : "即梦视频素材准备失败，尚未提交生成；请检查参考素材后重试";
    const rejectionLabel = receipt && [1006, 5000].includes(receipt.code) ? "即梦账号积分不足，上游已拒绝本次视频生成" : receipt && [4013, 1015, 1019].includes(receipt.code) ? "即梦安全风控已拒绝本次请求，请检查账号" : "即梦上游已明确拒绝本次视频提交";
    const reason = hold ? "即梦提交结果未确认；账号保持占用，未自动重提，请检查即梦生成记录" : rejected ? `${rejectionLabel}（${receipt!.code}）；未自动重提` : preparation;
    const saved = database.prepare("UPDATE canvas_tasks SET status=CASE WHEN status='canceled' THEN status ELSE ? END, provider_status=?, provider_hold=?, credential=CASE WHEN ?=1 THEN credential ELSE '' END, error=CASE WHEN status='canceled' THEN error ELSE ? END, quote_json=CASE WHEN json_valid(quote_json) THEN json_set(quote_json,'$.submissionReceipt',json(?)) ELSE quote_json END WHERE id=? AND account_id=? AND history_id='' AND result='' AND status!='succeeded' AND paid_started_at=? AND provider_hold=? AND quote_json IS ?").run(hold ? "uncertain" : "failed", hold ? "uncertain" : "failed", Number(hold), Number(hold), reason, JSON.stringify(observation), task.id, task.account_id, current.paid_started_at, current.provider_hold, current.quote_json);
    if (!saved.changes) { logger.warn(`视频原任务状态已变化，保留提交输入 ${task.id}`); return; }
    await clearPayload(task);
  }
}

/** One durable queue shared by all managed keys; only original history IDs are polled. */
export function runVideoQueueTick(): Promise<void> {
  if (videoTick) return videoTick;
  videoTick = (async () => {
    pollHeldVideoTasks();
    const queued = database.prepare("SELECT * FROM canvas_tasks WHERE kind='video' AND status='queued' ORDER BY rowid").all() as Task[];
    if (queued.length) await refreshVideoAccountBalances(queued[0].model);
    for (const task of queued) {
      if (Date.now() >= task.deadline || !database.prepare("SELECT 1 FROM api_keys WHERE id=? AND enabled=1").get(task.owner)) {
        const error = Date.now() >= task.deadline ? "视频排队超过 30 分钟，未提交生成" : "调用 Key 已停用，未提交生成";
        if (database.prepare("UPDATE canvas_tasks SET status='failed', provider_status='failed', error=? WHERE id=? AND status='queued'").run(error, task.id).changes) await clearPayload(task);
        continue;
      }
      let input: ReturnType<typeof taskInput>;
      try {
        if (task.payload_path !== payloadPath(task)) throw Error("队列输入不可读取");
        input = taskInput(JSON.parse(decrypt(await readFile(task.payload_path, "utf8"))));
        if (input.kind !== "video" || crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex") !== task.fingerprint) throw Error("队列输入不匹配");
      } catch {
        if (database.prepare("UPDATE canvas_tasks SET status='failed', provider_status='failed', error='视频队列输入损坏或不匹配，未提交生成' WHERE id=? AND status='queued'").run(task.id).changes) await clearPayload(task);
        continue;
      }
      if (input.kind !== "video") continue;
      let minimumCredits: Map<string, number>;
      try {
        if ("sourceTaskId" in input) {
          const source = sourceForUpgrade(input.sourceTaskId, task.owner);
          if (task.requested_account_id !== source.task.account_id || task.source_task_id !== source.task.id) throw Error("原样片账号绑定不匹配，未提交高清生成");
          const quote = await quoteSeedanceDraftUpgrade(source.quote, readAccountSessionById(source.task.account_id));
          minimumCredits = new Map([[source.task.account_id, quote.estimatedCredits]]);
        } else minimumCredits = await videoAccountMinimumCredits(input);
      }
      catch (error) {
        if ("sourceTaskId" in input && /^原样片/.test(String(error?.message || ""))) {
          if (database.prepare("UPDATE canvas_tasks SET status='failed', provider_status='failed', error=? WHERE id=? AND status='queued'").run(String(error.message), task.id).changes) await clearPayload(task);
        }
        continue;
      } // An unavailable quote cannot admit a paid request.
      const accounts = accountPool.list().filter(account => account.enabled && accountSupportsModel(account.name, task.model, true) && (!account.cooldownUntil || Date.parse(account.cooldownUntil) <= Date.now()) && (!task.requested_account_id || account.id === task.requested_account_id));
      // Busy but sufficiently funded accounts stay in the queue; only confirmed shortages fail.
      if (accounts.length && accounts.every(account => !account.status.error && Date.now() - Date.parse(account.status.checkedAt || "") < 10_000 && Number.isFinite(account.status.totalCredit) && minimumCredits.has(account.id) && account.status.totalCredit! < Math.max(5, minimumCredits.get(account.id)!))) {
        const available = Math.max(...accounts.map(account => account.status.totalCredit!)), required = Math.min(...accounts.map(account => minimumCredits.get(account.id)!));
        const reason = `即梦账号积分不足：最高余额 ${available}，本次视频报价至少 ${required}；未提交生成，请补充积分后重试`;
        if (database.prepare("UPDATE canvas_tasks SET status='failed', provider_status='failed', error=? WHERE id=? AND status='queued'").run(reason, task.id).changes) await clearPayload(task);
        continue;
      }
      const settings = readVideoQueueSettings();
      const selected = reserveVideoAccount(task.id, settings.perAccountConcurrency, settings.totalConcurrency ?? Infinity, minimumCredits);
      if (selected) startVideoDispatch(get(task.id)!, selected.sessionId);
    }
  })().finally(() => { videoTick = undefined; });
  return videoTick;
}
const videoQueueTimer = setInterval(() => { void runVideoQueueTick().catch(() => undefined); }, 2000);
videoQueueTimer.unref();

export async function createTask(owner: number, authorization: string, body: unknown, requestedAccountId?: string) {
  const input = taskInput(body);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const previous = get(input.id);
  if (previous) {
    if (previous.owner !== owner || previous.fingerprint !== fingerprint) return { status: 409, body: { error: "任务 ID 已使用，不能替换参数或归属" } };
    return { status: 200, body: publicTask(previous) };
  }
  if (input.kind === "video") return enqueueVideo(owner, authorization, input, fingerprint, requestedAccountId);
  const credential = await resolveAuthorization(authorization, requestedAccountId, input.model, true);
  // resolveAuthorization yields: recheck for concurrent requests before inserting.
  const reserved = database.prepare("INSERT OR IGNORE INTO canvas_tasks (id, owner, kind, model, fingerprint, status, credential, account_id, deadline) VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?, ?)").run(input.id, owner, input.kind, input.model, fingerprint, encrypt(credential.token), credential.accountId || "", Date.now() + 60 * 60_000);
  if (!reserved.changes) return createTask(owner, authorization, body, requestedAccountId);
  const onSubmitted = (historyId: string) => {
    database.prepare("UPDATE canvas_tasks SET history_id = ?, status = 'running', error = '' WHERE id = ? AND status IN ('submitting', 'uncertain') AND history_id=''").run(historyId, input.id);
  };
  const beforeSubmit = () => { const current = get(input.id); if (current?.status !== "submitting" || Date.now() >= current.deadline) throw Error("任务已取消或超时"); };
  const work = generateImages(input.model, input.prompt, { ratio: input.ratio, resolution: input.resolution, filePaths: input.images, n: 1, onSubmitted, beforeSubmit }, credential.token);
  void work.catch((error) => {
    // Never return raw upstream errors, request configs, cookies or asset URLs.
    const message = String(error?.message || "");
    const cooldownMs = accountFailureCooldown(error);
    if (credential.accountId && cooldownMs !== null) markFailure(credential.accountId, cooldownMs);
    const known = /\(错误码: 4013\)$/.test(message)
      ? "即梦安全风控拒绝了本次请求（4013：疑似存在异常行为）；未自动重提，请前往即梦网页检查账号安全验证或联系即梦支持"
      : message.match(/当前即梦模型不支持所选(?:清晰度|时长)，未自动(?:降级|缩短)|^首帧上传失败$|^尾帧上传失败，未提交生成$|^第 \d+ 张参考图上传失败，未提交生成$|^(?:当前账号|当前视频|参考(?:图|视频|音频|音视频))[^\r\n]{0,100}，未提交生成$/)?.[0];
    const rejected = Boolean(known) || /^HTTP (?:400|401|402|403|404|405|413|415|422|429)\b/.test(message) || Number.isInteger(error?.upstreamCode) && error.upstreamCode > 0;
    database.prepare("UPDATE canvas_tasks SET status = ?, credential = CASE WHEN ?=1 THEN '' ELSE credential END, error = ? WHERE id = ? AND status IN ('submitting', 'uncertain') AND history_id=''").run(rejected ? "failed" : "uncertain", Number(rejected), known || (rejected ? "即梦已拒绝本次提交；未自动重提，请检查账号积分、权限和即梦生成记录" : "即梦提交回执未确认；保留原账号与凭据，未自动重提，请检查即梦生成记录"), input.id);
  });
  return { status: 202, body: publicTask(get(input.id)!) };
}

export async function queryTask(owner: number, id: string, refreshResult = false) {
  let task = get(id);
  if (!task || task.owner !== owner) return { status: 404, body: { error: "任务不存在" } };
  if (refreshResult && task.kind === "video" && task.status === "succeeded" && task.history_id && task.account_id) {
    if (!await refreshSucceededVideoResult(task)) return { status: 503, body: { id: task.id, status: task.status, providerStatus: task.provider_status, error: "原视频结果地址暂时无法刷新，请稍后重试" } };
    task = get(id)!;
  }
  if ((task.kind === "video" ? task.provider_hold && task.history_id && task.credential : task.status === "running" && task.history_id && task.credential) && Date.now() - task.checked_at >= 5000) {
    if (!polling.has(id)) {
      const current = task;
      database.prepare("UPDATE canvas_tasks SET checked_at = ? WHERE id = ?").run(Date.now(), id);
      const work = (async () => {
        const response = await request("post", "/mweb/v1/get_history_by_ids", decrypt(current.credential), { timeout: 15_000, data: { history_ids: [current.history_id], ...(current.kind === "image" ? { image_info: { width: 4096, height: 4096, format: "webp" } } : {}) } });
        const sample = current.model === "jimeng-video-seedance-2.5-draft" && !current.source_task_id;
        if (sample && Number(taskHistory(response, current.history_id)?.status) === 21) return;
        const result = readTaskResult(response, current);
        if (result.status === "running") return;
        if (result.status === "failed" && current.account_id) {
          const cooldownMs = accountFailureCooldown(result.error);
          if (cooldownMs !== null) markFailure(current.account_id, cooldownMs);
        }
        let billing;
        if (current.kind === "video" && result.status === "succeeded") try { billing = await readVideoBilling(decrypt(current.credential), current, taskHistory(response, current.history_id)); } catch { /* Keep the successful MP4 and original credential until its exact bill is confirmed. */ }
        const hold = current.kind === "video" && result.status === "succeeded" && !billing;
        let sampleSnapshot: string | null = null;
        if (sample && result.status === "succeeded") try { sampleSnapshot = encrypt(JSON.stringify(readDraftSource(response, current.history_id))); } catch { /* Keep a successful video without granting an unverified finalization. */ }
        const updated = current.kind === "video"
          ? database.prepare("UPDATE canvas_tasks SET status=CASE WHEN status='canceled' THEN status ELSE ? END, provider_status=?, result=?, error=CASE WHEN status='canceled' THEN error ELSE ? END, sample_snapshot_json=COALESCE(sample_snapshot_json,?), billing_json=COALESCE(billing_json,?), credential=CASE WHEN ?=1 THEN credential ELSE '' END, provider_hold=? WHERE id=? AND provider_hold=1 AND history_id=? AND account_id=?").run(result.status, result.status, result.status === "succeeded" ? JSON.stringify(result.urls.map((url) => ({ url }))) : "", result.status === "failed" ? result.error : "", sampleSnapshot, billing ? JSON.stringify(billing) : null, Number(hold), Number(hold), id, current.history_id, current.account_id)
          : database.prepare("UPDATE canvas_tasks SET status = ?, result = ?, error = ?, credential = '' WHERE id = ? AND status = 'running'").run(result.status, result.status === "succeeded" ? JSON.stringify(result.urls.map((url) => ({ url }))) : "", result.status === "failed" ? result.error : "", id);
        if (updated.changes && result.status === "succeeded" && current.status !== "succeeded" && current.account_id) markSuccess(current.account_id);
      })().catch((error) => {
        const cooldownMs = accountFailureCooldown(error);
        if (current.account_id && cooldownMs !== null) markFailure(current.account_id, cooldownMs);
        // Transient query failures retain the same upstream history and credential.
      }).finally(() => polling.delete(id));
      polling.set(id, work);
    }
    await polling.get(id);
  }
  // Query once before expiring: the result may have completed while the browser was closed.
  task = get(id)!;
  if (task.kind === "video" && task.provider_hold && !task.history_id && Date.now() >= task.deadline && task.paid_started_at) {
    database.prepare("UPDATE canvas_tasks SET status=CASE WHEN status='canceled' THEN status ELSE 'uncertain' END, error=CASE WHEN status='canceled' THEN error ELSE '即梦提交回执仍未确认；账号保持占用，未自动重提' END WHERE id=? AND provider_hold=1").run(id);
  }
  if (task.kind === "image" && ["running", "submitting"].includes(task.status) && !task.history_id && Date.now() >= task.deadline) {
    database.prepare("UPDATE canvas_tasks SET status = 'uncertain', error = '即梦提交回执未确认；保留原账号与凭据，未重新生成，请检查即梦记录' WHERE id = ? AND status IN ('running', 'submitting') AND history_id=''").run(id);
  }
  return { status: 200, body: publicTask(get(id)!) };
}

function interruptionReview(task: Task) {
  return crypto.createHash("sha256").update(JSON.stringify([task.id, task.owner, task.kind, task.fingerprint, task.status, task.provider_status, task.provider_hold, task.paid_started_at, task.account_id, task.history_id, task.result, task.credential, task.quote_json])).digest("hex");
}

function canReleaseVideoSubmission(task: Task) {
  if (videoDispatches.has(task.id) || task.kind !== "video" || !["uncertain", "canceled"].includes(task.status) || task.provider_status !== "uncertain" || task.provider_hold !== 1 || task.history_id || task.result || !task.account_id || !Number.isSafeInteger(task.paid_started_at) || task.paid_started_at <= 0 || videoSubmissionReconciled(task)) return false;
  try {
    const quote = JSON.parse(task.quote_json || "null");
    return quote?.taskId === task.id && quote.accountId === task.account_id && quote.submissionReceipt?.acceptanceIdentity !== true;
  } catch { return false; }
}

function interruptionSnapshot(task: Task) {
  const active = videoDispatches.has(task.id);
  const phase = task.result ? "completed" : task.history_id ? "accepted" : task.paid_started_at > 0 ? active ? "submitting" : "unconfirmed" : task.status === "queued" ? "queued" : active ? "preparing" : "unsubmitted";
  return { task: publicTask(task), interruption: { active, phase, canRelease: canReleaseVideoSubmission(task), submissionReleased: videoSubmissionReconciled(task), review: interruptionReview(task), ...(task.paid_started_at > 0 ? { paidStartedAt: task.paid_started_at } : {}) } };
}

/** Read only local durable state; inspecting an interruption never polls or dispatches. */
export function readTaskInterruption(owner: number, id: string) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return { status: 400, body: { error: "任务 ID 无效" } };
  const task = get(id);
  if (!task || task.owner !== owner) return { status: 404, body: { error: "任务不存在" } };
  if (task.kind !== "video") return { status: 400, body: { error: "仅视频任务支持强制中断请求" } };
  return { status: 200, body: interruptionSnapshot(task) };
}

export async function interruptTask(owner: number, id: string, body: unknown = {}) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return { status: 400, body: { error: "任务 ID 无效" } };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "中断参数无效" } };
  const input = body as { confirmNoRecord?: unknown; review?: unknown };
  if (input.confirmNoRecord !== undefined && typeof input.confirmNoRecord !== "boolean" || input.confirmNoRecord === true && (typeof input.review !== "string" || !/^[a-f0-9]{64}$/.test(input.review))) return { status: 400, body: { error: "须明确确认官网无对应记录，并提供原任务核对快照" } };
  let task = get(id);
  if (!task || task.owner !== owner) return { status: 404, body: { error: "任务不存在" } };
  if (task.kind !== "video") return { status: 400, body: { error: "仅视频任务支持强制中断请求" } };
  if (input.confirmNoRecord === true) {
    if (videoSubmissionReconciled(task)) return JSON.parse(task.quote_json!).submissionReconciliation.review === input.review
      ? { status: 200, body: interruptionSnapshot(task) }
      : { status: 409, body: { error: "此任务已按另一核对快照解除提交占槽，请读取最新状态" } };
    const released = database.transaction(() => {
      const current = get(id);
      if (!current || current.owner !== owner || interruptionReview(current) !== input.review || !canReleaseVideoSubmission(current)) return false;
      const quote = JSON.parse(current.quote_json!);
      const submissionReconciliation = { kind: "operator_confirmed_no_record", taskId: current.id, accountId: current.account_id, paidStartedAt: current.paid_started_at, confirmedAt: Date.now(), evidenceId: `interrupt-${crypto.randomUUID()}`, review: input.review };
      return database.prepare("UPDATE canvas_tasks SET quote_json=? WHERE id=? AND owner=? AND kind='video' AND status=? AND provider_status='uncertain' AND provider_hold=1 AND paid_started_at=? AND account_id=? AND history_id='' AND result='' AND credential=? AND fingerprint=? AND quote_json IS ?").run(JSON.stringify({ ...quote, submissionReconciliation }), id, owner, current.status, current.paid_started_at, current.account_id, current.credential, current.fingerprint, current.quote_json).changes === 1;
    }).immediate();
    if (!released) return { status: 409, body: { error: "原请求仍在执行、任务已受理或核对快照已变化；请读取最新状态，未解除占槽" } };
    void runVideoQueueTick().catch(() => undefined);
    return { status: 200, body: interruptionSnapshot(get(id)!) };
  }
  if (task.status === "queued") cancelTask(owner, id);
  const active = videoDispatches.get(id);
  if (active) {
    // Persist pre-paid cancellation before aborting, so restart cannot resume this upload.
    database.prepare("UPDATE canvas_tasks SET status='canceled', error='已强制中断素材准备，等待原请求退出；尚未提交生成' WHERE id=? AND owner=? AND status='preparing' AND paid_started_at=0 AND history_id='' AND result=''").run(id, owner);
    active.controller.abort(Error("视频请求已强制中断"));
    const drained = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 25_000);
      active.done.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
    });
    if (!drained) return { status: 503, body: { error: "当前请求清理尚未完成；原任务与积分预留保留，请读取最新状态后重试", ...interruptionSnapshot(get(id)!) } };
    database.prepare("UPDATE canvas_tasks SET error='已强制中断素材准备，尚未提交生成' WHERE id=? AND owner=? AND status='canceled' AND provider_hold=0 AND paid_started_at=0 AND history_id='' AND result='' AND error='已强制中断素材准备，等待原请求退出；尚未提交生成'").run(id, owner);
  }
  task = get(id)!;
  return { status: 200, body: interruptionSnapshot(task) };
}

export function cancelTask(owner: number, id: string) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return { status: 400, body: { error: "任务 ID 无效" } };
  const previous = get(id);
  if (previous && previous.owner !== owner) return { status: 404, body: { error: "任务不存在" } };
  if (previous?.kind === "video") {
    // An in-flight upload must drain before the next task can upload on this account.
    const preparing = (previous.status === "preparing" || previous.status === "canceled" && previous.provider_status === "preparing") && !previous.paid_started_at && !previous.history_id;
    const hold = Boolean(previous.provider_hold && (preparing || previous.paid_started_at || previous.history_id || ["uncertain", "running", "failed"].includes(previous.status)));
    if (["queued", "preparing", "submitting", "running", "uncertain", "canceled"].includes(previous.status) || previous.provider_hold) {
      database.prepare("UPDATE canvas_tasks SET status='canceled', provider_status=CASE WHEN ?=1 THEN provider_status ELSE 'canceled' END, provider_hold=?, credential=CASE WHEN ?=1 THEN credential ELSE '' END, error=? WHERE id=?").run(Number(hold), Number(hold), Number(hold), preparing && hold ? "已停止准备；等待当前上传结束后释放账号，尚未提交生成" : hold ? "已停止等待；原任务仍按原编号查询，未重新提交" : "已取消未提交的视频任务", id);
      if (!hold) void clearPayload(previous);
    }
    void runVideoQueueTick().catch(() => undefined);
    return { status: 200, body: publicTask(get(id)!) };
  }
  // Tombstone a DELETE that races ahead of POST; that POST must never spend points.
  database.prepare("INSERT OR IGNORE INTO canvas_tasks (id, owner, kind, model, fingerprint, status, deadline) VALUES (?, ?, 'image', '', '', 'canceled', ?)").run(id, owner, Date.now());
  database.prepare("UPDATE canvas_tasks SET status = 'canceled', credential = '', error = '已停止等待；即梦已接收的任务可能继续运行，积分以即梦结算为准' WHERE id = ? AND status IN ('submitting', 'running', 'canceled')").run(id);
  return { status: 200, body: publicTask(get(id)!) };
}
