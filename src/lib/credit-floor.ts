export function parseJimengCreditFloors(value = process.env.JIMENG_ACCOUNT_CREDIT_FLOORS || "{}") {
    const input: unknown = JSON.parse(value);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("即梦保留积分配置必须为账号ID到积分的映射");
    const result = new Map<string, number>();
    for (const [id, amount] of Object.entries(input)) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(amount) || amount < 0) throw Error("即梦保留积分配置无效");
        result.set(id, amount);
    }
    return result;
}

const floors = parseJimengCreditFloors();
export const jimengCreditFloor = (accountId: string) => floors.get(accountId) || 0;
export function spendableJimengCredits(accountId: string, total: number | null, held = 0): number | null {
    if (total === null || !Number.isFinite(total) || total < 0) return null;
    return Math.max(0, total - jimengCreditFloor(accountId) - held);
}
