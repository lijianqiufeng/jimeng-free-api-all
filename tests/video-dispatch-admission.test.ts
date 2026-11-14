import assert from "node:assert/strict";
import { after, test } from "node:test";
import axios from "axios";
import models from "./fixtures/seedance-models.json";

assert.equal(process.env.JIMENG_ACCOUNT_POOL_KEY, "isolated-video-queue-test");
assert.ok(process.env.DB_PATH?.includes("cpa-video-queue-test-"));
let balance = 100, submissions = 0;
axios.defaults.adapter = async config => {
  const path = new URL(String(config.url)).pathname;
  const ok = (data: unknown) => ({ data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config });
  if (path.endsWith("/benefit_metadata") && String(config.headers?.Cookie).includes("admission-broken")) return ok({});
  if (path.endsWith("/user_credit")) return ok({ credit: { gift_credit: balance, purchase_credit: 0, vip_credit: 0 } });
  if (path.endsWith("/video_generate/get_common_config")) return ok({ models });
  if (path.endsWith("/get_common_config")) return ok({});
  if (path.endsWith("/benefit_metadata") || path.endsWith("/batch_get_user_benefit")) {
    const types = JSON.parse(String(config.data)).query_list[0].benefit_type_list;
    return ok(path.endsWith("/benefit_metadata")
      ? { metadata_list: [{ resource_type: "aigc", resource_id: "generate_video", benefits_pay_strategy: types.map((benefit_type: string) => ({ benefit_type, unit: "second", credit_strategy: { credit_limits: [{ role: "standard" }], credit_pricing_info: { min_charge_cnt: 1, credit_unit_price: 13, original_credit_unit_price: 26 } } })) }] }
      : { asset_list: types.map((benefit_type: string) => ({ resource_type: "aigc", resource_id: "generate_video", benefit_type, asset_details: [{ pay_mode: "UserCredit", role: "standard" }] })) });
  }
  if (path.endsWith("/aigc_draft/generate")) { submissions++; return ok({ aigc_data: { history_record_id: `admission-history-${submissions}` } }); }
  if (path.endsWith("/get_history_by_ids")) {
    const id = JSON.parse(String(config.data)).history_ids[0];
    return ok({ [id]: { status: 20 } });
  }
  throw Error(`Unmocked request: ${path}`);
};
const { database: db, createApiKey, validateApiKey } = await import("../src/lib/database.ts");
const pool = await import("../src/lib/account-pool.ts");
pool.setMembershipStatusProvider(undefined);
const key = createApiKey("admission fixture"), owner = validateApiKey(key.key).apiKeyId!;
const account = pool.createAccount({ name: "准入夹具_超级", sessionId: "admission-fixture" });
const { createTask, runVideoQueueTick, cancelTask } = await import("../src/api/controllers/tasks.ts");
const oldId = "admission_old_reviewed_submission", paidAt = Date.now() - 86400_000;
const quote = { taskId: oldId, accountId: account.id, estimatedCredits: 80, submissionReconciliation: { kind: "operator_confirmed_no_record", taskId: oldId, accountId: account.id, paidStartedAt: paidAt, confirmedAt: paidAt + 1000, evidenceId: "admission-isolated-proof" } };
db.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,account_id,provider_status,provider_hold,paid_started_at,quote_json,deadline) VALUES(?,?,'video','jimeng-video-seedance-2.5','','uncertain',?,'uncertain',1,?,?,?)").run(oldId, owner, account.id, paidAt, JSON.stringify(quote), Date.now() - 1000);
const row = (id: string) => db.prepare("SELECT * FROM canvas_tasks WHERE id=?").get(id) as any;
const original = row(oldId);
const input = (id: string) => ({ id, model: "jimeng-video-seedance-2.5", prompt: id, ratio: "9:16", resolution: "720p", duration: 5, references: [] });
function funds(value: number) {
  balance = value;
  db.prepare("UPDATE jimeng_accounts SET total_credit=?,status_error=NULL,status_checked_at=? WHERE id=?").run(value, new Date().toISOString(), account.id);
}
after(() => db.close());

test("reviewed old reservation cannot leave a fresh unpaid request dispatching indefinitely", async () => {
  funds(100);
  assert.equal(pool.videoAccountUsage().get(account.id)?.active, 0);
  const id = "admission_frozen_funds_shortage";
  await createTask(owner, `Bearer ${key.key}`, input(id));
  await runVideoQueueTick();
  assert.equal(row(id).status, "failed");
  assert.match(row(id).error, /预留.*不足|不足.*预留/);
  assert.equal(row(id).account_id, "");
  assert.equal(row(id).paid_started_at, 0);
  assert.equal(row(id).provider_hold, 0);
  assert.equal(submissions, 0);
  assert.deepEqual(row(oldId), original, "the old unknown task, marker and reservation remain intact");
  await createTask(owner, `Bearer ${key.key}`, input(id));
  await runVideoQueueTick();
  assert.equal(row(id).status, "failed", "same ID never recreates a failed paid request");
  assert.equal(submissions, 0);
});

test("sufficient unreserved funds dispatch once while preserving the old unknown task", async () => {
  funds(500);
  const id = "admission_sufficient_funds_fixture";
  await createTask(owner, `Bearer ${key.key}`, input(id));
  await runVideoQueueTick();
  const deadline = Date.now() + 3000;
  while (!row(id).history_id && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(row(id).status, "running");
  assert.equal(row(id).account_id, account.id);
  assert.equal(row(id).history_id, "admission-history-1");
  assert.equal(submissions, 1);
  await createTask(owner, `Bearer ${key.key}`, input(id));
  await runVideoQueueTick();
  assert.equal(submissions, 1, "same task never repeats its paid POST");
  assert.deepEqual(row(oldId), original);
});

test("rendering and billing reservations wait; canceled IDs cannot revive after funding", async () => {
  funds(100);
  const activeId = "admission_sufficient_funds_fixture", waiting = "admission_wait_rendering_fixture";
  await createTask(owner, `Bearer ${key.key}`, input(waiting));
  await runVideoQueueTick();
  assert.equal(row(waiting).status, "queued", "an accepted video can still finish and settle");
  assert.equal(row(waiting).paid_started_at, 0);
  db.prepare("UPDATE canvas_tasks SET status='succeeded',provider_status='succeeded',result=?,checked_at=? WHERE id=?").run(JSON.stringify([{ url: "https://fixture.test/original.mp4" }]), Date.now() + 60_000, activeId);
  assert.equal(pool.videoAccountUsage().get(account.id)?.billingPending, 1);
  await runVideoQueueTick();
  assert.equal(row(waiting).status, "queued", "an original successful video may still settle");
  await cancelTask(owner, waiting);
  funds(1000);
  const canceled = row(waiting);
  await createTask(owner, `Bearer ${key.key}`, input(waiting));
  await runVideoQueueTick();
  assert.equal(row(waiting).status, "canceled");
  assert.deepEqual(row(waiting), canceled);
  assert.equal(submissions, 1);
  assert.deepEqual(row(oldId), original);
});

test("snapshot admission 282 minus 234 blocks both reference sets before any upload or paid POST", async () => {
  pool.setAccountEnabled(account.id, false);
  balance = 282;
  const replayAccount = pool.createAccount({ name: "快照准入夹具_超级", sessionId: "admission-snapshot-fixture" });
  db.prepare("UPDATE jimeng_accounts SET total_credit=282,status_checked_at=? WHERE id=?").run(new Date().toISOString(), replayAccount.id);
  const replayId = "admission_snapshot_old_reviewed", replayQuote = { ...quote, taskId: replayId, accountId: replayAccount.id, estimatedCredits: 234, submissionReconciliation: { ...quote.submissionReconciliation, taskId: replayId, accountId: replayAccount.id } };
  db.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,account_id,provider_status,provider_hold,paid_started_at,quote_json,deadline) VALUES(?,?,'video','jimeng-video-seedance-2.5','','uncertain',?,'uncertain',1,?,?,?)").run(replayId, owner, replayAccount.id, paidAt, JSON.stringify(replayQuote), Date.now() - 1000);
  const before = row(replayId), sentBefore = submissions, usage = pool.videoAccountUsage().get(replayAccount.id)!;
  assert.equal(usage.active, 0);
  assert.equal(282 - usage.reservedCredits, 48);
  const { videoAccountMinimumCredits } = await import("../src/api/controllers/video-quote.ts");
  for (const count of [1, 4]) {
    const request = { ...input(`admission_snapshot_${count}_images`), references: [...Array.from({ length: count }, () => ({ kind: "image", url: "data:image/png;base64,aA==" })), { kind: "video", url: "https://fixture.tos-cn-beijing.volces.com/reference.mp4" }] };
    assert.equal((await videoAccountMinimumCredits(request as any)).get(replayAccount.id), 65);
    await createTask(owner, `Bearer ${key.key}`, request);
    await runVideoQueueTick();
    assert.equal(row(request.id).status, "failed");
    assert.match(row(request.id).error, /预留.*不足/);
    assert.equal(row(request.id).account_id, "");
    assert.equal(row(request.id).paid_started_at, 0);
    assert.equal(row(request.id).provider_hold, 0);
  }
  assert.equal(submissions, sentBefore);
  assert.deepEqual(row(replayId), before);
  assert.deepEqual(row(oldId), original);
});

test("below-five accounts fail without quote lookup, retaining old tasks and preventing revival", async () => {
  balance = 4;
  db.prepare("UPDATE jimeng_accounts SET total_credit=4,status_error=NULL,status_checked_at=? WHERE enabled=1").run(new Date().toISOString());
  const before = row(oldId), sent = submissions, id = "admission_below_five_fixture";
  await createTask(owner, `Bearer ${key.key}`, input(id)); await runVideoQueueTick();
  assert.equal(row(id).status, "failed"); assert.match(row(id).error, /最低 5 积分/);
  assert.equal(row(id).paid_started_at, 0); assert.equal(submissions, sent); assert.deepEqual(row(oldId), before);
  balance = 1000;
  db.prepare("UPDATE jimeng_accounts SET total_credit=1000,status_checked_at=? WHERE enabled=1").run(new Date().toISOString());
  await createTask(owner, `Bearer ${key.key}`, input(id)); await runVideoQueueTick();
  assert.equal(row(id).status, "failed"); assert.equal(submissions, sent);
});

test("a broken quote account does not block one paid submission on the healthy account", async () => {
  balance = 1000;
  const bad = pool.createAccount({ name: "报价异常准入夹具_超级", sessionId: "admission-broken" });
  db.prepare("UPDATE jimeng_accounts SET total_credit=1000,status_error=NULL,status_checked_at=? WHERE enabled=1").run(new Date().toISOString());
  const id = "admission_healthy_despite_broken", sent = submissions, before = row(oldId);
  await createTask(owner, `Bearer ${key.key}`, input(id)); await runVideoQueueTick();
  const deadline = Date.now() + 3000;
  while (!row(id).history_id && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(row(id).status, "running"); assert.notEqual(row(id).account_id, bad.id); assert.equal(row(id).error, "");
  assert.equal(submissions, sent + 1); assert.deepEqual(row(oldId), before);
  await createTask(owner, `Bearer ${key.key}`, input(id)); await runVideoQueueTick();
  assert.equal(submissions, sent + 1);
});
