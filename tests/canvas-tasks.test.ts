import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import axios from "axios";
import { database, createApiKey, validateApiKey } from "@/lib/database.ts";
import accountPool from "@/lib/account-pool.ts";
import { taskInput, taskResult } from "@/api/controllers/task-contract.ts";
import { createTask, queryTask, cancelTask } from "@/api/controllers/tasks.ts";
import { request } from "@/api/controllers/core.ts";
import { markCredentialFailure, resolveAuthorization } from "@/api/controllers/auth.ts";
import accountRoutes from "@/api/routes/account-status.ts";

globalThis.fetch = async () => { throw Error("unmocked network forbidden"); };
let submissions = 0, timeoutSubmission = false, submissionRet = "0", submissionHttpStatus = 200, historyRet = "0";
let uploaded = 0, failUpload = 0, lastDraft: any;
axios.defaults.adapter = async (config) => {
  const url = String(config.url);
  const ok = (data: unknown) => ({ data, status: 200, statusText: "OK", headers: {}, config });
  if (url.includes("Action=ApplyImageUpload")) return ok({ Result: { UploadAddress: { UploadHosts: ["upload.test"], StoreInfos: [{ StoreUri: `frame-${uploaded + 1}`, Auth: "fake" }], SessionKey: "fake" } } });
  if (url.startsWith("https://upload.test/")) { uploaded++; return ok({ code: uploaded === failUpload ? 5000 : 2000 }); }
  if (url.includes("Action=CommitImageUpload")) return ok({ Result: { Results: [{ Uri: `frame-${uploaded}` }] } });
  let data: any;
  if (url.includes("/get_upload_token?")) data = { access_key_id: "fake", secret_access_key: "fake", session_token: "fake" };
  else if (url.endsWith("/get_common_config")) data = {};
  else if (url.endsWith("/user_credit")) data = { credit: { gift_credit: 500, purchase_credit: 0, vip_credit: 0 } };
  else if (url.endsWith("/aigc_draft/generate")) {
    submissions++;
    lastDraft = JSON.parse(JSON.parse(String(config.data)).draft_content || "{}");
    if (timeoutSubmission) throw Object.assign(Error("timeout"), { code: "ETIMEDOUT" });
    if (submissionHttpStatus !== 200) return { data: {}, status: submissionHttpStatus, statusText: "Denied", headers: {}, config };
    if (submissionRet !== "0") return { data: { ret: submissionRet, errmsg: "生成失败，疑似存在异常行为 private-token-not-for-client" }, status: 200, statusText: "OK", headers: {}, config };
    data = { aigc_data: { history_record_id: `history-${submissions}` } };
  } else if (url.endsWith("/get_history_by_ids")) {
    if (historyRet !== "0") return ok({ ret: historyRet, errmsg: "登录失效" });
    const id = JSON.parse(String(config.data)).history_ids[0];
    data = { [id]: { status: 50, item_list: [{ image: { large_images: [{ image_url: "https://example.com/image.webp" }] } }] } };
  } else if (url.includes("/passport/account/info/v2")) {
    data = { user_info: { is_vip: false } };
  } else throw Error("unmocked axios network forbidden");
  return { data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config };
};
const managed = createApiKey("isolated canvas");
const owner = validateApiKey(managed.key).apiKeyId!;
const otherManaged = createApiKey("other isolated canvas");
accountPool.create({ name: "isolated account", sessionId: "fake-account-session" });
const authorization = `Bearer ${managed.key}`;
const otherAuthorization = `Bearer ${otherManaged.key}`;
const boundAccount = accountPool.create({ name: "bound account", sessionId: "bound-account-session" });
const input = { id: "canvas_test_1234567890", model: "jimeng-image-5.0-lite", prompt: "test 16:9 but request 1:1", ratio: "1:1", resolution: "2k", images: [] };
async function until(predicate: () => boolean) { const end = Date.now() + 2000; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(predicate()); }

test("ordered refs and strict parameters reject paths, URLs and unknown models", () => {
  assert.deepEqual(taskInput(input).images, []);
  for (const image of ["/etc/passwd", "http://127.0.0.1/a", "file:///c:/secret"]) assert.throws(() => taskInput({ ...input, images: [image] }));
  assert.throws(() => taskInput({ ...input, resolution: "1k" }));
  assert.throws(() => taskInput({ ...input, model: "unknown" }));
  assert.throws(() => taskInput({ ...input, model: "jimeng-video-seedance-2.0-fast" }));
});
test("ID-keyed image history resolves only the requested task and recognizes failure", () => {
  const history = { a: { status: 50, item_list: [{ image: { large_images: [{ image_url: "https://example.com/image.png" }] } }] } };
  assert.equal(taskResult(history, "a", "image").status, "succeeded");
  assert.equal(taskResult(history, "b", "image").status, "running");
  assert.equal(taskResult({ a: { status: 30, fail_code: "2038", item_list: [] } }, "a", "image").status, "failed");
});
test("account binding requires a live lease owned by the same managed key", async () => {
  const credits = await accountRoutes.get["/credits"]({ headers: { authorization: otherAuthorization } } as any) as any;
  assert.ok(credits.accounts.some((account: any) => account.id === boundAccount.id));
  await assert.rejects(resolveAuthorization(otherAuthorization, boundAccount.id), /租约|绑定/);
  const statusRequest: any = { headers: { authorization } };
  statusRequest.validate = () => statusRequest;
  const status = await accountRoutes.get["/status"](statusRequest) as any;
  const accountId = status.account.id;
  const credential = await resolveAuthorization(authorization, accountId);
  assert.equal(credential.accountId, accountId);
  await assert.rejects(resolveAuthorization(otherAuthorization, accountId), /租约|绑定/);
  database.prepare("UPDATE jimeng_account_leases SET expires_at = ? WHERE api_key_id = ? AND account_id = ?").run(Date.now() - 1, owner, accountId);
  await assert.rejects(resolveAuthorization(authorization, accountId), /租约|绑定/);
});
test("round robin persists a fair sequence instead of relying on timestamps", () => {
  const columns = database.prepare("PRAGMA table_info(jimeng_accounts)").all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "selection_seq"));
  const previous = accountPool.list();
  for (const account of previous) accountPool.setEnabled(account.id, false);
  const fair = ["fair-a", "fair-b", "fair-c"].map((name) => accountPool.create({ name, sessionId: `${name}-session` }));
  const selected = Array.from({ length: 6 }, () => accountPool.select("round_robin").account.id);
  assert.equal(new Set(selected.slice(0, 3)).size, 3);
  assert.deepEqual(selected.slice(3), selected.slice(0, 3));
  for (const account of fair) accountPool.setEnabled(account.id, false);
  for (const account of previous) accountPool.setEnabled(account.id, account.enabled);
});
test("credits expose only the controlled public status DTO", async () => {
  database.prepare("UPDATE jimeng_accounts SET free_credit = 7, total_credit = 7, status_error = 'private upstream URL and token' WHERE id = ?").run(boundAccount.id);
  const result = await accountRoutes.get["/credits"]({ headers: { authorization } } as any) as any;
  const account = result.accounts.find((item: any) => item.id === boundAccount.id);
  assert.deepEqual(Object.keys(account).sort(), ["cooldownUntil", "enabled", "id", "status"]);
  assert.deepEqual(Object.keys(account.status).sort(), ["checkedAt", "freeCredit", "membership", "purchaseCredit", "totalCredit", "vipCredit"]);
  assert.ok(!JSON.stringify(account).includes("private upstream"));
});
test("duplicate POST never creates another paid task; poll retains private credential", async () => {
  database.prepare("DELETE FROM jimeng_account_leases WHERE api_key_id = ?").run(owner);
  const first = await createTask(owner, authorization, input);
  assert.equal(first.status, 202);
  await until(() => (database.prepare("SELECT status FROM canvas_tasks WHERE id = ?").get(input.id) as any)?.status === "running");
  assert.equal((await createTask(owner, authorization, input)).status, 200);
  assert.equal(submissions, 1);
  const row = database.prepare("SELECT credential, account_id FROM canvas_tasks WHERE id = ?").get(input.id) as any;
  assert.ok(row.credential && !row.credential.includes("fake-account-session"));
  assert.ok(row.account_id);
  assert.ok((database.prepare("SELECT 1 FROM jimeng_account_leases WHERE api_key_id = ? AND account_id = ? AND expires_at > ?").get(owner, row.account_id, Date.now()) as any));
  assert.equal((await queryTask(owner + 1, input.id)).status, 404);
  const result = await queryTask(owner, input.id);
  assert.equal((result.body as any).status, "succeeded");
  assert.ok(accountPool.get(row.account_id).successCount > 0);
  assert.ok(!JSON.stringify(result).includes("fake-account-session"));
  assert.equal((database.prepare("SELECT credential FROM canvas_tasks WHERE id = ?").get(input.id) as any).credential, "");
  assert.equal((await createTask(owner, authorization, { ...input, prompt: "changed" })).status, 409);
});
test("cancel-before-POST tombstone blocks paid dispatch", async () => {
  const id = "canvas_cancel_1234567890";
  assert.equal(cancelTask(owner, id).status, 200);
  assert.equal((await createTask(owner, authorization, { ...input, id })).status, 409);
  assert.equal(submissions, 1);
});
test("finished upstream result is recovered after the wait deadline without another POST", async () => {
  const id = "canvas_expired_1234567890";
  await createTask(owner, authorization, { ...input, id });
  await until(() => (database.prepare("SELECT status FROM canvas_tasks WHERE id = ?").get(id) as any)?.status === "running");
  database.prepare("UPDATE canvas_tasks SET deadline = ? WHERE id = ?").run(Date.now() - 1, id);
  assert.equal((await queryTask(owner, id)).body.status, "succeeded");
  assert.equal(submissions, 2);
});
test("risk control is clearly reported without exposing raw errors or retrying", async () => {
  submissionRet = "4013";
  try {
    const id = "canvas_risk_1234567890";
    await createTask(owner, authorization, { ...input, id });
    await until(() => (database.prepare("SELECT status FROM canvas_tasks WHERE id = ?").get(id) as any)?.status === "failed");
    const result = await queryTask(owner, id);
    assert.match((result.body as any).error, /4013/);
    assert.ok(!JSON.stringify(result).includes("private-token"));
    assert.equal((await createTask(owner, authorization, { ...input, id })).body.status, "failed");
    assert.equal(submissions, 3);
    const row = database.prepare("SELECT account_id FROM canvas_tasks WHERE id = ?").get(id) as any;
    const cooldown = accountPool.get(row.account_id).cooldownUntil;
    assert.ok(cooldown && Date.parse(cooldown) - Date.now() > 55 * 60_000);
    accountPool.markSuccess(row.account_id);
    assert.equal(accountPool.get(row.account_id).cooldownUntil, cooldown);
  } finally {
    submissionRet = "0";
  }
});
test("query authentication failures cool the pinned account while retaining the task", async () => {
  const id = "canvas_query_risk_1234567890";
  await createTask(owner, authorization, { ...input, id });
  await until(() => (database.prepare("SELECT status FROM canvas_tasks WHERE id = ?").get(id) as any)?.status === "running");
  const row = database.prepare("SELECT account_id FROM canvas_tasks WHERE id = ?").get(id) as any;
  historyRet = "1015";
  const result = await queryTask(owner, id);
  historyRet = "0";
  assert.equal((result.body as any).status, "running");
  assert.ok(Date.parse(accountPool.get(row.account_id).cooldownUntil || "") > Date.now());
});
test("HTTP authentication failures cool only the task's pinned account", async () => {
  accountPool.create({ name: "http auth account", sessionId: "http-auth-account-session" });
  submissionHttpStatus = 401;
  try {
    const id = "canvas_http_auth_1234567890";
    await createTask(owner, authorization, { ...input, id });
    await until(() => (database.prepare("SELECT status FROM canvas_tasks WHERE id = ?").get(id) as any)?.status === "failed");
    const row = database.prepare("SELECT account_id FROM canvas_tasks WHERE id = ?").get(id) as any;
    assert.ok(Date.parse(accountPool.get(row.account_id).cooldownUntil || "") > Date.now());
  } finally {
    submissionHttpStatus = 200;
  }
});
test("paid request timeout is not automatically retried", async () => {
  const before = submissions;
  timeoutSubmission = true;
  await assert.rejects(request("post", "/mweb/v1/aigc_draft/generate", "fake-account-session", { data: {} }));
  assert.equal(submissions, before + 1);
  timeoutSubmission = false;
});
test("image edits preserve upload order, request one result, and never submit after upload failure", async () => {
  accountPool.create({ name: "upload account", sessionId: "upload-account-session" });
  const before = submissions;
  const edit = { ...input, id: "canvas_images_1234567890", images: ["data:image/png;base64,YQ==", "data:image/png;base64,Yg=="] };
  await createTask(owner, authorization, edit);
  await until(() => (database.prepare("SELECT status FROM canvas_tasks WHERE id = ?").get(edit.id) as any)?.status === "running");
  const abilities = lastDraft.component_list[0].abilities;
  assert.deepEqual(abilities.blend.ability_list[0].image_uri_list, ["frame-1", "frame-2"]);
  assert.equal(abilities.gen_option.gen_count, 1);
  assert.equal(submissions, before + 1);
  failUpload = 4;
  const failedId = "canvas_upload_failure_1234567890";
  await createTask(owner, authorization, { ...edit, id: failedId });
  await until(() => (database.prepare("SELECT status FROM canvas_tasks WHERE id = ?").get(failedId) as any)?.status === "failed");
  assert.equal(submissions, before + 1);
  const row = database.prepare("SELECT account_id FROM canvas_tasks WHERE id = ?").get(failedId) as any;
  assert.equal(accountPool.get(row.account_id).cooldownUntil, null);
});
test("logout and key creation clear or overwrite both secret key inputs safely", () => {
  const html = readFileSync("public/index.html", "utf8");
  assert.match(html, /handleLogout\(\).*sessionStorage\.removeItem\("jimengTestApiKey"\)/s);
  assert.match(html, /handleLogout\(\).*\$\("image-api-key"\).*value\s*=\s*""/s);
  assert.match(html, /handleLogout\(\).*\$\("upscale-api-key"\).*value\s*=\s*""/s);
  assert.match(html, /submitCreateApiKey\(\).*\$\("image-api-key"\).*value\s*=\s*data\.key/s);
  assert.match(html, /submitCreateApiKey\(\).*\$\("upscale-api-key"\).*value\s*=\s*data\.key/s);
});
test("HTTP 401 from request has no hung axios response", async () => {
  submissionHttpStatus = 401;
  try {
    await request("post", "/mweb/v1/aigc_draft/generate", "fake-account-session", { data: {} });
    assert.fail("request should reject HTTP 401");
  } catch (error: any) {
    assert.equal("response" in error, false);
    assert.match(String(error?.message || ""), /HTTP 401/);
  } finally {
    submissionHttpStatus = 200;
  }
});
test("markCredentialFailure without error cools the account", () => {
  const account = accountPool.create({ name: "openapi cool account", sessionId: "openapi-cool-session" });
  const cooled = markCredentialFailure({ token: "openapi-cool-session", accountId: account.id });
  assert.equal(cooled, true);
  assert.ok(Date.parse(accountPool.get(account.id).cooldownUntil || "") > Date.now());
});
