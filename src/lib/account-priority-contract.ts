import { createHash } from "node:crypto";

export type JimengAccountPriority = { schema: "jimeng-account-priority-v1"; revision: number; primaryAccountId: string; fallbackAccountId: string; primaryUntil: string };
export type JimengPriorityReceipt = { schema: "jimeng-account-priority-v1"; revision: number; hash: string };

export function parseJimengAccountPriority(value: string | undefined): JimengAccountPriority | null {
    if (value === undefined) return null;
    const input = JSON.parse(value);
    if (!input || input.schema !== "jimeng-account-priority-v1" || !Number.isSafeInteger(input.revision) || input.revision < 1
        || ![input.primaryAccountId, input.fallbackAccountId].every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id))
        || input.primaryAccountId === input.fallbackAccountId || typeof input.primaryUntil !== "string"
        || !Number.isFinite(Date.parse(input.primaryUntil)) || new Date(input.primaryUntil).toISOString() !== input.primaryUntil
        || Object.keys(input).sort().join(",") !== "fallbackAccountId,primaryAccountId,primaryUntil,revision,schema") throw Error("即梦账号优先级配置无效，已阻止新提交");
    return { schema: input.schema, revision: input.revision, primaryAccountId: input.primaryAccountId, fallbackAccountId: input.fallbackAccountId, primaryUntil: input.primaryUntil };
}

export function jimengPriorityReceipt(config: JimengAccountPriority | null, floors: ReadonlyMap<string, number>): JimengPriorityReceipt | null {
    if (!config) return null;
    const hash = createHash("sha256").update(JSON.stringify({ config, floors: [...floors].sort(([a], [b]) => a.localeCompare(b)) })).digest("hex");
    return { schema: config.schema, revision: config.revision, hash };
}

/** A persisted enabled policy cannot disappear or be downgraded by a restart. */
export function assertJimengPriorityRevision(current: JimengPriorityReceipt | null, previous: JimengPriorityReceipt | null) {
    if (previous && (!current || previous.schema !== current.schema || !Number.isSafeInteger(previous.revision) || !/^[a-f0-9]{64}$/.test(previous.hash)
        || current.revision < previous.revision || current.revision === previous.revision && current.hash !== previous.hash)) throw Error("即梦账号优先级或保留积分配置缺失、回退或不一致，已阻止新提交");
}

export function jimengNewAccountAllowed(config: JimengAccountPriority | null, id: string, now = Date.now()) {
    return !config || id === config.fallbackAccountId || id === config.primaryAccountId && now < Date.parse(config.primaryUntil);
}
