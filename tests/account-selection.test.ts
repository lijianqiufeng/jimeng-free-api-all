import assert from "node:assert/strict";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import axios from "axios";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "jimeng-account-test-"));
process.env.DB_PATH = join(directory, "accounts.sqlite");
process.env.JIMENG_ACCOUNT_POOL_KEY = "isolated-account-selection-test";
const pool = await import("../src/lib/account-pool.ts");
const { createApiKey, validateApiKey } = await import("../src/lib/database.ts");
const { resolveAuthorization } = await import("../src/api/controllers/auth.ts");
const { getStaticModelConfigs } = await import("../src/api/controllers/models.ts");
const db = new Database(process.env.DB_PATH);
pool.setMembershipStatusProvider(undefined);
axios.defaults.adapter = async (config) => {
  const text = String(config.headers?.Cookie || "");
  const credit = text.includes("video-rich") ? 14686 : text.includes("video-poor") ? 78 : text.includes("test-session-low") ? 2 : text.includes("test-session-high") ? 28 : 0;
  if (!String(config.url).includes("/commerce/v1/benefits/user_credit")) throw Error("Unmocked network");
  return { data: { ret: "0", data: { credit: { gift_credit: credit, purchase_credit: 0, vip_credit: 0 } } }, status: 200, statusText: "OK", headers: {}, config };
};
after(() => { db.close(); });

const accounts = [
  pool.createAccount({ name: "zero", sessionId: "test-session-zero" }),
  pool.createAccount({ name: "low", sessionId: "test-session-low" }),
  pool.createAccount({ name: "high", sessionId: "test-session-high" }),
];
const freeAccount = pool.createAccount({ name: "zero_高级", sessionId: "test-session-zero-free" });
for (const [index, credit] of [0, 4, 28].entries()) {
  db.prepare("UPDATE jimeng_accounts SET total_credit = ?, status_checked_at = ? WHERE id = ?").run(credit, new Date().toISOString(), accounts[index].id);
}

test("account tiers depend only on the trimmed final suffix", () => {
  for (const [name, tier] of [["账号_高级  ", "advanced"], ["账号_超级", "super"], ["5777", "standard"], ["超级_普通", "standard"], ["账号_超级_普通", "standard"], ["账号_高级_超级", "super"], ["账号_超级_高级", "advanced"]]) assert.equal(pool.accountTier(name), tier);
});

test("paid models exclude accounts below five credits; free premium models select only advanced accounts", () => {
  for (const model of ["jimeng-4k", "jimeng-8k", "jimeng-image-5.0-pro"]) {
    for (let index = 0; index < 20; index++) assert.equal(pool.selectAccount("round_robin", model).account.id, accounts[2].id);
  }
  for (const model of ["jimeng-image-5.0-lite", "high_aes_general_v50", "jimeng-image-4.6", "high_aes_general_v42"]) {
    assert.equal(pool.selectAccount("round_robin", model).account.id, freeAccount.id);
  }
});

test("a pre-bound zero-point account cannot submit a paid task", async () => {
  const { key } = createApiKey("isolated-test");
  pool.grantAccountLease(validateApiKey(key).apiKeyId!, accounts[0].id);
  await assert.rejects(resolveAuthorization(`Bearer ${key}`, accounts[0].id, "jimeng-4k", true), /积分不足/);
  db.prepare("UPDATE jimeng_accounts SET total_credit = 30 WHERE id = ?").run(accounts[1].id);
  pool.grantAccountLease(validateApiKey(key).apiKeyId!, accounts[1].id);
  await assert.rejects(resolveAuthorization(`Bearer ${key}`, accounts[1].id, "jimeng-8k", true), /积分不足/);
  await assert.rejects(resolveAuthorization(`Bearer ${key}`, accounts[0].id, "jimeng-image-5.0-lite", true), /_高级/);
  pool.grantAccountLease(validateApiKey(key).apiKeyId!, freeAccount.id);
  assert.equal((await resolveAuthorization(`Bearer ${key}`, freeAccount.id, "jimeng-image-5.0-lite", true)).accountId, freeAccount.id);
});

test("higher positive balance gets more paid work, then accounts above 30 share equally", () => {
  db.prepare("UPDATE jimeng_accounts SET total_credit = 5 WHERE id = ?").run(accounts[1].id);
  const selected = Array.from({ length: 100 }, () => pool.selectAccount("round_robin", "jimeng-4k").account.id);
  assert.ok(selected.filter((id) => id === accounts[2].id).length > selected.filter((id) => id === accounts[1].id).length);
  db.prepare("UPDATE jimeng_accounts SET total_credit = 35 WHERE id IN (?, ?)").run(accounts[1].id, accounts[2].id);
  const equal = Array.from({ length: 60 }, () => pool.selectAccount("round_robin", "jimeng-8k").account.id);
  assert.ok(Math.abs(equal.filter((id) => id === accounts[1].id).length - equal.filter((id) => id === accounts[2].id).length) <= 1);
});

test("one managed API key can rotate through four accounts and credits expose their names only", async () => {
  for (const account of pool.listAccounts()) pool.setAccountEnabled(account.id, false);
  const four = Array.from({ length: 4 }, (_, i) => pool.createAccount({ name: `画布账号 ${i + 1}`, sessionId: `test-session-high-${i}` }));
  for (const account of four) db.prepare("UPDATE jimeng_accounts SET total_credit=30 WHERE id=?").run(account.id);
  const { key } = createApiKey("single-key-four-accounts");
  const selected = await Promise.all(four.map(() => resolveAuthorization(`Bearer ${key}`, undefined, "jimeng-image-4.7")));
  assert.deepEqual(new Set(selected.map((item) => item.accountId)), new Set(four.map((item) => item.id)));
  const route = (await import("../src/api/routes/account-status.ts")).default;
  const result = await route.get["/credits"]({ headers: { authorization: `Bearer ${key}` } } as any) as any;
  assert.deepEqual(result.accounts.filter((account: any) => account.enabled).map((account: any) => account.name).sort(), four.map((account) => account.name).sort());
  assert.ok(!JSON.stringify(result).includes("test-session"));
  assert.ok(!JSON.stringify(result).includes("credential"));
});

test("advanced suffix preserves premium images and upscale while blocking new video", async () => {
  for (const account of pool.listAccounts()) pool.setAccountEnabled(account.id, false);
  const advanced = pool.createAccount({ name: "视频专用_高级", sessionId: "test-session-high-advanced" });
  const regular = pool.createAccount({ name: "普通图片号", sessionId: "test-session-high-regular" });
  for (const account of [advanced, regular]) db.prepare("UPDATE jimeng_accounts SET total_credit=100 WHERE id=?").run(account.id);
  const { key } = createApiKey("advanced-policy-test");
  pool.grantAccountLease(validateApiKey(key).apiKeyId!, advanced.id);
  for (const model of ["jimeng-image-5.0-pro", "high_aes_general_v50p_large"]) {
    for (let i = 0; i < 12; i++) assert.equal(pool.selectAccount("round_robin", model).account.id, regular.id);
    assert.equal((await resolveAuthorization(`Bearer ${key}`, undefined, model)).accountId, regular.id);
    await assert.rejects(resolveAuthorization(`Bearer ${key}`, advanced.id, model, true), /_高级/);
  }
  assert.equal(pool.selectAccountById(advanced.id).account.id, advanced.id); // Existing task/status lookups are unaffected.
  for (const model of ["jimeng-image-5.0-lite", "jimeng-8k", "jimeng-image-4.7"]) assert.equal((await resolveAuthorization(`Bearer ${key}`, advanced.id, model, true)).accountId, advanced.id);
  await assert.rejects(resolveAuthorization(`Bearer ${key}`, advanced.id, "jimeng-video-seedance-2.0", true), /高级账号已暂停新视频提交/);
  assert.equal(pool.getAccount(advanced.id).enabled, true, "video policy does not disable the account for images");
  pool.updateAccount(regular.id, { name: "新加入_高级" });
  assert.throws(() => pool.selectAccount("round_robin", "jimeng-image-5.0-pro"), /普通账号/);
  pool.updateAccount(advanced.id, { name: "恢复普通号" });
  assert.equal(pool.selectAccount("round_robin", "jimeng-image-5.0-pro").account.id, advanced.id);
  assert.equal(pool.accountSupportsModel("高级_普通", "jimeng-image-5.0-pro"), true);
});

test("all new video models use only super accounts; old advanced bindings remain readable", async () => {
  for (const account of pool.listAccounts()) pool.setAccountEnabled(account.id, false);
  const advanced = pool.createAccount({ name: "13800005776_高级  ", sessionId: "test-session-high-video-advanced" });
  const superAccount = pool.createAccount({ name: "13800005777_超级", sessionId: "test-session-high-video" });
  const regular = pool.createAccount({ name: "普通视频号", sessionId: "test-session-high-video-regular" });
  for (const account of [advanced, superAccount, regular]) db.prepare("UPDATE jimeng_accounts SET total_credit=100 WHERE id=?").run(account.id);
  const { key } = createApiKey("video-policy-test"), authorization = `Bearer ${key}`;
  for (const account of [advanced, superAccount, regular]) pool.grantAccountLease(validateApiKey(key).apiKeyId!, account.id);
  const videoModels = getStaticModelConfigs("video").flatMap(model => [model.id, model.modelReqKey, ...(model.aliases || [])]);
  for (const model of videoModels) {
    assert.equal(pool.accountSupportsModel(regular.name, model), false);
    assert.equal(pool.accountSupportsModel(advanced.name, model), false);
    assert.equal(pool.accountSupportsModel(superAccount.name, model), true);
    assert.equal(pool.selectAccount("round_robin", model).account.id, superAccount.id);
    assert.equal((await resolveAuthorization(authorization, undefined, model)).accountId, superAccount.id);
    for (const account of [advanced, regular]) await assert.rejects(resolveAuthorization(authorization, account.id, model, true), /视频.*_超级/);
    await assert.rejects(resolveAuthorization("Bearer test-session-high-direct", undefined, model, true), /托管 API Key/);
  }
  assert.equal((await resolveAuthorization(authorization, undefined, "unknown-video-alias", true, true)).accountId, superAccount.id);
  await assert.rejects(resolveAuthorization(authorization, regular.id, "unknown-video-alias", true, true), /视频.*_超级/);
  const videoRoute = (await import("../src/api/routes/videos.ts")).default;
  const chatRoute = (await import("../src/api/routes/chat.ts")).default;
  const directRequest = (model: string) => ({ body: { model }, headers: { authorization: "Bearer test-session-high-direct" }, validate() { return this; } });
  const legacyVideo = await videoRoute.post["/generations"](directRequest("unknown-model") as any);
  const legacyChat = await chatRoute.post["/completions"](directRequest("jimeng-video-unknown") as any);
  for (const result of [legacyVideo, legacyChat]) { assert.equal(result.statusCode, 400); assert.match(result.body.error, /\/v1\/tasks/); }
  assert.equal((await resolveAuthorization(authorization, regular.id)).accountId, regular.id); // Old status/history binding.
  assert.equal((await resolveAuthorization(authorization, advanced.id)).accountId, advanced.id);
  const statusRoute = (await import("../src/api/routes/account-status.ts")).default;
  const status = await statusRoute.get["/status"]({ headers: { authorization, "x-jimeng-account-id": advanced.id, "x-jimeng-model": videoModels[0] }, validate() {} } as any) as any;
  assert.equal(status.account.id, advanced.id);
  pool.updateAccount(superAccount.id, { name: "改名普通号" });
  assert.throws(() => pool.selectAccount("round_robin", videoModels[0]), /没有.*_超级/);
  await assert.rejects(resolveAuthorization(authorization, undefined, videoModels[0]), /没有.*_超级/);
  pool.updateAccount(regular.id, { name: "13800005778_超级" });
  assert.equal((await resolveAuthorization(authorization, undefined, videoModels[0])).accountId, regular.id);
  pool.updateAccount(regular.id, { sessionId: "test-session-low-video" });
  await assert.rejects(resolveAuthorization(authorization, regular.id, videoModels[0], true), /积分不足/);
});

test("concurrent new VIP videos prefer refreshed credit, preserving explicit bindings and image rotation", async () => {
  for (const account of pool.listAccounts()) pool.setAccountEnabled(account.id, false);
  const poor = pool.createAccount({ name: "13800005777_超级", sessionId: "video-poor" });
  const rich = pool.createAccount({ name: "13800005778_超级", sessionId: "video-rich" });
  // Stale cache prefers the wrong account; a new video must refresh before choosing.
  db.prepare("UPDATE jimeng_accounts SET total_credit=20000 WHERE id=?").run(poor.id);
  db.prepare("UPDATE jimeng_accounts SET total_credit=5 WHERE id=?").run(rich.id);
  const { key } = createApiKey("video-credit-selection"), auth = `Bearer ${key}`;
  const selected = await Promise.all([resolveAuthorization(auth, undefined, "jimeng-video-seedance-2.0-vip", true), resolveAuthorization(auth, undefined, "jimeng-video-seedance-2.0-vip", true)]);
  assert.deepEqual(selected.map(value => value.accountId), [rich.id, rich.id]);
  pool.grantAccountLease(validateApiKey(key).apiKeyId!, poor.id);
  assert.equal((await resolveAuthorization(auth, poor.id, "jimeng-video-seedance-2.0-vip", true)).accountId, poor.id);
  const images = Array.from({ length: 10 }, () => pool.selectAccount("round_robin", "jimeng-image-4.7").account.id);
  assert.ok(images.includes(poor.id) && images.includes(rich.id));
  pool.setAccountEnabled(rich.id, false);
  assert.equal((await resolveAuthorization(auth, undefined, "jimeng-video-seedance-2.0-vip", true)).accountId, poor.id);
});

test("super and advanced share image pools but only super can submit videos", async () => {
  for (const account of pool.listAccounts()) pool.setAccountEnabled(account.id, false);
  const premium = ["高级", "超级"].map(tier => pool.createAccount({ name: `等级测试_${tier}`, sessionId: `test-session-high-${tier}` }));
  const regular = pool.createAccount({ name: "等级测试_普通", sessionId: "test-session-high-standard" });
  for (const account of [...premium, regular]) db.prepare("UPDATE jimeng_accounts SET total_credit=100, status_checked_at=? WHERE id=?").run(new Date().toISOString(), account.id);
  const { key } = createApiKey("super-policy-test"), authorization = `Bearer ${key}`;
  await assert.rejects(resolveAuthorization(authorization, premium[1].id, "jimeng-video-seedance-2.0", true), /有效租约绑定/);
  for (const account of [...premium, regular]) pool.grantAccountLease(validateApiKey(key).apiKeyId!, account.id);
  for (const model of ["jimeng-image-5.0-lite", "high_aes_general_v50", "jimeng-image-4.6", "high_aes_general_v42"]) {
    assert.deepEqual(new Set(Array.from({ length: 8 }, () => pool.selectAccount("round_robin", model).account.id)), new Set(premium.map(account => account.id)));
    for (const account of premium) assert.equal((await resolveAuthorization(authorization, account.id, model, true)).accountId, account.id);
    await assert.rejects(resolveAuthorization(authorization, regular.id, model, true), /_高级 或 _超级/);
    await assert.rejects(resolveAuthorization("Bearer test-session-high-direct", undefined, model, true), /托管 API Key.*_高级 或 _超级/);
  }
  for (const model of getStaticModelConfigs("video").flatMap(model => [model.id, model.modelReqKey, ...(model.aliases || [])])) {
    assert.equal(pool.selectAccount("round_robin", model).account.id, premium[1].id);
    assert.equal((await resolveAuthorization(authorization, premium[1].id, model, true)).accountId, premium[1].id);
    for (const account of [premium[0], regular]) await assert.rejects(resolveAuthorization(authorization, account.id, model, true), /视频.*_超级/);
    await assert.rejects(resolveAuthorization("Bearer test-session-high-direct", undefined, model, true), /托管 API Key.*_超级/);
  }
  for (const model of ["jimeng-4k", "jimeng-8k", "jimeng-image-4.7"]) for (const account of premium) assert.equal(pool.accountSupportsModel(account.name, model), true);
  for (const model of ["jimeng-image-5.0-pro", "high_aes_general_v50p_large"]) {
    assert.equal(pool.selectAccount("round_robin", model).account.id, regular.id);
    for (const account of premium) await assert.rejects(resolveAuthorization(authorization, account.id, model, true), /_高级 或 _超级.*不用于 5.0 Pro/);
  }
  assert.equal(pool.selectAccountById(premium[1].id).account.id, premium[1].id);
  pool.updateAccount(premium[1].id, { sessionId: "test-session-low-super" });
  await assert.rejects(resolveAuthorization(authorization, premium[1].id, "jimeng-video-seedance-2.0", true), /积分不足/);
});
