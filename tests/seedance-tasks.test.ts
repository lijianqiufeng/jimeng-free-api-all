import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import axios from "axios";
import { VodService } from "@volcengine/openapi/lib/services/vod/index.js";
import models from "./fixtures/seedance-models.json";
import { database, createApiKey, validateApiKey } from "@/lib/database.ts";
import pool from "@/lib/account-pool.ts";
import { createTask, queryTask, cancelTask } from "@/api/controllers/tasks.ts";
import { taskInput, taskResult } from "@/api/controllers/task-contract.ts";
import { resolveVideoModelConfig } from "@/api/controllers/models.ts";
import { submitSeedanceVideo } from "@/api/controllers/seedance.ts";
import { seedanceInput } from "@/api/controllers/seedance-contract.ts";
import { generateVideo, generateVideoWithRetry } from "@/api/controllers/videos.ts";

let submits = 0, fail = "", draft: any, payload: any, historyStatus = 50, historyCookie = "", fetchFails = false, uploaded = 0;
globalThis.fetch = async url => {
  assert.match(String(url), /^https:\/\/fixture\.tos-cn-beijing\.volces\.com\//);
  if (fetchFails) throw Error("mock reference outage");
  return new Response(new Uint8Array(20), { headers: { "content-length": "20" } });
};
VodService.prototype.UploadMedia = async (input: any) => { for await (const _chunk of input.Content) {} return { Result: { Data: { Vid: "fixture-vid", SourceInfo: { Duration: 3, Width: 1280, Height: 720, Fps: 24 } } } } as any; };
axios.defaults.adapter = async config => {
  const url = String(config.url), ok = (data: unknown) => ({ data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config });
  const raw = (data: unknown) => ({ ...ok(data), data });
  if (url.includes("Action=ApplyImageUpload")) return raw({ Result: { UploadAddress: { UploadHosts: ["upload.test"], StoreInfos: [{ StoreUri: `frame-${uploaded + 1}`, Auth: "fake" }], SessionKey: "fake" } } });
  if (url.startsWith("https://upload.test/")) { uploaded++; return raw({ code: 2000 }); }
  if (url.includes("Action=CommitImageUpload")) return raw({ Result: { Results: [{ Uri: `frame-${uploaded}` }] } });
  if (url.endsWith("/video_generate/get_common_config")) return ok({ models });
  if (url.endsWith("/get_common_config")) return ok({});
  if (url.endsWith("/user_credit")) return ok({ credit: { gift_credit: 500, purchase_credit: 0, vip_credit: 0 } });
  if (url.includes("/passport/account/info/v2")) return ok({ user_info: { is_vip: true } });
  if (new URL(url).pathname.endsWith("/get_upload_token")) return ok({ access_key_id: "fake", secret_access_key: "fake", session_token: "fake", space_name: "fake" });
  if (url.endsWith("/aigc_draft/generate")) {
    submits++; payload = JSON.parse(String(config.data)); draft = JSON.parse(payload.draft_content);
    if (fail === "timeout") throw Object.assign(Error("timeout"), { code: "ETIMEDOUT" });
    if (fail) return { ...ok({}), data: { ret: fail, errmsg: "private failure" } };
    return ok({ aigc_data: { history_record_id: `history-${submits}` } });
  }
  if (url.endsWith("/get_history_by_ids")) {
    historyCookie = String(config.headers?.Cookie || config.headers?.cookie || "");
    const id = JSON.parse(String(config.data)).history_ids[0];
    return ok({ [id]: { status: historyStatus, item_list: [{ video: { transcoded_video: { origin: { video_url: "https://result.test/output.mp4" } } } }] } });
  }
  throw Error(`unmocked network: ${new URL(url).pathname}`);
};
const key = createApiKey("isolated video"), owner = validateApiKey(key.key).apiKeyId!, auth = `Bearer ${key.key}`;
pool.create({ name: "video", sessionId: "fixed-video-account" });
const base = { model: "jimeng-video-seedance-2.5", prompt: "蓝色小球滚动", ratio: "16:9", resolution: "720p", duration: 4, references: [] };
const get = (id: string) => database.prepare("SELECT * FROM canvas_tasks WHERE id=?").get(id) as any;
async function waitFor(id: string, status: string) {
  const end = Date.now() + 3000;
  while (get(id)?.status !== status && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  assert.equal(get(id)?.status, status);
}

test("four official models use dynamic resolutions, frame counts and ordinary commerce", async () => {
  const expected = [
    ["jimeng-video-seedance-2.5", "dreamina_seedance_45_pro", ["480p", "720p", "1080p"], 30],
    ["jimeng-video-seedance-2.0-mini", "dreamina_seedance_40_mini", ["720p"], 15],
    ["jimeng-video-seedance-2.0-fast-vip", "dreamina_seedance_40_vision", ["720p"], 15],
    ["jimeng-video-seedance-2.0-vip", "dreamina_seedance_40_pro_vision", ["720p", "1080p", "4k"], 15],
  ] as const;
  for (const [model, req, resolutions, max] of expected) {
    const config = await resolveVideoModelConfig(model, "fixed-video-account");
    assert.equal(config.modelReqKey, req);
    assert.deepEqual(config.supportedResolutions, resolutions);
    assert.ok(config.supportedDurations.includes(4) && config.supportedDurations.includes(max));
    assert.ok(!config.benefits["720p"].includes("long_video"));
    await assert.rejects(generateVideo(model, "fixture", {}, "fixed-video-account"), /\/v1\/tasks/);
    await assert.rejects(generateVideoWithRetry(req, "fixture", {}, "fixed-video-account"), /\/v1\/tasks/);
    const id = `video_fixture_${model.replaceAll(".", "_")}`;
    const input = { ...base, model, id };
    const before = submits;
    await Promise.all([createTask(owner, auth, input), createTask(owner, auth, input)]);
    await waitFor(id, "running");
    assert.equal(submits, before + 1);
    const params = draft.component_list[0].abilities.gen_video.text_to_video_params;
    assert.equal(params.model_req_key, req);
    assert.equal(params.video_gen_inputs[0].duration_ms, 4000);
    assert.equal(params.video_gen_inputs[0].resolution, "720p");
    assert.ok(!payload.extend.m_video_commerce_info.benefit_type.includes("long_video"));
    if (max === 30) assert.equal(payload.extend.m_video_commerce_info.benefit_type, "seedance_25_720p_no_input_video_output");
    assert.equal((await queryTask(owner + 1, id)).status, 404);
    database.prepare("UPDATE canvas_tasks SET deadline=? WHERE id=?").run(Date.now() - 1, id);
    historyStatus = 20;
    assert.equal((await queryTask(owner, id)).body.status, "running");
    assert.ok(get(id).credential, "超时仍保留已受理视频的查询凭据");
    historyStatus = 50;
    database.prepare("UPDATE canvas_tasks SET checked_at=0 WHERE id=?").run(id);
    assert.equal((await queryTask(owner, id)).body.status, "succeeded");
    assert.ok(historyCookie.includes("fixed-video-account"));
    assert.equal((await createTask(owner, auth, input)).body.status, "succeeded");
    assert.equal(submits, before + 1);
  }
});
test("unsupported parameters and internal URLs fail before any paid request", () => {
  for (const change of [{ duration: -1 }, { n: 2 }, { resolution: "4k" }, { ratio: "adaptive" }, { model: "jimeng-video-seedance-2.0-mini", duration: 30 }, { references: [{ kind: "video", url: "http://127.0.0.1/private" }] }]) assert.throws(() => taskInput({ ...base, id: "video_invalid_12345", ...change }));
  assert.equal(taskResult({ a: { status: 40 } }, "a", "video").status, "failed");
});
test("all multimodal references must upload, preserving material order", async () => {
  const image = `data:image/png;base64,${readFileSync("tests/fixtures/seedance-reference.png").toString("base64")}`;
  const references = [{ kind: "image", url: image }, { kind: "image", url: image }, { kind: "video", url: "https://fixture.tos-cn-beijing.volces.com/a.mp4" }, { kind: "audio", url: "https://fixture.tos-cn-beijing.volces.com/a.mp3" }];
  let submitted = "";
  await submitSeedanceVideo(seedanceInput({ ...base, references }), "fixed-video-account", { beforeSubmit() {}, onSubmitted(id) { submitted = id; } });
  assert.ok(submitted);
  const unified = draft.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0].unified_edit_input;
  assert.deepEqual(unified.material_list.map((x: any) => x.material_type), ["image", "image", "video", "audio"]);
  assert.deepEqual(unified.meta_list.slice(0, 4).map((x: any) => x.material_ref.material_idx), [0, 1, 2, 3]);
  assert.deepEqual(unified.material_list.slice(0, 2).map((x: any) => [x.image_info.image_uri, x.image_info.width, x.image_info.height]), [["frame-1", 512, 512], ["frame-2", 512, 512]]);
  assert.equal(payload.extend.m_video_commerce_info.benefit_type, "seedance_25_720p_output");
  const before = submits; fetchFails = true;
  await assert.rejects(submitSeedanceVideo(seedanceInput({ ...base, references }), "fixed-video-account", { beforeSubmit() {}, onSubmitted() { assert.fail(); } }));
  fetchFails = false; assert.equal(submits, before);
});
test("cancel before POST cannot dispatch; ambiguous errors and 4013 never retry", async () => {
  const canceled = "video_cancel_1234567890", before = submits;
  cancelTask(owner, canceled);
  assert.equal((await createTask(owner, auth, { ...base, id: canceled })).status, 409);
  assert.equal(submits, before);
  for (const failure of ["timeout", "4013"]) {
    fail = failure; const id = `video_failure_${failure}_1234567890`, input = { ...base, id };
    await createTask(owner, auth, input); await waitFor(id, "failed");
    const count = submits;
    await createTask(owner, auth, input); await queryTask(owner, id);
    assert.equal(submits, count);
    assert.ok(!JSON.stringify((await queryTask(owner, id)).body).includes("private failure"));
  }
  fail = "";
});
