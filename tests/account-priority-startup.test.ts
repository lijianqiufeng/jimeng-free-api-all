import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSync } from "esbuild";
import { mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
const root = process.cwd(), output = mkdtempSync(join(root, ".private/policy-startup-fixture-")), bundle = join(output, "startup.mjs");
assert.ok(process.env.DB_PATH?.includes("cpa-video-queue-test-"));
buildSync({ entryPoints: [resolve(root, "src/lib/account-priority.ts")], bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle });
const config = { schema: "jimeng-account-priority-v1", revision: 1, primaryAccountId: "temporary", fallbackAccountId: "owned", primaryUntil: "2026-11-28T16:00:00.000Z" };
function start(policy: unknown, floors = '{"temporary":56540}') {
    const env = { ...process.env, JIMENG_ACCOUNT_CREDIT_FLOORS: floors };
    if (policy === undefined) delete env.JIMENG_ACCOUNT_PRIORITY;
    else env.JIMENG_ACCOUNT_PRIORITY = typeof policy === "string" ? policy : JSON.stringify(policy);
    const result = spawnSync(process.execPath, ["--require", join(root,"tools/test-cpa-offline.cjs"), bundle], { cwd: root, env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.error, undefined);
    return result;
}
const receipt = () => { const db = new Database(process.env.DB_PATH!); try { return (db.prepare("SELECT receipt_json FROM jimeng_account_priority WHERE id=1").get() as any).receipt_json; } finally { db.close(); } };

test("an enabled persistent policy rejects missing/malformed/changed floors or rollback across actual process restarts", () => {
    assert.equal(start(config).status, 0);
    const first = receipt();
    for (const [policy, floors] of [[undefined, '{"temporary":56540}'], ["bad-json", '{"temporary":56540}'], [config, "{}"], [{...config, fallbackAccountId:"third"}, '{"temporary":56540}']] as const) {
        assert.notEqual(start(policy, floors).status, 0);
        assert.equal(receipt(), first);
    }
    assert.equal(start({...config,revision:2}).status, 0);
    const next = receipt();
    assert.notEqual(first, next);
    assert.notEqual(start(config).status, 0);
    assert.equal(receipt(), next);
});
