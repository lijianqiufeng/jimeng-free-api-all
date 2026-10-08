import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { database, createApiKey, validateApiKey } from "../src/lib/database.ts";
import pool from "../src/lib/account-pool.ts";
import { resolveAuthorization } from "../src/api/controllers/auth.ts";
import { generateImages, generateImagesWithRetry } from "../src/api/controllers/images.ts";
import { assertPremiumImageEntitlement } from "../src/api/controllers/image-entitlements.ts";
import { createTask, queryTask } from "../src/api/controllers/tasks.ts";
import { premiumImageBenefits, premiumImageConfig } from "./fixtures/premium-images.ts";

pool.setMembershipStatusProvider(undefined);
const advanced = pool.create({ name: "free_高级", sessionId: "fake-free-session" });
const regular = pool.create({ name: "regular", sessionId: "fake-regular-session" });
database.prepare("UPDATE jimeng_accounts SET total_credit=0 WHERE id=?").run(advanced.id);
database.prepare("UPDATE jimeng_accounts SET total_credit=30 WHERE id=?").run(regular.id);
const { key } = createApiKey("premium-isolated"), authorization = `Bearer ${key}`, owner = validateApiKey(key).apiKeyId!;
for (const account of [advanced, regular]) pool.grantLease(owner, account.id);
let benefits = premiumImageBenefits(), posts = 0, ret = "0", queries = 0, lastBody: any, unavailable = false;
axios.defaults.adapter = async config => {
  const url = String(config.url);
  let data: any;
  if (url.endsWith("/get_common_config")) data = premiumImageConfig;
  else if (url.endsWith("/batch_get_user_benefit")) {
    queries++;
    if (unavailable) return { data: {}, status: 503, statusText: "Unavailable", headers: {}, config };
    data = benefits;
  } else if (url.endsWith("/user_credit")) data = { credit: { gift_credit: 30, purchase_credit: 0, vip_credit: 0 } };
  else if (url.endsWith("/aigc_draft/generate")) {
    posts++; lastBody = JSON.parse(String(config.data));
    return { data: { ret, errmsg: "insufficient 2039 private-token", data: { aigc_data: { history_record_id: `premium-history-${posts}` } } }, status: 200, statusText: "OK", headers: {}, config };
  } else throw Error("unmocked network forbidden");
  return { data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config };
};
const options = { ratio: "1:1", resolution: "4k", n: 1, onSubmitted() {} };
async function until(predicate: () => boolean) { const deadline = Date.now() + 2000; while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate()); }

test("all premium aliases require advanced managed accounts even at zero balance", async () => {
  for (const model of ["jimeng-image-5.0-lite", "high_aes_general_v50", "jimeng-image-4.6", "high_aes_general_v42", "jimeng-image-4.6:2048x2048"]) {
    assert.equal((await resolveAuthorization(authorization, undefined, model, true)).accountId, advanced.id);
    await assert.rejects(resolveAuthorization(authorization, regular.id, model, true), /_高级/);
    await assert.rejects(resolveAuthorization("Bearer raw-cookie-session", undefined, model), /托管 API Key/);
    assert.equal((await resolveAuthorization(`${authorization}, raw-cookie-session`, undefined, model)).accountId, advanced.id);
  }
});

test("direct image, chat and default model requests cannot bypass premium policy", async () => {
  const imageRoute = (await import("../src/api/routes/images.ts")).default;
  const chatRoute = (await import("../src/api/routes/chat.ts")).default;
  for (const model of [undefined, "jimeng-image-5.0-lite", "jimeng-image-4.6", "high_aes_general_v42", "jimeng-image-4.6:2048x2048"]) {
    const request = { headers: { authorization: "Bearer sessionid=raw-cookie" }, body: { model, prompt: "test", messages: [] }, validate() { return this; } };
    await assert.rejects(imageRoute.post["/generations"](request as any), /托管 API Key/);
    await assert.rejects(chatRoute.post["/completions"](request as any), /托管 API Key/);
  }
  assert.equal(posts, 0);
});

test("account status headers select advanced for new work but preserve old regular bindings", async () => {
  const route = (await import("../src/api/routes/account-status.ts")).default;
  const request = (id?: string) => ({ headers: { authorization, "x-jimeng-model": "jimeng-image-4.6", ...(id ? { "x-jimeng-account-id": id } : {}) }, validate() { return this; } });
  assert.equal((await route.get["/status"](request() as any) as any).account.id, advanced.id);
  assert.equal((await route.get["/status"](request(regular.id) as any) as any).account.id, regular.id);
  await assert.rejects(createTask(owner, authorization, { id: "premium_binding_123456", model: "jimeng-image-4.6", prompt: "test", ratio: "1:1", resolution: "4k" }, regular.id), /_高级/);
  assert.equal(posts, 0);
});

test("fresh unlimited image and queue entitlements permit original 4K payload without invented flags", async () => {
  for (const model of ["jimeng-image-5.0-lite", "jimeng-image-4.6"]) {
    const before = queries;
    await generateImages(model, "test", options, "fake-free-session");
    assert.equal(queries, before + 1);
    assert.deepEqual(Object.keys(lastBody.extend), ["root_model"]);
    const draft = JSON.parse(lastBody.draft_content);
    assert.equal(draft.component_list[0].abilities.generate.core_param.large_image_info.resolution_type, "4k");
    assert.equal(draft.component_list[0].abilities.gen_option.gen_count, 1);
  }
  assert.equal(posts, 2);
});

test("missing, exhausted, expired, credit-only and wrong-resolution benefits never submit", async () => {
  const before = posts;
  const mutate = [
    () => { benefits.asset_list = benefits.asset_list.filter(asset => asset.benefit_type !== "queue_speed"); },
    () => { benefits.asset_list.find(asset => asset.benefit_type === "image_basic_v5_4k")!.asset_details[0].quota_left = 0; },
    () => { benefits.asset_list.find(asset => asset.benefit_type === "image_basic_v5_4k")!.asset_details[0].remain_time = 0; },
    () => { benefits.asset_list.find(asset => asset.benefit_type === "image_basic_v5_4k")!.asset_details[0].pay_mode = "UserCredit"; },
    () => { benefits.asset_list = benefits.asset_list.filter(asset => asset.benefit_type !== "image_basic_v5_4k"); },
  ];
  for (const change of mutate) {
    benefits = premiumImageBenefits(); change();
    await assert.rejects(generateImagesWithRetry("jimeng-image-5.0-lite", "test", { resolution: "4k" }, "fake-free-session"), /免费高速权益.*未提交生成/);
    assert.equal(posts, before);
  }
  benefits = premiumImageBenefits();
});

test("preparation failure has a safe terminal task error and never creates upstream history", async () => {
  benefits.asset_list = [];
  const before = posts, id = "premium_no_entitlement_123456";
  await createTask(owner, authorization, { id, model: "jimeng-image-4.6", prompt: "test", ratio: "1:1", resolution: "4k" });
  await until(() => (database.prepare("SELECT status FROM canvas_tasks WHERE id=?").get(id) as any)?.status === "failed");
  const result = await queryTask(owner, id);
  assert.match((result.body as any).error, /免费高速权益.*未提交生成/);
  assert.equal((database.prepare("SELECT history_id FROM canvas_tasks WHERE id=?").get(id) as any).history_id, "");
  assert.equal(posts, before);
  assert.equal((await createTask(owner, authorization, { id, model: "jimeng-image-4.6", prompt: "test", ratio: "1:1", resolution: "4k" })).status, 200);
  benefits = premiumImageBenefits();
});

test("an accepted entitlement followed by upstream 2039 is not retried or downgraded", async () => {
  const before = posts; ret = "2039";
  try { await assert.rejects(generateImagesWithRetry("jimeng-image-4.6", "test", { resolution: "4k" }, "fake-free-session")); }
  finally { ret = "0"; }
  assert.equal(posts, before + 1);
  assert.equal(JSON.parse(lastBody.draft_content).component_list[0].abilities.generate.core_param.large_image_info.resolution_type, "4k");
});

test("uncertain read-only entitlement query cannot fall back to credits or another generation", async () => {
  const before = posts; unavailable = true;
  try { await assert.rejects(generateImagesWithRetry("jimeng-image-5.0-lite", "test", { resolution: "4k" }, "fake-free-session"), /权益查询失败.*未提交生成/); }
  finally { unavailable = false; }
  assert.equal(posts, before);
});

test("cancellation during entitlement lookup and unknown model names never submit", async () => {
  const before = posts; let checked = 0;
  await assert.rejects(generateImages("jimeng-image-5.0-lite", "test", { ...options, beforeSubmit() { if (++checked > 1) throw Error("canceled"); } }, "fake-free-session"), /canceled/);
  await assert.rejects(generateImages("unknown-alias", "test", options, "raw-cookie-session"), /不支持/);
  const raw = structuredClone(premiumImageConfig.model_list[0]); raw.feats = [];
  await assert.rejects(assertPremiumImageEntitlement({ modelReqKey: raw.model_req_key, raw } as any, "4k", "fake-free-session"), /免费权益配置未确认.*未提交生成/);
  assert.equal(posts, before);
});
