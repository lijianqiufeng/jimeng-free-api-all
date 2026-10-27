import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, link, unlink } from "node:fs/promises";
import path from "node:path";
import { database } from "@/lib/database.ts";
import { encrypt, decrypt, getAccount } from "@/lib/account-pool.ts";
import { resolveAuthorization, markCredentialFailure } from "./auth.ts";
import { request, uploadFile, withVideoRequestSignal, videoSubmissionReceipt } from "./core.ts";
import { buildOutpaintRequest, outpaintHistoryResult, outpaintRequestParams, outpaintTaskInput, readOutpaintWorkspace, refreshOutpaintResults, type OutpaintInput } from "./outpaint-protocol.ts";

const UNCONFIRMED = "即梦原生扩图提交回执未确认，保留原编号和账号，未自动重新提交";
const NOT_FOUND = "扩图任务不存在";
const DEADLINE_MS = 60 * 60_000;
type OutpaintTask = { id: string; owner: number; fingerprint: string; status: string; account_id: string; requested_account_id: string; credential: string; submit_id: string; history_id: string; image_uri: string; workspace_id: string; parameters: string; payload_path: string; result: string; error: string; error_code: string; deadline: number; checked_at: number; paid_started_at: number; created_at: number };

database.pragma("synchronous = FULL");
database.exec(`CREATE TABLE IF NOT EXISTS native_outpaint_tasks (
  id TEXT PRIMARY KEY, owner INTEGER NOT NULL, fingerprint TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '', requested_account_id TEXT NOT NULL DEFAULT '', credential TEXT NOT NULL DEFAULT '',
  submit_id TEXT NOT NULL DEFAULT '', history_id TEXT NOT NULL DEFAULT '', image_uri TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL DEFAULT '',
  parameters TEXT NOT NULL DEFAULT '{}', payload_path TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '',
  deadline INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0, paid_started_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
); CREATE TABLE IF NOT EXISTS native_outpaint_workspaces (account_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);`);
export function recoverOutpaintTasksAfterRestart() {
  database.prepare("UPDATE native_outpaint_tasks SET status=CASE WHEN paid_started_at>0 THEN 'uncertain' ELSE 'failed' END,error=CASE WHEN paid_started_at>0 THEN ? ELSE '服务重启中断原图准备，未提交扩图' END,error_code=CASE WHEN paid_started_at>0 THEN 'submission_unconfirmed' ELSE 'preparation_failed' END,credential=CASE WHEN paid_started_at>0 THEN credential ELSE '' END WHERE status IN ('preparing','submitting','running') AND history_id=''").run(UNCONFIRMED);
  database.prepare("UPDATE native_outpaint_tasks SET status='running' WHERE status IN ('preparing','submitting','uncertain') AND history_id!='' AND credential!=''").run();
}
const get = (id: string) => database.prepare("SELECT * FROM native_outpaint_tasks WHERE id=?").get(id) as OutpaintTask | undefined;
const dispatches = new Map<string, AbortController>(), polls = new Map<string, Promise<void>>(), workspaces = new Map<string, Promise<string>>();
const accounts = new Set<string>(), queueRoot = path.join(path.dirname(process.env.DB_PATH || "./data/jimeng.db"), "private", "native-outpaint");
const fingerprintOf = (input: OutpaintInput, accountId: string) => createHash("sha256").update(JSON.stringify([input, accountId])).digest("hex");
const payloadPath = (task: Pick<OutpaintTask, "owner" | "id" | "fingerprint">) => path.join(queueRoot, `${createHash("sha256").update(`${task.owner}:${task.id}:${task.fingerprint}`).digest("hex")}.json.enc`);
const clearPayload = (task: OutpaintTask) => task.payload_path && task.payload_path === payloadPath(task) ? unlink(task.payload_path).catch(() => undefined) : Promise.resolve();
let queueTick: Promise<void> | undefined, registrations = 0;

// Follow the existing video queue's private encrypted, atomically published input format.
async function persistPayload(file: string, input: OutpaintInput) {
  await mkdir(queueRoot, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
  const { width, height, ...payload } = input;
  try {
    try { await handle.writeFile(encrypt(JSON.stringify(payload))); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, file).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (process.platform !== "win32") { const directory = await open(queueRoot, "r"); try { await directory.sync(); } finally { await directory.close(); } }
  } finally { await unlink(temporary).catch(() => undefined); }
}

function runQueue() {
  if (queueTick) return;
  queueTick = Promise.resolve().then(() => {
    const queued = database.prepare("SELECT * FROM native_outpaint_tasks WHERE status='preparing' AND paid_started_at=0 ORDER BY rowid").all() as OutpaintTask[];
    for (const task of queued) {
      if (dispatches.size >= 2) break;
      if (accounts.has(task.account_id) || dispatches.has(task.id)) continue;
      const controller = new AbortController(); dispatches.set(task.id, controller); accounts.add(task.account_id);
      const timer = setTimeout(() => controller.abort(), Math.max(1, task.deadline - Date.now()));
      void dispatch(task, controller).finally(() => {
        clearTimeout(timer); dispatches.delete(task.id); accounts.delete(task.account_id);
        void clearPayload(task); runQueue();
      }).catch(() => undefined);
    }
  }).finally(() => { queueTick = undefined; });
}
recoverOutpaintTasksAfterRestart();
for (const task of database.prepare("SELECT * FROM native_outpaint_tasks WHERE payload_path!='' AND status!='preparing'").all() as OutpaintTask[]) void clearPayload(task);

function publicTask(task: OutpaintTask) {
  const parameters = JSON.parse(task.parameters);
  return { id: task.id, operation: "outpaint", status: task.status, ...(task.account_id ? { accountId: task.account_id } : {}), ...parameters,
    submission: { state: task.history_id ? "accepted" : task.paid_started_at ? task.error_code === "provider_rejected" ? "rejected" : "unconfirmed" : task.status === "preparing" ? "preparing" : "unsubmitted", ...(task.submit_id ? { submitId: task.submit_id } : {}), ...(task.history_id ? { historyId: task.history_id } : {}) },
    ...(task.result ? { data: JSON.parse(task.result) } : {}), ...(task.error ? { error: task.error, errorCode: task.error_code } : {}) };
}

async function ensureWorkspace(accountId: string, token: string) {
  const stored = database.prepare("SELECT workspace_id FROM native_outpaint_workspaces WHERE account_id=?").get(accountId) as { workspace_id: string } | undefined;
  if (stored) {
    const id = readOutpaintWorkspace(stored);
    if (!id) throw Error("扩图原工作区身份无效，尚未提交生成");
    return id;
  }
  const pending = workspaces.get(accountId);
  if (pending) return pending;
  const work = (async () => {
    const listed = await request("post", "/mweb/v1/workspace/list", token, { data: { offset: 0, limit: 20 }, timeout: 20_000 });
    const workspaceId = readOutpaintWorkspace(listed) || readOutpaintWorkspace(await request("post", "/mweb/v1/workspace/create", token, { data: { name: "原生图片扩图" }, timeout: 20_000 }));
    if (!workspaceId) throw Error("扩图工作区回执无效");
    database.prepare("INSERT OR IGNORE INTO native_outpaint_workspaces(account_id,workspace_id) VALUES (?,?)").run(accountId, workspaceId);
    return workspaceId;
  })().finally(() => workspaces.delete(accountId));
  workspaces.set(accountId, work);
  return work;
}

async function dispatch(original: OutpaintTask, controller: AbortController) {
  await withVideoRequestSignal(controller.signal, async () => {
    const active = () => { const task = get(original.id); if (!task || !["preparing", "submitting"].includes(task.status) || Date.now() >= task.deadline || controller.signal.aborted || !database.prepare("SELECT 1 FROM api_keys WHERE id=? AND enabled=1").get(task.owner) || !getAccount(task.account_id).enabled) throw Error("扩图任务或原账号已停止"); return task; };
    let token = "";
    try {
      const task = active();
      if (task.payload_path !== payloadPath(task)) throw Error("扩图排队输入不可读取");
      const input = outpaintTaskInput(JSON.parse(decrypt(await readFile(task.payload_path, { encoding: "utf8", signal: controller.signal }))));
      if (fingerprintOf(input, task.requested_account_id) !== task.fingerprint) throw Error("扩图排队输入不匹配");
      active(); token = decrypt(task.credential);
      const uploaded = await uploadFile(token, input.image);
      active();
      if (typeof uploaded.uri !== "string" || !uploaded.uri || /\s/.test(uploaded.uri)) throw Error("扩图原图上传回执无效");
      const dimensions = uploaded as { width?: number; height?: number };
      if (dimensions.width !== undefined && dimensions.width !== input.width || dimensions.height !== undefined && dimensions.height !== input.height) throw Error("扩图上传回执尺寸与原图不一致，未提交生成");
      const workspaceId = await ensureWorkspace(task.account_id, token);
      active();
      database.prepare("UPDATE native_outpaint_tasks SET image_uri=?,workspace_id=? WHERE id=? AND status='preparing'").run(uploaded.uri, workspaceId, task.id);
      const payload = buildOutpaintRequest(input, uploaded.uri, workspaceId, task.submit_id, task.created_at);
      const response = await request("post", "/mweb/v1/aigc_draft/generate", token, { timeout: 120_000, signal: controller.signal, params: outpaintRequestParams(task.submit_id), data: payload,
        beforeSubmit: () => { active(); }, onSubmitting: () => { if (!database.prepare("UPDATE native_outpaint_tasks SET status='submitting',paid_started_at=? WHERE id=? AND status='preparing' AND paid_started_at=0").run(Date.now(), task.id).changes) throw Error("扩图提交身份已变化，未重复提交"); } });
      const historyId = response?.aigc_data?.history_record_id;
      if (historyId && historyId !== "0" && /^[A-Za-z0-9:_-]{1,160}$/.test(String(historyId))) {
        database.prepare("UPDATE native_outpaint_tasks SET history_id=?,status=CASE WHEN status='canceled' THEN status ELSE 'running' END,error='',error_code='' WHERE id=? AND history_id='' AND paid_started_at>0").run(String(historyId), task.id);
      } else if (response?.fail_code && Number(response.fail_code) !== 0) {
        database.prepare("UPDATE native_outpaint_tasks SET status='failed',credential='',error='即梦已拒绝原生扩图请求，未自动重提',error_code='provider_rejected' WHERE id=? AND status='submitting' AND history_id=''").run(task.id);
      } else throw Error(UNCONFIRMED);
    } catch (error) {
      const task = get(original.id);
      if (!task || task.status === "canceled" || task.history_id) return;
      const receipt = videoSubmissionReceipt(error), rejected = receipt && !receipt.acceptanceIdentity;
      const uncertain = task.paid_started_at > 0 && !rejected;
      database.prepare("UPDATE native_outpaint_tasks SET status=?,credential=CASE WHEN ? THEN credential ELSE '' END,error=?,error_code=? WHERE id=? AND status IN ('preparing','submitting') AND history_id=''").run(uncertain ? "uncertain" : "failed", Number(uncertain), uncertain ? UNCONFIRMED : task.paid_started_at ? "即梦已拒绝原生扩图请求，未自动重提" : "扩图原图准备失败，尚未提交生成", uncertain ? "submission_unconfirmed" : task.paid_started_at ? "provider_rejected" : "preparation_failed", task.id);
      try { markCredentialFailure({ token, accountId: task.account_id }, error); } catch { /* An account edit cannot erase the durable submission outcome. */ }
    }
  });
}

export async function createOutpaintTask(owner: number, authorization: string, body: unknown, requestedAccountId?: string) {
  if (registrations >= 2) return { status: 429, body: { error: "扩图输入准备繁忙，尚未登记或提交生成", errorCode: "input_busy" } };
  registrations++;
  try {
  const input = outpaintTaskInput(body), fingerprint = fingerprintOf(input, requestedAccountId || ""), previous = get(input.id);
  if (previous) return previous.owner !== owner || previous.fingerprint !== fingerprint ? { status: 409, body: { error: "扩图任务 ID 已绑定其他输入或归属", errorCode: "task_conflict" } } : { status: 200, body: publicTask(previous) };
  if (process.env.JIMENG_NATIVE_OUTPAINT_CREATE_ENABLED === "false") return { status: 503, body: { error: "即梦原生扩图已暂停新提交，原任务仍可查询或取消", errorCode: "create_disabled" } };
  const credential = await resolveAuthorization(authorization, requestedAccountId, "jimeng-outpaint", true, false);
  if (!credential.accountId) throw Error("原生扩图必须使用托管账号");
  const now = Date.now(), { image, id, prompt, width, height, ...geometry } = input;
  const file = payloadPath({ owner, id, fingerprint });
  await persistPayload(file, input);
  let inserted;
  try { inserted = database.prepare("INSERT OR IGNORE INTO native_outpaint_tasks(id,owner,fingerprint,status,account_id,requested_account_id,credential,submit_id,parameters,payload_path,deadline,created_at) VALUES (?,?,?,'preparing',?,?,?,?,?,?,?,?)").run(id, owner, fingerprint, credential.accountId, requestedAccountId || "", encrypt(credential.token), randomUUID(), JSON.stringify({ ...geometry, sourceWidth: width, sourceHeight: height }), file, now + DEADLINE_MS, now); }
  catch (error) { if (get(id)?.payload_path !== file) await unlink(file).catch(() => undefined); throw error; }
  if (!inserted.changes) {
    const existing = get(id)!; if (existing.payload_path !== file || !["preparing", "submitting"].includes(existing.status)) await unlink(file).catch(() => undefined);
    return existing.owner !== owner || existing.fingerprint !== fingerprint ? { status: 409, body: { error: "扩图任务 ID 已绑定其他输入或归属", errorCode: "task_conflict" } } : { status: 200, body: publicTask(existing) };
  }
  runQueue();
  return { status: 202, body: publicTask(get(id)!) };
  } finally { registrations--; }
}

export async function queryOutpaintTask(owner: number, id: string, requestedAccountId?: string) {
  let task = get(id);
  if (!task || task.owner !== owner || requestedAccountId && requestedAccountId !== task.account_id) return { status: 404, body: { error: NOT_FOUND, errorCode: "not_found" } };
  if (task.history_id && task.credential && ["running", "canceled", "uncertain", "succeeded"].includes(task.status) && Date.now() - task.checked_at >= 5000) {
    if (!polls.has(id)) {
      const snapshot = task;
      const work = (async () => {
        database.prepare("UPDATE native_outpaint_tasks SET checked_at=? WHERE id=?").run(Date.now(), id);
        try {
          const response = await request("post", "/mweb/v1/get_history_by_ids", decrypt(snapshot.credential), { timeout: 15_000, data: { history_ids: [snapshot.history_id] } });
          const result = outpaintHistoryResult(response, snapshot.history_id, snapshot.submit_id);
          if (snapshot.result && result.status === "uncertain") throw Error(result.error);
          const data = result.status === "succeeded" ? snapshot.result ? refreshOutpaintResults(JSON.parse(snapshot.result), result.data) : result.data : undefined;
          if (result.status !== "running" && !(snapshot.status === "succeeded" && result.status !== "succeeded")) database.prepare("UPDATE native_outpaint_tasks SET status=?,result=?,credential=CASE WHEN ?='failed' THEN '' ELSE credential END,error=?,error_code=? WHERE id=? AND account_id=? AND history_id=? AND submit_id=? AND status IN ('running','canceled','uncertain','succeeded')").run(result.status, data ? JSON.stringify(data) : "", result.status, result.status === "failed" || result.status === "uncertain" ? result.error : "", result.status === "failed" ? "provider_rejected" : result.status === "uncertain" ? result.errorCode : "", id, snapshot.account_id, snapshot.history_id, snapshot.submit_id);
        } catch (error) {
          if (snapshot.result && error instanceof Error && /^原扩图成果|^原扩图返回/.test(error.message)) database.prepare("UPDATE native_outpaint_tasks SET error=?,error_code='result_refresh_unconfirmed' WHERE id=? AND history_id=? AND submit_id=? AND result=?").run(error.message, id, snapshot.history_id, snapshot.submit_id, snapshot.result);
          // Query failures keep the original history/account and every previous result; never repeat generation.
        }
      })().finally(() => polls.delete(id));
      polls.set(id, work);
    }
    await polls.get(id);
  }
  task = get(id)!;
  return { status: 200, body: publicTask(task) };
}

export function cancelOutpaintTask(owner: number, id: string, requestedAccountId?: string) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return { status: 400, body: { error: "扩图任务 ID 无效", errorCode: "invalid_request" } };
  const previous = get(id);
  if (previous && (previous.owner !== owner || requestedAccountId && requestedAccountId !== previous.account_id)) return { status: 404, body: { error: NOT_FOUND, errorCode: "not_found" } };
  dispatches.get(id)?.abort();
  const now = Date.now();
  database.prepare("INSERT OR IGNORE INTO native_outpaint_tasks(id,owner,status,deadline,created_at) VALUES (?,?,'canceled',?,?)").run(id, owner, now, now);
  database.prepare("UPDATE native_outpaint_tasks SET status='canceled',credential=CASE WHEN paid_started_at>0 THEN credential ELSE '' END,error=CASE WHEN paid_started_at>0 THEN '已停止本地等待；上游可能继续，可查询原任务，未重新生成' ELSE '已取消，未提交扩图' END,error_code='canceled' WHERE id=? AND status IN ('preparing','submitting','running','uncertain','canceled')").run(id);
  const task = get(id)!; if (!dispatches.has(id)) void clearPayload(task);
  runQueue();
  return { status: 200, body: publicTask(get(id)!) };
}
