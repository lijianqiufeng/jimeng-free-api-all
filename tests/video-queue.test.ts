import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import axios from "axios";
import models from "./fixtures/seedance-models.json";

assert.equal(process.env.JIMENG_ACCOUNT_POOL_KEY, "isolated-video-queue-test");
assert.ok(process.env.DB_PATH?.includes("cpa-video-queue-test-"));
const blocked = () => { throw Error("Unmocked network is forbidden"); };
http.request = https.request = http.get = https.get = net.connect = net.createConnection = blocked as any;
globalThis.fetch = blocked as any;
const submits: Array<{ prompt: string; token: string; history: string }> = [], modes = new Map<string, string>(), histories = new Map<string, number>();
const credits = new Map<string, number>();
let billingStatus = "Checked";
let delayedHistory = "", releaseHistory: (() => void) | undefined, historyReadStarted = false;
axios.defaults.adapter = async config => {
  const path = new URL(String(config.url)).pathname;
  if (path.endsWith("/benefit_metadata") || path.endsWith("/batch_get_user_benefit")) {
    const types = JSON.parse(String(config.data)).query_list[0].benefit_type_list;
    const data = path.endsWith("/benefit_metadata") ? { metadata_list: [{ resource_type: "aigc", resource_id: "generate_video", benefits_pay_strategy: types.map((benefit_type: string) => ({ benefit_type, unit: "second", credit_strategy: { credit_limits: [{ role: "all" }], credit_pricing_info: { min_charge_cnt: 1, credit_unit_price: String(config.headers?.Cookie).includes("fixture-poor") ? 8 : 6, original_credit_unit_price: 26 } } })) }] } : { asset_list: types.map((benefit_type: string) => ({ resource_type: "aigc", resource_id: "generate_video", benefit_type, asset_details: [{ pay_mode: "UserCredit", role: "all" }] })) };
    return { data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config };
  }

  const pathname = new URL(String(config.url)).pathname;
  const token = String(config.headers?.Cookie || "");
  const ok = (data: unknown) => ({ data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config });
  if (pathname.endsWith("/user_credit")) return ok({ credit: { gift_credit: credits.get(/(?:^|; )sessionid=([^;]+)/.exec(token)?.[1] || "") ?? (token.includes("fixture-rich") ? 100 : 50), purchase_credit: 0, vip_credit: 0 } });
  if (pathname.endsWith("/video_generate/get_common_config")) return ok({ models });
  if (pathname.endsWith("/get_common_config")) return ok({});
  if (pathname.endsWith("/user_credit_history")) return ok({ records: submits.filter(item => histories.get(item.history) === 50).map(item => ({ submit_id: item.history, history_id: `bill-${item.history}`, history_type: 2, status: billingStatus, amount: 32, origin_credit_amount: 64 })), has_more: false });
  if (pathname.endsWith("/aigc_draft/generate")) {
    const payload = JSON.parse(String(config.data)), draft = JSON.parse(payload.draft_content);
    const prompt = draft.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0].prompt;
    const history = `fixture-history-${submits.length + 1}`;
    submits.push({ prompt, token, history });
    if (modes.get(prompt) === "timeout") throw Object.assign(Error("fixture timeout"), { code: "ETIMEDOUT" });
    if (modes.get(prompt) === "4013") return { ...ok({}), data: { ret: 4013, errmsg: "fixture risk rejection" } };
    if (modes.get(prompt) === "1006") return { ...ok({}), data: { ret: 1006, errmsg: "fixture insufficient credits" } };
    histories.set(history, 20);
    return ok({ aigc_data: { history_record_id: history } });
  }
  if (pathname.endsWith("/get_history_by_ids")) {
    const history = JSON.parse(String(config.data)).history_ids[0], original = submits.find(item => item.history === history);
    if (history === delayedHistory) { historyReadStarted = true; await new Promise<void>(resolve => { releaseHistory = resolve; }); }
    assert.equal(/(?:^|; )sessionid=([^;]+)/.exec(token)?.[1], /(?:^|; )sessionid=([^;]+)/.exec(original?.token || "")?.[1], "recovery only queries the original account/history; sid_guard timestamps may change");
    return ok({ [history]: { status: histories.get(history), submit_id: history, item_list: [{ video: { transcoded_video: { origin: { video_url: "https://result.test/fixture.mp4" } } } }] } });
  }
  throw Error(`Unmocked request: ${pathname}`);
};

const { database, createApiKey, validateApiKey } = await import("../src/lib/database.ts");
const pool = await import("../src/lib/account-pool.ts");
pool.setMembershipStatusProvider(undefined);
const restarting = process.argv.includes("--recover-fixture");
let owner = 0, owner2 = 0, auth = "", auth2 = "", rich = "", poor = "";
if (!restarting) {
  const key = createApiKey("fixture one"), key2 = createApiKey("fixture two");
  owner = validateApiKey(key.key).apiKeyId!; owner2 = validateApiKey(key2.key).apiKeyId!;
  auth = `Bearer ${key.key}`; auth2 = `Bearer ${key2.key}`;
  rich = pool.createAccount({ name: "13800005777_超级", sessionId: "fixture-rich" }).id;
  poor = pool.createAccount({ name: "13800005778_超级", sessionId: "fixture-poor" }).id;
  const base = pool.createAccount({ name: "fixture_basic", sessionId: "fixture-basic" }).id;
  database.exec("CREATE TABLE canvas_tasks(id TEXT PRIMARY KEY, owner INTEGER NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, credential TEXT NOT NULL DEFAULT '', account_id TEXT NOT NULL DEFAULT '', history_id TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', deadline INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0)");
  for (let i = 0; i < 8; i++) database.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,account_id,error,deadline) VALUES(?,?,'video','jimeng-video-seedance-2.5','','failed',?,'即梦提交结果未确认；未自动重提',?)").run(`legacy_unknown_${i}`, owner, i < 4 ? rich : base, Date.now() - 1000);
}
const { createTask, queryTask, cancelTask, runVideoQueueTick } = await import("../src/api/controllers/tasks.ts");
const row = (id: string) => database.prepare("SELECT * FROM canvas_tasks WHERE id=?").get(id) as any;
const input = (id: string) => ({ id, model: "jimeng-video-seedance-2.5", prompt: id, ratio: "16:9", resolution: "720p", duration: 4, references: [] });
async function wait(id: string, status: string) {
  const deadline = Date.now() + 3000;
  while (row(id)?.status !== status && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(row(id)?.status, status);
}
async function complete(id: string) {
  histories.set(row(id).history_id, 50);
  const deadline = Date.now() + 3000;
  let response;
  do {
    database.prepare("UPDATE canvas_tasks SET checked_at=0 WHERE id=?").run(id);
    response = await queryTask(row(id).owner, id);
    if (!row(id).provider_hold) return response;
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.equal(row(id).provider_hold, 0);
  return response;
}

if (restarting) {
  for (let i = 0; i < 8; i++) {
    const legacy = row(`legacy_unknown_${i}`);
    assert.equal(legacy.provider_hold, i < 4 ? 0 : 1, "authorized exact releases survive initialization; other legacy holds remain");
    assert.equal(legacy.status, "failed");
    assert.equal(legacy.error, "即梦提交结果未确认；未自动重提");
  }
  assert.equal(row("restart_preparing_fixture").status, "queued");
  assert.equal(row("restart_preparing_fixture").provider_hold, 0);
  assert.equal(row("restart_paid_fixture").status, "uncertain");
  assert.equal(row("restart_paid_fixture").provider_hold, 1);
  assert.ok(row("restart_paid_fixture").credential);
  assert.equal(row("restart_canceled_preparing_fixture").status, "canceled");
  assert.equal(row("restart_canceled_preparing_fixture").provider_status, "canceled");
  assert.equal(row("restart_canceled_preparing_fixture").provider_hold, 0);
  assert.equal(row("restart_canceled_preparing_fixture").credential, "");
  assert.equal(row("restart_canceled_preparing_fixture").paid_started_at, 0);
  assert.equal(row("restart_canceled_preparing_fixture").history_id, "");
  database.close();
} else {
  after(() => database.close());
  test("durable queue serializes uploads, pipelines accepted histories and never repeats an unknown paid request", async () => {
    assert.equal(database.prepare("SELECT count(*) AS n FROM canvas_tasks WHERE provider_hold=1").get().n, 8);
    const first = "queue_legacy_available_fixture";
    const oldName = pool.getAccount(poor).name;
    pool.updateAccount(poor, { name: "13800005779_超级" });
    await createTask(owner, auth, input(first)); await runVideoQueueTick(); await wait(first, "running");
    assert.equal(JSON.parse(row(first).quote_json).accountId, poor);
    assert.equal(JSON.parse(row(first).quote_json).accountName, "13800005779_超级");
    assert.equal(JSON.parse(row(first).quote_json).accountTier, "super");
    pool.updateAccount(poor, { name: oldName });
    assert.equal(JSON.parse(row(first).quote_json).accountTier, "super", "later renaming cannot change the original paid account tier");
    assert.equal(JSON.parse(row(first).quote_json).estimatedCredits, 32);
    assert.equal(JSON.parse(row(first).quote_json).taskId, first);
    assert.equal(row(first).account_id, poor, "four unknown legacy rows hold only their original account");
    const queued = "queue_legacy_waiting_fixture";
    assert.equal((await createTask(owner2, auth2, input(queued))).body.status, "queued");
    const file = row(queued).payload_path;
    assert.ok(existsSync(file)); assert.ok(!readFileSync(file, "utf8").includes(queued));
    const before = submits.length;
    assert.equal(cancelTask(owner2, queued).body.providerHold, false);
    await runVideoQueueTick(); assert.equal(submits.length, before);
    assert.equal((await createTask(owner2, auth2, input(queued))).body.status, "canceled");
    const canceledFirst = "queue_cancel_before_create_fixture";
    assert.equal(cancelTask(owner, canceledFirst).body.providerHold, false);
    assert.equal((await createTask(owner, auth, input(canceledFirst))).status, 409);
    assert.equal(submits.length, before);
    assert.equal(cancelTask(owner + 99, first).status, 404);
    assert.equal(cancelTask(owner, first).body.providerHold, true);
    assert.ok(row(first).credential);
    pool.updateAccount(poor, { name: "13800005778_高级" });
    const unknownAdvanced = "queue_old_advanced_uncertain_fixture";
    const legacyAdvanced = pool.createAccount({ name: "13800005781_高级", sessionId: "fixture-old-advanced" }).id;
    database.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,account_id,credential,provider_hold,paid_started_at,deadline) VALUES(?,?,'video','jimeng-video-seedance-2.5','legacy','uncertain',?,?,1,?,0)").run(unknownAdvanced, owner, legacyAdvanced, pool.encrypt("fixture-old-advanced"), Date.now() - 1000);
    const unknownBefore = { ...row(unknownAdvanced) }, paidBefore = submits.length;
    await queryTask(owner, unknownAdvanced); await runVideoQueueTick();
    assert.deepEqual(row(unknownAdvanced), { ...unknownBefore, error: "即梦提交回执仍未确认；账号保持占用，未自动重提" });
    assert.equal(submits.length, paidBefore, "old advanced unknown receipts never switch accounts or replay the paid POST");
    pool.setAccountEnabled(poor, false);
    const completedCanceled = await complete(first);
    assert.equal(completedCanceled.body.status, "canceled"); assert.equal(completedCanceled.body.providerHold, false);
    assert.equal(completedCanceled.body.providerStatus, "succeeded");
    assert.ok(!("data" in completedCanceled.body)); assert.equal(row(first).credential, "");
    assert.equal(row(first).account_id, poor, "old advanced history still settles through its original account");
    assert.equal(row(unknownAdvanced).provider_hold, 1);
    pool.updateAccount(poor, { name: oldName });
    pool.setAccountEnabled(poor, true);

    // Fixture-only manual confirmation: production unknown legacy rows are never auto-released.
    const legacyBefore = database.prepare("SELECT * FROM canvas_tasks WHERE id=?").get("legacy_unknown_0");
    for (let i = 0; i < 4; i++) database.prepare("UPDATE canvas_tasks SET provider_hold=0 WHERE id=? AND provider_hold=1 AND status='failed'").run(`legacy_unknown_${i}`);
    assert.deepEqual(row("legacy_unknown_0"), { ...legacyBefore, provider_hold: 0 }, "release changes only the explicitly authorized hold bit");
    assert.equal(database.prepare("SELECT count(*) AS n FROM canvas_tasks WHERE id IN ('legacy_unknown_4','legacy_unknown_5','legacy_unknown_6','legacy_unknown_7') AND provider_hold=1").get().n, 4);
    assert.equal((await queryTask(owner, "legacy_unknown_0")).body.providerHold, false);
    const a = "queue_parallel_one_fixture", b = "queue_parallel_two_fixture", c = "queue_parallel_three_fixture";
    pool.grantAccountLease(owner, rich); pool.grantAccountLease(owner2, poor);
    await Promise.all([createTask(owner, auth, input(a), rich), createTask(owner2, auth2, input(b), poor), createTask(owner, auth, input(a), rich)]);
    await runVideoQueueTick(); await wait(a, "running"); await wait(b, "running");
    const uploadLocks = ["queue_upload_lock_rich_fixture", "queue_upload_lock_poor_fixture"];
    for (const [index, accountId] of [rich, poor].entries()) database.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,account_id,provider_status,provider_hold,deadline) VALUES(?,?,'video','jimeng-video-seedance-2.5','fixture','preparing',?,'preparing',1,?)").run(uploadLocks[index], owner, accountId, Date.now() + 30_000);
    await createTask(owner, auth, input(c));
    database.prepare("UPDATE canvas_tasks SET deadline=? WHERE id=? AND status='queued'").run(Date.now() + 1000, c);
    assert.deepEqual(new Set([row(a).account_id, row(b).account_id]), new Set([rich, poor]));
    assert.equal(row(c).status, "queued");
    assert.equal(submits.filter(item => item.prompt === a).length, 1);
    assert.equal((await createTask(owner + 1, auth2, input(a))).status, 409);
    assert.equal((await createTask(owner, auth, { ...input(a), prompt: "other" })).status, 409);
    delayedHistory = row(a).history_id;
    const readDeadline = Date.now() + 1000;
    do {
      database.prepare("UPDATE canvas_tasks SET checked_at=0 WHERE id=?").run(a);
      await Promise.race([runVideoQueueTick(), new Promise((_, reject) => setTimeout(() => reject(Error("a slow read must not block queue admission")), 500))]);
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (!historyReadStarted && Date.now() < readDeadline);
    assert.equal(historyReadStarted, true);
    const third = pool.createAccount({ name: "13800005780_超级", sessionId: "fixture-third", enabled: false }).id;
    await pool.refreshStatus(third);
    await runVideoQueueTick(); assert.equal(row(c).status, "queued", "disabled new accounts add no slot");
    pool.setAccountEnabled(third, true);
    database.prepare("UPDATE jimeng_accounts SET cooldown_until=? WHERE id=?").run(new Date(Date.now() + 60_000).toISOString(), third);
    await runVideoQueueTick(); assert.equal(row(c).status, "queued", "cooling new accounts add no slot");
    database.prepare("UPDATE jimeng_accounts SET cooldown_until=NULL,total_credit=4 WHERE id=?").run(third);
    await runVideoQueueTick(); assert.equal(row(c).status, "queued", "under-five-credit accounts add no slot");
    database.prepare("UPDATE jimeng_accounts SET total_credit=5 WHERE id=?").run(third);
    await runVideoQueueTick(); assert.equal(row(c).status, "queued", "five credits cannot cover the official quote; preparing accounts keep the task queued");
    database.prepare("UPDATE jimeng_accounts SET total_credit=50 WHERE id=?").run(third);
    await runVideoQueueTick(); await wait(c, "running");
    assert.ok(row(c).deadline > Date.now() + 29 * 60_000, "dispatch starts an independent execution budget");
    assert.equal(row(c).account_id, third, "dynamic third account starts without changing code, total config or restarting");
    delayedHistory = ""; releaseHistory!();
    assert.equal(new Set([row(a).account_id, row(b).account_id, row(c).account_id]).size, 3);
    const fourth = "queue_fourth_dynamic_fixture";
    await createTask(owner, auth, input(fourth), rich); await runVideoQueueTick(); assert.equal(row(fourth).status, "queued");
    for (const id of uploadLocks) database.prepare("UPDATE canvas_tasks SET status='failed',provider_status='failed',provider_hold=0 WHERE id=?").run(id);
    const acceptedA = { ...row(a) };
    await runVideoQueueTick(); await wait(fourth, "running");
    assert.equal(row(fourth).account_id, row(a).account_id);
    assert.equal(histories.get(row(a).history_id), 20, "the next accepted task does not wait for the original video to finish");
    assert.equal(row(a).history_id, acceptedA.history_id); assert.equal(row(a).credential, acceptedA.credential);
    assert.equal(row(a).quote_json, acceptedA.quote_json); assert.equal(row(a).provider_hold, 1);
    assert.equal(pool.videoAccountUsage().get(rich)?.reservedCredits, JSON.parse(row(a).quote_json).estimatedCredits + JSON.parse(row(fourth).quote_json).estimatedCredits);
    await complete(a);
    await complete(b);
    await complete(c);
    await complete(fourth); pool.setAccountEnabled(third, false);

    const shortage = "queue_insufficient_quote_fixture", beforeShortage = submits.length;
    await createTask(owner, auth, { ...input(shortage), duration: 20 }); await runVideoQueueTick(); await wait(shortage, "failed");
    assert.match(row(shortage).error, /最高余额 100.*至少 120.*未提交生成/);
    assert.equal(row(shortage).paid_started_at, 0); assert.equal(submits.length, beforeShortage);
    const enough = "queue_sufficient_quote_fixture";
    await createTask(owner, auth, { ...input(enough), duration: 12 }); await runVideoQueueTick(); await wait(enough, "running");
    assert.equal(row(enough).account_id, rich, "the idle account with 50 credits cannot cover its 96-credit quote");
    await complete(enough);
    const fixed = "queue_requested_shortage_fixture", beforeFixed = submits.length;
    pool.grantAccountLease(owner, poor);
    await createTask(owner, auth, { ...input(fixed), duration: 12 }, poor); await runVideoQueueTick(); await wait(fixed, "failed");
    assert.equal(submits.length, beforeFixed, "a requested insufficient account cannot silently switch to another account");
    const fallen = "queue_credit_fallen_fixture";
    credits.set("fixture-rich", 10);
    await createTask(owner, auth, { ...input(fallen), duration: 16 }); await runVideoQueueTick(); await wait(fallen, "failed");
    assert.equal(row(fallen).paid_started_at, 0); assert.equal(row(fallen).provider_hold, 0);
    assert.equal(submits.length, beforeFixed, "a falling balance is rechecked before the paid POST");
    credits.delete("fixture-rich"); await pool.refreshStatus(rich);
    const rejectedCredit = "queue_rejected_credit_fixture";
    modes.set(rejectedCredit, "1006");
    await createTask(owner, auth, input(rejectedCredit)); await runVideoQueueTick(); await wait(rejectedCredit, "failed");
    await runVideoQueueTick(); await createTask(owner, auth, input(rejectedCredit));
    assert.match(row(rejectedCredit).error, /1006.*未自动重提/);
    assert.equal(row(rejectedCredit).provider_hold, 0);
    assert.equal(submits.filter(item => item.prompt === rejectedCredit).length, 1);
    database.prepare("UPDATE jimeng_accounts SET cooldown_until=NULL WHERE id=?").run(row(rejectedCredit).account_id);

    // Explicit operator total caps remain enforceable; only fixture reservations, no paid dispatch.
    for (const id of ["cap_one_fixture", "cap_two_fixture", "cap_three_fixture"]) database.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,deadline) VALUES(?,?,'video','jimeng-video-seedance-2.5','fixture','queued',?)").run(id, owner, Date.now() + 30_000);
    const existingActive = [...pool.videoAccountUsage().values()].reduce((sum, usage) => sum + usage.active, 0);
    assert.ok(pool.reserveVideoAccount("cap_one_fixture", 1, existingActive + 1));
    assert.equal(pool.reserveVideoAccount("cap_two_fixture", 1, existingActive + 1), undefined);
    assert.ok(pool.reserveVideoAccount("cap_two_fixture", 1, existingActive + 2));
    assert.equal(pool.reserveVideoAccount("cap_three_fixture", 1, existingActive + 2), undefined);
    for (const id of ["cap_one_fixture", "cap_two_fixture", "cap_three_fixture"]) database.prepare("UPDATE canvas_tasks SET status='failed',provider_hold=0,credential='' WHERE id=?").run(id);

    const timeout = "queue_uncertain_paid_fixture";
    modes.set(timeout, "timeout"); await createTask(owner, auth, input(timeout)); await runVideoQueueTick(); await wait(timeout, "uncertain");
    const bound = row(timeout).account_id, count = submits.length;
    database.prepare("UPDATE canvas_tasks SET deadline=0 WHERE id=?").run(timeout);
    await queryTask(owner, timeout); cancelTask(owner, timeout); await runVideoQueueTick();
    assert.equal(row(timeout).provider_hold, 1); assert.ok(row(timeout).credential); assert.equal(row(timeout).account_id, bound);
    assert.equal(submits.length, count); assert.equal((await createTask(owner, auth, input(timeout))).body.status, "canceled");
    const rejected = "queue_rejected_4013_fixture";
    modes.set(rejected, "4013"); await createTask(owner, auth, input(rejected)); await runVideoQueueTick(); await wait(rejected, "failed");
    assert.notEqual(row(rejected).account_id, bound); assert.equal(row(rejected).provider_hold, 0); assert.equal(row(rejected).credential, "");
    assert.equal(submits.filter(item => item.prompt === rejected).length, 1);

    const expired = "queue_expired_unpaid_fixture";
    database.prepare("UPDATE api_keys SET enabled=0 WHERE id=?").run(owner2);
    database.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,deadline) VALUES(?,?,'video','jimeng-video-seedance-2.5','fixture','queued',0)").run(expired, owner);
    await runVideoQueueTick(); await wait(expired, "failed");
    assert.equal(row(expired).paid_started_at, 0); assert.equal(row(expired).provider_hold, 0);

    const corrupt = "queue_invalid_payload_fixture", safeBefore = submits.length;
    await createTask(owner, auth, input(corrupt));
    writeFileSync(row(corrupt).payload_path, pool.encrypt("{invalid fixture input"));
    database.prepare("UPDATE jimeng_accounts SET cooldown_until=NULL WHERE id=?").run(row(rejected).account_id);
    await runVideoQueueTick(); await wait(corrupt, "failed");
    assert.equal(submits.length, safeBefore); assert.equal(row(corrupt).provider_hold, 0); assert.equal(row(corrupt).paid_started_at, 0);

    const stale = "queue_stale_credit_fixture";
    database.prepare("UPDATE jimeng_accounts SET status_error='fixture stale credit' WHERE id=?").run(row(rejected).account_id);
    await createTask(owner, auth, input(stale)); await runVideoQueueTick();
    assert.equal(row(stale).status, "queued"); assert.equal(submits.length, safeBefore);
    cancelTask(owner, stale);

    const billingPending = "queue_billing_pending_fixture";
    database.prepare("UPDATE jimeng_accounts SET status_error=NULL,cooldown_until=NULL WHERE id=?").run(row(rejected).account_id);
    const usageBeforePending = pool.videoAccountUsage();
    await createTask(owner, auth, input(billingPending));await runVideoQueueTick();await wait(billingPending,"running");
    const pendingTask = row(billingPending), previousUsage = usageBeforePending.get(pendingTask.account_id) || { active: 0, rendering: 0, billingPending: 0, reservedCredits: 0 };
    assert.equal(JSON.parse(pendingTask.quote_json).estimatedCredits, 32);
    const acceptedUsage = pool.videoAccountUsage().get(pendingTask.account_id)!;
    assert.equal(acceptedUsage.active, previousUsage.active); assert.equal(acceptedUsage.rendering, previousUsage.rendering + 1);
    assert.equal(acceptedUsage.reservedCredits, previousUsage.reservedCredits + 32, "accepted rendering frees the upload lock while keeping its original frozen funds");
    histories.set(row(billingPending).history_id,50);billingStatus="Init";
    database.prepare("UPDATE canvas_tasks SET checked_at=0 WHERE id=?").run(billingPending);
    const pendingBill=await queryTask(owner,billingPending), pendingMedia=row(billingPending).result;
    assert.equal(pendingBill.body.status,"succeeded");assert.ok(pendingBill.body.data[0].url);assert.equal(pendingBill.body.billingPending,true);assert.equal(row(billingPending).provider_hold,1);assert.ok(row(billingPending).credential);assert.equal(pendingBill.body.creditsUsed,undefined);
    assert.equal(row(billingPending).credential, pendingTask.credential); assert.equal(row(billingPending).quote_json, pendingTask.quote_json);
    const pendingUsage = pool.videoAccountUsage().get(pendingTask.account_id)!;
    assert.equal(pendingUsage.active, previousUsage.active); assert.equal(pendingUsage.rendering, previousUsage.rendering);
    assert.equal(pendingUsage.billingPending, previousUsage.billingPending + 1); assert.equal(pendingUsage.reservedCredits, previousUsage.reservedCredits + 32, "confirmed success moves rendering to billing-pending without releasing its original frozen credits");
    const beforeBillingRestart=submits.length;
    // Restart in a second isolated process against this same fixture DB.
    database.prepare("UPDATE api_keys SET enabled=0").run();
    const preparing = "restart_preparing_fixture", paid = "restart_paid_fixture", canceledPreparing = "restart_canceled_preparing_fixture";
    for (const [id, status, paidAt] of [[preparing, "preparing", 0], [paid, "submitting", Date.now()], [canceledPreparing, "canceled", 0]] as const) {
      database.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,credential,account_id,payload_path,provider_hold,paid_started_at,deadline) VALUES(?,?,'video','jimeng-video-seedance-2.5','fixture',?,?,?,'fixture-encrypted-input',1,?,?)").run(id, owner, status, pool.encrypt("fixture-rich"), rich, paidAt, Date.now() + 30_000);
    }
    database.prepare("UPDATE canvas_tasks SET provider_status='preparing' WHERE id=?").run(canceledPreparing);
    const originalQuote = { taskId: paid, accountId: rich, estimatedCredits: 32, basis: "official-estimate" };
    database.prepare("UPDATE canvas_tasks SET quote_json=? WHERE id IN (?,?)").run(JSON.stringify(originalQuote), preparing, paid);
    assert.equal((await queryTask(owner, preparing)).body.quote, undefined, "unpaid preparing quote is internal and cannot bind the API ledger");
    assert.deepEqual((await queryTask(owner, paid)).body.quote, originalQuote);
    const restart = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--recover-fixture"], { env: process.env, encoding: "utf8", timeout: 10_000 });
    assert.equal(restart.status, 0, restart.stderr);
    assert.equal(submits.length, beforeBillingRestart, "restart and timeout never replay the paid POST");
    assert.equal(row(preparing).status, "queued"); assert.equal(row(paid).status, "uncertain");
    assert.equal(row(canceledPreparing).status, "canceled"); assert.equal(row(canceledPreparing).provider_hold, 0); assert.equal(row(canceledPreparing).credential, "");
    assert.equal((await queryTask(owner, preparing)).body.quote, undefined, "unpaid restart cannot expose the previous account quote");
    assert.deepEqual((await queryTask(owner, paid)).body.quote, originalQuote);
    assert.deepEqual((await queryTask(owner, paid)).body.quote, originalQuote, "paid receipt replay only reads the same frozen quote");
    assert.ok(!row(paid).history_id); assert.equal(row(paid).provider_hold, 1);
    assert.equal(row("legacy_unknown_0").provider_hold, 0);
    assert.equal((await queryTask(owner, "legacy_unknown_0")).body.status, "failed");
    assert.equal(submits.length, beforeBillingRestart);
    assert.equal(row(billingPending).result,pendingMedia);assert.equal(row(billingPending).provider_hold,1);assert.ok(row(billingPending).credential);
    billingStatus="Checked";database.prepare("UPDATE canvas_tasks SET checked_at=0 WHERE id=?").run(billingPending);
    const settledBill=await queryTask(owner,billingPending);assert.equal(settledBill.body.creditsUsed,32);assert.equal(settledBill.body.billing.amount,32);assert.equal(row(billingPending).provider_hold,0);assert.equal(row(billingPending).credential,"");assert.equal(row(billingPending).result,pendingMedia);assert.equal(submits.length,beforeBillingRestart);
  });
}
