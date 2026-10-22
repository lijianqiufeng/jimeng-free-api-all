import accountPool, { accountTier, isVideoSubmissionAccount, videoAccountUsage, VIDEO_ACCOUNT_SUBMISSION_CONCURRENCY } from "@/lib/account-pool.ts";
import { database } from "@/lib/database.ts";
import { readVideoQueueSettings, VIDEO_CONCURRENCY_MAX } from "@/lib/video-queue-settings.ts";

export function videoQueueStatus() {
  const settings = readVideoQueueSettings();
  const tasks = (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_tasks'").get() ? database.prepare("SELECT account_id,status,provider_status,provider_hold,paid_started_at,history_id FROM canvas_tasks WHERE kind='video' AND (status='queued' OR provider_hold=1)").all() : []) as Array<{ account_id: string; status: string; provider_status: string; provider_hold: number; paid_started_at: number; history_id: string }>;
  const uncertain = (task: typeof tasks[number]) => Boolean(task.provider_hold && (!task.history_id && task.paid_started_at || [task.status, task.provider_status].includes("uncertain")));
  const usage = videoAccountUsage(), active = [...usage.values()].reduce((sum, account) => sum + account.active, 0);
  return {
    settings, effectivePerAccountConcurrency: VIDEO_ACCOUNT_SUBMISSION_CONCURRENCY, concurrencyScope: "upload-and-submit", localMaximum: VIDEO_CONCURRENCY_MAX, officialConcurrencyLimit: null,
    queued: tasks.filter(task => task.status === "queued").length,
    active, rendering: [...usage.values()].reduce((sum, account) => sum + account.rendering, 0), billingPending: [...usage.values()].reduce((sum, account) => sum + account.billingPending, 0), uncertain: tasks.filter(uncertain).length,
    accounts: accountPool.list().filter(account => accountTier(account.name) !== "standard" || tasks.some(task => task.account_id === account.id)).map(account => {
      const held = tasks.filter(task => task.provider_hold && task.account_id === account.id);
      const active = usage.get(account.id)?.active || 0;
      return { id: account.id, name: account.name, enabled: account.enabled, tier: accountTier(account.name), active, rendering: usage.get(account.id)?.rendering || 0, billingPending: usage.get(account.id)?.billingPending || 0, uncertain: held.filter(uncertain).length, remainingSlots: account.enabled && isVideoSubmissionAccount(account.name) ? Math.max(0, VIDEO_ACCOUNT_SUBMISSION_CONCURRENCY - active) : 0 };
    }),
  };
}
