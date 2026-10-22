import assert from "node:assert/strict";
import { test } from "node:test";
import axios from "axios";
if (process.env.NODE_ENV !== "test" || !process.env.DB_PATH?.includes("cpa-video-queue-test-")) throw Error("Isolated fixture required");
const { readVideoBilling } = await import("../src/api/controllers/video-billing.ts");
const task = { id: "original-task", account_id: "original-account", history_id: "original-history" };
const history = { history_record_id: task.history_id, status: 50, submit_id: "original-submit", task: { submit_id: "original-submit" } };
const record = { history_id: "official-credit-record", submit_id: "original-submit", history_type: 2, status: "Checked", amount: 130, origin_credit_amount: 260 };
let responses: any[] = [], calls = 0;
axios.defaults.adapter = async config => {
  assert.equal(new URL(String(config.url)).pathname, "/commerce/v1/benefits/user_credit_history");
  assert.match(String(config.headers?.Cookie), /sessionid=original-token/);
  const payload = JSON.parse(String(config.data));
  assert.equal(payload.count, 20); assert.equal(payload.need_with_hold, true);
  assert.equal(payload.cursor, calls ? "page2" : "0");
  return { data: { ret: "0", data: responses[calls++] }, status: 200, statusText: "OK", headers: {}, config };
};
function pages(rows: any[], firstEmpty = false) { calls = 0; responses = firstEmpty ? [{ records: [], has_more: true, new_cursor: "page2" }, { records: rows, has_more: false }] : [{ records: rows, has_more: false }]; }
test("original submit Checked bill returns actual130 instead of estimate127", async () => { pages([record]); const result = await readVideoBilling("original-token", task, history); assert.deepEqual({ ...result, checkedAt: "time" }, { taskId: task.id, accountId: task.account_id, historyId: task.history_id, submitId: history.submit_id, creditRecordId: record.history_id, amount: 130, originalAmount: 260, status: "Checked", historyType: 2, checkedAt: "time" }); });
test("pagination follows official cursor without mixing unrelated supplier usage", async () => { pages([{ ...record, submit_id: "other-submit" }, record], true); assert.equal((await readVideoBilling("original-token", task, history))?.amount, 130); assert.equal(calls, 2); });
for (const change of [{ status: "Init" }, { status: "Canceled" }, { submit_id: "foreign-submit" }, { history_type: 1 }, { amount: 130.5 }, { amount: -1 }, { origin_credit_amount: 120 }, { history_id: "" }]) test(`unsettled or mismatched bill is pending ${JSON.stringify(change)}`, async () => { pages([{ ...record, ...change }]); assert.equal(await readVideoBilling("original-token", task, history), undefined); });
test("duplicate submit records are ambiguous and do not settle", async () => { pages([record, record]); assert.equal(await readVideoBilling("original-token", task, history), undefined); });
test("a first-page match is not accepted before cross-page duplicates are ruled out", async () => { calls=0;responses=[{records:[record],has_more:true,new_cursor:"page2"},{records:[record],has_more:false}];assert.equal(await readVideoBilling("original-token",task,history),undefined);assert.equal(calls,2); });
test("an incomplete or stuck page never claims a unique final bill", async () => { calls=0;responses=[{records:[record],has_more:true,new_cursor:"0"}];assert.equal(await readVideoBilling("original-token",task,history),undefined); });
test("ordered records beyond the original submission time close its billing window", async () => { pages([{...record,create_time:101},{submit_id:"older",history_type:2,create_time:90}]);responses[0].has_more=true;responses[0].new_cursor="page2";assert.equal((await readVideoBilling("original-token",task,{...history,created_time:100}))?.amount,130);assert.equal(calls,1); });
test("mismatched original creation identity makes no billing request", async () => { pages([record]); for (const h of [{ ...history, status: 20 }, { ...history, history_record_id: "foreign" }, { ...history, task: { submit_id: "foreign" } }, { ...history, submit_id: "" }]) assert.equal(await readVideoBilling("original-token", task, h), undefined); assert.equal(calls, 0); });
