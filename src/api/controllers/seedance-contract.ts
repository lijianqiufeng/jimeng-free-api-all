export const SEEDANCE_MODELS = {
  "jimeng-video-seedance-2.0": { resolutions: ["720p"], maxDuration: 15, images: 9, videos: 3, audios: 3, total: 12 },
  "jimeng-video-seedance-2.5": { resolutions: ["480p", "720p", "1080p"], maxDuration: 30, images: 30, videos: 10, audios: 10, total: 50 },
  "jimeng-video-seedance-2.5-long": { resolutions: ["720p"], maxDuration: 180, images: 30, videos: 10, audios: 10, total: 50 },
  "jimeng-video-seedance-2.5-draft": { resolutions: ["480p"], maxDuration: 30, images: 30, videos: 10, audios: 10, total: 50 },
  "jimeng-video-seedance-2.0-mini": { resolutions: ["720p"], maxDuration: 15, images: 9, videos: 3, audios: 3, total: 12 },
  "jimeng-video-seedance-2.0-fast-vip": { resolutions: ["720p"], maxDuration: 15, images: 9, videos: 3, audios: 3, total: 12 },
  "jimeng-video-seedance-2.0-vip": { resolutions: ["720p", "1080p", "4k"], maxDuration: 15, images: 9, videos: 3, audios: 3, total: 12 },
} as const;
export type SeedanceModel = keyof typeof SEEDANCE_MODELS;
export type SeedanceReference = { kind: "image" | "video" | "audio"; url: string };
export const isLongVideo = (model: string) => model === "jimeng-video-seedance-2.5-long";
/** The quote and paid draft use the same official commerce branch. */
export function seedanceVideoPrice(model: string, resolution: string, hasVideo: boolean, raw: any) {
  const prices = raw?.commercial_config?.resolution_price_configs?.find((price: any) => price.resolution === resolution);
  if (isLongVideo(model)) return hasVideo ? prices?.long_video_price : prices?.no_input_video_long_video_price;
  return model === "jimeng-video-seedance-2.0"
    ? hasVideo ? raw?.commercial_config?.format_conf?.unified_edit_input_video : raw?.commercial_config?.default
    : ["jimeng-video-seedance-2.5", "jimeng-video-seedance-2.5-draft"].includes(model) && !hasVideo ? prices?.no_input_video_price : prices?.price;
}
export function seedanceVideoBenefit(model: string, resolution: string, hasVideo: boolean, raw: any): string | undefined {
  const price = seedanceVideoPrice(model, resolution, hasVideo, raw);
  if (isLongVideo(model) && (resolution !== "720p" || price?.resource_id !== "generate_video" || price?.resource_id_type !== "str" || price?.resource_sub_type !== "aigc" || price?.benefit_type !== (hasVideo ? "seedance_25_long_video_720p_output" : "seedance_25_long_video_720p_no_input_video_output"))) return;
  return typeof price?.benefit_type === "string" && price.benefit_type ? price.benefit_type : undefined;
}
export function seedanceInput(input: any) {
  const model = input.model as SeedanceModel, limits = SEEDANCE_MODELS[model];
  if (!limits) throw Error("不支持的即梦视频模型");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > (limits.maxDuration >= 30 ? 15000 : 4000)) throw Error("视频提示词为空或超出模型长度限制");
  if (!["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].includes(input.ratio)) throw Error("不支持的视频比例");
  if (!(limits.resolutions as readonly string[]).includes(input.resolution)) throw Error("当前即梦模型不支持所选清晰度，未自动降级");
  if (!Number.isInteger(input.duration) || input.duration < (isLongVideo(model) ? 30 : 4) || input.duration > limits.maxDuration) throw Error("当前即梦模型不支持所选时长，未自动缩短");
  if (input.n !== undefined && input.n !== 1) throw Error("每个任务只生成一个视频");
  if (input.images?.length || input.file_paths?.length) throw Error("视频参考素材须放入 references，未忽略旧字段提交");
  const references = input.references ?? [];
  if (!Array.isArray(references) || references.length > limits.total) throw Error("参考素材数量超限");
  const counts = { image: 0, video: 0, audio: 0 };
  let bytes = 0;
  const refs: SeedanceReference[] = references.map((ref: any) => {
    if (!ref || !["image", "video", "audio"].includes(ref.kind) || typeof ref.url !== "string") throw Error("参考素材无效");
    const kind = ref.kind as SeedanceReference["kind"];
    counts[kind]++;
    if (kind === "image") {
      if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(ref.url)) throw Error("参考图只接受 PNG、JPEG 或 WebP data URL");
      const size = Buffer.byteLength(ref.url.slice(ref.url.indexOf(",") + 1), "base64");
      if (size > 25 * 1024 * 1024) throw Error("单张参考图不能超过 25MB");
      bytes += size;
    } else {
      const url = new URL(ref.url);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !/^[a-z0-9-]+\.tos-cn-[a-z0-9-]+\.volces\.com$/.test(url.hostname)) throw Error("视频和音频须使用团队素材公网中转地址");
    }
    return { kind, url: ref.url };
  });
  if (bytes > 40 * 1024 * 1024 || counts.image > limits.images || counts.video > limits.videos || counts.audio > limits.audios) throw Error("参考素材数量或体积超限");
  if (limits.maxDuration === 15 && counts.audio && !counts.image && !counts.video) throw Error("音频参考需要同时添加图片或视频");
  return { model, prompt: input.prompt.trim() as string, ratio: input.ratio as string, resolution: input.resolution as string, duration: input.duration as number, references: refs };
}
