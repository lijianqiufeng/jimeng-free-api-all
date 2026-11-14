import _ from "lodash";
import { jimengCreditFloor, spendableJimengCredits } from "@/lib/credit-floor.ts";
import { createHash } from "node:crypto";

import { tokenSplit } from "@/api/controllers/core.ts";
import accountPool, { accountModelError, accountSupportsModel, isPremiumFreeImageModel, isVideoModel, MIN_PAID_CREDIT, readAccountSessionById, requiresPaidCredit } from "@/lib/account-pool.ts";
import db, { touchApiKey } from "@/lib/database.ts";
import { hasPremiumImageEntitlement } from "./image-entitlements.ts";
import { resolveImageModelConfig } from "./models.ts";

export interface ResolvedCredential {
  token: string;
  accountId?: string;
  managedKey?: string;
}

/** Resolve either a native Jimeng session token or a dashboard-managed API key. */
export function isManagedApiKey(value: string): boolean {
  return /^jm_[A-Za-z0-9_-]{20,}$/.test(value);
}

// Coalesce batch lookups by account credential, model and resolution; generation still checks live rights.
const freeImageChecks = new Map<string, { expiresAt: number; value: Promise<boolean> }>();
async function freeImageAccountIds(model: string, resolution: string, requestedAccountId?: string) {
  const modelId = model.trim().toLowerCase().split(":")[0], size = resolution.toLowerCase();
  if (requestedAccountId && !accountSupportsModel(accountPool.get(requestedAccountId).name, model)) throw Error(accountModelError(model));
  const candidates = accountPool.list().filter(account => account.enabled && accountSupportsModel(account.name, model) && (!account.cooldownUntil || Date.parse(account.cooldownUntil) <= Date.now()) && (!requestedAccountId || account.id === requestedAccountId));
  for (const [key, entry] of freeImageChecks) if (entry.expiresAt <= Date.now()) freeImageChecks.delete(key);
  const checks = await Promise.allSettled(candidates.map(async account => {
    const token = readAccountSessionById(account.id);
    const key = createHash("sha256").update(`${account.id}\0${token}\0${modelId}\0${size}`).digest("hex");
    if (!freeImageChecks.has(key)) freeImageChecks.set(key, { expiresAt: Date.now() + 30_000, value: resolveImageModelConfig(modelId, token).then(config => hasPremiumImageEntitlement(config, size, token)) });
    return freeImageChecks.get(key)!.value;
  }));
  const ids = new Set(candidates.filter((_, index) => { const check = checks[index]; return check.status === "fulfilled" && check.value; }).map(account => account.id));
  if (!ids.size) throw Error(checks.some(check => check.status === "rejected") ? "免费图片账号权益暂未确认，未提交生成" : "没有具备所选清晰度免费权益的可用账号，未提交生成");
  return ids;
}

let videoBalanceRefresh: Promise<void> | undefined;
let videoBalanceRefreshAt = 0;
export function refreshVideoAccountBalances(model: string) {
  if (videoBalanceRefresh) return videoBalanceRefresh;
  if (Date.now() < videoBalanceRefreshAt) return Promise.resolve();
  videoBalanceRefreshAt = Date.now() + 5000;
  videoBalanceRefresh = Promise.allSettled(accountPool.list().filter(account => account.enabled && accountSupportsModel(account.name, model, true) && (!account.cooldownUntil || Date.parse(account.cooldownUntil) <= Date.now())).map(account => accountPool.refreshStatus(account.id))).then(() => undefined).finally(() => { videoBalanceRefresh = undefined; });
  return videoBalanceRefresh;
}

export function publicAccountError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : "";
  return [
    "当前账号有保留积分，此入口缺少可冻结报价，未提交生成；请使用视频创作台或其他账号",
    "没有可用于视频生成的 _超级账号；须启用、未冷却且至少 5 积分，未提交生成",
    "视频生成仅使用名称以 _超级 结尾的账号；高级账号已暂停新视频提交，本次未提交生成",
    "视频生成必须使用托管 API Key 和名称以 _超级 结尾的账号；本次未提交生成",
    "指定账号已暂停新视频提交，仅可使用超级账号；本次未提交生成",
    "当前账号已暂停新视频提交，仅可使用超级账号；本次未提交生成",
    "原样片账号已暂停新视频提交，不能转换高清；原样片保留，未更换账号或提交生成",
    "即梦账号积分不足 5，仅可用于 Lite；本次未提交生成",
    "Lite 和 4.6 免费高速生成仅使用名称以 _高级 或 _超级 结尾的账号；本次未提交生成",
    "没有可用于 Lite 和 4.6 免费高速生成的 _高级/_超级账号；本次未提交生成",
    "Lite 和 4.6 免费高速生成必须使用托管 API Key 和名称以 _高级 或 _超级 结尾的账号；本次未提交生成",
    "没有具备所选清晰度免费权益的可用账号，未提交生成",
    "免费图片账号权益暂未确认，未提交生成",
  ].includes(message) ? message : undefined;
}

export async function resolveAuthorization(authorization: string, requestedAccountId?: string, model = "", requirePaidBalance = false, video = isVideoModel(model), resolution = "2k"): Promise<ResolvedCredential> {
  const tokens = tokenSplit(authorization);
  if (tokens.length === 0) throw new Error("Authorization token is empty");

  const managed = tokens.map((token) => ({ token, validation: db.validateApiKey(token) }))
    .find(({ validation }) => validation.valid && validation.apiKeyId);
  const looksLikeManagedKey = tokens.find(isManagedApiKey);
  if (managed?.validation.apiKeyId) {
    const apiKeyId = managed.validation.apiKeyId;
    if (requestedAccountId && !accountPool.hasLease(apiKeyId, requestedAccountId)) {
      throw new Error("该 API Key 没有此账号的有效租约绑定");
    }
    const paid = requiresPaidCredit(model, video);
    const eligibleIds = !video && isPremiumFreeImageModel(model) ? await freeImageAccountIds(model, resolution, requestedAccountId) : undefined;
    if (!requestedAccountId && paid) {
      const available = accountPool.list().filter((a) => a.enabled && accountSupportsModel(a.name, model, video) && (!a.cooldownUntil || Date.parse(a.cooldownUntil) <= Date.now()));
      if (video || !available.some((a) => (spendableJimengCredits(a.id, a.status.totalCredit) ?? 0) >= MIN_PAID_CREDIT)) {
        await Promise.allSettled(available.map((a) => accountPool.refreshStatus(a.id)));
      }
    }
    let selected = requestedAccountId ? accountPool.selectById(requestedAccountId, model, video) : accountPool.select("round_robin", model, video, Infinity, undefined, eligibleIds);
    if (requirePaidBalance && paid && jimengCreditFloor(selected.account.id)) throw Error("当前账号有保留积分，此入口缺少可冻结报价，未提交生成；请使用视频创作台或其他账号");
    if (requestedAccountId && requirePaidBalance && paid) {
      const current = await accountPool.refreshStatus(selected.account.id);
      if (!accountSupportsModel(current.name, model, video)) throw new Error(accountModelError(model, video));
      if ((spendableJimengCredits(current.id, current.status.totalCredit) ?? 0) < MIN_PAID_CREDIT) throw new Error("即梦账号积分不足 5，仅可用于 Lite；本次未提交生成");
    }
    if (!requestedAccountId && paid) {
      for (let attempt = 0; attempt < accountPool.list().length; attempt += 1) {
        const current = await accountPool.refreshStatus(selected.account.id);
        if (accountSupportsModel(current.name, model, video) && (spendableJimengCredits(current.id, current.status.totalCredit) ?? 0) >= MIN_PAID_CREDIT) break;
        if (attempt === accountPool.list().length - 1) throw new Error("即梦账号积分不足 5，仅可用于 Lite；本次未提交生成");
        selected = accountPool.select("round_robin", model, video);
      }
    }
    if (!requestedAccountId) accountPool.grantLease(apiKeyId, selected.account.id);
    touchApiKey(managed.token);
    return {
      token: selected.sessionId,
      accountId: selected.account.id,
      managedKey: managed.token,
    };
  }

  if (looksLikeManagedKey) {
    throw new Error("API key is invalid or disabled");
  }

  if (video) throw new Error("视频生成必须使用托管 API Key 和名称以 _超级 结尾的账号；本次未提交生成");
  if (isPremiumFreeImageModel(model)) throw new Error("Lite 和 4.6 免费高速生成必须使用托管 API Key 和名称以 _高级 或 _超级 结尾的账号；本次未提交生成");
  return { token: _.sample(tokens) as string };
}

export function markCredentialSuccess(credential: ResolvedCredential): void {
  if (credential.accountId) accountPool.markSuccess(credential.accountId);
}

export function accountFailureCooldown(error: unknown): number | null {
  const value = error as any;
  const message = String(value?.message || value || "");
  const status = Number(value?.response?.status ?? value?.statusCode ?? value?.status);
  // Request throttling/moderation is scoped to the originating user/model by NAS.
  // Keep authentication failures account-wide, but do not penalize other users for this input.
  if (/\b(?:4013|1015)\b/.test(message) || status === 429 || /(?:HTTP|状态码?|status)\D*429\b/i.test(message)) return null;
  if ([401, 403].includes(status) || /(?:HTTP|状态码?|status)\D*(?:401|403)\b/i.test(message) || /登录(?:已)?失效|未登录|session\s*(?:expired|invalid)/i.test(message)) {
    return 15 * 60_000;
  }
  return null;
}

export function markCredentialFailure(credential: ResolvedCredential, error?: unknown): boolean {
  if (!credential.accountId) return false;
  if (error === undefined) {
    accountPool.markFailure(credential.accountId);
    return true;
  }
  const cooldownMs = accountFailureCooldown(error);
  if (cooldownMs === null) return false;
  accountPool.markFailure(credential.accountId, cooldownMs);
  return true;
}
