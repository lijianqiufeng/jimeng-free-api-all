import { database } from "./database.ts";
import { parseJimengCreditFloors, spendableJimengCredits } from "./credit-floor.ts";
import { assertJimengPriorityRevision, jimengNewAccountAllowed, jimengPriorityReceipt, parseJimengAccountPriority, type JimengPriorityReceipt } from "./account-priority-contract.ts";

export const accountPriority = parseJimengAccountPriority(process.env.JIMENG_ACCOUNT_PRIORITY);
export const accountPriorityReceipt = jimengPriorityReceipt(accountPriority, parseJimengCreditFloors());
database.exec("CREATE TABLE IF NOT EXISTS jimeng_account_priority(id INTEGER PRIMARY KEY CHECK(id=1),receipt_json TEXT NOT NULL)");
database.transaction(() => {
    const row = database.prepare("SELECT receipt_json FROM jimeng_account_priority WHERE id=1").get() as { receipt_json: string } | undefined;
    const previous: JimengPriorityReceipt | null = row ? JSON.parse(row.receipt_json) : null;
    assertJimengPriorityRevision(accountPriorityReceipt, previous);
    if (accountPriorityReceipt && JSON.stringify(previous) !== JSON.stringify(accountPriorityReceipt)) database.prepare("INSERT INTO jimeng_account_priority(id,receipt_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET receipt_json=excluded.receipt_json").run(JSON.stringify(accountPriorityReceipt));
}).immediate();

export const newAccountAllowed = (id: string, paid = true) => !paid && id !== accountPriority?.primaryAccountId || jimengNewAccountAllowed(accountPriority, id);
export class AccountPriorityError extends Error {}
export function assertNewAccountAllowed(id: string, paid = true) {
    if (!newAccountAllowed(id, paid)) throw new AccountPriorityError("当前账号已停止接收新任务，未提交生成；原任务账号保持");
}

type Candidate = { id: string; status: { totalCredit: number | null; error?: string; checkedAt: string | null } };
/** Funding is checked before busy slots: a funded primary waits, without spending the fallback. */
export function preferredNewAccountIds(accounts: Candidate[], paid: boolean, minimumCredits?: ReadonlyMap<string, number>, reserved?: ReadonlyMap<string, number>) {
    if (!accountPriority || !paid) return undefined;
    const primary = accounts.find((account) => account.id === accountPriority.primaryAccountId && newAccountAllowed(account.id));
    if (primary) {
        const required = Math.max(5, minimumCredits?.get(primary.id) ?? (minimumCredits ? Infinity : 5));
        const held = reserved?.get(primary.id) || 0;
        const unknown = primary.status.error || primary.status.totalCredit === null || !Number.isFinite(primary.status.totalCredit)
            || !(Date.now() - Date.parse(primary.status.checkedAt || "") < 10_000) || !Number.isFinite(required) || !Number.isFinite(held);
        if (!paid || unknown || (spendableJimengCredits(primary.id, primary.status.totalCredit, held) ?? 0) >= required) return new Set([primary.id]);
    }
    return new Set([accountPriority.fallbackAccountId]);
}
