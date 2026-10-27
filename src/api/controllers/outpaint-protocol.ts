import { randomUUID } from "node:crypto";
import { imageSize } from "image-size";
import { publicJimengFailure } from "./task-errors.ts";

// This first integration exposes the workbench's eight ratios; the official enum has more.
export const OUTPAINT_RATIOS = { "1:1": 1, "3:4": 2, "16:9": 3, "4:3": 4, "9:16": 5, "2:3": 6, "3:2": 7, "21:9": 8 } as const;
export type OutpaintInput = { id: string; image: string; prompt: string; left: number; right: number; top: number; bottom: number; maxSize: number; ratio: keyof typeof OUTPAINT_RATIOS; width: number; height: number };
export type OutpaintResult = { index: number; itemId?: string; url: string; width?: number; height?: number };

export function outpaintTaskInput(value: any): OutpaintInput {
  const fields = ["id", "image", "prompt", "left", "right", "top", "bottom", "maxSize", "ratio"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || !/^[A-Za-z0-9_-]{16,100}$/.test(value.id || "")) throw Error("扩图任务参数无效");
  if (typeof value.image !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image)) throw Error("扩图原图只接受 PNG、JPEG 或 WebP data URL");
  if (value.image.length > Math.ceil(25 * 1024 * 1024 / 3) * 4 + 32) throw Error("扩图原图须小于 25MB");
  const bytes = Buffer.from(value.image.slice(value.image.indexOf(",") + 1), "base64");
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw Error("扩图原图须小于 25MB");
  let width: number, height: number;
  try { const info = imageSize(bytes), orientation = info.orientation || 1; if (orientation < 1 || orientation > 8) throw Error(); width = orientation >= 5 ? info.height : info.width; height = orientation >= 5 ? info.width : info.height; if (info.type !== (value.image.startsWith("data:image/jpeg;") ? "jpg" : value.image.slice(11, value.image.indexOf(";")))) throw Error(); }
  catch { throw Error("扩图原图无法读取真实尺寸"); }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 32_000_000) throw Error("扩图原图尺寸超过安全上限");
  if (["left", "right", "top", "bottom"].some(key => typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) || !(value.left + value.right + value.top + value.bottom > 0)) throw Error("扩图方向比例无效或没有新增区域");
  if (!Object.hasOwn(OUTPAINT_RATIOS, value.ratio) || !Number.isSafeInteger(value.maxSize) || value.maxSize < 1 || value.maxSize > 8192) throw Error("扩图目标比例或最长边无效");
  const [rw, rh] = value.ratio.split(":").map(Number), targetRatio = rw / rh;
  const canvasWidth = width * (1 + value.left + value.right), canvasHeight = height * (1 + value.top + value.bottom), expandedRatio = canvasWidth / canvasHeight;
  if (!Number.isFinite(expandedRatio) || Math.abs(expandedRatio / targetRatio - 1) > 0.015 || canvasWidth * canvasHeight > 32_000_000 || Math.max(canvasWidth, canvasHeight) > 8192 || value.maxSize !== Math.round(Math.max(canvasWidth, canvasHeight))) throw Error("扩图位置与目标尺寸不一致或超过安全上限，请减小倍率");
  if (value.prompt !== undefined && (typeof value.prompt !== "string" || value.prompt.length > 2000)) throw Error("扩图提示词须不超过 2000 字符");
  return { id: value.id, image: value.image, prompt: value.prompt?.trim() || "", left: value.left, right: value.right, top: value.top, bottom: value.bottom, maxSize: value.maxSize, ratio: value.ratio, width, height };
}

// Frozen official home-tool-image-outpaint -> Q6 -> LOh/HzX; see docs/native-outpaint.md.
// DANode defaults, DAImageResource's image_uri+uri and draft versions are source-derived.
export function buildOutpaintRequest(input: OutpaintInput, uri: string, workspaceId: string, submitId: string, createdAt: number) {
  const node = (fields: Record<string, unknown>) => ({ type: "", id: randomUUID(), ...fields });
  const resources = input.prompt ? [node({ resource_type: 1, purpose: 1, content: node({ text: node({ text_content: input.prompt }) }) })] : [];
  resources.push(node({ resource_type: 2, purpose: 11, content: node({ image: node({ image_content: node({ type: "image", source_from: "", platform_type: 1, name: "origin", image_uri: uri, uri, width: input.width, height: input.height, format: "" }) }) }) }));
  const component = node({ type: "image_base_component", min_version: "3.0.2", aigc_mode: "workbench", generate_type: "unified_generate", metadata: node({ created_platform: 3, created_platform_version: "", created_time_in_ms: String(createdAt), created_did: "" }), abilities: node({ unified_generate: node({ generate_type: 8, core_param: node({ prompt: input.prompt, generate_type: 0 }), unified_ability_list: [node({ ability_code: "outpainting", ability_param: node({ resource_list: resources, option: node({ out_painting: node({ top: input.top, bottom: input.bottom, left: input.left, right: input.right, max_size: input.maxSize, image_ratio: OUTPAINT_RATIOS[input.ratio] }) }) }) })] }) }) });
  const draft = node({ type: "draft", min_version: "3.0.2", min_features: [], is_from_tsn: true, version: "3.3.32", main_component_id: component.id, component_list: [component] });
  return { submit_id: submitId, extend: { workspace_id: workspaceId }, metrics_extra: JSON.stringify({ generateCount: 1, enterFrom: "ai_feature" }), draft_content: JSON.stringify(draft), http_common_info: { aid: 513695 } };
}

// Frozen GS.wi/Wu + sa0.ri: query names and URI encoding differ from draft JSON.
export function outpaintRequestParams(submitId: string) {
  return { da_version: "3.1.3", generate_id: `gen-${submitId}`, commerce_with_input_video: "1", babi_param: encodeURIComponent(JSON.stringify({ feature_entrance: "canvas", feature_entrance_detail: "canvas-expand", feature_key: "to_image_expand", scenario: "image_video_generation", edit_type: "tool", tool_id: "tool_image", sub_tool_id: "tool_image", tab_name: "tool", enter_from: "tool", template_id: "", scene_lv1: "tool", scene_lv2: "tool_image" })) };
}

export function readOutpaintWorkspace(value: any): string | undefined {
  const workspace = value?.workspace || value?.workspaces?.[0] || value?.workspace_list?.[0] || value;
  const id = workspace?.workspace_id ?? workspace?.workspaceId ?? workspace?.id;
  return id !== "0" && (typeof id === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(id) || typeof id === "number" && Number.isSafeInteger(id) && id > 0) ? String(id) : undefined;
}

export function outpaintHistoryResult(value: any, historyId: string, submitId: string) {
  const record = value?.[historyId] || [...(value?.history_list || []), ...(value?.history_records || [])].find((item: any) => String(item?.history_record_id || item?.id) === historyId);
  if (!record) return { status: "running" as const };
  if (record.history_record_id && String(record.history_record_id) !== historyId || record.submit_id && record.submit_id !== submitId) throw Error("扩图原任务回执身份不一致");
  if ([30, 40].includes(Number(record.status))) return { status: "failed" as const, error: publicJimengFailure(record) };
  if (Number(record.status) !== 50) return { status: "running" as const };
  const items = Array.isArray(record.item_list) ? record.item_list : [];
  if (items.length > 4) return { status: "uncertain" as const, error: "原扩图返回超过4张成果，保留原历史待核，未截断或重新生成", errorCode: "result_count_unconfirmed" };
  const data: OutpaintResult[] = [];
  for (const [index, item] of items.entries()) {
    const image = item?.image, large = image?.large_images?.[0], url = large?.image_url;
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) return { status: "running" as const };
    const width = Number(large.width ?? image.width), height = Number(large.height ?? image.height);
    const id = item?.common_attr?.id ?? item?.id, itemId = id !== 0 && id !== "0" && (typeof id === "string" || Number.isSafeInteger(id)) && /^[A-Za-z0-9:_-]{1,160}$/.test(String(id)) ? String(id) : undefined;
    data.push({ index, ...(itemId ? { itemId } : {}), url, ...(Number.isSafeInteger(width) && width > 0 ? { width } : {}), ...(Number.isSafeInteger(height) && height > 0 ? { height } : {}) });
  }
  const ids = data.flatMap(item => item.itemId ? [item.itemId] : []);
  if (new Set(ids).size !== ids.length) return { status: "uncertain" as const, error: "原扩图成果身份重复，保留原历史待核，未重新生成", errorCode: "result_identity_unconfirmed" };
  return data.length ? { status: "succeeded" as const, data } : { status: "running" as const };
}

/** Refresh signed URLs only for the same original results, retaining their first accepted order. */
export function refreshOutpaintResults(previous: OutpaintResult[], current: OutpaintResult[]) {
  if (previous.length !== current.length) throw Error("原扩图成果数量变化，保留已存成果和原历史待核");
  const objectKey = (url: string) => { const value = new URL(url); return value.origin + value.pathname; };
  return previous.map((item, index) => {
    const next = item.itemId ? current.find(value => value.itemId === item.itemId) : current[index];
    if (!next || !item.itemId && objectKey(item.url) !== objectKey(next.url) || item.width !== undefined && next.width !== undefined && item.width !== next.width || item.height !== undefined && next.height !== undefined && item.height !== next.height) throw Error("原扩图成果身份变化，保留已存成果和原历史待核");
    return { ...item, ...next, index };
  });
}
