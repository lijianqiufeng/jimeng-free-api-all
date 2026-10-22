import { request } from "./core.ts";
import { isLongVideo } from "./seedance-contract.ts";

export type VideoBilling = { taskId: string; accountId: string; historyId: string; submitId: string; creditRecordId: string; amount: number; originalAmount: number; status: "Checked"; historyType: 2; checkedAt: string; mode?: "long"; benefitType?: string };

/** The creation history's submit ID binds a credit record; balance changes never do. */
export async function readVideoBilling(token: string, task: { id: string; account_id: string; history_id: string; model?: string; quote_json?: string | null }, history: any): Promise<VideoBilling | undefined> {
  const long = isLongVideo(task.model || ""), submitId = history?.submit_id || (long ? history?.task?.submit_id : undefined);
  const status = long ? Number(history?.status ?? history?.task?.status) : history?.status;
  if (status !== 50 || typeof submitId !== "string" || !submitId || history.task?.submit_id && history.task.submit_id !== submitId || history.history_record_id && String(history.history_record_id) !== task.history_id) return;
  let longBenefit: string | undefined;
  if (long) {
    if (!task.quote_json) return;
    const quote = JSON.parse(task.quote_json);
    if (quote.mode !== "long" || quote.model !== task.model || quote.taskId !== task.id || quote.accountId !== task.account_id || quote.submitId !== submitId || quote.resolution !== "720p" || quote.benefitType !== (quote.hasVideo ? "seedance_25_long_video_720p_output" : "seedance_25_long_video_720p_no_input_video_output")) return;
    longBenefit = quote.benefitType;
  }
  let cursor = "0", complete = false, previousTime = Infinity, ordered = true;
  const matches: any[] = [], since = Number(history.created_time), deadline = performance.now() + 8000;
  for (let page = 0; page < 10; page++) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    const data = await request("post", "/commerce/v1/benefits/user_credit_history", token, { timeout: Math.min(3000, remaining), signal: AbortSignal.timeout(Math.ceil(remaining)), data: { cursor, count: 20, need_with_hold: true } });
    if (!Array.isArray(data?.records)) return;
    for (const row of data.records) {
      ordered = ordered && Number.isFinite(row.create_time) && row.create_time <= previousTime;
      previousTime = row.create_time;
      if (row.submit_id === submitId && row.history_type === 2) {
        if (Number.isFinite(since) && (!Number.isFinite(row.create_time) || row.create_time < Math.floor(since) - 2)) return;
        matches.push(row);
      }
    }
    if (matches.length > 1) return;
    if (!data.has_more || Number.isFinite(since) && ordered && previousTime < Math.floor(since) - 2) { complete = true; break; }
    if (typeof data.new_cursor !== "string" || !data.new_cursor || data.new_cursor === cursor) return;
    cursor = data.new_cursor;
  }
  const row = matches[0];
  if (!complete || matches.length !== 1 || row.status !== "Checked" || typeof row.history_id !== "string" || !row.history_id || !Number.isSafeInteger(row.amount) || row.amount < 0 || !Number.isSafeInteger(row.origin_credit_amount) || row.origin_credit_amount < row.amount) return;
  return { taskId: task.id, accountId: task.account_id, historyId: task.history_id, submitId, creditRecordId: row.history_id, amount: row.amount, originalAmount: row.origin_credit_amount, status: "Checked", historyType: 2, checkedAt: new Date().toISOString(), ...(long ? { mode: "long" as const, benefitType: longBenefit } : {}) };
}
