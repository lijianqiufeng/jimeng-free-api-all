import assert from "node:assert/strict";
import { after, test } from "node:test";
import axios from "axios";
import draftModel from "./fixtures/seedance-draft-model.json";

if (process.env.NODE_ENV !== "test" || !process.env.DB_PATH?.includes("cpa-video-queue-test-") || process.env.DATA_DIR !== process.env.DB_PATH?.replace(/[\\/]queue.sqlite$/, "")) throw Error("Isolated mock environment required before importing business modules");
const histories = new Map<string, any>(), submissions: any[] = [];
let mode = "valid", hdRate = 64;
axios.defaults.adapter = async config => {
  const path = new URL(String(config.url)).pathname, payload = JSON.parse(String(config.data || "{}"));
  const ok = (data: unknown) => ({ data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config });
  if (path.endsWith("/video_generate/get_common_config")) {
    const model = structuredClone(draftModel);
    if (mode === "disabled-hd") model.options.find(option => option.key === "generate_from_draft_config")!.generate_from_draft_config_val.resolution.disabled_string_value.push("1080p");
    return ok({ models: [model] });
  }
  if (path.endsWith("/get_common_config")) return ok({});
  if (path.endsWith("/user_credit")) return ok({ credit: { gift_credit: String(config.headers?.Cookie).includes("other-account") ? 50000 : 10000, purchase_credit: 0, vip_credit: 0 } });
  if (path.endsWith("/benefit_metadata") || path.endsWith("/batch_get_user_benefit")) {
    const types = payload.query_list[0].benefit_type_list;
    return ok(path.endsWith("/benefit_metadata")
      ? { metadata_list: [{ resource_type: "aigc", resource_id: "generate_video", benefits_pay_strategy: types.map((benefit_type: string) => ({ benefit_type, unit: "second", credit_strategy: { credit_limits: [{ role: "all" }], credit_pricing_info: { min_charge_cnt: 1, credit_unit_price: benefit_type.includes("1080p") ? hdRate : 9, original_credit_unit_price: 64 } } })) }] }
      : { asset_list: types.map((benefit_type: string) => ({ resource_type: "aigc", resource_id: "generate_video", benefit_type, asset_details: [{ pay_mode: "UserCredit", role: "all" }] })) });
  }
  if (path.endsWith("/aigc_draft/generate")) {
    const draft = JSON.parse(payload.draft_content), historyId = String(70000000000000 + submissions.length);
    submissions.push({ ...payload, cookie: String(config.headers?.Cookie), draft });
    if (mode === "lost-receipt") throw Object.assign(Error("lost accepted receipt"), { code: "ETIMEDOUT" });
    histories.set(historyId, { history_record_id: historyId, submit_id: payload.submit_id, status: 50, finish_time: Math.floor(Date.now() / 1000), task: { submit_id: payload.submit_id }, draft_content: payload.draft_content, item_list: [{ common_attr: { id: String(80000000000000 + submissions.length) }, video: { transcoded_video: { origin: { video_url: "https://result.test/sample.mp4" } } } }] });
    return ok({ aigc_data: { history_record_id: historyId } });
  }
  if (path.endsWith("/get_history_by_ids")) return ok(Object.fromEntries(payload.history_ids.map((id: string) => [id, histories.get(id)])));
  if (path.endsWith("/user_credit_history")) return ok({ records: submissions.map((item, index) => ({ submit_id: item.submit_id, history_id: `bill-${index}`, history_type: 2, status: "Checked", amount: 36, origin_credit_amount: 48 })), has_more: false });
  throw Error(`Unmocked network: ${path}`);
};
const { database, createApiKey, validateApiKey } = await import("../src/lib/database.ts");
const pool = await import("../src/lib/account-pool.ts");
pool.setMembershipStatusProvider(undefined);
const { createTask, queryTask, cancelTask, runVideoQueueTick } = await import("../src/api/controllers/tasks.ts");
const { taskInput } = await import("../src/api/controllers/task-contract.ts");
const { assertDraftSourceAvailable, readDraftSource, buildGenerateFromDraft } = await import("../src/api/controllers/seedance-draft-protocol.ts");
const { quoteSeedanceDraftUpgrade } = await import("../src/api/controllers/seedance.ts");
const key = createApiKey("isolated sample upgrade"), owner = validateApiKey(key.key).apiKeyId!, auth = `Bearer ${key.key}`;
const account = pool.createAccount({ name: "original_超级", sessionId: "source-account" });
const get = (id: string) => database.prepare("SELECT * FROM canvas_tasks WHERE id=?").get(id) as any;
const sampleId = "sample_upgrade_source_123456", upgradeId = "sample_upgrade_final_123456";
const sampleInput = { id: sampleId, model: "jimeng-video-seedance-2.5-draft", prompt: "原始提示词", ratio: "9:16", resolution: "480p", duration: 4, references: [] };
const upgradeInput = (id: string, sourceTaskId = sampleId) => ({ id, operation: "generate-from-draft", sourceTaskId, model: "jimeng-video-seedance-2.5-draft", resolution: "1080p" });
async function waitStatus(id: string, status: string) {
  const end = Date.now() + 4000;
  while (get(id)?.status !== status && Date.now() < end) { await runVideoQueueTick(); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(get(id)?.status, status);
}
async function waitAccepted(id: string) {
  const end = Date.now() + 4000;
  while (!["running", "succeeded"].includes(get(id)?.status) && Date.now() < end) { await runVideoQueueTick(); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(["running", "succeeded"].includes(get(id)?.status), "the original paid submission is accepted or already finished");
}
function cloneSource(id: string, edit: (task: any) => void = () => {}) {
  const row = { ...get(sampleId), id }, quote = JSON.parse(row.quote_json);
  quote.taskId = id; row.quote_json = JSON.stringify(quote); edit(row);
  const keys = Object.keys(row);
  database.prepare(`INSERT INTO canvas_tasks(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key]));
  return row;
}
after(() => database.close());

test("successful sample retains exact official source and exposes millisecond expiry", async () => {
  await createTask(owner, auth, sampleInput);
  await waitStatus(sampleId, "running");
  const response = await queryTask(owner, sampleId), row = get(sampleId);
  assert.equal(response.body.status, "succeeded");
  assert.equal(response.body.data[0].jimengMode, "draft");
  assert.equal(response.body.draftUpgrade.available, true);
  assert.equal(response.body.draftUpgrade.expiresAt, histories.get(row.history_id).finish_time * 1000 + 7 * 86400_000);
  assert.ok(row.sample_snapshot_json && !row.sample_snapshot_json.includes("draft_content"));
  assert.equal(row.account_id, account.id);
  pool.createAccount({ name: "other_超级", sessionId: "other-account" });
});

test("1080p final appends the official process on only the original account, preserving the sample", async () => {
  const original = { ...get(sampleId) }, before = submissions.length;
  await Promise.all([createTask(owner, auth, upgradeInput(upgradeId)), createTask(owner, auth, upgradeInput(upgradeId))]);
  await waitAccepted(upgradeId);
  assert.equal(submissions.length, before + 1);
  const submitted = submissions.at(-1), draft = submitted.draft, main = draft.component_list.at(-1), gen = main.abilities.gen_video;
  assert.match(submitted.cookie, /source-account/);
  assert.doesNotMatch(submitted.cookie, /other-account/);
  assert.equal(submitted.extend.root_model, "dreamina_seedance_45_pro_draft");
  assert.equal(main.process_type, 15);
  assert.equal(main.parent_id, JSON.parse(original.sample_snapshot_json ? pool.decrypt(original.sample_snapshot_json) : "{}").draftContent && JSON.parse(submissions[0].draft_content).main_component_id);
  assert.equal(gen.text_to_video_params.video_gen_inputs[0].resolution, "1080p");
  assert.equal(gen.text_to_video_params.video_gen_inputs[0].v2v_opt.generate_from_draft.enable, true);
  assert.equal(gen.text_to_video_params.video_gen_inputs[0].prompt, undefined);
  assert.equal(gen.text_to_video_params.model_req_key, undefined);
  assert.equal(draft.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0].is_draft_mode, undefined);
  assert.equal(gen.video_ref_params.origin_history_id, original.history_id);
  assert.equal(get(upgradeId).account_id, original.account_id);
  const quote = JSON.parse(get(upgradeId).quote_json);
  assert.equal(quote.sourceTaskId, sampleId);
  assert.equal(quote.operation, "generate-from-draft");
  assert.equal(quote.creditsPerSecond, 64);
  assert.equal(quote.estimatedCredits, 256);
  assert.equal((await queryTask(owner, upgradeId)).body.data[0].jimengMode, "final");
  assert.deepEqual(get(sampleId), original);
});

test("same task returns its original result and another task cannot repeat the source's paid conversion", async () => {
  const before = submissions.length;
  assert.equal((await createTask(owner, auth, upgradeInput(upgradeId))).body.status, "succeeded");
  await assert.rejects(createTask(owner, auth, upgradeInput("sample_upgrade_duplicate_123456")), /已有高清任务/);
  assert.equal(submissions.length, before);
});

test("caller cannot override source prompt, references, duration or use another owner", async () => {
  for (const extra of [{ prompt: "新提示词" }, { references: [] }, { duration: 30 }, { ratio: "16:9" }, { resolution: "720p" }]) assert.throws(() => taskInput({ ...upgradeInput("sample_override_123456"), ...extra }));
  await assert.rejects(createTask(owner + 1, auth, upgradeInput("sample_owner_denied_123456")), /API Key 无效|原样片/);
  const another = pool.listAccounts().find(item => item.id !== account.id)!;
  await assert.rejects(createTask(owner, auth, upgradeInput("sample_account_denied_123456"), another.id), /账号绑定不匹配/);
});

test("old missing snapshots and expired samples never admit an upgrade", async () => {
  const before = submissions.length;
  cloneSource("sample_missing_snapshot_123456", row => { row.sample_snapshot_json = null; });
  await assert.rejects(createTask(owner, auth, upgradeInput("sample_missing_final_123456", "sample_missing_snapshot_123456")), /原样片/);
  const source = JSON.parse(pool.decrypt(get(sampleId).sample_snapshot_json));
  source.finishedTime = Date.now() - 8 * 86400_000;
  cloneSource("sample_expired_source_123456", row => { row.sample_snapshot_json = pool.encrypt(JSON.stringify(source)); });
  await assert.rejects(createTask(owner, auth, upgradeInput("sample_expired_final_123456", "sample_expired_source_123456")), /7 天/);
  assert.equal(submissions.length, before);
});

test("post-edited history and unsupported final resolution fail closed", () => {
  const original = histories.get(get(sampleId).history_id), changed = structuredClone(original), content = JSON.parse(changed.draft_content);
  content.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0].v2v_opt = { super_resolution: { enable: true } };
  changed.draft_content = JSON.stringify(content);
  assert.throws(() => readDraftSource({ [get(sampleId).history_id]: changed }, get(sampleId).history_id), /后编辑/);
  const source = readDraftSource({ [get(sampleId).history_id]: original }, get(sampleId).history_id);
  assert.throws(() => buildGenerateFromDraft(source, "4k"), /仅开放升级 1080p/);
  assert.throws(() => assertDraftSourceAvailable({ ...source, finishedTime: Date.now() + 1000 }), /完成时间/);
});

test("final quote preserves original reference seconds at 64 credits with no super discount", async () => {
  const quote = await quoteSeedanceDraftUpgrade({ duration: 4, hasVideo: true, referenceVideoSeconds: 3.125 }, "source-account");
  assert.equal(quote.chargedSeconds, 7.125);
  assert.equal(quote.estimatedCredits, 456);
  assert.equal(quote.benefitType, "seedance_25_draft_1080p_output");
  hdRate = 48;
  try {
    const current = await quoteSeedanceDraftUpgrade({ duration: 4, hasVideo: true, referenceVideoSeconds: 3.125 }, "source-account");
    assert.equal(current.creditsPerSecond, 48, "freeze the current original-account official rate, never hard-code or halve it");
    assert.equal(current.estimatedCredits, 342);
  } finally { hdRate = 64; }
});

test("disabled official 1080p option and cancellation cannot make a paid request", async () => {
  const before = submissions.length;
  mode = "disabled-hd";
  cloneSource("sample_disabled_source_123456");
  try {
    await createTask(owner, auth, upgradeInput("sample_disabled_final_123456", "sample_disabled_source_123456"));
    await waitStatus("sample_disabled_final_123456", "failed");
    assert.equal(get("sample_disabled_final_123456").paid_started_at, 0);
  } finally { mode = "valid"; }
  cancelTask(owner, "sample_canceled_final_123456");
  assert.equal((await createTask(owner, auth, upgradeInput("sample_canceled_final_123456"))).status, 409);
  assert.equal(submissions.length, before);
});

test("unknown conversion receipt keeps original account and task identity without replay", async () => {
  cloneSource("sample_lost_source_123456");
  mode = "lost-receipt";
  const id = "sample_lost_final_123456", before = submissions.length;
  try {
    await createTask(owner, auth, upgradeInput(id, "sample_lost_source_123456"));
    await waitStatus(id, "uncertain");
    assert.equal(submissions.length, before + 1);
    assert.equal(get(id).provider_hold, 1);
    assert.equal(get(id).account_id, account.id);
    await createTask(owner, auth, upgradeInput(id, "sample_lost_source_123456"));
    await queryTask(owner, id);
    assert.equal(submissions.length, before + 1);
    assert.equal(get("sample_lost_source_123456").status, "succeeded");
  } finally { mode = "valid"; }
});

test("old advanced samples remain readable but cannot pay for a new conversion or switch to super", async () => {
  const advanced = pool.createAccount({ name: "13800005776_高级", sessionId: "old-advanced-sample" });
  const sourceId = "sample_old_advanced_source_123456", finalId = "sample_old_advanced_final_123456";
  cloneSource(sourceId, row => {
    row.account_id = advanced.id;
    const quote = JSON.parse(row.quote_json);
    row.quote_json = JSON.stringify({ ...quote, accountId: advanced.id, accountName: advanced.name, accountTier: "advanced" });
  });
  const original = { ...get(sourceId) }, before = submissions.length;
  const existing = await queryTask(owner, sourceId);
  assert.equal(existing.body.status, "succeeded");
  assert.ok(existing.body.data[0].url);
  assert.equal(existing.body.draftUpgrade.available, false);
  await assert.rejects(createTask(owner, auth, upgradeInput(finalId, sourceId)), /原样片账号已暂停新视频提交.*未更换账号或提交生成/);
  assert.equal(get(finalId), undefined);
  assert.deepEqual(get(sourceId), original);
  assert.equal(submissions.length, before);
  assert.equal(pool.getAccount(advanced.id).enabled, true);
});
