export const premiumImageConfig = {
  model_list: [["high_aes_general_v50", "v5"], ["high_aes_general_v42", "v46"]].map(([model_req_key, version]) => ({
    model_req_key,
    feats: ["t2i", "byte_edit", "per_piece"],
    resolution_map: { "2k": {}, "4k": {} },
    commercial_config: { image_model_commerce_config: { base: {
      default: { resource_sub_type: "aigc", resource_id: "generate_img", benefit_type: `image_basic_${version}_2k`, amount: 1 },
      rules: [{ resolution: ["4k"], benefit_key: { resource_sub_type: "aigc", resource_id: "generate_img", benefit_type: `image_basic_${version}_4k`, amount: 1 } }],
    } } },
  })),
};
export function premiumImageBenefits() {
  return { asset_list: ["image_basic_v5_2k", "image_basic_v5_4k", "image_basic_v46_2k", "image_basic_v46_4k", "queue_speed"].map(benefit_type => ({
    resource_type: benefit_type === "queue_speed" ? "normal_func" : "aigc",
    resource_id: benefit_type === "queue_speed" ? "queue_speed" : "generate_img",
    benefit_type,
    asset_details: [{ pay_mode: "LimitFree", quota_all: -1, quota_left: -1, limit_free_type: 2, ...(benefit_type === "queue_speed" ? {} : { remain_time: 3600 }) }],
  })) };
}
