import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
process.env.JIMENG_ACCOUNT_CREDIT_FLOORS = '{"protected":56540}';
const pool = await import("../src/lib/account-pool.ts");
const floor = await import("../src/lib/credit-floor.ts");
const db = new Database(process.env.DB_PATH!);
const account = pool.createAccount({ name: "fixture_超级", sessionId: "fixture-only-floor-session" });
db.prepare("UPDATE jimeng_accounts SET id='protected',total_credit=56640,status_checked_at=? WHERE id=?").run(new Date().toISOString(), account.id);
test("floor excludes owned-away credits and preserves raw balances", () => {
    assert.equal(floor.spendableJimengCredits("protected", 92334), 35794);
    assert.equal(floor.spendableJimengCredits("protected", 56540), 0);
    assert.equal(floor.spendableJimengCredits("protected", 56539), 0);
    assert.equal(floor.spendableJimengCredits("protected", null), null);
    assert.equal(floor.spendableJimengCredits("other", 100), 100);
    assert.equal(pool.getAccount("protected").status.totalCredit, 56640);
});
test("funded quoted video is admitted; exact boundary or insufficient quote is rejected", () => {
    assert.equal(pool.selectAccount("round_robin", "jimeng-video-seedance-2.5", true, 1, new Map([["protected", 100]])).account.id, "protected");
    assert.throws(() => pool.selectAccount("round_robin", "jimeng-video-seedance-2.5", true, 1, new Map([["protected", 101]])));
    db.prepare("UPDATE jimeng_accounts SET total_credit=56540 WHERE id='protected'").run();
    assert.throws(() => pool.selectAccount("round_robin", "jimeng-video-seedance-2.5", true, 1, new Map([["protected", 5]])));
    db.prepare("UPDATE jimeng_accounts SET total_credit=56640 WHERE id='protected'").run();
});
test("unknown-cost paid routes cannot consume protected points; verified free routing remains", () => {
    for (const model of ["jimeng-8k", "jimeng-outpaint", "jimeng-image-5.0-pro"]) assert.throws(() => pool.selectAccount("round_robin", model, false));
    assert.equal(pool.selectAccount("round_robin", "jimeng-image-5.0-lite", false).account.id, "protected");
    assert.equal(pool.readAccountSessionById("protected"), "fixture-only-floor-session");
});
test("other in-flight frozen quotes and unknown holds remain protected", () => {
    db.exec("CREATE TABLE IF NOT EXISTS canvas_tasks(id TEXT,kind TEXT,account_id TEXT,status TEXT,provider_status TEXT,provider_hold INTEGER,paid_started_at INTEGER,history_id TEXT,result TEXT,quote_json TEXT)");
    db.prepare("INSERT INTO canvas_tasks VALUES('held','video','protected','running','running',1,1,'history','',?)").run(JSON.stringify({taskId:"held",accountId:"protected",estimatedCredits:80}));
    assert.throws(() => pool.selectAccount("round_robin", "jimeng-video-seedance-2.5", true, 1, new Map([["protected", 21]])));
    assert.equal(pool.selectAccount("round_robin", "jimeng-video-seedance-2.5", true, 1, new Map([["protected", 20]])).account.id,"protected");
    db.prepare("UPDATE canvas_tasks SET quote_json=NULL WHERE id='held'").run();
    assert.throws(() => pool.selectAccount("round_robin", "jimeng-video-seedance-2.5", true, 1, new Map([["protected", 5]])));
});
test("invalid floor configuration fails closed", () => {
    for(const value of ["null","[]",'{"protected":-1}','{"protected":"56540"}','{"bad id":1}'])assert.throws(()=>floor.parseJimengCreditFloors(value));
});
