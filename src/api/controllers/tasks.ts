import crypto from "node:crypto";
import { database } from "@/lib/database.ts";
import { encrypt, decrypt, markFailure } from "@/lib/account-pool.ts";
import { resolveAuthorization } from "./auth.ts";
import { generateImages } from "./images.ts";
import { request } from "./core.ts";
import { taskInput, taskResult } from "./task-contract.ts";

type Task = { id: string; owner: number; kind: "image" | "video"; model: string; fingerprint: string; status: string; credential: string; history_id: string; result: string; error: string; deadline: number; checked_at: number };
database.exec(`CREATE TABLE IF NOT EXISTS canvas_tasks (
  id TEXT PRIMARY KEY, owner INTEGER NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
  fingerprint TEXT NOT NULL, status TEXT NOT NULL, credential TEXT NOT NULL DEFAULT '',
  history_id TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  deadline INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0
)`);
// A process crash before receiving history_id is ambiguous: never submit again.
database.prepare("UPDATE canvas_tasks SET status = 'failed', credential = '', error = '服务重启时提交结果未确认；为避免重复扣积分未自动重提，请检查即梦记录' WHERE status = 'submitting'").run();
const polling = new Map<string, Promise<void>>();
const get = (id: string) => database.prepare("SELECT * FROM canvas_tasks WHERE id = ?").get(id) as Task | undefined;
const publicTask = (task: Task) => ({ id: task.id, status: task.status === "submitting" ? "running" : task.status, model: task.model, ...(task.result ? { data: JSON.parse(task.result) } : {}), ...(task.error ? { error: task.error } : {}) });

export async function createTask(owner: number, authorization: string, body: unknown, requestedAccountId?: string) {
  const input = taskInput(body);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const previous = get(input.id);
  if (previous) {
    if (previous.owner !== owner || previous.fingerprint !== fingerprint) return { status: 409, body: { error: "任务 ID 已使用，不能替换参数或归属" } };
    return { status: 200, body: publicTask(previous) };
  }
  const credential = await resolveAuthorization(authorization, requestedAccountId);
  // resolveAuthorization yields: recheck for concurrent requests before inserting.
  const reserved = database.prepare("INSERT OR IGNORE INTO canvas_tasks (id, owner, kind, model, fingerprint, status, credential, deadline) VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?)").run(input.id, owner, input.kind, input.model, fingerprint, encrypt(credential.token), Date.now() + (input.kind === "image" ? 60 : 30) * 60_000);
  if (!reserved.changes) return createTask(owner, authorization, body, requestedAccountId);
  const onSubmitted = (historyId: string) => {
    database.prepare("UPDATE canvas_tasks SET history_id = ?, status = 'running' WHERE id = ? AND status = 'submitting'").run(historyId, input.id);
  };
  const beforeSubmit = () => { const current = get(input.id); if (current?.status !== "submitting" || Date.now() >= current.deadline) throw Error("任务已取消或超时"); };
  void generateImages(input.model, input.prompt, { ratio: input.ratio, resolution: input.resolution, filePaths: input.images, n: 1, onSubmitted, beforeSubmit }, credential.token).catch((error) => {
    // Never return raw upstream errors, request configs, cookies or asset URLs.
    const message = String(error?.message || "");
    if (credential.accountId) markFailure(credential.accountId, /4013/.test(message) ? 60 * 60_000 : 30_000);
    const known = /\(错误码: 4013\)$/.test(message)
      ? "即梦安全风控拒绝了本次请求（4013：疑似存在异常行为）；未自动重提，请前往即梦网页检查账号安全验证或联系即梦支持"
      : message.match(/当前即梦模型不支持所选(?:清晰度|时长)，未自动(?:降级|缩短)|^首帧上传失败$|^尾帧上传失败，未提交生成$/)?.[0];
    database.prepare("UPDATE canvas_tasks SET status = 'failed', credential = '', error = ? WHERE id = ? AND status = 'submitting'").run(known || "即梦提交失败或结果未确认；未自动重提，请检查账号积分、权限和即梦生成记录", input.id);
  });
  return { status: 202, body: publicTask(get(input.id)!) };
}

export async function queryTask(owner: number, id: string) {
  let task = get(id);
  if (!task || task.owner !== owner) return { status: 404, body: { error: "任务不存在" } };
  if (task.status === "running" && Date.now() - task.checked_at >= 5000) {
    if (!polling.has(id)) {
      const current = task;
      database.prepare("UPDATE canvas_tasks SET checked_at = ? WHERE id = ?").run(Date.now(), id);
      const work = (async () => {
        const response = await request("post", "/mweb/v1/get_history_by_ids", decrypt(current.credential), { timeout: 15_000, data: { history_ids: [current.history_id], ...(current.kind === "image" ? { image_info: { width: 4096, height: 4096, format: "webp" } } : {}) } });
        const result = taskResult(response, current.history_id, current.kind);
        if (result.status === "running") return;
        // The API does not return authoritative point spending; do not invent a zero-point bill.
        database.prepare("UPDATE canvas_tasks SET status = ?, result = ?, error = ?, credential = '' WHERE id = ? AND status = 'running'").run(result.status, result.status === "succeeded" ? JSON.stringify(result.urls.map((url) => ({ url }))) : "", result.status === "failed" ? result.error : "", id);
      })().catch(() => { /* Transient query failures retain the same upstream history and credential. */ }).finally(() => polling.delete(id));
      polling.set(id, work);
    }
    await polling.get(id);
  }
  // Query once before expiring: the result may have completed while the browser was closed.
  task = get(id)!;
  if (["running", "submitting"].includes(task.status) && Date.now() >= task.deadline) {
    database.prepare("UPDATE canvas_tasks SET status = 'failed', credential = '', error = '即梦任务等待超时，未重新生成；上游可能继续运行，请检查即梦记录' WHERE id = ? AND status IN ('running', 'submitting')").run(id);
  }
  return { status: 200, body: publicTask(get(id)!) };
}

export function cancelTask(owner: number, id: string) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return { status: 400, body: { error: "任务 ID 无效" } };
  const previous = get(id);
  if (previous && previous.owner !== owner) return { status: 404, body: { error: "任务不存在" } };
  // Tombstone a DELETE that races ahead of POST; that POST must never spend points.
  database.prepare("INSERT OR IGNORE INTO canvas_tasks (id, owner, kind, model, fingerprint, status, deadline) VALUES (?, ?, 'image', '', '', 'canceled', ?)").run(id, owner, Date.now());
  database.prepare("UPDATE canvas_tasks SET status = 'canceled', credential = '', error = '已停止等待；即梦已接收的任务可能继续运行，积分以即梦结算为准' WHERE id = ? AND status IN ('submitting', 'running', 'canceled')").run(id);
  return { status: 200, body: publicTask(get(id)!) };
}
