import { request } from "./core.ts";
import { findHistoryRecord } from "./agent-upscale-protocol.ts";

export function officialAssetReader(token: string) {
  const signal = AbortSignal.timeout(9_000);
  const params = { web_version: "7.5.0", da_version: "3.3.40", aigc_features: "app_lip_sync" };
  const headers = { Cookie: ["sessionid", "sessionid_ss", "sid_tt"].map(name => `${name}=${token}`).join("; ") };
  return (uri: string, data: object) => request("post", uri, token, { data, params, headers, signal });
}

// The image download button asks for a full local item. Gallery/history previews are separate renditions.
export async function officialUpscaleImage(read: (uri: string, data: object) => Promise<any>, historyId: string, submitId: string) {
  const settings = await read("/mweb/v1/get_settings", {});
  if (settings?.user_custom_settings?.close_watermark !== true) return;
  const history = findHistoryRecord(await read("/mweb/v1/get_history_by_ids", { history_ids: [historyId] }), submitId, historyId);
  if (!history || ![21, 50].includes(Number(history.status)) || String(history.history_record_id || history.id) !== historyId
    || String(history.task?.submit_id) !== submitId || !Array.isArray(history.item_list) || history.item_list.length !== 1) return;
  const source = history.item_list[0], itemId = String(source?.common_attr?.id ?? "");
  if (!source?.image || !/^[A-Za-z0-9_-]{1,128}$/.test(itemId)) return;
  const image_scene_list = [2400, 1080, 900, 720, 480, 360].map((width, index) => ({
    scene: index === 0 ? "normal" : "loss", width, height: width, uniq_key: String(width), format: "webp",
  }));
  const response = await read("/mweb/v1/get_local_item_list", {
    item_id_list: [itemId], pack_item_opt: { scene: 1, need_data_integrity: true },
    image_info: { width: 2048, height: 2048, format: "webp", image_scene_list }, is_for_video_download: false,
  });
  const item = response?.item_list?.[0];
  if (response?.item_list?.length !== 1 || String(item?.common_attr?.id) !== itemId) return;
  const variants = item?.image?.large_images;
  if (!Array.isArray(variants) || variants.length !== 1) return;
  const image = variants[0], previous = source.image.large_images?.[0];
  if (!Number.isSafeInteger(image?.width) || !Number.isSafeInteger(image?.height) || Math.min(image.width, image.height) < 1
    || (previous?.width > 0 && previous.width !== image.width) || (previous?.height > 0 && previous.height !== image.height)
    || typeof image.image_url !== "string") return;
  let address: URL;
  try { address = new URL(image.image_url); } catch { return; }
  if (address.protocol === "https:" && !address.username && !address.password && !address.port
    && /^p\d+-dreamina-sign\.byteimg\.com$/.test(address.hostname)) return address.href;
}
