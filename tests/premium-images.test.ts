import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { createHash } from "node:crypto";
import { taskInput } from "../src/api/controllers/task-contract.ts";
import { database, createApiKey, validateApiKey } from "../src/lib/database.ts";
import pool, { encrypt } from "../src/lib/account-pool.ts";
import { resolveAuthorization } from "../src/api/controllers/auth.ts";
import { generateImages, generateImagesWithRetry } from "../src/api/controllers/images.ts";
import { resolvePremiumImagePayment } from "../src/api/controllers/image-entitlements.ts";
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
let credit = 0, creditQueries = 0, creditUnavailable = false, billingQueries = 0, billStatus = "Checked", wrongHistory = false;
const submissions = new Map<string, string>();
const accountBenefits = new Map<string, ReturnType<typeof premiumImageBenefits>>();
const accountCredits = new Map<string, number>();
axios.defaults.adapter = async config => {
  const url = String(config.url);
  const token = /(?:^|;\s*)sessionid=([^;]+)/.exec(String(config.headers?.Cookie || ""))?.[1] || "";
  let data: any;
  if (url.endsWith("/get_common_config")) data = premiumImageConfig;
  else if (url.endsWith("/batch_get_user_benefit")) {
    queries++;
    if (unavailable) return { data: {}, status: 503, statusText: "Unavailable", headers: {}, config };
    data = accountBenefits.get(token) || benefits;
  } else if (url.endsWith("/user_credit")) {
    creditQueries++;
    if (creditUnavailable) throw Error("private credit request failure");
    data = { credit: { gift_credit: accountCredits.get(token) ?? credit, purchase_credit: 0, vip_credit: 0 } };
  } else if (url.endsWith("/get_history_by_ids")) {
    const id = JSON.parse(String(config.data)).history_ids[0];
    data = { [id]: { status: 50, history_record_id: id, submit_id: wrongHistory ? "wrong-submit" : submissions.get(id), created_time: Math.floor(Date.now() / 1000), item_list: [{ image: { large_images: [{ image_url: "https://example.test/paid-image.png" }] } }] } };
  } else if (url.endsWith("/user_credit_history")) {
    billingQueries++;
    data = { has_more: false, records: [{ history_type: 2, status: billStatus, submit_id: lastBody.submit_id, history_id: "image-bill-1", amount: 7, origin_credit_amount: 7, create_time: Math.floor(Date.now() / 1000) }] };
  }
  else if (url.endsWith("/aigc_draft/generate")) {
    posts++; lastBody = JSON.parse(String(config.data));
    submissions.set(`premium-history-${posts}`, lastBody.submit_id);
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
  const reads = creditQueries;
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
  assert.equal(creditQueries, reads, "free accounts do not need a paid credit balance");
});

test("2K-only unlimited assets may omit limit_free_type without losing their expiry and quota checks", async () => {
  const before = posts;
  benefits = premiumImageBenefits();
  benefits.asset_list = benefits.asset_list.filter(asset => !asset.benefit_type.endsWith("4k"));
  for (const asset of benefits.asset_list) {
    for (const detail of asset.asset_details) delete (detail as any).limit_free_type;
  }
  try {
    await generateImages("jimeng-image-5.0-lite", "test", { ...options, resolution: "2k" }, "fake-free-session");
    assert.equal(posts, before + 1);
    assert.equal(JSON.parse(lastBody.draft_content).component_list[0].abilities.generate.core_param.large_image_info.resolution_type, "2k");
    benefits.asset_list.find(asset => asset.benefit_type === "image_basic_v5_2k")!.asset_details[0].remain_time = 0;
    await assert.rejects(generateImages("jimeng-image-5.0-lite", "test", { ...options, resolution: "2k" }, "fake-free-session"), /没有所选清晰度的免费高速权益.*未提交生成/);
    assert.equal(posts, before + 1);
  } finally { benefits = premiumImageBenefits(); }
});

test("missing, exhausted, expired, credit-only and wrong-resolution benefits never use points", async () => {
  const before = posts;
  const mutate = [
    () => { benefits.asset_list = benefits.asset_list.filter(asset => asset.benefit_type !== "queue_speed"); },
    () => { benefits.asset_list.find(asset => asset.benefit_type === "image_basic_v5_4k")!.asset_details[0].quota_left = 0; },
    () => { benefits.asset_list.find(asset => asset.benefit_type === "image_basic_v5_4k")!.asset_details[0].remain_time = 0; },
    () => { benefits.asset_list.find(asset => asset.benefit_type === "image_basic_v5_4k")!.asset_details[0].pay_mode = "UserCredit"; },
    () => { benefits.asset_list.find(asset => asset.benefit_type === "image_basic_v5_4k")!.asset_details[0].limit_free_type = 1; },
    () => { benefits.asset_list = benefits.asset_list.filter(asset => asset.benefit_type !== "image_basic_v5_4k"); },
  ];
  for (const change of mutate) {
    benefits = premiumImageBenefits(); change();
    await assert.rejects(generateImagesWithRetry("jimeng-image-5.0-lite", "test", { resolution: "4k" }, "fake-free-session"), /没有所选清晰度的免费高速权益.*未提交生成/);
    assert.equal(posts, before);
  }
  benefits = premiumImageBenefits();
});

test("no free account is a pre-submission selection failure without a new task or paid request", async () => {
  benefits.asset_list = [];
  const before = posts, id = "premium_no_entitlement_123456";
  const input = { id, model: "jimeng-image-4.6", prompt: "test", ratio: "1:1", resolution: "4k" };
  try {
    await assert.rejects(createTask(owner, authorization, input), /没有具备所选清晰度免费权益/);
    assert.equal(database.prepare("SELECT id FROM canvas_tasks WHERE id=?").get(id), undefined);
    await assert.rejects(createTask(owner, authorization, input), /没有具备所选清晰度免费权益/);
    assert.equal(posts, before);
  } finally { benefits = premiumImageBenefits(); }
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
  await assert.rejects(resolvePremiumImagePayment({ modelReqKey: raw.model_req_key, raw } as any, "4k", "fake-free-session"), /图片权益配置未确认.*未提交生成/);
  assert.equal(posts, before);
});

test("free models route by resolution to the free account; a funded super account joins paid Pro instead", async () => {
  for (const account of pool.list()) pool.setEnabled(account.id, false);
  const free = pool.create({ name: "original_超级", sessionId: "routing-free-super" });
  const paid = pool.create({ name: "new_超级", sessionId: "routing-paid-super" });
  const twoK = pool.create({ name: "2k_高级", sessionId: "routing-2k-only" });
  for (const account of [free, paid, twoK]) pool.grantLease(owner, account.id);
  accountBenefits.set("routing-free-super", premiumImageBenefits());
  accountBenefits.set("routing-paid-super", { asset_list: [] });
  accountBenefits.set("routing-2k-only", { asset_list: premiumImageBenefits().asset_list.filter(asset => !asset.benefit_type.endsWith("4k")) });
  accountCredits.set("routing-paid-super", 95000);
  database.prepare("UPDATE jimeng_accounts SET total_credit=95000 WHERE id=?").run(paid.id);
  database.prepare("UPDATE jimeng_accounts SET total_credit=0 WHERE id IN (?,?)").run(free.id, twoK.id);
  const reads = creditQueries, before = posts, lookups = queries;
  for (const model of ["jimeng-image-5.0-lite", "jimeng-image-4.6"]) {
    const selected = await Promise.all(Array.from({ length: 8 }, () => resolveAuthorization(authorization, undefined, model, true, false, "4k")));
    assert.deepEqual(new Set(selected.map(item => item.accountId)), new Set([free.id]));
    await assert.rejects(resolveAuthorization(authorization, paid.id, model, true, false, "4k"), /没有具备所选清晰度免费权益/);
    await assert.rejects(resolveAuthorization(authorization, twoK.id, model, true, false, "4k"), /没有具备所选清晰度免费权益/);
    assert.equal((await resolveAuthorization(authorization, twoK.id, model, true, false, "2k")).accountId, twoK.id);
  }
  assert.equal(queries - lookups, 8, "parallel requests share each account/model/resolution lookup");
  assert.equal(creditQueries, reads, "routing a free model does not require paid balances");
  const statusRoute = (await import("../src/api/routes/account-status.ts")).default;
  const status = await statusRoute.get["/status"]({ headers: { authorization, "x-jimeng-model": "jimeng-image-5.0-lite", "x-jimeng-resolution": "4k" }, validate() {} } as any) as any;
  assert.equal(status.account.id, free.id);
  for (const model of ["jimeng-image-5.0-pro", "high_aes_general_v50p_large", "jimeng-image-4.7"]) assert.equal((await resolveAuthorization(authorization, undefined, model, true)).accountId, paid.id);
  const id = "new_free_only_123456789";
  await createTask(owner, authorization, { id, model: "jimeng-image-5.0-lite", prompt: "test", ratio: "1:1", resolution: "4k" });
  await until(() => (database.prepare("SELECT status FROM canvas_tasks WHERE id=?").get(id) as any)?.status === "running");
  const task = (await queryTask(owner, id)).body as any;
  assert.equal(task.imagePayment.accountId, free.id);
  assert.equal(task.imagePayment.mode, "free");
  assert.equal(task.creditsUsed, 0);
  assert.equal(posts, before + 1);
});

test("expired routing cache and disabled free accounts cannot fall back to a funded account", async () => {
  const free = pool.list().find(account => account.name === "original_超级")!;
  const before = posts, reads = creditQueries;
  accountBenefits.set("routing-free-super", { asset_list: [] });
  const selected = await resolveAuthorization(authorization, undefined, "jimeng-image-5.0-lite", true, false, "4k");
  assert.equal(selected.accountId, free.id);
  await assert.rejects(generateImages("jimeng-image-5.0-lite", "test", options, selected.token), /没有所选清晰度的免费高速权益/);
  pool.setEnabled(free.id, false);
  await assert.rejects(resolveAuthorization(authorization, undefined, "jimeng-image-5.0-lite", true, false, "4k"), /没有具备所选清晰度免费权益/);
  assert.equal(posts, before);
  assert.equal(creditQueries, reads);
});

test("an existing paid task keeps its image and original receipt after free-only routing changes", async () => {
  benefits = { asset_list: [] }; credit = 30; billStatus = "Pending";
  const before = posts, id = "premium_paid_receipt_123456", account = pool.list().find(item => item.name === "new_超级")!;
  const input = { id, model: "jimeng-image-5.0-lite", prompt: "test", ratio: "1:1", resolution: "4k" };
  try {
    const historyId = "preserved-paid-history", submitId = "preserved-paid-submit";
    lastBody = { submit_id: submitId }; submissions.set(historyId, submitId);
    const payment = { policy: "image-payment-v1", mode: "credits", taskId: id, accountId: account.id, model: input.model, resolution: input.resolution, submitId };
    const fingerprint = createHash("sha256").update(JSON.stringify(taskInput(input))).digest("hex");
    database.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,credential,account_id,history_id,deadline,quote_json) VALUES(?,?,'image',?,?,'running',?,?,?,?,?)").run(id, owner, input.model, fingerprint, encrypt("routing-paid-super"), account.id, historyId, Date.now() + 60000, JSON.stringify(payment));
    const pending = (await queryTask(owner, id)).body as any;
    assert.equal(pending.status, "succeeded");
    assert.equal(pending.billingPending, true);
    assert.equal(pending.creditsUsed, undefined);
    assert.equal(pending.imagePayment.mode, "credits");
    assert.equal(pending.imagePayment.accountId, account.id);
    assert.ok((database.prepare("SELECT credential FROM canvas_tasks WHERE id=?").get(id) as any).credential);
    const reads = billingQueries;
    wrongHistory = true;
    database.prepare("UPDATE canvas_tasks SET checked_at=0 WHERE id=?").run(id);
    assert.equal(((await queryTask(owner, id)).body as any).billingPending, true);
    assert.equal(billingQueries, reads, "another submit cannot be used to look up this bill");
    wrongHistory = false; billStatus = "Checked";
    database.prepare("UPDATE canvas_tasks SET checked_at=0 WHERE id=?").run(id);
    const settled = (await queryTask(owner, id)).body as any;
    assert.equal(settled.creditsUsed, 7);
    assert.equal(settled.billing.submitId, lastBody.submit_id);
    assert.deepEqual(settled.data, pending.data);
    assert.equal((database.prepare("SELECT credential FROM canvas_tasks WHERE id=?").get(id) as any).credential, "");
    assert.equal((await createTask(owner, authorization, input, account.id)).status, 200);
    await queryTask(owner, id);
    assert.equal(billingQueries, reads + 1);
    assert.equal(posts, before);
  } finally { credit = 0; billStatus = "Checked"; wrongHistory = false; benefits = premiumImageBenefits(); }
});
