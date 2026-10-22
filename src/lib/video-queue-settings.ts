import { database } from "./database.ts";

export const VIDEO_CONCURRENCY_MAX = 100;
export type VideoQueueSettings = { perAccountConcurrency: number; totalConcurrency: number | null; version: number; source: "administrator" | "environment" | "default"; updatedAt: number | null };
database.exec(`CREATE TABLE IF NOT EXISTS video_queue_settings (
  id INTEGER PRIMARY KEY CHECK (id=1), per_account INTEGER NOT NULL,
  total INTEGER, version INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`);

function concurrency(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > VIDEO_CONCURRENCY_MAX) throw Error(`${name}须为 1–${VIDEO_CONCURRENCY_MAX} 的整数`);
  return Number(value);
}

export function readVideoQueueSettings(): VideoQueueSettings {
  const row = database.prepare("SELECT per_account,total,version,updated_at FROM video_queue_settings WHERE id=1").get() as { per_account: number; total: number | null; version: number; updated_at: number } | undefined;
  if (row) return { perAccountConcurrency: concurrency(row.per_account, "每账号并发数"), totalConcurrency: row.total === null ? null : concurrency(row.total, "总并发数"), version: row.version, source: "administrator", updatedAt: row.updated_at };
  return {
    perAccountConcurrency: concurrency(Number(process.env.JIMENG_VIDEO_ACCOUNT_CONCURRENCY || 1), "JIMENG_VIDEO_ACCOUNT_CONCURRENCY"),
    totalConcurrency: process.env.JIMENG_VIDEO_CONCURRENCY ? concurrency(Number(process.env.JIMENG_VIDEO_CONCURRENCY), "JIMENG_VIDEO_CONCURRENCY") : null,
    version: 0, source: process.env.JIMENG_VIDEO_ACCOUNT_CONCURRENCY || process.env.JIMENG_VIDEO_CONCURRENCY ? "environment" : "default", updatedAt: null,
  };
}

export function saveVideoQueueSettings(input: unknown): VideoQueueSettings {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["perAccountConcurrency", "totalConcurrency", "expectedVersion"].includes(key))) throw Error("并发配置参数无效");
  const body = input as Record<string, unknown>;
  const perAccount = concurrency(body.perAccountConcurrency, "每账号并发数"), total = body.totalConcurrency === null ? null : concurrency(body.totalConcurrency, "总并发数");
  if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw Error("缺少有效配置版本，请刷新后重试");
  return database.transaction(() => {
    const current = readVideoQueueSettings();
    if (current.version !== body.expectedVersion) throw Object.assign(Error("并发配置已被其他管理员修改，请刷新后核对；当前输入已保留"), { code: "VIDEO_QUEUE_CONFLICT" });
    database.prepare("INSERT INTO video_queue_settings(id,per_account,total,version,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET per_account=excluded.per_account,total=excluded.total,version=excluded.version,updated_at=excluded.updated_at").run(perAccount, total, current.version + 1, Date.now());
    return readVideoQueueSettings();
  }).immediate();
}
