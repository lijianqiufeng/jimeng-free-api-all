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
const db = new Database(process.env.DB_PATH);
pool.setMembershipStatusProvider(undefined);
axios.defaults.adapter = async (config) => {
  const text = String(config.headers?.Cookie || "");
  const credit = text.includes("test-session-low") ? 2 : text.includes("test-session-high") ? 28 : 0;
  if (!String(config.url).includes("/commerce/v1/benefits/user_credit")) throw Error("Unmocked network");
  return { data: { ret: "0", data: { credit: { gift_credit: credit, purchase_credit: 0, vip_credit: 0 } } }, status: 200, statusText: "OK", headers: {}, config };
};
after(() => { db.close(); });

const accounts = [
  pool.createAccount({ name: "zero", sessionId: "test-session-zero" }),
  pool.createAccount({ name: "low", sessionId: "test-session-low" }),
  pool.createAccount({ name: "high", sessionId: "test-session-high" }),
];
for (const [index, credit] of [0, 4, 28].entries()) {
  db.prepare("UPDATE jimeng_accounts SET total_credit = ?, status_checked_at = ? WHERE id = ?").run(credit, new Date().toISOString(), accounts[index].id);
}

test("paid models exclude all accounts below five credits; Lite still uses them", () => {
  for (const model of ["jimeng-4k", "jimeng-8k", "jimeng-image-5.0-pro"]) {
    for (let index = 0; index < 20; index++) assert.equal(pool.selectAccount("round_robin", model).account.id, accounts[2].id);
  }
  assert.ok(Array.from({ length: 12 }, () => pool.selectAccount("round_robin", "jimeng-image-5.0-lite").account.id).includes(accounts[0].id));
});

test("a pre-bound zero-point account cannot submit a paid task", async () => {
  const { key } = createApiKey("isolated-test");
  pool.grantAccountLease(validateApiKey(key).apiKeyId!, accounts[0].id);
  await assert.rejects(resolveAuthorization(`Bearer ${key}`, accounts[0].id, "jimeng-4k", true), /积分不足/);
  db.prepare("UPDATE jimeng_accounts SET total_credit = 30 WHERE id = ?").run(accounts[1].id);
  pool.grantAccountLease(validateApiKey(key).apiKeyId!, accounts[1].id);
  await assert.rejects(resolveAuthorization(`Bearer ${key}`, accounts[1].id, "jimeng-8k", true), /积分不足/);
  assert.equal((await resolveAuthorization(`Bearer ${key}`, accounts[0].id, "jimeng-image-5.0-lite", true)).accountId, accounts[0].id);
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
  for (const account of accounts) pool.setAccountEnabled(account.id, false);
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

test("advanced suffix excludes Pro for automatic and explicit selection, while Lite and video remain available", async () => {
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
  for (const model of ["jimeng-image-5.0-lite", "jimeng-video-seedance-2.0", "jimeng-8k", "jimeng-image-4.7"]) assert.equal((await resolveAuthorization(`Bearer ${key}`, advanced.id, model, true)).accountId, advanced.id);
  pool.updateAccount(regular.id, { name: "新加入_高级" });
  assert.throws(() => pool.selectAccount("round_robin", "jimeng-image-5.0-pro"), /普通账号/);
  pool.updateAccount(advanced.id, { name: "恢复普通号" });
  assert.equal(pool.selectAccount("round_robin", "jimeng-image-5.0-pro").account.id, advanced.id);
  assert.equal(pool.accountSupportsModel("高级_普通", "jimeng-image-5.0-pro"), true);
});
