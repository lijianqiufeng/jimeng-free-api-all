import assert from "node:assert/strict";
import { after, test } from "node:test";
import axios from "axios";

if (process.env.NODE_ENV !== "test" || !process.env.DB_PATH?.includes("cpa-video-queue-test-") || process.env.DATA_DIR !== process.env.DB_PATH?.replace(/[\\/]queue.sqlite$/, "")) throw Error("Isolated mock environment required before importing business modules");
const calls: string[] = [];
let mode = "valid", clock = Date.now();
const originalNow = Date.now;
Date.now = () => clock;
const specs = [
  ["dreamina_seedance_40_pro", "jimeng-video-seedance-2.0", ["720p"]],
  ["dreamina_seedance_45_pro", "jimeng-video-seedance-2.5", ["480p", "720p", "1080p"]],
  ["dreamina_seedance_45_pro_draft", "jimeng-video-seedance-2.5-draft", ["480p"]],
  ["dreamina_seedance_40_mini", "jimeng-video-seedance-2.0-mini", ["720p"]],
  ["dreamina_seedance_40_vision", "jimeng-video-seedance-2.0-fast-vip", ["720p"]],
  ["dreamina_seedance_40_pro_vision", "jimeng-video-seedance-2.0-vip", ["720p", "1080p", "4k"]],
] as const;
const benefit = (id: string, resolution: string) => `${id.replaceAll("-", "_")}_${resolution}`;
const videoBenefit = (id: string, resolution: string, hasVideo: boolean) => id === "jimeng-video-seedance-2.5-draft" ? `seedance_25_draft_480p_${hasVideo ? "output" : "no_input_video_output"}` : mode === "super-promotion" && id === "jimeng-video-seedance-2.5" && resolution === "720p" && hasVideo ? "seedance_25_720p_output" : `${benefit(id, resolution)}${hasVideo ? "" : "_no_video"}`;
axios.defaults.adapter = async config => {
  const pathname = new URL(String(config.url)).pathname, payload = JSON.parse(String(config.data || "{}"));
  assert.ok(!String(config.headers?.Cookie).includes("fixture-excluded-advanced"), "advanced accounts must not enter the new video quote pool");
  calls.push(pathname);
  const ok = (data: unknown) => ({ data: { ret: "0", data }, status: 200, statusText: "OK", headers: {}, config });
  if (pathname.endsWith("/video_generate/get_common_config")) return ok({ models: specs.map(([key, id, resolutions]) => ({ model_req_key: key, model_status: 0, ...(id === "jimeng-video-seedance-2.5-draft" ? { extra: { is_draft_mode: true } } : {}), options: [{ key: "resolution", enum_val: { string_value: resolutions } }, { key: "frames", enum_val: { int_value: [96, 120] } }], commercial_config: { default: { benefit_type: "normal_output", amount: 0 }, format_conf: { unified_edit_input_video: { benefit_type: "normal_video", amount: 0 } }, resolution_price_configs: id === "jimeng-video-seedance-2.0" ? [] : resolutions.map(resolution => ({ resolution, price: { benefit_type: videoBenefit(id, resolution, true), amount: 0 }, no_input_video_price: { benefit_type: videoBenefit(id, resolution, false), amount: 0 } })) } })) });
  assert.deepEqual(payload.query_list[0].resource_type, "aigc");
  assert.deepEqual(payload.query_list[0].resource_id, "generate_video");
  const types = payload.query_list[0].benefit_type_list;
  if (pathname.endsWith("/benefit_metadata")) return ok({ metadata_list: [{ resource_type: "aigc", resource_id: "generate_video", benefits_pay_strategy: types.map((type: string) => ({ benefit_type: type, unit: mode === "wrong-unit" ? "count" : "second", credit_strategy: { credit_limits: [{ role: "standard" }], credit_pricing_info: { min_charge_cnt: 1, credit_unit_price: type.startsWith("seedance_25_draft") ? 9 : type === "seedance_25_720p_output" ? String(config.headers?.Cookie).includes("fixture2") ? 26 : 13 : type.endsWith("no_video") ? 20 : type === "normal_output" ? 3 : type === "normal_video" ? 6 : String(config.headers?.Cookie).includes("fixture2") ? 8 : 6, original_credit_unit_price: type.startsWith("seedance_25_draft") ? 12 : 26 } } })) }] });
  if (pathname.endsWith("/batch_get_user_benefit")) return ok({ asset_list: types.map((type: string) => ({ resource_type: "aigc", resource_id: "generate_video", benefit_type: type, asset_details: [{ pay_mode: "UserCredit", role: mode === "wrong-role" ? "other" : "standard" }, { pay_mode: "LimitFree", role: "all", quota_all: 0, quota_left: 0 }] })), credits_detail: { private_fixture: true } });
  throw Error(`Unmocked network ${pathname}`);
};
const { database, createApiKey } = await import("../src/lib/database.ts");
const pool = await import("../src/lib/account-pool.ts");
pool.setMembershipStatusProvider(undefined);
const key = createApiKey("quote fixture"), auth = `Bearer ${key.key}`;
const account = pool.createAccount({ name: "13800005777_超级", sessionId: "fixture1" });
database.prepare("UPDATE jimeng_accounts SET total_credit=100 WHERE id=?").run(account.id);
const { quoteVideo, videoQuoteInput, freezeVideoQuote } = await import("../src/api/controllers/video-quote.ts");
const input = { model: "jimeng-video-seedance-2.5", resolution: "720p", duration: 4, hasVideo: false, referenceVideoSeconds: 0 };
after(() => { Date.now = originalNow; database.close(); });

test("official points quote uses output-duration credit strategy; account configuration zero is not free", async () => {
  const before = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all();
  const accountBefore = pool.listAccounts()[0];
  const quote = await quoteVideo(auth, input);
  assert.deepEqual(quote, { ...input, unit: "jimeng-credit", audioMode: "model-default", basis: "credit-strategy", accountPolicy: "super-only", status: "available", benefitType: "jimeng_video_seedance_2.5_720p_no_video", checkedAt: quote.checkedAt, chargeInputVideoDuration: true, chargedSecondsMin: 4, chargedSecondsMax: 4, creditsPerSecondMin: 20, creditsPerSecondMax: 20, estimatedCreditsMin: 80, estimatedCreditsMax: 80, originalCreditsPerSecondMin: 26, originalCreditsPerSecondMax: 26, originalEstimatedCreditsMin: 104, originalEstimatedCreditsMax: 104 });
  assert.deepEqual(before, database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all());
  assert.deepEqual(accountBefore, pool.listAccounts()[0], "quote creates no lease, account selection, cooldown, status or counters");
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='canvas_tasks'").get(), undefined);
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(quote).includes("fixture1"), false);
});

test("all employees and parameter changes share the same global readonly snapshot", async () => {
  const before = calls.length;
  const quotes = await Promise.all(Array.from({ length: 20 }, (_, i) => quoteVideo(auth, { ...input, hasVideo: Boolean(i % 2), referenceVideoSeconds: i % 2 ? 3 : 0 })));
  assert.equal(calls.length, before);
  assert.equal(quotes[1].estimatedCreditsMin, 42);
  assert.equal(quotes[1].chargedSecondsMin, 7);
  assert.equal((await quoteVideo(auth, { ...input, model: "jimeng-video-seedance-2.0" })).estimatedCreditsMin, 12);
  const ordinaryVideo = await quoteVideo(auth, { ...input, model: "jimeng-video-seedance-2.0", hasVideo: true, referenceVideoSeconds: 3 });
  assert.equal(ordinaryVideo.estimatedCreditsMin, 24);
  assert.equal(ordinaryVideo.chargeInputVideoDuration, false);
  assert.equal(ordinaryVideo.chargedSecondsMin, 4);
  assert.equal((await quoteVideo(auth, { ...input, hasVideo: true })).status, "unavailable", "unknown video duration cannot be silently priced as zero");
});

test("only super accounts enter quotes and genuine different super prices retain a range", async () => {
  const second = pool.createAccount({ name: "13800005778_超级", sessionId: "fixture2" });
  const advanced = pool.createAccount({ name: "13800005776_高级", sessionId: "fixture-excluded-advanced" });
  for (const item of [second, advanced]) database.prepare("UPDATE jimeng_accounts SET total_credit=100 WHERE id=?").run(item.id);
  const quotes = await Promise.all(Array.from({ length: 10 }, () => quoteVideo(auth, { ...input, hasVideo: true, referenceVideoSeconds: 3 })));
  assert.equal(quotes[0].creditsPerSecondMin, 6);
  assert.equal(quotes[0].creditsPerSecondMax, 8);
  assert.equal(quotes[0].estimatedCreditsMin, 42);
  assert.equal(quotes[0].estimatedCreditsMax, 56);
  assert.equal(calls.length, 9, "two-account cache population is coalesced");
  assert.ok(pool.listAccounts().every(item => item.lastUsedAt === null));
  assert.equal(pool.getAccount(advanced.id).enabled, true, "excluding advanced videos does not disable the account");
});

test("video policy requires a managed key and performs no supplier or account operation", async () => {
  const route = (await import("../src/api/routes/videos.ts")).default;
  const beforeCalls = calls.length, beforeAccounts = pool.listAccounts();
  const request = (authorization: string) => ({ headers: { authorization }, validate() { return this; } }) as any;
  assert.deepEqual(await route.get["/policy"](request(auth)), {
    accountPolicy: "super-only",
    videoQueuePolicy: "serial-submit-on-accepted-v2",
    longVideoPolicy: "official-long-video-v1",
  });
  for (const authorization of ["Bearer fixture1", "Bearer invalid"]) assert.equal((await route.get["/policy"](request(authorization)) as any).statusCode, 401);
  assert.equal(calls.length, beforeCalls);
  assert.deepEqual(pool.listAccounts(), beforeAccounts);
});

test("unsupported UI parameters and invalid keys never query the supplier", async () => {
  const before = calls.length;
  await assert.rejects(quoteVideo("Bearer invalid", input));
  assert.throws(() => videoQuoteInput({ ...input, model: "jimeng-video-seedance-2.0-fast-vip", resolution: "1080p" }));
  assert.throws(() => videoQuoteInput({ ...input, resolution: "2k" }));
  assert.throws(() => videoQuoteInput({ ...input, duration: -1 }));
  assert.equal(calls.length, before);
});

test("unknown units or payment roles remain unavailable and metadata is never a paid admission", async () => {
  for (const value of ["wrong-unit", "wrong-role"]) {
    clock += 61_000; mode = value;
    const unavailable = await quoteVideo(auth, input);
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.accountPolicy, "super-only");
  }
  assert.ok(calls.every(path => /get_common_config|benefit_metadata|batch_get_user_benefit/.test(path)));
  assert.equal(calls.some(path => /generate$|withhold|report_usage|exchange/.test(path)), false);
});


test("paid task quote is fresh for only its already bound account and freezes actual input duration", async () => {
  mode = "valid";
  const { resolveVideoModelConfig } = await import("../src/api/controllers/models.ts");
  const config = await resolveVideoModelConfig(input.model, "fixture2");
  const before = calls.length, accounts = pool.listAccounts();
  const quote = await freezeVideoQuote("fixture2", { ...input, hasVideo: true, referenceVideoSeconds: 3.125 }, config);
  assert.equal(calls.length, before + 2, "only original-account official metadata, no selection or other account cache");
  assert.equal(quote.estimatedCredits, 57);
  assert.equal(quote.chargedSeconds, 7.125);
  assert.equal(quote.creditsPerSecond, 8);
  assert.equal(quote.originalCreditsPerSecond, 26);
  assert.equal(quote.discountMultiplier, 8 / 26);
  assert.equal(quote.basis, "official-estimate");
  assert.deepEqual(pool.listAccounts(), accounts);
  mode = "wrong-role";
  await assert.rejects(freezeVideoQuote("fixture2", input, config), /官方视频报价未确认，未提交生成/);
  assert.ok(calls.every(path => /get_common_config|benefit_metadata|batch_get_user_benefit/.test(path)));
});

test("official super quote keeps 13 of 26, different super prices retain ranges and samples remain 9 of 12", async () => {
  mode = "super-promotion"; clock = Date.parse("2026-10-15T12:00:00+08:00");
  pool.updateAccount(account.id, { name: "13800005779_超级" });
  const mixed = await quoteVideo(auth, { ...input, hasVideo: true, referenceVideoSeconds: 6 });
  assert.equal(mixed.creditsPerSecondMin, 13); assert.equal(mixed.creditsPerSecondMax, 26);
  assert.equal(mixed.estimatedCreditsMin, 130); assert.equal(mixed.estimatedCreditsMax, 260);
  assert.equal(mixed.originalEstimatedCreditsMin, 260); assert.equal(mixed.originalEstimatedCreditsMax, 260);
  assert.equal(mixed.promotion?.allAccountsEligible, false);
  const second = pool.listAccounts().find(item => item.name === "13800005778_超级")!;
  pool.updateAccount(second.id, { enabled: false });
  const onlySuper = await quoteVideo(auth, { ...input, hasVideo: true, referenceVideoSeconds: 6 });
  assert.equal(onlySuper.estimatedCreditsMin, 130); assert.equal(onlySuper.estimatedCreditsMax, 130);
  assert.equal(onlySuper.promotion?.allAccountsEligible, true);
  assert.equal(JSON.stringify(onlySuper).includes("13800005777"), false);
  const { fetchVideoModelConfigs } = await import("../src/api/controllers/models.ts");
  const config = (await fetchVideoModelConfigs("fixture1", true)).find(item => item.id === input.model)!;
  const frozen = await freezeVideoQuote("fixture1", { ...input, hasVideo: true, referenceVideoSeconds: 6 }, config);
  assert.equal(frozen.creditsPerSecond, 13); assert.equal(frozen.originalCreditsPerSecond, 26); assert.equal(frozen.discountMultiplier, 0.5); assert.equal(frozen.estimatedCredits, 130);
  const sample = await quoteVideo(auth, { ...input, model: "jimeng-video-seedance-2.5-draft", resolution: "480p", hasVideo: true, referenceVideoSeconds: 6 });
  assert.equal(sample.creditsPerSecondMin, 9); assert.equal(sample.originalCreditsPerSecondMin, 12); assert.equal(sample.estimatedCreditsMin, 90); assert.equal(sample.originalEstimatedCreditsMin, 120); assert.equal(sample.promotion, undefined);
  clock = Date.parse("2026-10-27T00:00:00+08:00");
  assert.equal((await quoteVideo(auth, { ...input, hasVideo: true, referenceVideoSeconds: 6 })).promotion, undefined);
  assert.ok(calls.every(path => /get_common_config|benefit_metadata|batch_get_user_benefit/.test(path)));
});
