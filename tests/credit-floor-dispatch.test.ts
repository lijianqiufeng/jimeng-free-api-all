import assert from "node:assert/strict";
import { after, test } from "node:test";
import axios from "axios";
import models from "./fixtures/seedance-models.json";
process.env.JIMENG_ACCOUNT_CREDIT_FLOORS = '{"protected":56540}';
const pool = await import("../src/lib/account-pool.ts");
pool.setMembershipStatusProvider(undefined);
const { database, createApiKey, validateApiKey } = await import("../src/lib/database.ts");
const original = pool.createAccount({ name: "fixture_超级", sessionId: "fixture-protected-session" });
database.prepare("UPDATE jimeng_accounts SET id='protected' WHERE id=?").run(original.id);
const { key } = createApiKey("floor-fixture"); const owner = validateApiKey(key).apiKeyId!;
let credit = 56588, sends = 0, creditReads = 0, dropOnSecondRead = false;
axios.defaults.adapter = async config => {
    const path = new URL(String(config.url)).pathname;
    const ok = (data: unknown) => ({ data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config });
    if (path.endsWith("/user_credit")) { creditReads++; return ok({ credit: { gift_credit: dropOnSecondRead && creditReads > 1 ? 56563 : credit, purchase_credit: 0, vip_credit: 0 } }); }
    if (path.endsWith("/benefit_metadata") || path.endsWith("/batch_get_user_benefit")) {
        const types = JSON.parse(String(config.data)).query_list[0].benefit_type_list;
        return ok(path.endsWith("/benefit_metadata") ? { metadata_list: [{ resource_type: "aigc", resource_id: "generate_video", benefits_pay_strategy: types.map((benefit_type: string) => ({ benefit_type, unit: "second", credit_strategy: { credit_limits: [{ role: "all" }], credit_pricing_info: { min_charge_cnt: 1, credit_unit_price: 6, original_credit_unit_price: 26 } } })) }] } : { asset_list: types.map((benefit_type: string) => ({ resource_type: "aigc", resource_id: "generate_video", benefit_type, asset_details: [{ pay_mode: "UserCredit", role: "all" }] })) });
    }
    if (path.endsWith("/video_generate/get_common_config")) return ok({ models });
    if (path.endsWith("/get_common_config")) return ok({});
    if (path.endsWith("/aigc_draft/generate")) { sends++; return ok({ aigc_data: { history_record_id: `floor-history-${sends}` } }); }
    throw Error("Unmocked request: " + path);
};
const { createTask, runVideoQueueTick } = await import("../src/api/controllers/tasks.ts");
const row = (id: string) => database.prepare("SELECT * FROM canvas_tasks WHERE id=?").get(id) as any;
async function wait(id: string, status: string) { const deadline=Date.now()+4000;while(row(id)?.status!==status&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.equal(row(id)?.status,status); }
const input = (id: string) => ({ id, model: "jimeng-video-seedance-2.5", prompt: id, ratio: "16:9", resolution: "720p", duration: 4, references: [] });
after(()=>database.close());
test("actual durable dispatch reserves quotes above the floor and stops further paid submissions", async () => {
    await createTask(owner,`Bearer ${key}`,input("floor_first_fixture"));await runVideoQueueTick();await wait("floor_first_fixture","running");
    assert.equal(sends,1);assert.equal(JSON.parse(row("floor_first_fixture").quote_json).estimatedCredits,24);
    await createTask(owner,`Bearer ${key}`,input("floor_second_fixture"));await runVideoQueueTick();await wait("floor_second_fixture","running");assert.equal(sends,2);
    await createTask(owner,`Bearer ${key}`,input("floor_third_fixture"));await runVideoQueueTick();await new Promise(r=>setTimeout(r,200));assert.equal(sends,2);assert.equal(row("floor_third_fixture").paid_started_at,0);
    credit=56540;await pool.refreshStatus("protected");await runVideoQueueTick();assert.equal(sends,2);assert.equal(row("floor_third_fixture").paid_started_at,0);
    assert.equal(row("floor_first_fixture").credit_before,56588);assert.equal(pool.getAccount("protected").status.totalCredit,56540);
});
test("balance drops before the frozen quote cannot cross the floor", async () => {
    database.prepare("UPDATE canvas_tasks SET provider_hold=0,status='failed',provider_status='failed'").run();credit=56640;creditReads=0;dropOnSecondRead=true;
    await pool.refreshStatus("protected");await createTask(owner,`Bearer ${key}`,input("floor_race_fixture"));await runVideoQueueTick();await new Promise(r=>setTimeout(r,300));
    assert.equal(sends,2);assert.equal(row("floor_race_fixture").paid_started_at,0);
});
