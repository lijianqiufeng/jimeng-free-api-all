import { publicJimengFailure } from "./task-errors.ts";
import { SEEDANCE_MODELS, seedanceInput } from "./seedance-contract.ts";
export const TASK_MODELS = {
  "jimeng-image-5.0-lite": "image",
  "jimeng-image-5.0-pro": "image",
  "jimeng-image-4.7": "image",
  "jimeng-image-4.6": "image",
} as const;

export function taskInput(input: any) {
  if (!input || typeof input !== "object" || !/^[A-Za-z0-9_-]{16,100}$/.test(input.id || "")) throw Error("任务 ID 无效");
  if (Object.hasOwn(SEEDANCE_MODELS, input.model)) return { id: String(input.id), kind: "video" as const, ...seedanceInput(input) };
  const kind = TASK_MODELS[input.model as keyof typeof TASK_MODELS];
  if (!kind) throw Error("不支持的即梦模型");
  if (input.n !== undefined && input.n !== 1) throw Error("每个任务仅生成一张图片");
  const promptLimit = 2000;
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > promptLimit) throw Error(`提示词须为 1–${promptLimit} 字符`);
  const ratios = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
  if (!ratios.includes(input.ratio)) throw Error("不支持的画幅比例");
  if (!["2k", "4k"].includes(input.resolution)) throw Error("不支持的清晰度");
  const images = input.images ?? [];
  if (!Array.isArray(images) || images.length > 10) throw Error("参考图数量超限");
  let bytes = 0;
  for (const image of images) {
    if (typeof image !== "string" || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw Error("参考图只接受 PNG、JPEG 或 WebP 的 data URL");
    const size = Buffer.byteLength(image.slice(image.indexOf(",") + 1), "base64");
    if (size > 25 * 1024 * 1024) throw Error("单张参考图不能超过 25MB");
    bytes += size;
  }
  if (bytes > 40 * 1024 * 1024) throw Error("参考图合计不能超过 40MB");
  return { id: String(input.id), kind, model: String(input.model), prompt: input.prompt.trim(), ratio: String(input.ratio), resolution: String(input.resolution), images: images as string[] };
}

// The history API returns either an ID-keyed object or a history_list envelope.
export function taskResult(result: any, historyId: string, kind: "image" | "video") {
  const history = result?.[historyId] || [...(result?.history_list || []), ...(result?.history_records || [])].find((item: any) => String(item?.history_record_id || item?.id) === historyId);
  if (!history) return { status: "running" as const };
  if ([30, 40].includes(Number(history.status))) return { status: "failed" as const, error: publicJimengFailure(history) };
  const urls = (Array.isArray(history.item_list) ? history.item_list : []).map((item: any) => kind === "image"
    ? item?.image?.large_images?.[0]?.image_url
    : item?.video?.transcoded_video?.origin?.video_url || item?.video?.play_url || item?.video?.download_url || item?.video?.url
  ).filter((url: unknown): url is string => typeof url === "string" && /^https:\/\//i.test(url));
  // A canvas task requests exactly one image. Jimeng can keep the surrounding
  // conversation open for a separately confirmed batch after that image exists.
  if (urls.length && (kind === "image" || [21, 50].includes(Number(history.status)))) return { status: "succeeded" as const, urls: urls.slice(0, 1) };
  return { status: "running" as const };
}
