/** Public reasons only: never expose upstream request objects, cookies or URLs. */
export function publicJimengFailure(record: Record<string, unknown>): string {
  const message = [record.fail_msg, record.fail_message, record.fail_reason].find((value) => typeof value === "string") as string | undefined;
  if (message?.includes("你上传的图片不符合平台规则") || String(record.fail_code) === "2039") return "你上传的图片不符合平台规则，请修改后重试";
  if (String(record.fail_code) === "2038") return "即梦内容审核未通过，请调整素材或提示词";
  if (["4013", "1015"].includes(String(record.fail_code))) return "即梦安全风控拒绝了本次请求，请稍后重试；未自动重新提交";
  if (message?.includes("操作频繁") || message?.includes("请求过于频繁")) return "即梦请求过于频繁，请稍后重试";
  return `即梦生成失败（${String(record.fail_code || "unknown").replace(/[^\w-]/g, "").slice(0, 40)}）`;
}
