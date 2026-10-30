import { readVideoBilling, type VideoBilling } from "./video-billing.ts";

export type OutpaintBilling = VideoBilling & { operation: "outpaint" };

/** Reuse the original-submit consumption-record reader; never infer a bill from balance changes. */
export async function readOutpaintBilling(token: string, task: { id: string; account_id: string; history_id: string; submit_id: string }, history: any): Promise<OutpaintBilling | undefined> {
  if (!task.submit_id || history?.submit_id !== task.submit_id) return;
  const billing = await readVideoBilling(token, task, history);
  return billing ? { ...billing, operation: "outpaint" } : undefined;
}
