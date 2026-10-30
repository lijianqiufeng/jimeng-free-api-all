import assert from "node:assert/strict";
import { test } from "node:test";
import axios from "axios";
if (process.env.NODE_ENV !== "test" || !process.env.DB_PATH?.includes("cpa-video-queue-test-")) throw Error("Isolated fixture required");
const { readOutpaintBilling } = await import("../src/api/controllers/outpaint-billing.ts");
const task = { id: "outpaint-original", account_id: "original-account", history_id: "original-history", submit_id: "original-submit" };
const history = { history_record_id: task.history_id, status: 50, submit_id: task.submit_id };
const record = { history_id: "original-credit-record", submit_id: task.submit_id, history_type: 2, status: "Checked", amount: 7, origin_credit_amount: 9 };
let pages: any[] = [], calls = 0;
axios.defaults.adapter = async config => {
  assert.equal(new URL(String(config.url)).pathname, "/commerce/v1/benefits/user_credit_history");
  assert.match(String(config.headers?.Cookie), /sessionid=original-token/);
  assert.equal(JSON.parse(String(config.data)).cursor, calls ? "page2" : "0");
  return { data: { ret: "0", data: pages[calls++] }, status: 200, statusText: "OK", headers: {}, config };
};
function rows(values: any[]) { calls = 0; pages = [{ records: values, has_more: false }]; }
test("official original-submit bill returns actual amount including an explicit zero", async () => {
  for (const amount of [7, 0]) { rows([{ ...record, amount }]); const bill = await readOutpaintBilling("original-token", task, history); assert.equal(bill?.amount, amount); assert.equal(bill?.operation, "outpaint"); assert.equal(bill?.submitId, task.submit_id); }
});
test("foreign original history or submit makes no bill request", async () => {
  rows([record]); for (const changed of [{ ...history, submit_id: "foreign" }, { ...history, history_record_id: "foreign" }, { ...history, status: 20 }]) assert.equal(await readOutpaintBilling("original-token", task, changed), undefined); assert.equal(calls, 0);
});
test("unsettled, foreign, duplicated and malformed consumption stays pending", async () => {
  for (const values of [[{ ...record, status: "Init" }], [{ ...record, submit_id: "foreign" }], [record, record], [{ ...record, amount: -1 }], [{ ...record, amount: 1.5 }], [{ ...record, history_type: 1 }]]) { rows(values); assert.equal(await readOutpaintBilling("original-token", task, history), undefined); }
});
test("cross-page duplicate is rejected instead of accepting the first apparent match", async () => {
  calls = 0; pages = [{ records: [record], has_more: true, new_cursor: "page2" }, { records: [record], has_more: false }]; assert.equal(await readOutpaintBilling("original-token", task, history), undefined); assert.equal(calls, 2);
});
