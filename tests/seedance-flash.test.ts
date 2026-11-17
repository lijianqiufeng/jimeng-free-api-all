import { expect, mock, test } from "bun:test";
import raw from "./fixtures/seedance25-flash-catalog.json";
import { SEEDANCE_MODELS, seedanceInput, seedanceVideoBenefit } from "../src/api/controllers/seedance-contract";

const model = "jimeng-video-seedance-2.5-flash";
const submissions: any[] = [];
mock.module("../src/lib/logger.ts", () => ({ default: { info() {}, warn() {}, error() {} } }));
mock.module("../src/lib/util.ts", () => ({ default: { md5: () => "isolated-model-catalog" } }));
mock.module("../src/api/controllers/core.ts", () => ({ uploadFile: () => { throw Error("No real uploads"); }, request: async (_method: string, path: string, _token: string, options?: any) => {
  if (path === "/mweb/v1/aigc_draft/generate") { options.beforeSubmit(); options.onSubmitting?.(); submissions.push(options.data); return { aigc_data: { history_record_id: "synthetic-history" } }; }
  if (path !== "/mweb/v1/video_generate/get_common_config") throw Error("Unexpected upstream request");
  return { models: [raw] };
} }));
mock.module("../src/api/controllers/video-quote.ts", () => ({ freezeVideoQuote: async (_token: string, input: any) => ({ ...input, benefitType: `seedance_25_flash_${input.resolution}_${input.hasVideo ? "output" : "no_input_video"}`, estimatedCredits: input.duration * 19 }) }));
mock.module("../src/api/controllers/seedance-upload.ts", () => ({ UploadError: class extends Error {}, seedanceUploadUser: () => { throw Error("No real uploads"); }, uploadSeedanceReference: () => { throw Error("No real uploads"); } }));
const { fetchVideoModelConfigs, getStaticModelReqKey } = await import("../src/api/controllers/models");
const { submitSeedanceVideo } = await import("../src/api/controllers/seedance");

test("Flash resolves the observed official key and its own resolution/duration catalog", async () => {
  expect(getStaticModelReqKey(model, "video")).toBe("dreamina_seedance_45_flash");
  const models = await fetchVideoModelConfigs("synthetic-only", true);
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({ id: model, modelReqKey: "dreamina_seedance_45_flash", supportedResolutions: ["480p", "720p"], source: "dynamic" });
  expect(models[0].supportedDurations).toEqual(Array.from({ length: 27 }, (_, index) => index + 4));
});

test("Flash uses separate with-video and no-video commerce branches and rejects a Pro branch", () => {
  for (const resolution of ["480p", "720p"]) for (const hasVideo of [false, true]) {
    expect(seedanceVideoBenefit(model, resolution, hasVideo, raw)).toBe(`seedance_25_flash_${resolution}_${hasVideo ? "output" : "no_input_video"}`);
  }
  expect(seedanceVideoBenefit(model, "1080p", false, raw)).toBeUndefined();
  expect(seedanceVideoBenefit(model, "720p", true, { ...raw, model_req_key: "dreamina_seedance_45_pro" })).toBeUndefined();
  const wrong = structuredClone(raw); wrong.commercial_config.resolution_price_configs[1].price.benefit_type = "seedance_25_720p_output";
  expect(seedanceVideoBenefit(model, "720p", true, wrong)).toBeUndefined();
});

test("Flash rejects unsupported quality and excess material counts before submission", () => {
  const input = { model, prompt: "test", ratio: "16:9", resolution: "720p", duration: 30, references: [] };
  expect(seedanceInput(input).model).toBe(model);
  expect(SEEDANCE_MODELS[model]).toMatchObject({ images: 10, videos: 5, audios: 5, total: 20 });
  expect(() => seedanceInput({ ...input, resolution: "1080p" })).toThrow();
  expect(() => seedanceInput({ ...input, duration: 31 })).toThrow();
  expect(() => seedanceInput({ ...input, references: Array.from({ length: 11 }, () => ({ kind: "image", url: "data:image/png;base64,AAAA" })) })).toThrow();
  expect(() => seedanceInput({ ...input, references: Array.from({ length: 6 }, () => ({ kind: "video", url: "https://fixture.tos-cn-beijing.volces.com/test.mp4" })) })).toThrow();
});

test("the frozen quote is followed by one Flash draft submission with the original hooks", async () => {
  const order: string[] = [];
  await submitSeedanceVideo({ model, prompt: "test", ratio: "16:9", resolution: "720p", duration: 6, references: [] }, "synthetic-only", { beforeSubmit: () => {}, onQuoted: async () => { order.push("quote"); }, onSubmitting: () => { order.push("submit"); }, onSubmitted: (id) => { order.push(id); } });
  expect(order).toEqual(["quote", "submit", "synthetic-history"]); expect(submissions).toHaveLength(1);
  expect(submissions[0].extend.root_model).toBe("dreamina_seedance_45_flash");
  expect(submissions[0].extend.m_video_commerce_info.benefit_type).toBe("seedance_25_flash_720p_no_input_video");
  const draft = JSON.parse(submissions[0].draft_content), params = draft.component_list[0].abilities.gen_video.text_to_video_params;
  expect(params.model_req_key).toBe("dreamina_seedance_45_flash"); expect(params.video_gen_inputs[0]).toMatchObject({ duration_ms: 6000, resolution: "720p", fps: 24 });
});
