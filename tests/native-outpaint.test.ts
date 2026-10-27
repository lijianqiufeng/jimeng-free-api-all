import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { database, createApiKey, validateApiKey } from "@/lib/database.ts";
import accountPool, { encrypt } from "@/lib/account-pool.ts";
import { OUTPAINT_RATIOS, buildOutpaintRequest, outpaintHistoryResult, outpaintRequestParams, outpaintTaskInput, readOutpaintWorkspace, refreshOutpaintResults } from "@/api/controllers/outpaint-protocol.ts";
import { createOutpaintTask, queryOutpaintTask, cancelOutpaintTask, recoverOutpaintTasksAfterRestart } from "@/api/controllers/outpaint-tasks.ts";
import route from "@/api/routes/outpaint-tasks.ts";

assert.equal(process.env.NODE_ENV, "test");
assert.ok(process.env.DATA_DIR && process.env.DB_PATH?.startsWith(process.env.DATA_DIR));
assert.ok(path.basename(process.env.DATA_DIR!).startsWith("cpa-native-outpaint-test-"));
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO++sFEAAAAASUVORK5CYII=";
const input = (id: string) => ({ id, image, prompt: "延续背景", left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, maxSize: 2, ratio: "1:1" });
const row = (id: string): any => database.prepare("SELECT * FROM native_outpaint_tasks WHERE id=?").get(id);
const until = async (check: () => boolean) => { for (let count = 0; count < 500; count++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("isolated task did not settle"); };
const managed = createApiKey("native outpaint fixture"), owner = validateApiKey(managed.key).apiKeyId!, authorization = `Bearer ${managed.key}`;
const second = createApiKey("other native fixture"), otherOwner = validateApiKey(second.key).apiKeyId!;
const account = accountPool.create({ name: "native fixture", sessionId: "native-outpaint-fake-session" });
accountPool.grantLease(owner, account.id);
let mode: "ok" | "timeout" | "reject" | "missing" | "zero-string" | "zero-number" = "ok", generateCalls = 0, workspaceCreates = 0, uploadHold: Promise<void> | undefined;
let uploadedWidth = 1, uploadedHeight = 1, uploadAttempts = 0, activeUploads = 0, maximumUploads = 0;
const fixtureAccounts = new Set([account.id]), uploadedBodies: Buffer[] = [];
const payloads: any[] = [], histories = new Map<string, any>(), queried: string[] = [];
axios.defaults.adapter = async config => {
  const url = String(config.url), body = typeof config.data === "string" ? JSON.parse(config.data) : config.data || {};
  const raw = (data: any) => ({ data, status: 200, statusText: "OK", headers: {}, config });
  const ok = (data: any) => raw({ ret: "0", data });
  if (url.endsWith("/user_credit")) return ok({ credit: { gift_credit: 500, purchase_credit: 0, vip_credit: 0 } });
  if (url.endsWith("/passport/account/info/v2")) return ok({ user_info: { is_vip: false } });
  if (url.endsWith("/get_common_config")) return ok({});
  if (url.includes("/get_upload_token?")) return ok({ access_key_id: "fixture", secret_access_key: "fixture", session_token: "fixture" });
  if (url.includes("Action=ApplyImageUpload")) { uploadAttempts++; activeUploads++; maximumUploads = Math.max(maximumUploads, activeUploads); try { if (uploadHold) await uploadHold; return raw({ Result: { UploadAddress: { UploadHosts: ["upload.fixture.invalid"], StoreInfos: [{ StoreUri: "native-original", Auth: "fixture" }], SessionKey: "fixture" } } }); } finally { activeUploads--; } }
  if (url.startsWith("https://upload.fixture.invalid/")) { uploadedBodies.push(Buffer.from(config.data)); return raw({ code: 2000 }); }
  if (url.includes("Action=CommitImageUpload")) return raw({ Result: { Results: [{ Uri: "tos-native-original" }], PluginResult: [{ ImageWidth: uploadedWidth, ImageHeight: uploadedHeight }] } });
  if (url.endsWith("/workspace/list")) return ok({ workspaces: [] });
  if (url.endsWith("/workspace/create")) { workspaceCreates++; return ok({ workspace_id: "native-fixture-workspace" }); }
  if (url.endsWith("/aigc_draft/generate")) {
    generateCalls++; payloads.push(body);
    assert.equal(config.params.generate_id, `gen-${body.submit_id}`); assert.equal(config.params.generateId, undefined);
    assert.equal(JSON.parse(decodeURIComponent(config.params.babi_param)).feature_key, "to_image_expand");
    const task = database.prepare("SELECT * FROM native_outpaint_tasks WHERE submit_id=?").get(body.submit_id) as any;
    assert.ok(task && task.status === "submitting" && task.paid_started_at > 0 && task.image_uri === "tos-native-original");
    assert.ok(fixtureAccounts.has(task.account_id));
    if (mode === "timeout") throw Object.assign(Error("fixture timeout"), { code: "ETIMEDOUT" });
    if (mode === "reject") return raw({ ret: "4013", errmsg: "原请求被拒绝" });
    if (mode === "missing") return ok({});
    if (mode === "zero-string" || mode === "zero-number") return ok({ aigc_data: { history_record_id: mode === "zero-string" ? "0" : 0 }, fail_code: 0 });
    const id = `history-${body.submit_id}`;
    histories.set(id, { history_record_id: id, submit_id: body.submit_id, status: 50, item_list: [{ image: { width: 2048, height: 2048, large_images: [{ image_url: "https://fixture.invalid/outpaint.png", width: 2048, height: 2048 }] } }] });
    return ok({ aigc_data: { history_record_id: id }, fail_code: 0 });
  }
  if (url.endsWith("/get_history_by_ids")) { const id = body.history_ids[0]; queried.push(id); return ok({ [id]: histories.get(id) }); }
  throw Error("Unmocked native outpaint axios request is forbidden");
};

describe("native outpaint isolated contract", { concurrency: 1 }, () => {
  test("native create gate rejects new IDs before account or input persistence and retains original query and cancellation", async () => {
    const previousFlag = process.env.JIMENG_NATIVE_OUTPAINT_CREATE_ENABLED, body = input("outpaint_create_gate_existing_123");
    try {
      delete process.env.JIMENG_NATIVE_OUTPAINT_CREATE_ENABLED;
      await createOutpaintTask(owner, authorization, body, account.id); await until(() => row(body.id).status === "running");
      const submitId = row(body.id).submit_id, historyId = row(body.id).history_id, before = generateCalls, queries = queried.length;
      process.env.JIMENG_NATIVE_OUTPAINT_CREATE_ENABLED = "false";
      const blockedId = "outpaint_create_gate_blocked_123", files = fs.readdirSync(path.join(path.dirname(process.env.DB_PATH!), "private", "native-outpaint"));
      const blocked = await createOutpaintTask(owner, authorization, input(blockedId), "account-does-not-exist");
      assert.equal(blocked.status, 503); assert.equal((blocked.body as any).errorCode, "create_disabled"); assert.equal(row(blockedId), undefined);
      assert.deepEqual(fs.readdirSync(path.join(path.dirname(process.env.DB_PATH!), "private", "native-outpaint")), files);
      assert.equal((await createOutpaintTask(owner, authorization, body, account.id)).status, 200);
      assert.equal((await createOutpaintTask(otherOwner, `Bearer ${second.key}`, body, account.id)).status, 409);
      assert.equal((await createOutpaintTask(owner, authorization, { ...body, prompt: "changed" }, account.id)).status, 409);
      assert.equal(cancelOutpaintTask(owner, body.id, account.id).body.status, "canceled");
      const recovered = await queryOutpaintTask(owner, body.id, account.id);
      assert.equal(recovered.body.status, "succeeded"); assert.ok(recovered.body.data?.length);
      assert.equal(row(body.id).submit_id, submitId); assert.equal(row(body.id).history_id, historyId); assert.equal(row(body.id).account_id, account.id);
      assert.equal(queried.length, queries + 1); assert.equal(queried.at(-1), historyId); assert.equal(generateCalls, before);
    } finally { if (previousFlag === undefined) delete process.env.JIMENG_NATIVE_OUTPAINT_CREATE_ENABLED; else process.env.JIMENG_NATIVE_OUTPAINT_CREATE_ENABLED = previousFlag; }
  });

  test("zero native result identities use original order and object paths while valid item IDs retain identity", () => {
    const items = Array.from({ length: 4 }, (_, index) => ({ common_attr: { id: index % 2 ? "0" : 0 }, image: { large_images: [{ image_url: `https://fixture.invalid/zero-${index}.png?signature=old`, width: 2048, height: 2048 }] } }));
    const parse = (values: any[]) => outpaintHistoryResult({ original: { history_record_id: "original", submit_id: "fixed-submit", status: 50, item_list: values } }, "original", "fixed-submit");
    const allMissing = parse(items);
    assert.equal(allMissing.status, "succeeded"); assert.equal(allMissing.data?.length, 4);
    assert.ok(allMissing.data?.every(item => !Object.hasOwn(item, "itemId")));
    const mixed = parse(items.map((item, index) => index >= 2 ? { ...item, common_attr: { id: index === 2 ? "native-valid" : 42 } } : item));
    assert.deepEqual(mixed.data?.map(item => item.itemId), [undefined, undefined, "native-valid", "42"]);
    const previous = mixed.data!, before = structuredClone(previous);
    const fresh = previous.map(item => ({ ...item, url: item.url.replace("old", "fresh") }));
    const updated = refreshOutpaintResults(previous, [fresh[0], fresh[1], fresh[3], fresh[2]]);
    assert.deepEqual(updated.map(item => [item.index, item.itemId]), previous.map(item => [item.index, item.itemId]));
    assert.ok(updated.every(item => item.url.endsWith("signature=fresh")));
    assert.throws(() => refreshOutpaintResults(previous, [...fresh].reverse()), /身份变化/);
    assert.deepEqual(previous, before);
  });

  test("zero native workspace identities are rejected before paid submission and valid cached identity remains bound", async () => {
    for (const id of [0, "0"]) for (const wrapped of [{ workspace_id: id }, { workspace: { workspace_id: id } }, { workspaces: [{ id }] }]) assert.equal(readOutpaintWorkspace(wrapped), undefined);
    assert.equal(readOutpaintWorkspace({ workspace_id: 123 }), "123");
    assert.equal(readOutpaintWorkspace({ workspace_id: "native-fixture-workspace" }), "native-fixture-workspace");
    database.prepare("INSERT INTO native_outpaint_workspaces(account_id,workspace_id) VALUES (?,?)").run(account.id, "0");
    const body = input("outpaint_zero_workspace_123"), before = generateCalls, creates = workspaceCreates;
    try {
      await createOutpaintTask(owner, authorization, body, account.id); await until(() => row(body.id).status === "failed");
      assert.equal(row(body.id).paid_started_at, 0); assert.equal(row(body.id).history_id, "");
      assert.equal(generateCalls, before); assert.equal(workspaceCreates, creates);
      assert.equal((database.prepare("SELECT workspace_id FROM native_outpaint_workspaces WHERE account_id=?").get(account.id) as any).workspace_id, "0");
    } finally { database.prepare("DELETE FROM native_outpaint_workspaces WHERE account_id=?").run(account.id); }
  });

  test("zero native history identities stay unconfirmed with the same submit and account without a replay", async () => {
    try {
      for (const state of ["zero-string", "zero-number"] as const) {
        mode = state; const body = input(`outpaint_${state.replace("-", "_")}_12345`), before = generateCalls, queryCount = queried.length;
        await createOutpaintTask(owner, authorization, body, account.id); await until(() => row(body.id).status === "uncertain");
        const submitId = row(body.id).submit_id;
        assert.equal(row(body.id).history_id, ""); assert.equal(row(body.id).account_id, account.id); assert.ok(row(body.id).credential);
        assert.equal(row(body.id).error_code, "submission_unconfirmed"); assert.equal(generateCalls, before + 1);
        assert.equal((await createOutpaintTask(owner, authorization, body, account.id)).status, 200);
        const pending = await queryOutpaintTask(owner, body.id, account.id); recoverOutpaintTasksAfterRestart();
        assert.equal(pending.body.submission.state, "unconfirmed"); assert.equal(row(body.id).status, "uncertain");
        assert.equal(row(body.id).submit_id, submitId); assert.equal(row(body.id).account_id, account.id);
        assert.equal(generateCalls, before + 1); assert.equal(queried.length, queryCount);
        assert.equal((database.prepare("SELECT workspace_id FROM native_outpaint_workspaces WHERE account_id=?").get(account.id) as any).workspace_id, "native-fixture-workspace");
      }
    } finally { mode = "ok"; }
  });

  test("uses actual image dimensions and enforces explicit input, geometry and local safety limits", () => {
    const valid = outpaintTaskInput(input("outpaint_contract_1234"));
    assert.equal(valid.width, 1); assert.equal(valid.height, 1);
    for (const patch of [{ image: "https://fixture.invalid/a.png" }, { image: image.replace("image/png", "image/jpeg") }, { left: -1 }, { top: Number.NaN }, { maxSize: 8193 }, { maxSize: 6000 }, { ratio: "auto" }, { ratio: "4:5" }, { ratio: "16:9" }, { submitId: "override" }]) assert.throws(() => outpaintTaskInput({ ...input("outpaint_invalid_1234"), ...patch }));
    assert.throws(() => outpaintTaskInput({ ...input("outpaint_no_region_1234"), left: 0, right: 0, top: 0, bottom: 0 }));
  });

  test("builds the source-proven native unified outpainting branch, never blend or Agent", () => {
    const body = buildOutpaintRequest(outpaintTaskInput(input("outpaint_wire_123456")), "tos-real-upload-receipt", "workspace", "fixed-submit", 123);
    assert.equal(body.submit_id, "fixed-submit");
    const query = outpaintRequestParams("fixed-submit");
    assert.equal(query.generate_id, "gen-fixed-submit"); assert.ok(query.babi_param.startsWith("%7B"));
    assert.equal(JSON.parse(decodeURIComponent(query.babi_param)).tool_id, "tool_image");
    const draft = JSON.parse(body.draft_content), component = draft.component_list[0], unified = component.abilities.unified_generate, ability = unified.unified_ability_list[0];
    assert.equal(draft.version, "3.3.32"); assert.equal(draft.min_version, "3.0.2"); assert.deepEqual(draft.min_features, []);
    assert.equal(component.type, "image_base_component"); assert.equal(component.generate_type, "unified_generate");
    assert.equal(unified.generate_type, 8); assert.equal(ability.ability_code, "outpainting");
    assert.equal(ability.ability_param.option.out_painting.image_ratio, OUTPAINT_RATIOS["1:1"]);
    const original = ability.ability_param.resource_list[1];
    assert.equal(original.purpose, 11); assert.equal(original.resource_type, 2);
    assert.deepEqual(Object.fromEntries(["uri", "image_uri", "width", "height", "name", "source_from", "platform_type"].map(key => [key, original.content.image.image_content[key]])), { uri: "tos-real-upload-receipt", image_uri: "tos-real-upload-receipt", width: 1, height: 1, name: "origin", source_from: "", platform_type: 1 });
    assert.ok(!("blend" in component.abilities)); assert.ok(!("mask_uri" in ability.ability_param));
    const empty = buildOutpaintRequest({ ...outpaintTaskInput(input("outpaint_empty_12345")), prompt: "" }, "tos-uri", "workspace", "submit", 123);
    assert.equal(JSON.parse(empty.draft_content).component_list[0].abilities.unified_generate.unified_ability_list[0].ability_param.resource_list.length, 1);
  });

  test("registers before one paid send, binds the account and polls only the accepted original history", async () => {
    mode = "ok"; const body = input("outpaint_success_123456"), before = generateCalls;
    assert.equal((await createOutpaintTask(owner, authorization, body, account.id)).status, 202);
    await until(() => row(body.id).status === "running");
    assert.equal(generateCalls, before + 1);
    const result = await queryOutpaintTask(owner, body.id, account.id);
    assert.equal(result.body.status, "succeeded"); assert.deepEqual(result.body.data, [{ index: 0, url: "https://fixture.invalid/outpaint.png", width: 2048, height: 2048 }]);
    assert.equal(queried.at(-1), row(body.id).history_id); assert.ok(row(body.id).credential);
    assert.equal((await createOutpaintTask(owner, authorization, body, account.id)).status, 200);
    assert.equal((await createOutpaintTask(owner, authorization, { ...body, prompt: "changed" }, account.id)).status, 409);
    assert.equal((await createOutpaintTask(otherOwner, `Bearer ${second.key}`, body, account.id)).status, 409);
    assert.equal((await queryOutpaintTask(otherOwner, body.id)).status, 404);
    assert.equal((await queryOutpaintTask(owner, body.id, "other-account")).status, 404);
    assert.equal(generateCalls, before + 1); assert.equal(workspaceCreates, 1);
    assert.ok(!JSON.stringify(result.body).includes("fake-session"));
  });

  test("concurrent identical creation has one fixed submit ID and exactly one native generation", async () => {
    const body = input("outpaint_concurrent_1234"), before = generateCalls;
    await Promise.all([createOutpaintTask(owner, authorization, body, account.id), createOutpaintTask(owner, authorization, body, account.id)]);
    await until(() => row(body.id).status === "running");
    assert.equal(generateCalls, before + 1); assert.equal(payloads.at(-1).submit_id, row(body.id).submit_id);
  });

  test("timeout and missing receipts stay uncertain and never replay a paid submission", async () => {
    for (const state of ["timeout", "missing"] as const) {
      mode = state; const body = input(`outpaint_${state}_123456`), before = generateCalls;
      await createOutpaintTask(owner, authorization, body, account.id);
      await until(() => row(body.id).status === "uncertain");
      const submitId = row(body.id).submit_id;
      assert.equal((await createOutpaintTask(owner, authorization, body, account.id)).status, 200);
      const result = await queryOutpaintTask(owner, body.id, account.id);
      assert.equal(result.body.status, "uncertain"); assert.equal(result.body.submission.state, "unconfirmed");
      assert.equal(row(body.id).submit_id, submitId); assert.equal(generateCalls, before + 1); assert.ok(row(body.id).credential);
    }
    mode = "ok";
  });

  test("a received explicit business rejection is terminal without a second generate", async () => {
    mode = "reject"; const body = input("outpaint_rejected_12345"), before = generateCalls;
    await createOutpaintTask(owner, authorization, body, account.id);
    await until(() => row(body.id).status === "failed");
    assert.equal(row(body.id).error_code, "provider_rejected"); assert.equal(row(body.id).credential, "");
    await createOutpaintTask(owner, authorization, body, account.id);
    assert.equal(generateCalls, before + 1); mode = "ok";
  });

  test("cancel during source preparation prevents native generation and tombstones prevent a late create", async () => {
    let release!: () => void; uploadHold = new Promise(resolve => { release = resolve; });
    const body = input("outpaint_cancel_prep_123"), before = generateCalls;
    await createOutpaintTask(owner, authorization, body, account.id);
    assert.equal(cancelOutpaintTask(owner, body.id, account.id).body.status, "canceled");
    release(); uploadHold = undefined;
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(generateCalls, before);
    const late = input("outpaint_cancel_late_123"); cancelOutpaintTask(owner, late.id);
    assert.equal((await createOutpaintTask(owner, authorization, late)).status, 409);
  });

  test("an upload receipt with changed source dimensions fails before any paid send", async () => {
    const body = input("outpaint_upload_size_123"), before = generateCalls; uploadedWidth = 2;
    await createOutpaintTask(owner, authorization, body, account.id);
    await until(() => row(body.id).status === "failed"); uploadedWidth = 1;
    assert.equal(row(body.id).paid_started_at, 0); assert.equal(generateCalls, before);
  });

  test("restart recovery never resends an unconfirmed job and preserves accepted history identity", async () => {
    const uncertainId = "outpaint_restart_paid_123", preparingId = "outpaint_restart_prep_123", acceptedId = "outpaint_restart_receipt_123";
    const insert = database.prepare("INSERT INTO native_outpaint_tasks(id,owner,status,credential,submit_id,history_id,account_id,paid_started_at,deadline,created_at) VALUES (?,?,'submitting',?,?,?,?,?,?,?)");
    insert.run(uncertainId, owner, encrypt("fixture"), "fixed-paid", "", account.id, 1, Date.now() + 10000, 1);
    insert.run(preparingId, owner, encrypt("fixture"), "fixed-prep", "", account.id, 0, Date.now() + 10000, 1);
    insert.run(acceptedId, owner, encrypt("fixture"), "fixed-accepted", "history-fixed", account.id, 1, Date.now() + 10000, 1);
    const before = generateCalls; recoverOutpaintTasksAfterRestart();
    assert.equal(row(uncertainId).status, "uncertain"); assert.equal(row(preparingId).status, "failed");
    assert.equal(row(acceptedId).status, "running"); assert.equal(row(acceptedId).history_id, "history-fixed");
    assert.equal(row(uncertainId).submit_id, "fixed-paid"); assert.equal(generateCalls, before);
  });

  test("a mismatched history never saves another result, and the original receipt can still recover", async () => {
    const body = input("outpaint_wrong_receipt_123");
    await createOutpaintTask(owner, authorization, body, account.id);
    await until(() => row(body.id).status === "running");
    const historyId = row(body.id).history_id, original = histories.get(historyId), before = generateCalls;
    histories.set(historyId, { ...original, submit_id: "another-submit" });
    assert.equal((await queryOutpaintTask(owner, body.id, account.id)).body.status, "running");
    assert.equal(row(body.id).result, "");
    histories.set(historyId, original); database.prepare("UPDATE native_outpaint_tasks SET checked_at=0 WHERE id=?").run(body.id);
    assert.equal((await queryOutpaintTask(owner, body.id, account.id)).body.status, "succeeded");
    assert.equal(generateCalls, before);
  });

  test("cancel after acceptance preserves original history and does not pretend to cancel upstream", async () => {
    const body = input("outpaint_cancel_paid_123");
    await createOutpaintTask(owner, authorization, body, account.id);
    await until(() => row(body.id).status === "running");
    const historyId = row(body.id).history_id, before = generateCalls;
    const stopped = cancelOutpaintTask(owner, body.id, account.id);
    assert.equal(stopped.body.status, "canceled"); assert.match(stopped.body.error!, /上游可能继续/);
    const original = await queryOutpaintTask(owner, body.id, account.id);
    assert.equal(original.body.status, "succeeded"); assert.ok(original.body.data); assert.equal(row(body.id).history_id, historyId);
    assert.equal(generateCalls, before);
  });

  test("history parsing rejects another submit identity and retains actual failure metadata", () => {
    assert.throws(() => outpaintHistoryResult({ original: { history_record_id: "original", submit_id: "another", item_list: [] } }, "original", "bound-submit"));
    assert.equal(outpaintHistoryResult({ original: { status: 30, fail_code: 2038 } }, "original", "bound-submit").status, "failed");
  });

  test("route rejects native session credentials and registration does not alter other routes", async () => {
    const response = await route.post[""]({ headers: { authorization: "Bearer raw-session" }, body: input("outpaint_auth_1234567") } as any);
    assert.equal(response.statusCode, 401); assert.equal(route.prefix, "/v1/outpaint/tasks");
    const original = await route.get["/:id"]({ headers: { authorization, "x-jimeng-account-id": account.id }, method: "GET", params: { id: "outpaint_success_123456" } } as any);
    assert.equal(original.statusCode, 200); assert.equal(original.body.status, "succeeded");
    const index = fs.readFileSync("src/api/routes/index.ts", "utf8");
    assert.ok(index.includes("outpaintTasks")); assert.ok(index.includes("upscaleTasks")); assert.ok(index.includes("tasks,"));
  });

  test("resource slots bound global uploads, keep one account serial, cancel queued payloads and preserve deadline", async () => {
    const other = accountPool.create({ name: "native resource fixture", sessionId: "native-resource-fake-session" }), third = accountPool.create({ name: "native third fixture", sessionId: "native-third-fake-session" });
    for (const item of [other, third]) { fixtureAccounts.add(item.id); accountPool.grantLease(owner, item.id); }
    const first = input("outpaint_resource_first_123"), queued = input("outpaint_resource_cancel_123"), parallel = input("outpaint_resource_second_123"), expired = input("outpaint_resource_expired_123");
    let release!: () => void; uploadHold = new Promise(resolve => { release = resolve; });
    const before = generateCalls, uploadsBefore = uploadAttempts; maximumUploads = 0;
    try {
      await createOutpaintTask(owner, authorization, first, account.id); await until(() => uploadAttempts === uploadsBefore + 1);
      await createOutpaintTask(owner, authorization, queued, account.id); await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(uploadAttempts, uploadsBefore + 1); assert.equal(row(queued.id).paid_started_at, 0);
      assert.ok(fs.existsSync(row(queued.id).payload_path)); assert.ok(!fs.readFileSync(row(queued.id).payload_path, "utf8").includes(image));
      await createOutpaintTask(owner, authorization, parallel, other.id); await until(() => uploadAttempts === uploadsBefore + 2);
      await createOutpaintTask(owner, authorization, expired, third.id); const deadline = row(expired.id).deadline;
      await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(uploadAttempts, uploadsBefore + 2); assert.equal(maximumUploads, 2); assert.equal(row(expired.id).deadline, deadline);
      const file = row(queued.id).payload_path; cancelOutpaintTask(owner, queued.id, account.id); await until(() => !fs.existsSync(file));
      database.prepare("UPDATE native_outpaint_tasks SET deadline=? WHERE id=?").run(Date.now() - 1, expired.id);
      uploadHold = undefined; release();
      await until(() => row(first.id).status === "running" && row(parallel.id).status === "running" && row(expired.id).status === "failed");
      assert.equal(row(queued.id).status, "canceled"); assert.equal(row(expired.id).paid_started_at, 0); assert.equal(row(expired.id).account_id, third.id);
      assert.equal(generateCalls, before + 2); assert.equal(maximumUploads, 2); assert.equal(uploadAttempts, uploadsBefore + 2);
    } finally { uploadHold = undefined; release(); }
  });

  test("EXIF uses display dimensions while original uploaded bytes and receipt checks stay intact", async () => {
    // Minimal JPEG metadata fixture: encoded 2×1, EXIF orientation=6 displays as 1×2.
    const bytes = Buffer.from("ffd8ffe1002245786966000049492a0008000000010012010300010000000600000000000000ffc00011080001000203011100021100031100ffd9", "hex"), jpeg = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    const body = { ...input("outpaint_exif_display_123"), image: jpeg, top: 0, bottom: 0 }, normalized = outpaintTaskInput(body);
    assert.equal(normalized.width, 1); assert.equal(normalized.height, 2); assert.equal(normalized.image, jpeg);
    const before = generateCalls; uploadedHeight = 2;
    try {
      await createOutpaintTask(owner, authorization, body, account.id); await until(() => ["running", "failed"].includes(row(body.id).status));
      assert.equal(row(body.id).status, "running"); assert.equal(generateCalls, before + 1); assert.deepEqual(uploadedBodies.at(-1), bytes);
      const resource = JSON.parse(payloads.at(-1).draft_content).component_list[0].abilities.unified_generate.unified_ability_list[0].ability_param.resource_list[1].content.image.image_content;
      assert.equal(resource.width, 1); assert.equal(resource.height, 2);
    } finally { uploadedHeight = 1; }
  });

  test("signed URL refresh only queries the original successful history and keeps success on refresh failure", async () => {
    const body = input("outpaint_signed_refresh_123"), before = generateCalls;
    await createOutpaintTask(owner, authorization, body, account.id); await until(() => row(body.id).status === "running");
    const original = await queryOutpaintTask(owner, body.id, account.id), historyId = row(body.id).history_id, submitId = row(body.id).submit_id, priorQueries = queried.length;
    const history = histories.get(historyId); histories.set(historyId, { ...history, item_list: [{ image: { large_images: [{ image_url: "https://fixture.invalid/outpaint.png?signature=fresh", width: 2048, height: 2048 }] } }] });
    assert.equal((await queryOutpaintTask(owner, body.id, account.id)).body.data?.[0].url, original.body.data?.[0].url); assert.equal(queried.length, priorQueries);
    database.prepare("UPDATE native_outpaint_tasks SET checked_at=0 WHERE id=?").run(body.id);
    const fresh = await queryOutpaintTask(owner, body.id, account.id); assert.match(fresh.body.data![0].url, /signature=fresh/); assert.equal(queried.at(-1), historyId);
    histories.set(historyId, { ...history, submit_id: "another-submit" }); database.prepare("UPDATE native_outpaint_tasks SET checked_at=0 WHERE id=?").run(body.id);
    const failure = await queryOutpaintTask(owner, body.id, account.id); assert.equal(failure.body.status, "succeeded"); assert.equal(failure.body.data![0].url, fresh.body.data![0].url);
    histories.set(historyId, { ...history, status: 30, item_list: [] }); database.prepare("UPDATE native_outpaint_tasks SET checked_at=0 WHERE id=?").run(body.id);
    assert.equal((await queryOutpaintTask(owner, body.id, account.id)).body.status, "succeeded");
    assert.equal(row(body.id).history_id, historyId); assert.equal(row(body.id).submit_id, submitId); assert.equal(generateCalls, before + 1); assert.ok(row(body.id).credential);
  });

  test("multi-result parsing waits for completed history and preserves all four items without truncation", () => {
    const items = Array.from({ length: 4 }, (_, index) => ({ common_attr: { id: `native-item-${index}` }, image: { large_images: [{ image_url: `https://fixture.invalid/result-${index}.png`, width: 2048, height: 2048 }] } }));
    const history = { history_record_id: "original", submit_id: "fixed-submit", status: 50, item_list: items };
    assert.equal(outpaintHistoryResult({ original: { ...history, status: 20, item_list: [items[0]] } }, "original", "fixed-submit").status, "running");
    const result = outpaintHistoryResult({ original: history }, "original", "fixed-submit");
    assert.equal(result.status, "succeeded"); assert.equal(result.data?.length, 4);
    assert.deepEqual(result.data?.map(item => [item.index, item.itemId, item.url]), items.map((item, index) => [index, item.common_attr.id, item.image.large_images[0].image_url]));
    assert.equal(outpaintHistoryResult({ original: { ...history, item_list: [items[0], { common_attr: { id: "not-ready" } }] } }, "original", "fixed-submit").status, "running");
    const excess = outpaintHistoryResult({ original: { ...history, item_list: [...items, { ...items[0], common_attr: { id: "fifth-item" } }] } }, "original", "fixed-submit");
    assert.equal(excess.status, "uncertain"); assert.equal(excess.errorCode, "result_count_unconfirmed"); assert.equal(excess.data, undefined);
    assert.equal(outpaintHistoryResult({ original: { ...history, item_list: [items[0]] } }, "original", "fixed-submit").data?.length, 1);
  });

  test("multi-result one generate returns four and refresh keeps original order, count and identity", async () => {
    const body = input("outpaint_multi_success_123"), before = generateCalls;
    await createOutpaintTask(owner, authorization, body, account.id); await until(() => row(body.id).status === "running");
    const historyId = row(body.id).history_id, submitId = row(body.id).submit_id;
    const items = Array.from({ length: 4 }, (_, index) => ({ common_attr: { id: `native-four-${index}` }, image: { large_images: [{ image_url: `https://fixture.invalid/four-${index}.png?signature=old`, width: 2048, height: 2048 }] } }));
    const history = { ...histories.get(historyId), item_list: items }; histories.set(historyId, history);
    const initial = await queryOutpaintTask(owner, body.id, account.id);
    assert.equal(initial.body.status, "succeeded"); assert.equal(initial.body.data?.length, 4); assert.equal(generateCalls, before + 1);
    assert.equal(JSON.parse(payloads.at(-1).metrics_extra).generateCount, 1);
    histories.set(historyId, { ...history, item_list: [...items].reverse().map(item => ({ ...item, image: { large_images: [{ ...item.image.large_images[0], image_url: item.image.large_images[0].image_url.replace("old", "fresh") }] } })) });
    database.prepare("UPDATE native_outpaint_tasks SET checked_at=0 WHERE id=?").run(body.id);
    const fresh = await queryOutpaintTask(owner, body.id, account.id);
    assert.deepEqual(fresh.body.data?.map(item => [item.index, item.itemId]), initial.body.data?.map(item => [item.index, item.itemId]));
    assert.ok(fresh.body.data?.every(item => item.url.endsWith("signature=fresh")));
    histories.set(historyId, { ...history, item_list: items.slice(0, 3) }); database.prepare("UPDATE native_outpaint_tasks SET checked_at=0 WHERE id=?").run(body.id);
    const fewer = await queryOutpaintTask(owner, body.id, account.id);
    assert.equal(fewer.body.status, "succeeded"); assert.deepEqual(fewer.body.data, fresh.body.data); assert.match(fewer.body.error || "", /数量变化/);
    histories.set(historyId, { ...history, item_list: [{ ...items[0], common_attr: { id: "foreign-result" } }, ...items.slice(1)] }); database.prepare("UPDATE native_outpaint_tasks SET checked_at=0 WHERE id=?").run(body.id);
    const foreign = await queryOutpaintTask(owner, body.id, account.id);
    assert.equal(foreign.body.status, "succeeded"); assert.deepEqual(foreign.body.data, fresh.body.data); assert.match(foreign.body.error || "", /身份变化/);
    assert.equal(row(body.id).history_id, historyId); assert.equal(row(body.id).submit_id, submitId); assert.equal(generateCalls, before + 1);
  });

  test("multi-result excess stays uncertain with original history and recovers four only by querying", async () => {
    const body = input("outpaint_multi_excess_123"), before = generateCalls;
    await createOutpaintTask(owner, authorization, body, account.id); await until(() => row(body.id).status === "running");
    const historyId = row(body.id).history_id, submitId = row(body.id).submit_id;
    const items = Array.from({ length: 5 }, (_, index) => ({ id: `native-excess-${index}`, image: { large_images: [{ image_url: `https://fixture.invalid/excess-${index}.png`, width: 2048, height: 2048 }] } }));
    const history = { ...histories.get(historyId), item_list: items }; histories.set(historyId, history);
    const pending = await queryOutpaintTask(owner, body.id, account.id);
    assert.equal(pending.body.status, "uncertain"); assert.equal(pending.body.errorCode, "result_count_unconfirmed"); assert.equal(pending.body.data, undefined);
    assert.ok(row(body.id).credential); assert.equal(row(body.id).history_id, historyId); assert.equal(row(body.id).submit_id, submitId);
    histories.set(historyId, { ...history, item_list: items.slice(0, 4) }); database.prepare("UPDATE native_outpaint_tasks SET checked_at=0 WHERE id=?").run(body.id);
    const recovered = await queryOutpaintTask(owner, body.id, account.id);
    assert.equal(recovered.body.status, "succeeded"); assert.equal(recovered.body.data?.length, 4); assert.deepEqual(recovered.body.data?.map(item => item.index), [0, 1, 2, 3]);
    assert.equal(generateCalls, before + 1); assert.equal(row(body.id).history_id, historyId); assert.equal(row(body.id).submit_id, submitId);
  });
});
