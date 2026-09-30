import _ from "lodash";

import { tokenSplit } from "@/api/controllers/core.ts";
import accountPool, { accountSupportsModel, MIN_PAID_CREDIT } from "@/lib/account-pool.ts";
import db, { touchApiKey } from "@/lib/database.ts";

export interface ResolvedCredential {
  token: string;
  accountId?: string;
  managedKey?: string;
}

/** Resolve either a native Jimeng session token or a dashboard-managed API key. */
export function isManagedApiKey(value: string): boolean {
  return /^jm_[A-Za-z0-9_-]{20,}$/.test(value);
}

export async function resolveAuthorization(authorization: string, requestedAccountId?: string, model = "", requirePaidBalance = false): Promise<ResolvedCredential> {
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
    if (!requestedAccountId && model && !/lite/i.test(model)) {
      const available = accountPool.list().filter((a) => a.enabled && accountSupportsModel(a.name, model) && (!a.cooldownUntil || Date.parse(a.cooldownUntil) <= Date.now()));
      if (!available.some((a) => (a.status.totalCredit ?? 0) >= MIN_PAID_CREDIT)) {
        await Promise.allSettled(available.map((a) => accountPool.refreshStatus(a.id)));
      }
    }
    let selected = requestedAccountId ? accountPool.selectById(requestedAccountId, model) : accountPool.select("round_robin", model);
    if (requestedAccountId && requirePaidBalance && model && !/lite/i.test(model)) {
      const current = await accountPool.refreshStatus(selected.account.id);
      if (!accountSupportsModel(current.name, model)) throw new Error("名称以 _高级 结尾的账号不用于 5.0 Pro；本次未提交生成");
      if ((current.status.totalCredit ?? 0) < MIN_PAID_CREDIT) throw new Error("即梦账号积分不足 5，仅可用于 Lite；本次未提交生成");
    }
    if (!requestedAccountId && model && !/lite/i.test(model)) {
      for (let attempt = 0; attempt < accountPool.list().length; attempt += 1) {
        const current = await accountPool.refreshStatus(selected.account.id);
        if (accountSupportsModel(current.name, model) && (current.status.totalCredit ?? 0) >= MIN_PAID_CREDIT) break;
        if (attempt === accountPool.list().length - 1) throw new Error("即梦账号积分不足 5，仅可用于 Lite；本次未提交生成");
        selected = accountPool.select("round_robin", model);
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

  return { token: _.sample(tokens) as string };
}

export function markCredentialSuccess(credential: ResolvedCredential): void {
  if (credential.accountId) accountPool.markSuccess(credential.accountId);
}

export function accountFailureCooldown(error: unknown): number | null {
  const value = error as any;
  const message = String(value?.message || value || "");
  const status = Number(value?.response?.status ?? value?.statusCode ?? value?.status);
  if (/\b(?:4013|1015)\b/.test(message)) return 60 * 60_000;
  if (status === 429 || /(?:HTTP|状态码?|status)\D*429\b/i.test(message)) return 5 * 60_000;
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
