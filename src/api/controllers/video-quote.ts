import accountPool, { accountSupportsModel, accountTier, MIN_PAID_CREDIT, readAccountSessionById } from "@/lib/account-pool.ts";
import db from "@/lib/database.ts";
import { request, tokenSplit } from "./core.ts";
import { fetchVideoModelConfigs, getStaticModelReqKey } from "./models.ts";
import { SEEDANCE_MODELS, isLongVideo, seedanceVideoBenefit, seedanceVideoPrice, type SeedanceModel } from "./seedance-contract.ts";

type QuoteInput = { model: SeedanceModel; resolution: string; duration: number; hasVideo: boolean; referenceVideoSeconds: number; operation?: "generate-from-draft" };
type Snapshot = { accountId?: string; accountName?: string; models: Awaited<ReturnType<typeof fetchVideoModelConfigs>>; rules: any[]; assets: any[]; checkedAt: string };
let cache: { key: string; expires: number; value: Promise<Snapshot[]> } | undefined;
const superPromotion = { id: "super-reference-720p-20261013", startsAt: "2026-10-13T00:00:00+08:00", endsAt: "2026-10-27T00:00:00+08:00", multiplier: 0.5, label: "超级账号限时5折" } as const;

export function videoQuoteInput(input: any): QuoteInput {
  const model = input.model as SeedanceModel, limits = SEEDANCE_MODELS[model], duration = Number(input.duration), referenceVideoSeconds = Number(input.referenceVideoSeconds), hasVideo = input.hasVideo === true || input.hasVideo === "true";
  const upgrade = input.operation === "generate-from-draft" && model === "jimeng-video-seedance-2.5-draft" && input.resolution === "1080p";
  if (!limits || input.operation !== undefined && !upgrade || !upgrade && !(limits.resolutions as readonly string[]).includes(input.resolution) || !Number.isInteger(duration) || duration < (isLongVideo(model) ? 30 : 4) || duration > limits.maxDuration || ![true, false, "true", "false"].includes(input.hasVideo) || !Number.isFinite(referenceVideoSeconds) || referenceVideoSeconds < 0 || referenceVideoSeconds > Math.min(limits.maxDuration, 30) + 0.2 || !hasVideo && referenceVideoSeconds !== 0) throw Error("即梦视频报价参数无效");
  return { model, resolution: input.resolution, duration, hasVideo, referenceVideoSeconds, ...(upgrade ? { operation: "generate-from-draft" as const } : {}) };
}

async function readSnapshots() {
  const accounts = accountPool.list().filter(account => account.enabled && accountSupportsModel(account.name, "", true) && (account.status.totalCredit ?? 0) >= MIN_PAID_CREDIT && (!account.cooldownUntil || Date.parse(account.cooldownUntil) <= Date.now()));
  if (!accounts.length) throw Error("没有可读取视频报价的超级账号");
  const key = JSON.stringify(accounts.map(account => [account.id, account.name]).sort(([left], [right]) => left.localeCompare(right)));
  if (cache?.key === key && cache.expires > Date.now()) return cache.value;
  const value = Promise.all(accounts.map(async account => {
    // No account selection, lease, task admission, balance refresh or usage reporting.
    const token = readAccountSessionById(account.id), models = await fetchVideoModelConfigs(token, true);
    const benefits = new Set<string>();
    for (const model of models) for (const resolution of model.supportedResolutions) for (const hasVideo of [false, true]) {
      const benefit = seedanceVideoBenefit(model.id, resolution, hasVideo, model.raw);
      if (benefit && SEEDANCE_MODELS[model.id as SeedanceModel]) benefits.add(benefit);
    }
    if (!benefits.size) throw Error("官方视频计费项缺失");
    const data = { query_list: [{ resource_type: "aigc", resource_id: "generate_video", benefit_type_list: [...benefits] }] };
    const [metadata, userBenefits] = await Promise.all([
      request("post", "/commerce/v3/resource/benefit_metadata", token, { data }),
      request("post", "/commerce/v3/benefits/batch_get_user_benefit", token, { data }),
    ]);
    const rules = metadata?.metadata_list?.filter((item: any) => item.resource_type === "aigc" && item.resource_id === "generate_video").flatMap((item: any) => item.benefits_pay_strategy || []);
    if (!Array.isArray(rules) || !Array.isArray(userBenefits?.asset_list)) throw Error("官方视频报价响应不完整");
    return { accountId: account.id, accountName: account.name, models, rules, assets: userBenefits.asset_list, checkedAt: new Date(Date.now()).toISOString() };
  }));
  cache = { key, expires: Date.now() + 60_000, value };
  value.catch(() => { if (cache?.value === value) cache.expires = Date.now() + 10_000; });
  return value;
}

function snapshotPrice(input: QuoteInput, snapshot: Snapshot) {
      const config = snapshot.models.find(model => isLongVideo(input.model) ? model.id === input.model && model.mode === "long" : model.modelReqKey === getStaticModelReqKey(input.model, "video") && model.mode !== "long");
      const upgrade = config?.raw?.options?.find((option: any) => option.key === "generate_from_draft_config")?.generate_from_draft_config_val?.resolution;
      const resolutionAllowed = input.operation === "generate-from-draft" ? upgrade?.string_value?.includes(input.resolution) && !upgrade?.disabled_string_value?.includes(input.resolution) : config?.supportedResolutions.includes(input.resolution);
      if (config?.raw?.model_status !== 0 || !resolutionAllowed || !config.supportedDurations?.includes(input.duration)) throw Error("官方模型参数未确认");
      const benefitType = seedanceVideoBenefit(input.model, input.resolution, input.hasVideo, config.raw);
      const rules = snapshot.rules.filter(rule => rule.benefit_type === benefitType);
      if (rules.length !== 1 || rules[0].unit !== "second") throw Error("官方积分规则未确认");
      const rule = rules[0], pricing = rule.credit_strategy?.credit_pricing_info;
      const assets = snapshot.assets.filter(asset => asset.resource_type === "aigc" && asset.resource_id === "generate_video" && asset.benefit_type === benefitType).flatMap(asset => asset.asset_details || []);
      if (!assets.some(asset => asset.pay_mode === "UserCredit" && rule.credit_strategy.credit_limits?.some((limit: any) => limit.role === "all" || limit.role === asset.role))) throw Error("官方积分支付策略未确认");
      if (!pricing || ![pricing.credit_unit_price, pricing.original_credit_unit_price, pricing.min_charge_cnt].every(value => typeof value === "number" && Number.isFinite(value) && value > 0)) throw Error("官方积分单价未确认");
      // Official website: Ge(commercialConfig), Ld(sceneOptions), _getBenefitAmount and SDK tmz.
      const chargeInputVideoDuration = Boolean(config.raw.commercial_config?.resolution_price_configs?.length);
      const price = seedanceVideoPrice(input.model, input.resolution, input.hasVideo, config.raw);
      if (price?.amount !== undefined && (typeof price.amount !== "number" || !Number.isFinite(price.amount) || price.amount < 0)) throw Error("官方视频计费倍率未确认");
      const amount = price?.amount || 1, chargedSeconds = input.duration + (chargeInputVideoDuration ? input.referenceVideoSeconds : 0);
      const rate = pricing.credit_unit_price * amount / Math.max(pricing.min_charge_cnt, 1);
      const originalRate = pricing.original_credit_unit_price * amount / Math.max(pricing.min_charge_cnt, 1);
      return { benefitType, rate, originalRate, discountMultiplier: rate / originalRate, credits: Math.floor(Math.max(chargedSeconds * rate, 1)), originalCredits: Math.floor(Math.max(chargedSeconds * originalRate, 1)), chargeInputVideoDuration, chargedSeconds, checkedAt: snapshot.checkedAt, ...(isLongVideo(input.model) ? { mode: "long" as const, durationRange: config.durationRange, supportedDurations: config.supportedDurations } : {}) };
}

/** Admission uses an official lower bound; uploaded video duration is priced again before paying. */
export async function videoAccountMinimumCredits(input: { model: SeedanceModel; resolution: string; duration: number; references: Array<{ kind: string }> }) {
  const quoteInput = videoQuoteInput({ ...input, hasVideo: input.references.some(ref => ref.kind === "video"), referenceVideoSeconds: 0 });
  const snapshots = await readSnapshots();
  return new Map(snapshots.flatMap(snapshot => {
    try { return [[snapshot.accountId!, snapshotPrice(quoteInput, snapshot).credits] as const]; }
    catch { return []; }
  }));
}

/** Fresh official quote for the already reserved account, before its one paid POST. */
export async function freezeVideoQuote(token: string, rawInput: QuoteInput, config: Snapshot["models"][number]) {
  const input = videoQuoteInput(rawInput);
  if (input.hasVideo && input.referenceVideoSeconds <= 0) throw Error("参考视频时长未确认，未提交生成");
  const benefit = seedanceVideoBenefit(input.model, input.resolution, input.hasVideo, config.raw);
  const data = { query_list: [{ resource_type: "aigc", resource_id: "generate_video", benefit_type_list: [benefit] }] };
  try {
    const [metadata, userBenefits] = await Promise.all([
      request("post", "/commerce/v3/resource/benefit_metadata", token, { data }),
      request("post", "/commerce/v3/benefits/batch_get_user_benefit", token, { data }),
    ]);
    const rules = metadata?.metadata_list?.filter((item: any) => item.resource_type === "aigc" && item.resource_id === "generate_video").flatMap((item: any) => item.benefits_pay_strategy || []);
    if (!Array.isArray(rules) || !Array.isArray(userBenefits?.asset_list)) throw Error("官方报价响应不完整");
    const price = snapshotPrice(input, { models: [config], rules, assets: userBenefits.asset_list, checkedAt: new Date(Date.now()).toISOString() });
    if (!Number.isSafeInteger(price.credits) || price.credits < 1) throw Error("官方积分总额未确认");
    return { ...input, unit: "jimeng-credit" as const, basis: "official-estimate" as const, benefitType: price.benefitType, creditsPerSecond: price.rate, originalCreditsPerSecond: price.originalRate, discountMultiplier: price.discountMultiplier, estimatedCredits: price.credits, originalEstimatedCredits: price.originalCredits, chargedSeconds: price.chargedSeconds, chargeInputVideoDuration: price.chargeInputVideoDuration, checkedAt: price.checkedAt, ...(isLongVideo(input.model) ? { mode: "long" as const, durationRange: price.durationRange } : {}) };
  } catch { throw Error("当前账号官方视频报价未确认，未提交生成；请稍后重试"); }
}

export async function quoteVideo(authorization: string, rawInput: any) {
  if (!tokenSplit(authorization).some(token => db.validateApiKey(token).valid)) throw Error("API key is invalid or disabled");
  const input = videoQuoteInput(rawInput), base = { ...input, unit: "jimeng-credit", audioMode: "model-default", basis: "credit-strategy", accountPolicy: "super-only", ...(isLongVideo(input.model) ? { mode: "long" as const, longVideoPolicy: "official-long-video-v1" } : {}) };
  try {
    if (input.hasVideo && input.referenceVideoSeconds <= 0) throw Error("参考视频时长未确认");
    const snapshots = await readSnapshots();
    const eligible = isLongVideo(input.model) ? snapshots.filter(snapshot => snapshot.models.some(model => model.id === input.model && model.mode === "long" && model.supportedDurations?.includes(input.duration))) : snapshots;
    if (!eligible.length) throw Error("当前账号未开放所选超长视频参数");
    const prices = eligible.map(snapshot => {
      const price = snapshotPrice(input, snapshot), time = Date.parse(price.checkedAt);
      const promoted = input.model === "jimeng-video-seedance-2.5" && input.resolution === "720p" && input.hasVideo && price.benefitType === "seedance_25_720p_output" && accountTier(snapshot.accountName || "") === "super" && time >= Date.parse(superPromotion.startsAt) && time < Date.parse(superPromotion.endsAt) && price.discountMultiplier === superPromotion.multiplier;
      return { ...price, promoted };
    });
    if (new Set(prices.map(price => price.benefitType)).size !== 1) throw Error("账号官方计费项不一致");
    const durations = isLongVideo(input.model) ? prices[0].supportedDurations!.filter(seconds => prices.every(price => price.supportedDurations?.includes(seconds))) : [];
    const step = durations.length > 1 ? durations[1] - durations[0] : prices[0].durationRange?.step;
    if (isLongVideo(input.model) && (!durations.includes(input.duration) || !step || durations.some((seconds, index) => index > 0 && seconds - durations[index - 1] !== step))) throw Error("账号超长视频时长范围未确认");
    return { ...base, status: "available", ...(isLongVideo(input.model) ? { durationRange: { min: durations[0], max: durations.at(-1)!, step } } : {}), benefitType: prices[0].benefitType, checkedAt: prices.map(price => price.checkedAt).sort()[0], ...(new Set(prices.map(price => price.chargeInputVideoDuration)).size === 1 ? { chargeInputVideoDuration: prices[0].chargeInputVideoDuration } : {}), chargedSecondsMin: Math.min(...prices.map(price => price.chargedSeconds)), chargedSecondsMax: Math.max(...prices.map(price => price.chargedSeconds)), creditsPerSecondMin: Math.min(...prices.map(price => price.rate)), creditsPerSecondMax: Math.max(...prices.map(price => price.rate)), estimatedCreditsMin: Math.min(...prices.map(price => price.credits)), estimatedCreditsMax: Math.max(...prices.map(price => price.credits)), originalCreditsPerSecondMin: Math.min(...prices.map(price => price.originalRate)), originalCreditsPerSecondMax: Math.max(...prices.map(price => price.originalRate)), originalEstimatedCreditsMin: Math.min(...prices.map(price => price.originalCredits)), originalEstimatedCreditsMax: Math.max(...prices.map(price => price.originalCredits)), ...(prices.some(price => price.promoted) ? { promotion: { ...superPromotion, allAccountsEligible: prices.every(price => price.promoted) } } : {}) };
  } catch {
    return { ...base, status: "unavailable", reason: "官方报价暂不可用" };
  }
}
