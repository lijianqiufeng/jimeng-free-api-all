import assert from "node:assert/strict";
import { after, test } from "node:test";
process.env.JIMENG_ACCOUNT_PRIORITY = JSON.stringify({ schema: "jimeng-account-priority-v1", revision: 1, primaryAccountId: "temporary", fallbackAccountId: "owned", primaryUntil: "2026-11-28T16:00:00.000Z" });
process.env.JIMENG_ACCOUNT_CREDIT_FLOORS = '{"temporary":56540}';
const clock = Date.now, cutoff = Date.parse("2026-11-28T16:00:00.000Z");
let time = cutoff - 60_000;
Date.now = () => time;
const { database: db, createApiKey, validateApiKey } = await import("../src/lib/database.ts");
const pool = await import("../src/lib/account-pool.ts");
const { accountPriorityReceipt, assertNewAccountAllowed } = await import("../src/lib/account-priority.ts");
for (const [id, balance] of [["temporary", 56640], ["owned", 90000], ["third", 100000]] as const) {
    const account = pool.createAccount({ name: id + "_超级", sessionId: "fixture-" + id });
    db.prepare("UPDATE jimeng_accounts SET id=?,total_credit=?,status_checked_at=? WHERE id=?").run(id, balance, new Date(time).toISOString(), account.id);
}
const { key } = createApiKey("priority-fixture"), owner = validateApiKey(key).apiKeyId!;
await import("../src/api/controllers/tasks.ts");
const model = "jimeng-video-seedance-2.5", quotes = new Map([["temporary", 80], ["owned", 80], ["third", 80]]);
const select = () => pool.selectAccount("round_robin", model, true, 1, quotes).account.id;
const enqueue = (id: string) => db.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,deadline) VALUES(?,?,'video',?,'','queued',?)").run(id, owner, model, time + 60000);
after(() => { Date.now = clock; db.close(); });

test("funded primary outranks larger balances, while busy primary queues instead of spending owned credits", () => {
    assert.equal(select(), "temporary");
    db.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,account_id,provider_hold,paid_started_at,quote_json,deadline) VALUES('busy',?,'video',?,'','submitting','temporary',1,1,?,?)").run(owner, model, JSON.stringify({ taskId: "busy", accountId: "temporary", estimatedCredits: 10 }), time + 60000);
    enqueue("wait_for_primary");
    assert.equal(pool.reserveVideoAccount("wait_for_primary", 1, Infinity, quotes), undefined);
    assert.equal((db.prepare("SELECT status,account_id FROM canvas_tasks WHERE id='wait_for_primary'").get() as any).status, "queued");
    db.prepare("DELETE FROM canvas_tasks WHERE id IN ('busy','wait_for_primary')").run();
});
test("deducts floor and exact in-flight quotes; only confirmed shortage falls back", () => {
    db.prepare("UPDATE jimeng_accounts SET total_credit=56619 WHERE id='temporary'").run();
    assert.equal(select(), "owned");
    db.prepare("UPDATE jimeng_accounts SET total_credit=56620 WHERE id='temporary'").run();
    assert.equal(select(), "temporary");
    db.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,account_id,provider_status,provider_hold,paid_started_at,history_id,quote_json,deadline) VALUES('hold',?,'video',?,'','running','temporary','running',1,1,'original-history',?,?)").run(owner, model, JSON.stringify({ taskId: "hold", accountId: "temporary", estimatedCredits: 1 }), time + 60000);
    assert.equal(select(), "owned");
    db.prepare("UPDATE canvas_tasks SET quote_json=NULL WHERE id='hold'").run();
    assert.throws(select, "unknown primary reservation cannot silently spend fallback credits");
    assert.equal(pool.readAccountSessionById("temporary"), "fixture-temporary");
    db.prepare("DELETE FROM canvas_tasks WHERE id='hold'").run();
    db.prepare("UPDATE jimeng_accounts SET total_credit=56640,status_error='unconfirmed' WHERE id='temporary'").run();
    assert.throws(select);
    db.prepare("UPDATE jimeng_accounts SET status_error=NULL WHERE id='temporary'").run();
});
test("unquoted paid operations cannot use protected primary; known free eligibility is retained", () => {
    assert.equal(pool.selectAccount("round_robin", "jimeng-8k", false).account.id, "owned");
    assert.equal(pool.selectAccount("round_robin", "jimeng-image-5.0-lite", false, Infinity, undefined, new Set(["temporary"])).account.id, "temporary");
    assert.equal(pool.selectAccount("round_robin", "jimeng-image-5.0-lite", false, Infinity, undefined, new Set(["owned"])).account.id, "owned");
    assert.equal(pool.getAccount("temporary").status.totalCredit, 56640);
});
test("exact cutoff permits only owned account; original account identity and credentials remain readable", () => {
    time = cutoff;
    for (const id of ["temporary", "owned", "third"]) db.prepare("UPDATE jimeng_accounts SET status_checked_at=? WHERE id=?").run(new Date(time).toISOString(), id);
    assert.equal(select(), "owned");
    assert.throws(() => assertNewAccountAllowed("temporary"));
    assert.throws(() => assertNewAccountAllowed("third"));
    assert.equal(pool.selectAccount("round_robin", "jimeng-image-5.0-lite", false, Infinity, undefined, new Set(["third"])).account.id, "third", "other verified free rights retain their original account pool");
    assert.throws(() => pool.selectAccount("round_robin", "jimeng-image-5.0-lite", false, Infinity, undefined, new Set(["temporary"])));
    assert.equal(pool.readAccountSessionById("temporary"), "fixture-temporary");
    assert.equal(pool.selectAccountById("temporary").account.id, "temporary", "read/status binding is independent of new submission policy");
    assert.deepEqual(JSON.parse((db.prepare("SELECT receipt_json FROM jimeng_account_priority WHERE id=1").get() as any).receipt_json), accountPriorityReceipt);
    db.prepare("UPDATE jimeng_accounts SET enabled=0 WHERE id='owned'").run();
    assert.throws(select, "no third-account fallback after cutoff");
});
