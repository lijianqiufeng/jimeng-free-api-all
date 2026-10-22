import assert from "node:assert/strict";
import { after, test } from "node:test";
import axios from "axios";
import draftModel from "./fixtures/seedance-draft-model.json";
import models from "./fixtures/seedance-models.json";

if (process.env.NODE_ENV !== "test" || !process.env.DB_PATH?.includes("cpa-video-queue-test-") || process.env.DATA_DIR !== process.env.DB_PATH?.replace(/[\\/]queue.sqlite$/, "")) throw Error("Isolated mock environment required before importing business modules");
const model = "jimeng-video-seedance-2.5-draft", reqKey = "dreamina_seedance_45_pro_draft";
let mode = "valid", submitted = 0, payload: any, frozen: any;
const calls: string[] = [];
axios.defaults.adapter = async config => {
  const path = new URL(String(config.url)).pathname;
  calls.push(path);
  const ok = (data: unknown) => ({ data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config });
  if (path.endsWith("/video_generate/get_common_config")) return ok({ models: [...models, ...(mode === "missing" ? [] : [{ ...draftModel, model_status: mode === "disabled" ? 1 : 0, extra: { is_draft_mode: mode !== "flag-missing" }, ...(mode === "no-commerce" ? { commercial_config: {} } : {}) }])] });
  if (path.endsWith("/get_common_config")) return ok({});
  if (path.endsWith("/benefit_metadata") || path.endsWith("/batch_get_user_benefit")) {
    const types = JSON.parse(String(config.data)).query_list[0].benefit_type_list;
    return ok(path.endsWith("/benefit_metadata")
      ? { metadata_list: [{ resource_type: "aigc", resource_id: "generate_video", benefits_pay_strategy: types.map((benefit_type: string) => ({ benefit_type, unit: "second", credit_strategy: { credit_limits: [{ role: "all" }], credit_pricing_info: { min_charge_cnt: 1, credit_unit_price: 9, original_credit_unit_price: 12 } } })) }] }
      : { asset_list: types.map((benefit_type: string) => ({ resource_type: "aigc", resource_id: "generate_video", benefit_type, asset_details: [{ pay_mode: "UserCredit", role: "all" }] })) });
  }
  if (path.endsWith("/aigc_draft/generate")) {
    assert.ok(frozen, "original-account quote is frozen before the only paid POST");
    submitted++; payload = JSON.parse(String(config.data));
    return ok({ aigc_data: { history_record_id: `mock-draft-${submitted}` } });
  }
  throw Error(`Unmocked network: ${path}`);
};
const { database } = await import("../src/lib/database.ts");
const { resolveVideoModelConfig } = await import("../src/api/controllers/models.ts");
const { seedanceInput, seedanceVideoBenefit } = await import("../src/api/controllers/seedance-contract.ts");
const { submitSeedanceVideo } = await import("../src/api/controllers/seedance.ts");
const { freezeVideoQuote } = await import("../src/api/controllers/video-quote.ts");
const base = { model, prompt: "隔离样片", ratio: "16:9", resolution: "480p", duration: 4, references: [] };
const hooks = { beforeSubmit() {}, onQuoted(quote: any) { frozen = quote; }, onSubmitted() {} };
after(() => database.close());

test("draft and ordinary 2.5 keep independent dynamic request keys and parameters", async () => {
  const sample = await resolveVideoModelConfig(model, "draft-config-fixture");
  assert.equal(sample.modelReqKey, reqKey);
  assert.equal(sample.source, "dynamic");
  assert.deepEqual(sample.supportedResolutions, ["480p"]);
  assert.ok(sample.supportedDurations?.includes(4) && sample.supportedDurations.includes(30));
  const ordinary = await resolveVideoModelConfig("jimeng-video-seedance-2.5", "draft-config-fixture");
  assert.equal(ordinary.modelReqKey, "dreamina_seedance_45_pro");
  assert.ok(ordinary.supportedResolutions.includes("720p"));
});

test("draft schema accepts 2.5 reference counts and 30 seconds but rejects higher resolutions", () => {
  const image = { kind: "image", url: "data:image/png;base64,AAAA" }, video = { kind: "video", url: "https://fixture.tos-cn-beijing.volces.com/ref.mp4" }, audio = { ...video, kind: "audio" };
  assert.equal(seedanceInput({ ...base, duration: 30, references: [...Array(30).fill(image), ...Array(10).fill(video), ...Array(10).fill(audio)] }).references.length, 50);
  for (const change of [{ resolution: "720p" }, { resolution: "1080p" }, { duration: 31 }, { duration: 3 }, { references: Array(11).fill(video) }]) assert.throws(() => seedanceInput({ ...base, ...change }));
  assert.equal(seedanceVideoBenefit(model, "480p", false, draftModel), "seedance_25_draft_480p_no_input_video_output");
  assert.equal(seedanceVideoBenefit(model, "480p", true, draftModel), "seedance_25_draft_480p_output");
});

test("sample submission writes the official snake-case flag and its own commerce branch", async () => {
  frozen = undefined;
  const before = submitted;
  await submitSeedanceVideo(seedanceInput({ ...base, duration: 30 }), "draft-submit-fixture", hooks);
  assert.equal(submitted, before + 1);
  const params = JSON.parse(payload.draft_content).component_list[0].abilities.gen_video.text_to_video_params;
  assert.equal(params.model_req_key, reqKey);
  assert.equal(payload.extend.root_model, reqKey);
  assert.equal(params.video_gen_inputs[0].is_draft_mode, true);
  assert.equal(params.video_gen_inputs[0].resolution, "480p");
  assert.equal(params.video_gen_inputs[0].duration_ms, 30000);
  assert.equal(payload.extend.m_video_commerce_info.benefit_type, "seedance_25_draft_480p_no_input_video_output");
  assert.equal(frozen.model, model);
  assert.equal(frozen.estimatedCredits, 270);
});

test("sample actual-account quote includes fractional reference duration without a second discount", async () => {
  const config = await resolveVideoModelConfig(model, "draft-quote-fixture");
  const quote = await freezeVideoQuote("draft-quote-fixture", { ...base, hasVideo: true, referenceVideoSeconds: 3.125 }, config);
  assert.equal(quote.benefitType, "seedance_25_draft_480p_output");
  assert.equal(quote.chargeInputVideoDuration, true);
  assert.equal(quote.chargedSeconds, 7.125);
  assert.equal(quote.creditsPerSecond, 9);
  assert.equal(quote.estimatedCredits, 64);
});

test("ordinary 2.5 never inherits sample mode", async () => {
  frozen = undefined;
  await submitSeedanceVideo(seedanceInput({ ...base, model: "jimeng-video-seedance-2.5", resolution: "720p" }), "draft-normal-fixture", hooks);
  const params = JSON.parse(payload.draft_content).component_list[0].abilities.gen_video.text_to_video_params;
  assert.equal(params.model_req_key, "dreamina_seedance_45_pro");
  assert.equal(params.video_gen_inputs[0].is_draft_mode, undefined);
});

test("missing, disabled or unconfirmed dynamic sample configuration never falls back to ordinary 2.5", async () => {
  const before = submitted;
  for (mode of ["missing", "disabled", "flag-missing"]) await assert.rejects(submitSeedanceVideo(seedanceInput(base), `draft-${mode}-fixture`, { beforeSubmit() {}, onQuoted() { assert.fail(); }, onSubmitted() { assert.fail(); } }), /未确认可用.*未提交生成/);
  mode = "no-commerce";
  await assert.rejects(submitSeedanceVideo(seedanceInput(base), "draft-no-commerce-fixture", { beforeSubmit() {}, onQuoted() { assert.fail(); }, onSubmitted() { assert.fail(); } }), /计费项未确认，未提交生成/);
  mode = "valid";
  assert.equal(submitted, before);
  assert.ok(calls.every(path => /get_common_config|benefit_metadata|batch_get_user_benefit|aigc_draft\/generate/.test(path)));
});
