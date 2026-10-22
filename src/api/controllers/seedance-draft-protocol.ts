import { randomUUID } from "node:crypto";

const DRAFT_MODEL = "dreamina_seedance_45_pro_draft";
const MAX_AGE = 7 * 24 * 60 * 60_000;
type Json = Record<string, any>;
export type DraftSource = { historyId: string; itemId: string; finishedTime: number; draftContent: string; submitId: string; duration: number; hasVideo: boolean; referenceVideoSeconds: number; taskExtra: Record<string, unknown> };
const object = (value: unknown): value is Json => Boolean(value && typeof value === "object" && !Array.isArray(value));
const identity = (value: unknown) => typeof value === "string" && /^\d{1,25}$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : "";
const node = (fields: Json = {}) => ({ type: "", id: randomUUID(), ...fields });

function sourceParts(draftContent: string) {
  if (typeof draftContent !== "string" || !draftContent || Buffer.byteLength(draftContent) > 4 * 1024 * 1024) throw Error("原样片草稿未确认，未提交高清正片");
  const draft: Json = JSON.parse(draftContent), chain: Json[] = [], seen = new Set<string>();
  if (!object(draft) || !Array.isArray(draft.component_list) || !draft.main_component_id) throw Error("原样片草稿无效，未提交高清正片");
  let id = draft.main_component_id;
  while (id) {
    const component = draft.component_list.find((item: Json) => item?.id === id);
    if (!component || seen.has(id)) throw Error("原样片图层链无效，未提交高清正片");
    seen.add(id); chain.unshift(component); id = component.parent_id;
  }
  const main = chain.at(-1)!, root = chain[0], genVideo = root.abilities?.gen_video;
  const params = genVideo?.text_to_video_params, input = params?.video_gen_inputs?.[0];
  if (root.type !== "video_base_component" || params?.model_req_key !== DRAFT_MODEL || !object(input) || input.is_draft_mode !== true || ![undefined, 1, 13].includes(main.process_type)) throw Error("原任务不是可升级的样片，未提交高清正片");
  if (input.v2v_opt !== undefined && (!object(input.v2v_opt) || Object.values(input.v2v_opt).some(Boolean))) throw Error("后编辑视频不能作为原样片升级，未提交高清正片");
  const duration = Number(input.duration_ms) / 1000;
  if (!Number.isInteger(duration) || duration < 4 || duration > 30 || input.long_video_input || input.multi_frames?.length) throw Error("原样片时长或参考模式未确认，未提交高清正片");
  const materials = input.unified_edit_input?.material_list ?? [];
  if (!Array.isArray(materials)) throw Error("原样片参考素材未确认，未提交高清正片");
  const videos = materials.filter((material: Json) => material?.material_type === "video");
  const referenceVideoSeconds = videos.reduce((total: number, material: Json) => {
    const milliseconds = Number(material.video_info?.duration);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw Error("原样片参考视频时长未确认，未提交高清正片");
    return total + milliseconds;
  }, 0) / 1000;
  if (referenceVideoSeconds > 30.2) throw Error("原样片参考视频时长超限，未提交高清正片");
  const taskExtra = genVideo.video_task_extra ? JSON.parse(genVideo.video_task_extra) : {};
  if (!object(taskExtra)) throw Error("原样片执行快照无效，未提交高清正片");
  return { draft, chain, root, main, duration, referenceVideoSeconds, hasVideo: videos.length > 0, taskExtra };
}

/** Read only the original official success, including its official completion time. */
export function readDraftSource(response: unknown, historyId: string): DraftSource {
  if (!identity(historyId) || !object(response)) throw Error("原样片历史编号无效，未提交高清正片");
  const history = response[historyId] || [...(response.history_list || []), ...(response.history_records || [])].find((item: Json) => identity(item?.history_record_id || item?.id) === historyId);
  if (!object(history) || history.history_record_id !== undefined && identity(history.history_record_id) !== historyId || Number(history.status ?? history.task?.status) !== 50) throw Error("原样片尚未确认最终成功，未提交高清正片");
  const items = history.item_list;
  if (!Array.isArray(items) || items.length !== 1 || !object(items[0]?.video)) throw Error("原样片结果身份未确认，未提交高清正片");
  const itemId = identity(items[0].common_attr?.id), finishedTime = Number(history.finish_time || history.task?.finish_time) * 1000;
  const submitId = history.task?.submit_id || history.submit_id;
  if (!itemId || !Number.isFinite(finishedTime) || finishedTime <= 0 || typeof submitId !== "string" || !submitId) throw Error("原样片结果或官方完成时间缺失，未提交高清正片");
  const parts = sourceParts(history.draft_content);
  return { historyId, itemId, finishedTime, draftContent: history.draft_content, submitId, duration: parts.duration, hasVideo: parts.hasVideo, referenceVideoSeconds: parts.referenceVideoSeconds, taskExtra: parts.taskExtra };
}

export function assertDraftSourceAvailable(source: DraftSource, now = Date.now()) {
  const parts = sourceParts(source.draftContent);
  if (!identity(source.historyId) || !identity(source.itemId) || !source.submitId || !Number.isFinite(source.finishedTime) || source.finishedTime <= 0 || source.finishedTime > now) throw Error("原样片结果或官方完成时间未确认，未提交高清正片");
  if (now - source.finishedTime > MAX_AGE) throw Error("原样片已超过 7 天有效期，未提交高清正片");
  if (source.duration !== parts.duration || source.hasVideo !== parts.hasVideo || source.referenceVideoSeconds !== parts.referenceVideoSeconds) throw Error("原样片计费快照不匹配，未提交高清正片");
}

/** Official GenerateFromDraft (process 15), retaining the original draft chain. */
export function buildGenerateFromDraft(source: DraftSource, resolution = "1080p") {
  assertDraftSourceAvailable(source);
  if (resolution !== "1080p") throw Error("当前样片仅开放升级 1080p，未自动切换清晰度");
  const { chain, main, taskExtra: originalExtra } = sourceParts(source.draftContent);
  for (const component of chain) for (const input of component.abilities?.gen_video?.text_to_video_params?.video_gen_inputs || []) delete input.is_draft_mode;
  const taskExtra = { promptSource: "custom", isDefaultSeed: 1, ...originalExtra, originSubmitId: originalExtra.originSubmitId || source.submitId, originId: originalExtra.originId || source.itemId, previewSubmitId: source.submitId, isRegenerate: false, enterFrom: originalExtra.enterFrom || "click", videoProcessType: 15, videoStage: "final" };
  const component = node({ type: "video_base_component", min_version: "1.0.0", parent_id: main.id, generate_type: "gen_video", aigc_mode: "workbench", process_type: 15,
    metadata: node({ created_platform: 3, created_platform_version: "", created_time_in_ms: String(Date.now()), created_did: "" }),
    abilities: node({ gen_video: node({
      text_to_video_params: node({ video_gen_inputs: [node({ min_version: "3.2.4", origin_history_id: source.historyId, resolution, v2v_opt: node({ min_version: "3.1.0", generate_from_draft: node({ min_version: "3.3.28", enable: true }) }) })] }),
      video_task_extra: JSON.stringify(taskExtra), video_ref_params: node({ generate_type: 0, origin_history_id: source.historyId, item_id: source.itemId }),
    }) }),
  });
  const draft = node({ type: "draft", min_version: "3.3.28", is_from_tsn: true, version: "3.3.30", main_component_id: component.id, component_list: [...chain, component] });
  return { draft, rootModel: DRAFT_MODEL, taskExtra };
}
