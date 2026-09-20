import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { database, createApiKey, validateApiKey } from "@/lib/database.ts";
import accountPool from "@/lib/account-pool.ts";
import { taskInput, taskResult } from "@/api/controllers/task-contract.ts";
import { createTask, queryTask, cancelTask } from "@/api/controllers/tasks.ts";
import { request } from "@/api/controllers/core.ts";

globalThis.fetch = async () => { throw Error("unmocked network forbidden"); };
let submissions = 0, timeoutSubmission = false, submissionRet = "0";
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
    if (submissionRet !== "0") return { data: { ret: submissionRet, errmsg: "生成失败，疑似存在异常行为 private-token-not-for-client" }, status: 200, statusText: "OK", headers: {}, config };
    data = { aigc_data: { history_record_id: `history-${submissions}` } };
  } else if (url.endsWith("/get_history_by_ids")) {
    const id = JSON.parse(String(config.data)).history_ids[0];
    data = { [id]: { status: 50, item_list: [{ image: { large_images: [{ image_url: "https://example.com/image.webp" }] } }] } };
  } else throw Error("unmocked axios network forbidden");
  return { data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config };
};
const managed = createApiKey("isolated canvas");
const owner = validateApiKey(managed.key).apiKeyId!;
accountPool.create({ name: "isolated account", sessionId: "fake-account-session" });
const authorization = `Bearer ${managed.key}`;
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
test("duplicate POST never creates another paid task; poll retains private credential", async () => {
  const first = await createTask(owner, authorization, input);
  assert.equal(first.status, 202);
  await until(() => (database.prepare("SELECT status FROM canvas_tasks WHERE id = ?").get(input.id) as any)?.status === "running");
  assert.equal((await createTask(owner, authorization, input)).status, 200);
  assert.equal(submissions, 1);
  const row = database.prepare("SELECT credential FROM canvas_tasks WHERE id = ?").get(input.id) as any;
  assert.ok(row.credential && !row.credential.includes("fake-account-session"));
  assert.equal((await queryTask(owner + 1, input.id)).status, 404);
  const result = await queryTask(owner, input.id);
  assert.equal((result.body as any).status, "succeeded");
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
  const id = "canvas_risk_1234567890";
  await createTask(owner, authorization, { ...input, id });
  await until(() => (database.prepare("SELECT status FROM canvas_tasks WHERE id = ?").get(id) as any)?.status === "failed");
  const result = await queryTask(owner, id);
  assert.match((result.body as any).error, /4013/);
  assert.ok(!JSON.stringify(result).includes("private-token"));
  assert.equal((await createTask(owner, authorization, { ...input, id })).body.status, "failed");
  assert.equal(submissions, 3);
  submissionRet = "0";
});
test("paid request timeout is not automatically retried", async () => {
  timeoutSubmission = true;
  await assert.rejects(request("post", "/mweb/v1/aigc_draft/generate", "fake-account-session", { data: {} }));
  assert.equal(submissions, 4);
  timeoutSubmission = false;
});
test("image edits preserve upload order, request one result, and never submit after upload failure", async () => {
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
});
