import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import childProcess from "node:child_process";
import axios from "axios";
import CRC32 from "crc-32";
import aws4 from "aws4";
import { seedanceUploadUser, uploadSeedanceReference } from "@/api/controllers/seedance-upload.ts";

let media = Buffer.alloc(20), failed = "", fps = "30/1", duration = 3, probePath = "", declared = 20, metaMismatch = false, userReply: unknown;
const exactUserId = "1234567890123456789";
const phases: string[] = [], transfers: Buffer[] = [];
globalThis.fetch = async () => new Response(media, { headers: { "content-length": String(declared), "content-type": "video/mp4" } });
childProcess.execFile = ((_file: string, args: string[], _options: unknown, callback: Function) => {
  assert.equal(_file, "ffprobe"); probePath = args.at(-1)!;
  callback(failed === "probe" ? Object.assign(Error("private probe output"), { code: "ENOENT" }) : null, JSON.stringify({ format: { duration }, streams: [{ codec_type: "video", width: 1280, height: 720, avg_frame_rate: fps }, { codec_type: "audio" }] }));
  const child = { once(event: string, handler: Function) { if (event === "close") queueMicrotask(() => handler(failed === "probe" ? 1 : 0)); return child; } };
  return child;
}) as any;
axios.defaults.adapter = async config => {
  const url = new URL(String(config.url)), phase = url.searchParams.get("Action") || url.searchParams.get("phase") || (url.pathname.includes("/passport/account/info/v2") ? "user" : "token");
  phases.push(phase);
  if (failed === phase) throw Object.assign(Error("private https://signed.example/s?secret=test"), { response: { status: 403, data: { secret: "private" } } });
  const data = phase === "user" ? userReply
    : phase === "token" ? { ret: "0", data: { access_key_id: "fixture-ak", secret_access_key: "fixture-sk", session_token: "fixture-sts", space_name: "fixture-space" } }
    : phase === "ApplyUploadInner" ? { ResponseMetadata: {}, Result: { InnerUploadAddress: { UploadNodes: [{ UploadHost: "fixture-upload.test", UploadHeader: { "X-Fixture": "yes" }, SessionKey: "fixture-session", StoreInfos: [{ StoreUri: "fixture/store", Auth: "fixture-store-auth" }] }] } } }
    : phase === "init" ? { code: 2000, data: { uploadid: "fixture-upload-id" } }
    : phase === "finish" ? { code: 2000, data: { key: "fixture/store" } }
    : phase === "CommitUploadInner" ? { ResponseMetadata: {}, Result: { Results: [{ Vid: "fixture-vid", VideoMeta: { Duration: metaMismatch ? 100 : duration, Width: 1280, Height: 720 } }] } }
    : { code: 2000 };
  if (["ApplyUploadInner", "CommitUploadInner"].includes(phase)) {
    assert.equal(url.hostname, "vod.bytedanceapi.com"); assert.equal(url.searchParams.get("Version"), "2020-11-19");
    assert.match(String(config.headers?.Authorization), /^AWS4-HMAC-SHA256 Credential=fixture-ak\/[0-9]{8}\/cn-north-1\/vod\/aws4_request,/);
  } else if (!["token", "user"].includes(phase)) {
    assert.equal(config.method, "post"); assert.equal(url.pathname, "/upload/v1/fixture/store");
    assert.equal(config.headers?.["X-Fixture"], "yes"); assert.equal(config.headers?.Authorization, "fixture-store-auth");
    assert.equal(config.headers?.["X-Storage-U"], "12345678");
  }
  if (phase === "transfer") {
    const chunk = Buffer.from(config.data as any); transfers.push(chunk);
    assert.equal(config.headers?.["Content-CRC32"], (CRC32.buf(chunk) >>> 0).toString(16).padStart(8, "0"));
    assert.equal(url.searchParams.get("part_number"), String(transfers.length));
  }
  if (phase === "finish") assert.equal(String(config.data), transfers.map((chunk, index) => `${index + 1}:${(CRC32.buf(chunk) >>> 0).toString(16).padStart(8, "0")}`).join(","));
  if (phase === "CommitUploadInner") assert.deepEqual(JSON.parse(String(config.data)).Functions, [{ name: "GetMeta" }]);
  return { data, status: 200, statusText: "OK", headers: {}, config };
};
const ref = { kind: "video" as const, url: "https://fixture.tos-cn-beijing.volces.com/reference.mp4" };
const reset = () => { media = Buffer.alloc(20); failed = ""; fps = "30/1"; duration = 3; declared = 20; probePath = ""; metaMismatch = false; userReply = { message: "success", data: { user_id: Number(exactUserId), user_id_str: exactUserId } }; phases.length = 0; transfers.length = 0; };

test("upstream upload identity must be a confirmed user_id and failure is safe", async () => {
  for (const reply of [
    { message: "success", data: { user_id: Number(exactUserId), user_id_str: exactUserId } },
    { ret: "0", data: { user_id: Number(exactUserId), user_id_str: exactUserId } },
    { user_id_str: exactUserId, user_id: Number(exactUserId) },
  ]) {
    reset(); userReply = reply;
    assert.equal(await seedanceUploadUser("fixture-session", "video", () => {}), exactUserId);
    assert.deepEqual(phases, ["user"]);
  }
  for (const invalid of [undefined, "", "signed=https://private.example", 9007199254740992]) {
    reset(); userReply = { message: "success", data: { user_id: invalid } };
    await assert.rejects(seedanceUploadUser("fixture-session", "audio", () => {}), /参考音频账号身份未确认，未提交生成/);
    assert.deepEqual(phases, ["user"]);
  }
  reset(); userReply = { message: "success", data: { user_id: 12345678, user_id_str: "invalid" } };
  await assert.rejects(seedanceUploadUser("fixture-session", "video", () => {}), /账号身份未确认/);
  reset(); failed = "user";
  await assert.rejects(seedanceUploadUser("fixture-session", "video", () => {}), (error: any) => error.phase === "user" && error.code === "HTTP_403" && !error.message.includes("private"));
});

test("Inner video and audio uploads validate original media, accept VideoMeta without FPS and clean temporary files", async () => {
  for (const kind of ["video", "audio"] as const) {
    reset();
    const result = await uploadSeedanceReference("fixture-session", { ...ref, kind }, 15, () => {}, "12345678");
    assert.equal(result.vid, "fixture-vid"); assert.equal(result.duration, 3000);
    assert.equal(result.fps, kind === "video" ? 30 : undefined);
    assert.deepEqual(phases, ["token", "ApplyUploadInner", "init", "transfer", "finish", "CommitUploadInner"]);
    assert.equal(existsSync(probePath), false);
  }
});
test("multipart sends each original byte exactly once and finishes ordered CRC32 list", async () => {
  reset(); media = Buffer.alloc(5 * 1024 * 1024 + 37, 91); declared = media.length;
  await uploadSeedanceReference("fixture-session", ref, 15, () => {}, "12345678");
  assert.deepEqual(transfers.map(chunk => chunk.length), [5 * 1024 * 1024, 37]);
  assert.deepEqual(Buffer.concat(transfers), media); assert.equal(existsSync(probePath), false);
});
test("original size, duration and FPS errors stop before requesting any upload credential", async () => {
  for (const invalid of ["size", "fps", "duration", "probe"]) {
    reset();
    if (invalid === "size") declared = 50 * 1024 * 1024 + 1;
    if (invalid === "fps") fps = "10/1";
    if (invalid === "duration") duration = 20;
    if (invalid === "probe") failed = "probe";
    await assert.rejects(uploadSeedanceReference("fixture-session", ref, 15, () => {}, "12345678"), /参考视频.*，未提交生成/);
    assert.deepEqual(phases, []); if (probePath) assert.equal(existsSync(probePath), false);
  }
});
test("every failed Inner upload phase is safe, terminal and cleans its temporary original", async () => {
  for (const phase of ["token", "ApplyUploadInner", "init", "transfer", "finish", "CommitUploadInner"]) {
    reset(); failed = phase;
    await assert.rejects(uploadSeedanceReference("fixture-session", ref, 15, () => {}, "12345678"), (error: any) => {
      assert.match(error.message, /^参考视频.*失败，未提交生成$/);
      assert.equal(error.code, "HTTP_403");
      assert.ok(!JSON.stringify(error).includes("private")); assert.ok(!error.message.includes("https://")); return true;
    });
    assert.equal(existsSync(probePath), false);
    assert.equal(phases.filter(item => item === phase).length, 1);
    assert.equal(phases.at(-1), phase);
  }
});

test("a reference shorter than two seconds gives its exact duration without uploading; exactly two is accepted", async () => {
  reset(); duration = 1.999;
  await assert.rejects(uploadSeedanceReference("fixture-session", ref, 30, () => {}, "12345678"), /时长 1.999 秒，不足即梦要求的 2 秒.*未提交生成/);
  assert.deepEqual(phases, []); assert.equal(existsSync(probePath), false);
  reset(); duration = 2;
  assert.equal((await uploadSeedanceReference("fixture-session", ref, 30, () => {}, "12345678")).duration, 2000);
});
test("mismatched uploaded metadata and cancellation do not proceed beyond the original upload", async () => {
  reset(); metaMismatch = true;
  await assert.rejects(uploadSeedanceReference("fixture-session", ref, 15, () => {}, "12345678"), /与原素材不符/);
  reset();
  await assert.rejects(uploadSeedanceReference("fixture-session", ref, 15, () => { if (phases.includes("init")) throw Error("canceled"); }, "12345678"), /未提交生成/);
  assert.ok(!phases.includes("transfer")); assert.equal(existsSync(probePath), false);
});
test("mature AWS4 signer matches the published fixed IAM signing example", () => {
  const result = aws4.sign({ host: "iam.amazonaws.com", path: "/?Action=ListUsers&Version=2010-05-08", method: "GET", service: "iam", region: "us-east-1", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", "X-Amz-Date": "20150830T123600Z" } }, { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" });
  assert.equal(result.headers.Authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
});
