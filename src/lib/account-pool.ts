import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs-extra";
import path from "path";

import { getCredit, request, videoRequestSignal } from "@/api/controllers/core.ts";

const DB_PATH = process.env.DB_PATH || "./data/jimeng.db";
const TABLE = "jimeng_accounts";

export type AccountCredentialKind = "cookie" | "sessionid";
export type AccountSelectionStrategy = "round_robin" | "least_failures";
export const MIN_PAID_CREDIT = 5;
export const VIDEO_ACCOUNT_SUBMISSION_CONCURRENCY = 1;
export function isVideoModel(model: string): boolean {
  return /^(?:jimeng-video-|seedance-|dreamina_seedance_|dreamina_ic_generate_video_model_)/i.test(model.trim());
}
export function isPremiumFreeImageModel(model: string): boolean {
  return ["jimeng-image-5.0-lite", "high_aes_general_v50", "jimeng-image-4.6", "high_aes_general_v42"].includes(model.trim().toLowerCase().split(":")[0]);
}
export function requiresPaidCredit(model: string, video = isVideoModel(model)): boolean {
  return video || Boolean(model && !isPremiumFreeImageModel(model) && !/lite/i.test(model));
}
export function accountTier(name: string): "standard" | "advanced" | "super" {
  const value = name.trim();
  return value.endsWith("_超级") ? "super" : value.endsWith("_高级") ? "advanced" : "standard";
}
/** New video submissions only; original task queries keep their saved account. */
export const isVideoSubmissionAccount = (name: string) => accountTier(name) === "super";
export function accountModelError(model: string, video = isVideoModel(model)): string {
  return video ? "视频生成仅使用名称以 _超级 结尾的账号；高级账号已暂停新视频提交，本次未提交生成" : isPremiumFreeImageModel(model) ? "Lite 和 4.6 免费高速生成仅使用名称以 _高级 或 _超级 结尾的账号；本次未提交生成" : "名称以 _高级 或 _超级 结尾的账号不用于 5.0 Pro；本次未提交生成";
}
export function accountSupportsModel(name: string, model: string, video = isVideoModel(model)): boolean {
  if (video) return isVideoSubmissionAccount(name);
  const premium = accountTier(name) !== "standard";
  return isPremiumFreeImageModel(model) ? premium : !premium || !["jimeng-image-5.0-pro", "high_aes_general_v50p_large"].includes(model.trim().toLowerCase().split(":")[0]);
}

export interface AccountPoolCreateInput {
  name: string;
  cookie?: string;
  sessionId?: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AccountPoolUpdateInput {
  name?: string;
  cookie?: string;
  sessionId?: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AccountStatus {
  freeCredit: number | null;
  purchaseCredit: number | null;
  vipCredit: number | null;
  totalCredit: number | null;
  membership: unknown;
  checkedAt: string | null;
  error?: string;
}

export interface PublicAccount {
  id: string;
  name: string;
  credentialKind: AccountCredentialKind;
  credentialPreview: string;
  enabled: boolean;
  failureCount: number;
  successCount: number;
  cooldownUntil: string | null;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  status: AccountStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AccountSelection {
  account: PublicAccount;
  /** Internal use by the caller that performs a Jimeng request. Never return this from an HTTP handler. */
  credential: string;
  sessionId: string;
}

export type MembershipStatusProvider = (sessionId: string, account: PublicAccount) => Promise<unknown>;

interface AccountRow {
  id: string;
  name: string;
  credential_kind: AccountCredentialKind;
  credential_hash: string;
  credential_ciphertext: string;
  enabled: number;
  failure_count: number;
  success_count: number;
  cooldown_until: string | null;
  last_used_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  free_credit: number | null;
  purchase_credit: number | null;
  vip_credit: number | null;
  total_credit: number | null;
  membership_json: string | null;
  status_checked_at: string | null;
  status_error: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  selection_seq: number;
}

export class AccountPoolConfigurationError extends Error {
  constructor(message = "账号池未配置加密密钥，请设置 JIMENG_ACCOUNT_POOL_KEY 或 ACCOUNT_POOL_ENCRYPTION_KEY") {
    super(message);
    this.name = "AccountPoolConfigurationError";
  }
}

function now(): string {
  return new Date().toISOString();
}

function preview(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function extractSessionId(credential: string, kind: AccountCredentialKind): string {
  const raw = credential.trim();
  if (kind === "sessionid") return raw;

  // 兼容浏览器开发者工具复制出来的多种 Cookie 形式：
  // `sessionid=...`、`Cookie: sessionid=...`、换行分隔以及带空格的键值对。
  const normalized = raw
    .replace(/^\s*cookie\s*:\s*/i, "")
    .replace(/[\r\n]+/g, ";");
  const pairs = new Map<string, string>();
  for (const item of normalized.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim().toLowerCase();
    const value = item.slice(separator + 1).trim();
    if (key && value) pairs.set(key, value);
  }

  let value = pairs.get("sessionid") || pairs.get("sessionid_ss") || pairs.get("sid_tt");
  if (!value) {
    const sidGuard = pairs.get("sid_guard");
    value = sidGuard?.split("%7C")[0] || sidGuard?.split("|")[0];
  }
  // 也允许直接粘贴 sessionId，方便从接口或环境变量中复制。
  if (!value && !normalized.includes("=") && /^[^\s;]+$/.test(raw)) value = raw;
  if (!value) throw new Error("Cookie 中缺少 sessionid、sessionid_ss 或 sid_tt");
  try { return decodeURIComponent(value); } catch { return value; }
}

function getEncryptionKey(): Buffer {
  const raw = process.env.JIMENG_ACCOUNT_POOL_KEY || process.env.ACCOUNT_POOL_ENCRYPTION_KEY;
  if (!raw?.trim()) throw new AccountPoolConfigurationError();
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decrypt(value: string): string {
  const [ivText, tagText, ciphertextText] = value.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("账号凭据密文格式无效");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}

function hashCredential(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function credentialInput(input: AccountPoolCreateInput | AccountPoolUpdateInput): { value: string; kind: AccountCredentialKind } | null {
  if (input.cookie && input.sessionId) throw new Error("cookie 和 sessionId 只能提供一个");
  if (input.cookie?.trim()) return { value: input.cookie.trim(), kind: "cookie" };
  if (input.sessionId?.trim()) return { value: input.sessionId.trim(), kind: "sessionid" };
  return null;
}

const dbDirectory = path.dirname(DB_PATH);
fs.ensureDirSync(dbDirectory);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.exec(`
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    credential_kind TEXT NOT NULL CHECK (credential_kind IN ('cookie', 'sessionid')),
    credential_hash TEXT NOT NULL UNIQUE,
    credential_ciphertext TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failure_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    cooldown_until TEXT,
    last_used_at TEXT,
    last_success_at TEXT,
    last_failure_at TEXT,
    free_credit INTEGER,
    purchase_credit INTEGER,
    vip_credit INTEGER,
    total_credit INTEGER,
    membership_json TEXT,
    status_checked_at TEXT,
    status_error TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    selection_seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_${TABLE}_eligible ON ${TABLE}(enabled, cooldown_until, failure_count);
  CREATE TABLE IF NOT EXISTS jimeng_account_leases (
    api_key_id INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (api_key_id, account_id)
  );
  CREATE INDEX IF NOT EXISTS idx_jimeng_account_leases_expiry ON jimeng_account_leases(expires_at);
`);
const accountColumns = new Set((db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>).map((column) => column.name));
if (!accountColumns.has("selection_seq")) db.exec(`ALTER TABLE ${TABLE} ADD COLUMN selection_seq INTEGER NOT NULL DEFAULT 0`);

let membershipStatusProvider: MembershipStatusProvider | undefined;

function toPublic(row: AccountRow): PublicAccount {
  return {
    id: row.id,
    name: row.name,
    credentialKind: row.credential_kind,
    credentialPreview: row.credential_kind === "cookie" ? "cookie:********" : preview(row.credential_hash),
    enabled: Boolean(row.enabled),
    failureCount: row.failure_count,
    successCount: row.success_count,
    cooldownUntil: row.cooldown_until,
    lastUsedAt: row.last_used_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    status: {
      freeCredit: row.free_credit,
      purchaseCredit: row.purchase_credit,
      vipCredit: row.vip_credit,
      totalCredit: row.total_credit,
      membership: parseJson(row.membership_json, "unknown"),
      checkedAt: row.status_checked_at,
      ...(row.status_error ? { error: row.status_error } : {})
    },
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getRow(id: string): AccountRow {
  const row = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id) as AccountRow | undefined;
  if (!row) throw new Error(`账号不存在: ${id}`);
  return row;
}

export function setMembershipStatusProvider(provider?: MembershipStatusProvider): void {
  membershipStatusProvider = provider;
}

export function listAccounts(): PublicAccount[] {
  return (db.prepare(`SELECT * FROM ${TABLE} ORDER BY created_at ASC`).all() as AccountRow[]).map(toPublic);
}

export function getAccount(id: string): PublicAccount {
  return toPublic(getRow(id));
}

export function createAccount(input: AccountPoolCreateInput): PublicAccount {
  if (!input.name?.trim()) throw new Error("账号名称不能为空");
  const credential = credentialInput(input);
  if (!credential) throw new Error("必须提供 cookie 或 sessionId");
  extractSessionId(credential.value, credential.kind);
  const timestamp = now();
  const id = crypto.randomUUID();
  try {
    db.prepare(`INSERT INTO ${TABLE} (id, name, credential_kind, credential_hash, credential_ciphertext, enabled, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.name.trim(), credential.kind, hashCredential(credential.value), encrypt(credential.value), input.enabled === false ? 0 : 1,
      JSON.stringify(input.metadata || {}), timestamp, timestamp
    );
  } catch (error: any) {
    if (String(error?.message).includes("UNIQUE")) throw new Error("该账号凭据已存在");
    throw error;
  }
  return getAccount(id);
}

export function updateAccount(id: string, input: AccountPoolUpdateInput): PublicAccount {
  const row = getRow(id);
  const credential = credentialInput(input);
  if (credential) { extractSessionId(credential.value, credential.kind); }
  const timestamp = now();
  const values = {
    name: input.name === undefined ? row.name : input.name.trim(),
    enabled: input.enabled === undefined ? row.enabled : (input.enabled ? 1 : 0),
    metadata: input.metadata === undefined ? row.metadata_json : JSON.stringify(input.metadata),
    kind: credential?.kind || row.credential_kind,
    hash: credential ? hashCredential(credential.value) : row.credential_hash,
    ciphertext: credential ? encrypt(credential.value) : row.credential_ciphertext
  };
  if (!values.name) throw new Error("账号名称不能为空");
  try {
    db.prepare(`UPDATE ${TABLE} SET name = ?, credential_kind = ?, credential_hash = ?, credential_ciphertext = ?, enabled = ?, metadata_json = ?, updated_at = ? WHERE id = ?`).run(
      values.name, values.kind, values.hash, values.ciphertext, values.enabled, values.metadata, timestamp, id
    );
  } catch (error: any) {
    if (String(error?.message).includes("UNIQUE")) throw new Error("该账号凭据已存在");
    throw error;
  }
  return getAccount(id);
}

export function deleteAccount(id: string): void {
  const result = db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id);
  if (!result.changes) throw new Error(`账号不存在: ${id}`);
}

export function setAccountEnabled(id: string, enabled: boolean): PublicAccount {
  getRow(id);
  db.prepare(`UPDATE ${TABLE} SET enabled = ?, updated_at = ? WHERE id = ?`).run(enabled ? 1 : 0, now(), id);
  return getAccount(id);
}

type VideoSubmissionTask = { id: string; kind: string; account_id: string; status: string; provider_status?: string; provider_hold?: number; paid_started_at?: number; history_id?: string; result?: string; quote_json?: string | null };

export function videoReservedCredits(task: Pick<VideoSubmissionTask, "id" | "account_id" | "quote_json">): number {
  try {
    const quote = JSON.parse(task.quote_json || "null");
    return quote?.taskId === task.id && quote.accountId === task.account_id && Number.isSafeInteger(quote.estimatedCredits) && quote.estimatedCredits > 0 ? quote.estimatedCredits : Infinity;
  } catch { return Infinity; }
}

/** An exact operator reconciliation releases only this unknown submission slot, never its funds. */
export function videoSubmissionReconciled(task: VideoSubmissionTask): boolean {
  if (task.kind !== "video" || !["uncertain", "canceled"].includes(task.status) || task.provider_status !== "uncertain" || task.provider_hold !== 1 || task.history_id || task.result || !task.account_id || !Number.isSafeInteger(task.paid_started_at) || !(task.paid_started_at! > 0) || !task.quote_json) return false;
  try {
    const quote = JSON.parse(task.quote_json), marker = quote.submissionReconciliation;
    return quote.taskId === task.id && quote.accountId === task.account_id && quote.submissionReceipt?.acceptanceIdentity !== true && marker?.kind === "operator_confirmed_no_record"
      && marker.taskId === task.id && marker.accountId === task.account_id && marker.paidStartedAt === task.paid_started_at
      && Number.isSafeInteger(marker.confirmedAt) && marker.confirmedAt >= task.paid_started_at! && marker.confirmedAt <= Date.now()
      && typeof marker.evidenceId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(marker.evidenceId);
  } catch { return false; }
}

/** Serialize upload/submission until the original history is saved; rendering and funds stay bound. */
export function videoAccountUsage(): Map<string, { active: number; rendering: number; billingPending: number; reservedCredits: number }> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_tasks'").get()) return new Map();
  const hasHold = (db.prepare("PRAGMA table_info(canvas_tasks)").all() as Array<{ name: string }>).some(column => column.name === "provider_hold");
  const usage = new Map<string, { active: number; rendering: number; billingPending: number; reservedCredits: number }>();
  const held = db.prepare(`SELECT * FROM canvas_tasks WHERE kind='video' AND ${hasHold ? "provider_hold=1" : "status IN ('submitting','running')"}`).all() as VideoSubmissionTask[];
  for (const task of held) {
    let active = !videoSubmissionReconciled(task), rendering = 0, billingPending = 0;
    if (task.account_id && task.history_id && task.provider_status === "running") {
      active = false;
      rendering = 1;
    }
    if (task.account_id && task.history_id && task.provider_status === "succeeded") {
      try {
        const result = JSON.parse(task.result || "");
        if (Array.isArray(result) && result.length && result.every(item => typeof item?.url === "string" && /^https:\/\/[^\s]+$/.test(item.url))) { active = false; billingPending = 1; }
      } catch { /* Missing or invalid result proof keeps the original submission slot. */ }
    }
    const reservedCredits = videoReservedCredits(task);
    const previous = usage.get(task.account_id) || { active: 0, rendering: 0, billingPending: 0, reservedCredits: 0 };
    usage.set(task.account_id, { active: previous.active + Number(active), rendering: previous.rendering + rendering, billingPending: previous.billingPending + billingPending, reservedCredits: previous.reservedCredits + reservedCredits });
  }
  return usage;
}

/** Read the original task account without selection, lease, cooldown or balance changes. */
export function readAccountSessionById(id: string): string {
  const row = getRow(id);
  return extractSessionId(decrypt(row.credential_ciphertext), row.credential_kind);
}

export function selectAccount(strategy: AccountSelectionStrategy = "least_failures", model = "", video = isVideoModel(model), videoLimit = Infinity, minimumCredits?: ReadonlyMap<string, number>): AccountSelection {
  const requireRecentStatus = Number.isFinite(videoLimit);
  if (video) videoLimit = Math.min(videoLimit, VIDEO_ACCOUNT_SUBMISSION_CONCURRENCY);
  const reserve = db.transaction(() => {
    const timestamp = now();
    const rows = db.prepare(`SELECT * FROM ${TABLE} WHERE enabled = 1 AND (cooldown_until IS NULL OR cooldown_until <= ?) ORDER BY selection_seq ASC, id ASC`)
      .all(timestamp) as AccountRow[];
    const paid = requiresPaidCredit(model, video);
    const usage = video ? videoAccountUsage() : new Map<string, { active: number; reservedCredits: number }>();
    const active = (id: string) => usage.get(id)?.active || 0;
    const available = (row: AccountRow) => Math.max(0, (row.total_credit ?? 0) - (usage.get(row.id)?.reservedCredits || 0));
    const eligible = rows.filter((row) => accountSupportsModel(row.name, model, video) && (!paid || row.total_credit !== null && available(row) >= Math.max(MIN_PAID_CREDIT, minimumCredits ? minimumCredits.get(row.id) ?? Infinity : 0)) && (!video || active(row.id) < videoLimit) && (!requireRecentStatus || !row.status_error && Date.now() - Date.parse(row.status_checked_at || "") < 10_000));
    // Five credits is an admission floor, not the price of a VIP video.
    const leastActive = video ? eligible.filter(row => active(row.id) === Math.min(...eligible.map(item => active(item.id)))) : eligible;
    const candidates = video ? leastActive.filter((row) => available(row) === Math.max(...leastActive.map(available)))
      : strategy === "round_robin" || !eligible.length ? eligible : eligible.filter((row) => row.failure_count === Math.min(...eligible.map((item) => item.failure_count)));
    const equalWeight = !paid || candidates.every((row) => row.total_credit !== null && row.total_credit >= 30);
    const sequence = (db.prepare(`SELECT COALESCE(MAX(selection_seq), 0) + 1 AS value FROM ${TABLE}`).get() as { value: number }).value;
    const weight = (row: AccountRow) => equalWeight ? 1 : 1 + 3 * Math.min(1, Math.max(0, row.total_credit ?? 0) / 30);
    const row = candidates.reduce<AccountRow | undefined>((best, item) => !best || (sequence - item.selection_seq) * weight(item) > (sequence - best.selection_seq) * weight(best) ? item : best, undefined);
    if (!row) throw new Error(video ? "没有可用于视频生成的 _超级账号；须启用、未冷却且至少 5 积分，未提交生成" : isPremiumFreeImageModel(model) ? "没有可用于 Lite 和 4.6 免费高速生成的 _高级/_超级账号；本次未提交生成" : !accountSupportsModel("_高级", model) ? "没有可用于 5.0 Pro 的普通账号；_高级/_超级账号保留给其他模型，普通账号须至少 5 积分" : paid ? "没有积分达到 5 的即梦账号；低于 5 积分的账号仅用于 Lite" : "没有可用的即梦账号");
    db.prepare(`UPDATE ${TABLE} SET selection_seq = ?, last_used_at = ?, updated_at = ? WHERE id = ?`).run(sequence, timestamp, timestamp, row.id);
    return row;
  });
  // IMMEDIATE obtains the SQLite write reservation before reading the candidate.
  // SQLITE_BUSY is intentionally propagated so another process cannot silently reuse the same row.
  const row = reserve.immediate();
  const credential = decrypt(row.credential_ciphertext);
  return { account: getAccount(row.id), credential, sessionId: extractSessionId(credential, row.credential_kind) };
}

/** Select one specific enabled account for an already-bound task or status check. */
export function selectAccountById(id: string, model = "", video = isVideoModel(model)): AccountSelection {
  const row = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ? AND enabled = 1 AND (cooldown_until IS NULL OR cooldown_until <= ?)`)
    .get(id, now()) as AccountRow | undefined;
  if (!row) throw new Error("指定的即梦账号不可用");
  if (!accountSupportsModel(row.name, model, video)) throw new Error(accountModelError(model, video));
  const timestamp = now();
  db.prepare(`UPDATE ${TABLE} SET last_used_at = ?, updated_at = ? WHERE id = ?`).run(timestamp, timestamp, row.id);
  const credential = decrypt(row.credential_ciphertext);
  return { account: getAccount(row.id), credential, sessionId: extractSessionId(credential, row.credential_kind) };
}

/** Account choice and the durable video slot are reserved under one SQLite write lock. */
export function reserveVideoAccount(taskId: string, perAccount: number, total: number, minimumCredits?: ReadonlyMap<string, number>): AccountSelection | undefined {
  perAccount = Math.min(perAccount, VIDEO_ACCOUNT_SUBMISSION_CONCURRENCY);
  return db.transaction(() => {
    const task = db.prepare("SELECT owner, model, requested_account_id FROM canvas_tasks WHERE id=? AND kind='video' AND status='queued'").get(taskId) as { owner: number; model: string; requested_account_id: string } | undefined;
    if (!task || !db.prepare("SELECT 1 FROM api_keys WHERE id=? AND enabled=1").get(task.owner)) return;
    const usage = videoAccountUsage();
    const accounts = listAccounts().filter(account => accountSupportsModel(account.name, task.model, true));
    // Unknown receipts keep their submission lock; accepted histories render independently.
    if ([...usage.values()].reduce((sum, account) => sum + account.active, 0) >= total) return;
    const eligible = accounts.filter(account => account.enabled && (!account.cooldownUntil || Date.parse(account.cooldownUntil) <= Date.now()) && !account.status.error && Date.now() - Date.parse(account.status.checkedAt || "") < 10_000 && Math.max(0, (account.status.totalCredit ?? 0) - (usage.get(account.id)?.reservedCredits || 0)) >= Math.max(MIN_PAID_CREDIT, minimumCredits ? minimumCredits.get(account.id) ?? Infinity : 0) && (usage.get(account.id)?.active || 0) < perAccount && (!task.requested_account_id || task.requested_account_id === account.id));
    if (!eligible.length) return;
    const selected = task.requested_account_id ? selectAccountById(task.requested_account_id, task.model, true) : selectAccount("round_robin", task.model, true, perAccount, minimumCredits);
    const changed = db.prepare("UPDATE canvas_tasks SET status='preparing', provider_status='preparing', account_id=?, credential=?, credit_before=?, provider_hold=1, deadline=? WHERE id=? AND status='queued'").run(selected.account.id, encrypt(selected.sessionId), selected.account.status.totalCredit, Date.now() + 30 * 60_000, taskId);
    if (!changed.changes) return;
    grantAccountLease(task.owner, selected.account.id);
    return selected;
  }).immediate();
}

export function grantAccountLease(apiKeyId: number, accountId: string, ttlMs = 5 * 60_000): void {
  getRow(accountId);
  const expiresAt = Date.now() + Math.max(1, ttlMs);
  db.prepare(`
    INSERT INTO jimeng_account_leases (api_key_id, account_id, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(api_key_id, account_id) DO UPDATE SET expires_at = excluded.expires_at
  `).run(apiKeyId, accountId, expiresAt);
}

export function hasAccountLease(apiKeyId: number, accountId: string): boolean {
  const row = db.prepare("SELECT expires_at FROM jimeng_account_leases WHERE api_key_id = ? AND account_id = ?")
    .get(apiKeyId, accountId) as { expires_at: number } | undefined;
  return Boolean(row && row.expires_at > Date.now());
}

export function markSuccess(id: string): PublicAccount {
  getRow(id);
  const timestamp = now();
  db.prepare(`
    UPDATE ${TABLE}
    SET success_count = success_count + 1,
        failure_count = CASE WHEN cooldown_until IS NULL OR cooldown_until <= ? THEN 0 ELSE failure_count END,
        cooldown_until = CASE WHEN cooldown_until IS NULL OR cooldown_until <= ? THEN NULL ELSE cooldown_until END,
        last_success_at = ?, updated_at = ?
    WHERE id = ?
  `).run(timestamp, timestamp, timestamp, timestamp, id);
  return getAccount(id);
}

export function markFailure(id: string, cooldownMs = 30_000): PublicAccount {
  const row = getRow(id);
  const delay = Math.min(24 * 60 * 60_000, Math.max(0, cooldownMs) * 2 ** Math.min(row.failure_count, 5));
  const cooldownUntil = new Date(Math.max(Date.parse(row.cooldown_until || "") || 0, Date.now() + delay + Math.random() * delay * 0.1)).toISOString();
  db.prepare(`UPDATE ${TABLE} SET failure_count = failure_count + 1, cooldown_until = ?, last_failure_at = ?, updated_at = ? WHERE id = ?`).run(cooldownUntil, now(), now(), id);
  return getAccount(id);
}

export async function refreshStatus(id: string): Promise<PublicAccount> {
  const row = getRow(id);
  const credential = decrypt(row.credential_ciphertext);
  const sessionId = extractSessionId(credential, row.credential_kind);
  try {
    const credit = await getCredit(sessionId);
    const membership = membershipStatusProvider ? await membershipStatusProvider(sessionId, toPublic(row)) : "unknown";
    const timestamp = now();
    db.prepare(`UPDATE ${TABLE} SET free_credit = ?, purchase_credit = ?, vip_credit = ?, total_credit = ?, membership_json = ?, status_checked_at = ?, status_error = NULL, updated_at = ? WHERE id = ?`).run(
      credit.giftCredit ?? null, credit.purchaseCredit ?? null, credit.vipCredit ?? null, credit.totalCredit ?? null, JSON.stringify(membership), timestamp, timestamp, id
    );
    return getAccount(id);
  } catch (error: any) {
    videoRequestSignal()?.throwIfAborted();
    const message = error instanceof AccountPoolConfigurationError ? error.message : (error?.message || "状态查询失败");
    db.prepare(`UPDATE ${TABLE} SET status_checked_at = ?, status_error = ?, updated_at = ? WHERE id = ?`).run(now(), message.slice(0, 500), now(), id);
    throw error;
  }
}

// Explicit named service API for callers that do not want to use the default object.
export const list = listAccounts;
export const create = createAccount;
export const update = updateAccount;
export const remove = deleteAccount;
export { deleteAccount as delete };
export const select = selectAccount;
export const selectById = selectAccountById;
export const grantLease = grantAccountLease;
export const hasLease = hasAccountLease;

export const accountPool = {
  list: listAccounts,
  get: getAccount,
  create: createAccount,
  update: updateAccount,
  delete: deleteAccount,
  setEnabled: setAccountEnabled,
  select: selectAccount,
  selectById: selectAccountById,
  grantLease: grantAccountLease,
  hasLease: hasAccountLease,
  markSuccess,
  markFailure,
  refreshStatus,
  setMembershipStatusProvider
};

setMembershipStatusProvider(async (sessionId) => {
  const result = await request("POST", "/passport/account/info/v2", sessionId, {
    params: { account_sdk_source: "web" }
  });
  const source = result?.user_info || result?.user || result?.account || result;
  const membership = {
    isVip: source?.is_vip ?? source?.isVip ?? source?.vip_status ?? null,
    vipExpireAt: source?.vip_expire_time ?? source?.vipExpireTime ?? source?.vip_expire_at ?? null,
    membershipType: source?.membership_type ?? source?.membershipType ?? null
  };
  return Object.values(membership).some((value) => value !== null) ? membership : "unknown";
});

export default accountPool;
