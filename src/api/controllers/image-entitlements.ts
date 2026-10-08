import { isPremiumFreeImageModel } from "@/lib/account-pool.ts";
import type { JimengModelConfig } from "./models.ts";
import { request } from "./core.ts";

export async function assertPremiumImageEntitlement(model: JimengModelConfig, resolution: string, token: string): Promise<void> {
  if (!isPremiumFreeImageModel(model.modelReqKey)) return;
  const base = model.raw?.commercial_config?.image_model_commerce_config?.base;
  const benefit = base?.rules?.filter((rule: any) => rule.resolution?.includes(resolution)).at(-1)?.benefit_key || base?.default;
  const expected = `image_basic_${model.modelReqKey === "high_aes_general_v50" ? "v5" : "v46"}_${resolution}`;
  if (!model.raw?.feats?.includes("per_piece") || benefit?.benefit_type !== expected || benefit.resource_sub_type !== "aigc" || benefit.resource_id !== "generate_img") {
    throw Error("当前账号所选清晰度的免费权益配置未确认，未提交生成");
  }
  let response: any;
  try {
    response = await request("post", "/commerce/v3/benefits/batch_get_user_benefit", token, {
      data: { query_list: [
        { resource_type: "aigc", resource_id: "generate_img", benefit_type_list: [expected] },
        { resource_type: "normal_func", resource_id: "queue_speed", benefit_type_list: ["queue_speed"] },
      ] },
    });
  } catch {
    throw Error("当前账号免费高速权益查询失败，未提交生成");
  }
  const free = (type: string, id: string, key: string, timed: boolean) => response?.asset_list?.some((asset: any) =>
    asset.resource_type === type && asset.resource_id === id && asset.benefit_type === key &&
    asset.asset_details?.some((detail: any) => detail.pay_mode === "LimitFree" && detail.limit_free_type === 2 &&
      detail.quota_all === -1 && detail.quota_left === -1 &&
      (timed ? Number.isFinite(detail.remain_time) && detail.remain_time > 0 : detail.remain_time === undefined || Number.isFinite(detail.remain_time) && detail.remain_time > 0)));
  if (!free("aigc", "generate_img", expected, true) || !free("normal_func", "queue_speed", "queue_speed", false)) {
    throw Error("当前账号没有所选清晰度的免费高速权益，未提交生成");
  }
}
