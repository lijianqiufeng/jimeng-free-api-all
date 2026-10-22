import assert from "node:assert/strict";
import { after, test } from "node:test";
import Database from "better-sqlite3";

assert.equal(process.env.JIMENG_ACCOUNT_POOL_KEY, "isolated-video-queue-test");
assert.ok(process.env.DB_PATH?.includes("cpa-video-queue-test-"));
const { database, createApiKey, validateApiKey, createUser, validateUser, createSession } = await import("../src/lib/database.ts");
const pool = await import("../src/lib/account-pool.ts");
const { readVideoQueueSettings, saveVideoQueueSettings } = await import("../src/lib/video-queue-settings.ts");
const { default: dashboard } = await import("../src/api/routes/dashboard.ts");
pool.setMembershipStatusProvider(undefined);
after(() => database.close());

test("video concurrency configuration requires an admin session, validates values and uses persistent CAS", async () => {
  assert.deepEqual(readVideoQueueSettings(), { perAccountConcurrency: 1, totalConcurrency: null, version: 0, source: "default", updatedAt: null });
  assert.equal(database.prepare("SELECT count(*) AS n FROM video_queue_settings").get().n, 0, "reading defaults does not save an override");
  process.env.JIMENG_VIDEO_ACCOUNT_CONCURRENCY = "3";
  assert.equal(readVideoQueueSettings().perAccountConcurrency, 3); assert.equal(readVideoQueueSettings().source, "environment");
  delete process.env.JIMENG_VIDEO_ACCOUNT_CONCURRENCY;
  const managedKey = createApiKey("fixture key");
  const request = (headers: object, body?: unknown) => ({ headers, body }) as any;
  const unauthorized = { authorization: `Bearer ${managedKey.key}` };
  assert.equal((await dashboard.get["/video-queue"](request(unauthorized))).statusCode, 401);
  assert.equal((await dashboard.put["/video-queue"](request(unauthorized, { perAccountConcurrency: 100, totalConcurrency: null, expectedVersion: 0 }))).statusCode, 401);
  createUser("fixture-admin", "fixture-password");
  const headers = { cookie: `session=${createSession(validateUser("fixture-admin", "fixture-password")!)}` };
  const saved = await dashboard.put["/video-queue"](request(headers, { perAccountConcurrency: 2, totalConcurrency: 3, expectedVersion: 0 })) as any;
  assert.equal(saved.settings.version, 1); assert.equal(saved.settings.source, "administrator");
  assert.equal(saved.localMaximum, 100); assert.equal(saved.officialConcurrencyLimit, null);
  assert.equal(saved.effectivePerAccountConcurrency, 1); assert.equal(saved.concurrencyScope, "upload-and-submit"); assert.equal(saved.settings.perAccountConcurrency, 2);
  const before = readVideoQueueSettings();
  for (const change of [{ perAccountConcurrency: 0 }, { perAccountConcurrency: 101 }, { perAccountConcurrency: 1.5 }, { perAccountConcurrency: "2" }, { totalConcurrency: 0 }, { totalConcurrency: 101 }, { expectedVersion: undefined }, { unexpected: true }]) {
    const result = await dashboard.put["/video-queue"](request(headers, { perAccountConcurrency: 2, totalConcurrency: null, expectedVersion: 1, ...change })) as any;
    assert.equal(result.statusCode, 400); assert.deepEqual(readVideoQueueSettings(), before);
  }
  const conflict = await dashboard.put["/video-queue"](request(headers, { perAccountConcurrency: 3, totalConcurrency: null, expectedVersion: 0 })) as any;
  assert.equal(conflict.statusCode, 409); assert.deepEqual(readVideoQueueSettings(), before);
  const separate = new Database(process.env.DB_PATH!, { readonly: true });
  try { assert.equal(separate.prepare("SELECT per_account FROM video_queue_settings WHERE id=1").get().per_account, 2); } finally { separate.close(); }
  assert.equal(database.prepare("SELECT count(*) AS n FROM video_queue_settings").get().n, 1);
});

test("one account serializes preparation across keys, releases accepted submissions and preserves funds and unknown holds", () => {
  database.exec(`CREATE TABLE canvas_tasks (
    id TEXT PRIMARY KEY, owner INTEGER NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
    requested_account_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '',
    credential TEXT NOT NULL DEFAULT '', credit_before INTEGER, provider_hold INTEGER NOT NULL DEFAULT 0,
    provider_status TEXT NOT NULL DEFAULT '', paid_started_at INTEGER NOT NULL DEFAULT 0,
    history_id TEXT NOT NULL DEFAULT '', quote_json TEXT, result TEXT NOT NULL DEFAULT '', deadline INTEGER NOT NULL
  )`);
  const owners = [createApiKey("fixture one"), createApiKey("fixture two")].map(key => validateApiKey(key.key).apiKeyId!);
  const superAccount = pool.createAccount({ name: "fixture-phone_超级", sessionId: "fixture-super" }).id;
  database.prepare("UPDATE jimeng_accounts SET total_credit=10000,status_checked_at=?,status_error=NULL WHERE id=?").run(new Date().toISOString(), superAccount);
  saveVideoQueueSettings({ perAccountConcurrency: 3, totalConcurrency: null, expectedVersion: 1 });
  for (let i = 0; i < 5; i++) database.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,status,deadline) VALUES(?,?,'video','jimeng-video-seedance-2.5','queued',?)").run(`slot-fixture-${i}`, owners[i % 2], Date.now() + 60_000);
  const reserve = (index: number) => { const settings = readVideoQueueSettings(); return pool.reserveVideoAccount(`slot-fixture-${index}`, settings.perAccountConcurrency, settings.totalConcurrency ?? Infinity); };
  assert.equal(reserve(0)?.account.id, superAccount);
  for (let i = 1; i < 3; i++) assert.equal(reserve(i), undefined);
  assert.equal(reserve(3), undefined); assert.equal(reserve(0), undefined, "a task cannot reserve twice");
  const quote = JSON.stringify({ taskId: "slot-fixture-0", accountId: superAccount, estimatedCredits: 32 });
  database.prepare("UPDATE canvas_tasks SET status='running',provider_status='running',history_id='accepted-fixture-history',paid_started_at=?,quote_json=? WHERE id='slot-fixture-0'").run(Date.now(), quote);
  const accepted = database.prepare("SELECT * FROM canvas_tasks WHERE id='slot-fixture-0'").get() as any;
  assert.equal(pool.videoAccountUsage().get(superAccount)?.active, 0, "a persisted original history releases only the preparation/submission lock");
  assert.equal(pool.videoAccountUsage().get(superAccount)?.rendering, 1);
  assert.equal(pool.videoAccountUsage().get(superAccount)?.reservedCredits, 32);
  database.prepare("UPDATE jimeng_accounts SET total_credit=35 WHERE id=?").run(superAccount);
  assert.equal(reserve(1), undefined, "the accepted task's frozen credits cannot fund another submission");
  database.prepare("UPDATE jimeng_accounts SET total_credit=10000 WHERE id=?").run(superAccount);
  assert.equal(reserve(1)?.account.id, superAccount, "another key may prepare the next task before the original video completes");
  assert.deepEqual(database.prepare("SELECT * FROM canvas_tasks WHERE id='slot-fixture-0'").get(), accepted, "admitting the next task keeps the original history, credential, quote and hold");
  assert.equal(accepted.provider_hold, 1); assert.ok(accepted.credential); assert.equal(accepted.quote_json, quote);
  assert.equal(reserve(2), undefined, "the next task's preparing lock still blocks both keys");
  database.prepare("UPDATE canvas_tasks SET status='uncertain',provider_status='uncertain',paid_started_at=? WHERE id='slot-fixture-1'").run(Date.now());
  const originalRows = database.prepare("SELECT * FROM canvas_tasks ORDER BY id").all();
  saveVideoQueueSettings({ perAccountConcurrency: 1, totalConcurrency: 1, expectedVersion: 2 });
  assert.deepEqual(database.prepare("SELECT * FROM canvas_tasks ORDER BY id").all(), originalRows, "configuration never cancels, rebinds or edits existing tasks");
  assert.equal(reserve(3), undefined);
  const second = pool.createAccount({ name: "fixture-second_超级", sessionId: "fixture-second" }).id;
  database.prepare("UPDATE jimeng_accounts SET total_credit=10000,status_checked_at=?,status_error=NULL WHERE id=?").run(new Date().toISOString(), second);
  assert.equal(reserve(4), undefined, "the unknown original task still occupies the global slot");
  saveVideoQueueSettings({ perAccountConcurrency: 1, totalConcurrency: 2, expectedVersion: 3 });
  assert.equal(reserve(4)?.account.id, second, "raising total admits another account without reusing the unknown account");
  const unknown = database.prepare("SELECT * FROM canvas_tasks WHERE id='slot-fixture-1'").get() as any;
  assert.equal(unknown.account_id, superAccount); assert.equal(unknown.provider_hold, 1); assert.ok(unknown.credential);
  assert.equal(unknown.history_id, "");
});
