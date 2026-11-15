import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import axios from "axios";
import models from "./fixtures/seedance-models.json";
const cutoff = Date.parse("2026-11-28T16:00:00.000Z");
mock.timers.enable({ apis: ["Date"], now: cutoff - 60_000 });
process.env.JIMENG_ACCOUNT_PRIORITY = JSON.stringify({ schema: "jimeng-account-priority-v1", revision: 1, primaryAccountId: "temporary", fallbackAccountId: "owned", primaryUntil: new Date(cutoff).toISOString() });
process.env.JIMENG_ACCOUNT_CREDIT_FLOORS = '{"temporary":56540}';
const pool = await import("../src/lib/account-pool.ts");
pool.setMembershipStatusProvider(undefined);
const { database: db, createApiKey, validateApiKey } = await import("../src/lib/database.ts");
for (const id of ["temporary", "owned"]) {
    const account = pool.createAccount({ name: id + "_超级", sessionId: "fixture-" + id });
    db.prepare("UPDATE jimeng_accounts SET id=? WHERE id=?").run(id, account.id);
}
let temporaryCredits = 56564, crossDeadline = false;
const sends: string[] = [];
axios.defaults.adapter = async config => {
    const path = new URL(String(config.url)).pathname, primary = String(config.headers?.Cookie).includes("fixture-temporary");
    const ok = (data: unknown) => ({ data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config });
    if (path.endsWith("/user_credit")) {
        if (crossDeadline && primary && (db.prepare("SELECT status FROM canvas_tasks WHERE id='priority_cutoff_race'").get() as any)?.status === "preparing") mock.timers.setTime(cutoff);
        return ok({ credit: { gift_credit: primary ? temporaryCredits : 90000, purchase_credit: 0, vip_credit: 0 } });
    }
    if (path.endsWith("/video_generate/get_common_config")) return ok({ models });
    if (path.endsWith("/get_common_config")) return ok({});
    if (path.endsWith("/benefit_metadata") || path.endsWith("/batch_get_user_benefit")) {
        const types = JSON.parse(String(config.data)).query_list[0].benefit_type_list;
        return ok(path.endsWith("/benefit_metadata") ? { metadata_list: [{ resource_type: "aigc", resource_id: "generate_video", benefits_pay_strategy: types.map((benefit_type: string) => ({ benefit_type, unit: "second", credit_strategy: { credit_limits: [{ role: "all" }], credit_pricing_info: { min_charge_cnt: 1, credit_unit_price: 6, original_credit_unit_price: 26 } } })) }] } : { asset_list: types.map((benefit_type: string) => ({ resource_type: "aigc", resource_id: "generate_video", benefit_type, asset_details: [{ pay_mode: "UserCredit", role: "all" }] })) });
    }
    if (path.endsWith("/aigc_draft/generate")) { sends.push(primary ? "temporary" : "owned"); return ok({ aigc_data: { history_record_id: "priority-history-" + sends.length } }); }
    if (path.endsWith("/get_history_by_ids")) { const id = JSON.parse(String(config.data)).history_ids[0]; return ok({ [id]: { status: 20 } }); }
    throw Error("Unmocked request: " + path);
};
const { key } = createApiKey("priority-dispatch-fixture"), owner = validateApiKey(key).apiKeyId!;
const { createTask, runVideoQueueTick } = await import("../src/api/controllers/tasks.ts");
const input = (id: string) => ({ id, model: "jimeng-video-seedance-2.5", prompt: id, ratio: "16:9", resolution: "720p", duration: 4, references: [] });
const row = (id: string) => db.prepare("SELECT * FROM canvas_tasks WHERE id=?").get(id) as any;
async function wait(id: string, status: string) { for (let i=0;i<400&&row(id)?.status!==status;i++) await new Promise(done=>setTimeout(done,10)); assert.equal(row(id)?.status,status); }
after(() => { mock.timers.reset(); db.close(); });

test("durable queue spends the protected primary first, freezes the real quote, then uses owned funds", async () => {
    await createTask(owner, `Bearer ${key}`, input("priority_first_fixture")); await runVideoQueueTick(); await wait("priority_first_fixture", "running");
    assert.deepEqual(sends, ["temporary"]);
    assert.equal(row("priority_first_fixture").credit_before, 56564);
    assert.equal(JSON.parse(row("priority_first_fixture").quote_json).estimatedCredits, 24);
    const original = row("priority_first_fixture");
    await createTask(owner, `Bearer ${key}`, input("priority_next_fixture")); await runVideoQueueTick(); await wait("priority_next_fixture", "running");
    assert.deepEqual(sends, ["temporary", "owned"]);
    assert.deepEqual(row("priority_first_fixture"), { ...original, checked_at: row("priority_first_fixture").checked_at }, "only original-task polling observation may advance");
    assert.equal(pool.getAccount("temporary").status.totalCredit, 56564, "raw balance snapshot is never reduced by the floor");
});
test("crossing the cutoff during preparation cannot pay; an original accepted task stays bound and idempotent", async () => {
    db.prepare("UPDATE canvas_tasks SET provider_hold=0,provider_status='succeeded',status='succeeded' WHERE id IN ('priority_first_fixture','priority_next_fixture')").run();
    temporaryCredits = 56640;
    await pool.refreshStatus("temporary");
    crossDeadline = true;
    await createTask(owner, `Bearer ${key}`, input("priority_cutoff_race")); await runVideoQueueTick(); await wait("priority_cutoff_race", "failed");
    assert.equal(row("priority_cutoff_race").paid_started_at, 0);
    assert.equal(row("priority_cutoff_race").account_id, "temporary");
    assert.deepEqual(sends, ["temporary", "owned"]);
    const original = row("priority_first_fixture");
    assert.equal((await createTask(owner, `Bearer ${key}`, input("priority_first_fixture"))).status, 200);
    assert.deepEqual(row("priority_first_fixture"), original);
    await assert.rejects(createTask(owner, `Bearer ${key}`, input("priority_explicit_expired"), "temporary"), /停止接收新任务/);
    assert.equal(pool.readAccountSessionById("temporary"), "fixture-temporary");
});
