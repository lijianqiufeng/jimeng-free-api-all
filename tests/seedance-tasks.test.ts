import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import childProcess from "node:child_process";
import axios from "axios";
import CRC32 from "crc-32";
import models from "./fixtures/seedance-models.json";
import standardModel from "./fixtures/seedance20-model.json";
import { database, createApiKey, validateApiKey } from "@/lib/database.ts";
import pool from "@/lib/account-pool.ts";
import { createTask, queryTask, cancelTask } from "@/api/controllers/tasks.ts";
import { taskInput, taskResult } from "@/api/controllers/task-contract.ts";
import { resolveVideoModelConfig } from "@/api/controllers/models.ts";
import { submitSeedanceVideo } from "@/api/controllers/seedance.ts";
import { seedanceInput } from "@/api/controllers/seedance-contract.ts";
import { generateVideo, generateVideoWithRetry } from "@/api/controllers/videos.ts";

let submits = 0, fail = "", draft: any, payload: any, historyStatus = 50, historyCookie = "", fetchFails = false, uploaded = 0, userReads = 0;
const vodStages: string[] = [];
childProcess.execFile = ((_file: string, _args: string[], _options: unknown, callback: Function) => callback(null, JSON.stringify({ format: { duration: 3 }, streams: [{ codec_type: "video", width: 1280, height: 720, avg_frame_rate: "24/1" }, { codec_type: "audio" }] }))) as any;
globalThis.fetch = async url => {
  assert.match(String(url), /^https:\/\/fixture\.tos-cn-beijing\.volces\.com\//);
  if (fetchFails) throw Error("mock reference outage");
  return new Response(new Uint8Array(20), { headers: { "content-length": "20" } });
};
axios.defaults.adapter = async config => {
  const url = String(config.url), ok = (data: unknown) => ({ data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config });
  const raw = (data: unknown) => ({ ...ok(data), data });
  const parsed = new URL(url), action = parsed.searchParams.get("Action");
  if (parsed.hostname === "vod.bytedanceapi.com") {
    assert.equal(parsed.searchParams.get("Version"), "2020-11-19");
    assert.equal(parsed.searchParams.get("SpaceName"), "fake");
    assert.match(String(config.headers?.Authorization), /^AWS4-HMAC-SHA256 Credential=fake\/[0-9]{8}\/cn-north-1\/vod\/aws4_request,/);
    assert.ok(config.headers?.["X-Amz-Security-Token"]);
    vodStages.push(action!);
    if (action === "ApplyUploadInner") {
      assert.equal(parsed.searchParams.get("FileType"), "video"); assert.equal(parsed.searchParams.get("IsInner"), "1");
      return raw({ ResponseMetadata: {}, Result: { InnerUploadAddress: { UploadNodes: [{ UploadHost: "vod-upload.test", SessionKey: "fixture-session", StoreInfos: [{ StoreUri: "fixture-path", Auth: "fixture-auth" }] }] } } });
    }
    assert.equal(action, "CommitUploadInner");
    assert.deepEqual(JSON.parse(String(config.data)), { SessionKey: "fixture-session", Functions: [{ name: "GetMeta" }] });
    return raw({ ResponseMetadata: {}, Result: { Results: [{ Vid: "fixture-vid", VideoMeta: { Duration: 3, Width: 1280, Height: 720 } }] } });
  }
  if (parsed.hostname === "vod-upload.test") {
    assert.equal(config.method, "post"); assert.equal(parsed.pathname, "/upload/v1/fixture-path");
    assert.equal(config.headers?.["X-Storage-U"], "1234567890123456789");
    const phase = parsed.searchParams.get("phase"); vodStages.push(phase!);
    if (phase === "init") return raw({ code: 2000, data: { uploadid: "fixture-id" } });
    assert.equal(parsed.searchParams.get("uploadid"), "fixture-id");
    if (phase === "transfer") { assert.equal(config.headers?.["Content-CRC32"], (CRC32.buf(Buffer.from(config.data as any)) >>> 0).toString(16).padStart(8, "0")); return raw({ code: 2000 }); }
    assert.equal(phase, "finish"); assert.match(String(config.data), /^1:[a-f0-9]{8}$/);
    return raw({ code: 2000, data: { key: "fixture-path" } });
  }
  if (url.includes("Action=ApplyImageUpload")) return raw({ Result: { UploadAddress: { UploadHosts: ["upload.test"], StoreInfos: [{ StoreUri: `frame-${uploaded + 1}`, Auth: "fake" }], SessionKey: "fake" } } });
  if (url.startsWith("https://upload.test/")) { uploaded++; return raw({ code: 2000 }); }
  if (url.includes("Action=CommitImageUpload")) return raw({ Result: { Results: [{ Uri: `frame-${uploaded}` }] } });
  if (url.endsWith("/video_generate/get_common_config")) return ok({ models: [...models, standardModel] });
  if (url.endsWith("/get_common_config")) return ok({});
  if (url.endsWith("/user_credit")) return ok({ credit: { gift_credit: 500, purchase_credit: 0, vip_credit: 0 } });
  if (url.includes("/passport/account/info/v2")) { userReads++; return raw({ message: "success", data: { user_id: 1234567890123456789, user_id_str: "1234567890123456789", user_info: { is_vip: true } } }); }
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
pool.create({ name: "video_高级", sessionId: "fixed-video-account" });
const base = { model: "jimeng-video-seedance-2.5", prompt: "蓝色小球滚动", ratio: "16:9", resolution: "720p", duration: 4, references: [] };
const get = (id: string) => database.prepare("SELECT * FROM canvas_tasks WHERE id=?").get(id) as any;
async function waitFor(id: string, status: string) {
  const end = Date.now() + 3000;
  while (get(id)?.status !== status && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  assert.equal(get(id)?.status, status);
}

test("five official models use dynamic resolutions, frame counts and ordinary commerce", async () => {
  const expected = [
    ["jimeng-video-seedance-2.0", "dreamina_seedance_40_pro", ["720p"], 15],
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
    if (model === "jimeng-video-seedance-2.0") assert.equal(payload.extend.m_video_commerce_info.benefit_type, "dreamina_video_seedance_20_pro");
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

test("standard 2.0 uses the official reference-video commerce branch and rejects unsupported settings", async () => {
  const model = "jimeng-video-seedance-2.0", image = "data:image/png;base64," + readFileSync("tests/fixtures/seedance-reference.png").toString("base64");
  const references = [{ kind: "image", url: image }, { kind: "image", url: image }, { kind: "video", url: "https://fixture.tos-cn-beijing.volces.com/a.mp4" }, { kind: "audio", url: "https://fixture.tos-cn-beijing.volces.com/a.mp3" }];
  const before = submits, previousUploads = uploaded;
  await submitSeedanceVideo(seedanceInput({ ...base, model, references }), "fixed-video-account", { beforeSubmit() {}, onSubmitted() {} });
  assert.equal(submits, before + 1);
  assert.equal(payload.extend.m_video_commerce_info.benefit_type, "dreamina_video_seedance_20_video_add");
  assert.deepEqual(payload.extend.m_video_commerce_info_list, [payload.extend.m_video_commerce_info]);
  const input = draft.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0].unified_edit_input;
  assert.deepEqual(input.material_list.map((m: any) => m.material_type), ["image", "image", "video", "audio"]);
  assert.deepEqual(input.meta_list.slice(0, 4).map((m: any) => m.material_ref.material_idx), [0, 1, 2, 3]);
  assert.equal(uploaded, previousUploads + 2);
  assert.throws(() => seedanceInput({ ...base, model, resolution: "1080p" }));
  assert.throws(() => seedanceInput({ ...base, model, duration: 16 }));
  assert.throws(() => seedanceInput({ ...base, model, references: Array(10).fill(references[0]) }));
  await assert.rejects(generateVideoWithRetry("seedance-2.0-pro", "fixture", {}, "fixed-video-account"), /\/v1\/tasks/);
  const commercial = standardModel.commercial_config;
  try {
    standardModel.commercial_config = {} as any;
    await assert.rejects(submitSeedanceVideo(seedanceInput({ ...base, model }), "new-no-commerce-fixture", { beforeSubmit() {}, onSubmitting() { assert.fail(); }, onSubmitted() { assert.fail(); } }), /计费项未确认/);
  } finally { standardModel.commercial_config = commercial; }
  assert.equal(submits, before + 1);
});
test("unsupported parameters and internal URLs fail before any paid request", () => {
  for (const change of [{ duration: -1 }, { n: 2 }, { resolution: "4k" }, { ratio: "adaptive" }, { model: "jimeng-video-seedance-2.0-mini", duration: 30 }, { references: [{ kind: "video", url: "http://127.0.0.1/private" }] }]) assert.throws(() => taskInput({ ...base, id: "video_invalid_12345", ...change }));
  assert.equal(taskResult({ a: { status: 40 } }, "a", "video").status, "failed");
});
test("all multimodal references must upload, preserving material order", async () => {
  const image = `data:image/png;base64,${readFileSync("tests/fixtures/seedance-reference.png").toString("base64")}`;
  const references = [{ kind: "image", url: image }, { kind: "image", url: image }, { kind: "video", url: "https://fixture.tos-cn-beijing.volces.com/a.mp4" }, { kind: "audio", url: "https://fixture.tos-cn-beijing.volces.com/a.mp3" }];
  let submitted = "";
  vodStages.length = 0;
  const previousReads = userReads, previousUploads = uploaded;
  let submitting = 0;
  await submitSeedanceVideo(seedanceInput({ ...base, references }), "fixed-video-account", { beforeSubmit() {}, onSubmitting() { submitting++; assert.equal(vodStages.at(-1), "CommitUploadInner"); }, onSubmitted(id) { submitted = id; } });
  assert.ok(submitted);
  assert.equal(submitting, 1);
  assert.equal(userReads, previousReads + 1, "全部参考音视频复用一次真实账号 UID 查询");
  assert.deepEqual(vodStages, ["ApplyUploadInner", "init", "transfer", "finish", "CommitUploadInner", "ApplyUploadInner", "init", "transfer", "finish", "CommitUploadInner"]);
  const unified = draft.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0].unified_edit_input;
  assert.deepEqual(unified.material_list.map((x: any) => x.material_type), ["image", "image", "video", "audio"]);
  assert.deepEqual(unified.meta_list.slice(0, 4).map((x: any) => x.material_ref.material_idx), [0, 1, 2, 3]);
  assert.deepEqual(unified.material_list.slice(0, 2).map((x: any) => [x.image_info.image_uri, x.image_info.width, x.image_info.height]), [[`frame-${previousUploads + 1}`, 512, 512], [`frame-${previousUploads + 2}`, 512, 512]]);
  assert.equal(payload.extend.m_video_commerce_info.benefit_type, "seedance_25_720p_output");
  const before = submits; fetchFails = true;
  await assert.rejects(submitSeedanceVideo(seedanceInput({ ...base, references }), "fixed-video-account", { beforeSubmit() {}, onSubmitting() { assert.fail(); }, onSubmitted() { assert.fail(); } }), /参考视频读取失败，未提交生成/);
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
