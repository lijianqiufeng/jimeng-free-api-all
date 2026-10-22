/** Public reasons only: never expose upstream request objects, cookies or URLs. */
export function publicJimengFailure(record: Record<string, unknown>): string {
  const items = Array.isArray(record.failed_item_list) ? record.failed_item_list : [];
  const reasons = [record.fail_starling_message, record.fail_msg, record.fail_message, record.fail_reason, ...items.flatMap((item: any) => [item?.fail_starling_message, item?.fail_msg, item?.fail_message, item?.fail_reason, item?.gen_result_data?.result_msg])].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  const message = reasons.join(" ");
  if (message?.includes("你上传的图片不符合平台规则") || String(record.fail_code) === "2039") return "你上传的图片不符合平台规则，请修改后重试";
  if (String(record.fail_code) === "2038") return "即梦内容审核未通过，请调整素材或提示词";
  if (["4013", "1015"].includes(String(record.fail_code))) return "即梦安全风控拒绝了本次请求，请稍后重试；未自动重新提交";
  if (message?.includes("操作频繁") || message?.includes("请求过于频繁")) return "即梦请求过于频繁，请稍后重试";
  const publicReason = reasons.find(value => /[\u3400-\u9fff]/u.test(value) && value.length <= 300 && !/https?:|cookie|token|authorization|api.?key|password|secret|[<>]/i.test(value));
  if (publicReason) return publicReason.replace(/。?如有问题[，,]?请点击这里反馈[。.]?$/, "").trim();
  if (/未通过审核|审核未通过|审核不通过|不符合平台规则/.test(message)) return "即梦生成的图片未通过审核，请调整提示词或参考图后再次生成";
  if (items.some((item: any) => item?.gen_result_data?.result_msg === "SystemBusy") || String(record.fail_code) === "150100") return "即梦服务繁忙，暂时无法生成，请稍后重试（150100）";
  return `即梦生成失败（${String(record.fail_code || "unknown").replace(/[^\w-]/g, "").slice(0, 40)}），上游未提供具体原因`;
}
