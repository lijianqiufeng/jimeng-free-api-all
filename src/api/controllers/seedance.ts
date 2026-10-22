import { freezeVideoQuote } from "./video-quote.ts";
import { randomUUID } from "node:crypto";
import { imageSize } from "image-size";
import { request, uploadFile } from "./core.ts";
import { fetchVideoModelConfigs, resolveVideoModelConfig } from "./models.ts";
import { isLongVideo, seedanceInput, seedanceVideoBenefit } from "./seedance-contract.ts";
import { UploadError, seedanceUploadUser, uploadSeedanceReference } from "./seedance-upload.ts";
import { assertDraftSourceAvailable, buildGenerateFromDraft, readDraftSource, type DraftSource } from "./seedance-draft-protocol.ts";

const node = (fields: Record<string, unknown>) => ({ type: "", id: randomUUID(), ...fields });
export type SeedanceSubmitHooks = { beforeSubmit(): void; onSubmitted(id: string): void; onSubmitting?(): void; onQuoted(quote: Awaited<ReturnType<typeof freezeVideoQuote>> & { submitId: string; draftId: string }): void | Promise<void> };

/** One paid POST only. The caller persists its account and history ID before polling. */
export async function submitSeedanceVideo(input: ReturnType<typeof seedanceInput>, token: string, hooks: SeedanceSubmitHooks) {
  const isDraft = input.model === "jimeng-video-seedance-2.5-draft";
  const isLong = isLongVideo(input.model);
  let config = isLong ? (await fetchVideoModelConfigs(token, true)).find(model => model.id === input.model) : await resolveVideoModelConfig(input.model, token);
  if (!config) throw Error("当前账号未确认可用超长视频模式，未提交生成");
  if (config.source !== "dynamic" || config.raw?.model_status !== 0) throw Error("当前账号未确认可用视频模型，未提交生成");
  if (isDraft && (config.modelReqKey !== "dreamina_seedance_45_pro_draft" || config.raw?.extra?.is_draft_mode !== true)) throw Error("当前账号未确认可用样片模式，未提交生成");
  if (!config.supportedResolutions.includes(input.resolution) || !config.supportedDurations?.includes(input.duration)) throw Error("当前账号不支持所选视频参数，未提交生成");
  const is25 = isLong || isDraft || input.model === "jimeng-video-seedance-2.5", materials: Record<string, unknown>[] = [];
  const checkLongReferences = () => {
    if (!isLong) return;
    const option = config?.raw?.options?.find((item: any) => item.key === "unified_edit"), limits = option?.unified_edit_config;
    if (config?.mode !== "long" || !config.durationRange || !config.supportedDurations?.includes(input.duration) || option?.forbidden_display !== false || !Number.isInteger(limits?.max_total_count) || input.references.length > limits.max_total_count || !Number.isInteger(config.raw.extra?.max_prompt_length) || input.prompt.length > config.raw.extra.max_prompt_length) throw Error("当前账号超长视频素材或时长能力未确认，未提交生成");
    for (const [kind, materialType] of [["image", 1], ["video", 2], ["audio", 3]] as const) {
      const refs = input.references.filter(ref => ref.kind === kind), rule = limits.supported_materials?.find((item: any) => item.material_type === materialType)?.limit;
      if (refs.length && (!Number.isInteger(rule?.max_count) || refs.length > rule.max_count)) throw Error("当前账号超长视频素材数量不支持，未提交生成");
      if (kind !== "image" && refs.length && materials.length) {
        const seconds = materials.filter(material => material.material_type === kind).map(material => Number((material[`${kind}_info`] as any)?.duration) / 1000);
        if (![rule.min_duration, rule.max_duration, limits[`max_total_${kind}_duration`]].every(value => Number.isFinite(value) && value > 0) || seconds.some(value => value < rule.min_duration || value > rule.max_duration) || seconds.reduce((sum, value) => sum + value, 0) > limits[`max_total_${kind}_duration`]) throw Error("当前账号超长视频参考时长不支持，未提交生成");
      }
    }
  };
  checkLongReferences();
  let userId = "";
  const referenceCounts = { video: 0, audio: 0 };
  for (const ref of input.references) {
    hooks.beforeSubmit();
    if (ref.kind === "image") {
      const data = Buffer.from(ref.url.slice(ref.url.indexOf(",") + 1), "base64");
      const { width, height, type } = imageSize(data);
      if (width < 300 || height < 300 || width > 6000 || height > 6000 || width / height < 0.4 || width / height > 2.5) throw Error("参考图尺寸不符合模型限制，未提交生成");
      const uploaded = await uploadFile(token, ref.url);
      materials.push(node({ material_type: "image", image_info: node({ type: "image", source_from: "upload", platform_type: 1, name: "", image_uri: uploaded.image_uri, uri: uploaded.image_uri, width, height, format: type }) }));
    } else {
      const index = ++referenceCounts[ref.kind];
      try {
        userId ||= await seedanceUploadUser(token, ref.kind, hooks.beforeSubmit);
        materials.push(node({ material_type: ref.kind, [`${ref.kind}_info`]: node({ type: ref.kind, source_from: "upload", name: "", ...await uploadSeedanceReference(token, ref as { kind: "video" | "audio"; url: string }, is25 ? 30 : 15, hooks.beforeSubmit, userId) }) }));
      } catch (error) {
        if (error instanceof UploadError) error.message = error.message.replace(/^参考(视频|音频)/, `参考$1 ${index}：`);
        throw error;
      }
    }
  }
  for (const kind of ["video", "audio"]) {
    const total = materials.reduce((sum, material) => sum + Number((material[`${kind}_info`] as any)?.duration || 0), 0);
    if (total > (is25 ? 30200 : kind === "video" ? 15200 : 15000)) throw Error("参考音视频总时长超限，未提交生成");
  }
  if (isLong) {
    config = (await fetchVideoModelConfigs(token, true)).find(model => model.id === input.model);
    if (!config) throw Error("当前账号未确认可用超长视频模式，未提交生成");
    checkLongReferences();
  }
  const hasVideo = input.references.some(ref => ref.kind === "video");
  const benefitType = seedanceVideoBenefit(input.model, input.resolution, hasVideo, config.raw);
  if (!benefitType) throw Error("当前视频计费项未确认，未提交生成");
  const commerce = { benefit_type: benefitType, resource_id: "generate_video", resource_id_type: "str", resource_sub_type: "aigc" };
  const referenceVideoSeconds = materials.reduce((sum, material) => sum + Number((material.video_info as any)?.duration || 0), 0) / 1000;
  hooks.beforeSubmit();
  const submitId = randomUUID(), draftId = randomUUID();
  const quote = { ...await freezeVideoQuote(token, { model: input.model, resolution: input.resolution, duration: input.duration, hasVideo, referenceVideoSeconds }, config), submitId, draftId };
  hooks.beforeSubmit();
  await hooks.onQuoted(quote);
  const componentId = randomUUID();
  const metaList = materials.map((material, index) => node({ meta_type: material.material_type, text: "", material_ref: node({ material_idx: index }) }));
  metaList.push(node({ meta_type: "text", text: input.prompt }) as any);
  const minVersion = isLong ? "3.3.21" : materials.length ? "3.3.9" : "3.0.5";
  const taskExtra = isLong ? { functionMode: "long_video", generatorFeature: "longVideo" } : undefined;
  const videoInput = node({ min_version: minVersion, prompt: isLong ? "" : input.prompt, duration_ms: input.duration * 1000, fps: 24, resolution: input.resolution, video_mode: 2, ...(isDraft ? { is_draft_mode: true } : {}), ...(isLong ? { long_video_input: node({ material_list: materials, meta_list: metaList }) } : materials.length ? { unified_edit_input: node({ material_list: materials, meta_list: metaList }) } : {}) });
  const draft = node({ id: draftId, type: "draft", min_version: minVersion, is_from_tsn: true, version: "3.3.28", main_component_id: componentId, component_list: [node({ id: componentId, type: "video_base_component", min_version: isLong ? minVersion : materials.length ? "3.3.9" : "1.0.0", generate_type: "gen_video", aigc_mode: "workbench", abilities: node({ gen_video: node({ text_to_video_params: node({ model_req_key: config.modelReqKey, priority: 0, seed: Math.floor(Math.random() * 2147483647), video_aspect_ratio: input.ratio, video_gen_inputs: [videoInput] }), ...(taskExtra ? { video_task_extra: JSON.stringify(taskExtra) } : {}) }) }) })] });
  hooks.beforeSubmit();
  const result = await request("post", "/mweb/v1/aigc_draft/generate", token, { beforeSubmit: hooks.beforeSubmit, onSubmitting: hooks.onSubmitting, params: { web_version: "7.5.0", da_version: "3.3.28", aigc_features: "app_lip_sync", web_component_open_flag: 1 }, data: { submit_id: submitId, ...(taskExtra ? { metrics_extra: JSON.stringify(taskExtra) } : {}), extend: { root_model: config.modelReqKey, m_video_commerce_info: commerce, m_video_commerce_info_list: [commerce] }, draft_content: JSON.stringify(draft), http_common_info: { aid: 513695 } } });
  const historyId = result?.aigc_data?.history_record_id;
  if (!historyId) throw Error("即梦视频提交结果未确认；未自动重提");
  hooks.onSubmitted(String(historyId));
}

type SourceQuote = { duration: number; hasVideo: boolean; referenceVideoSeconds: number };
async function draftUpgradePricing(source: SourceQuote, token: string) {
  const config = (await fetchVideoModelConfigs(token, true)).find(model => model.id === "jimeng-video-seedance-2.5-draft" && model.modelReqKey === "dreamina_seedance_45_pro_draft");
  const resolution = config?.raw?.options?.find((option: any) => option.key === "generate_from_draft_config")?.generate_from_draft_config_val?.resolution;
  if (config?.source !== "dynamic" || config.raw?.model_status !== 0 || config.raw?.extra?.is_draft_mode !== true || !resolution?.string_value?.includes("1080p") || resolution.disabled_string_value?.includes("1080p")) throw Error("原样片模型未开放1080p正片，未提交高清生成");
  const quote = await freezeVideoQuote(token, { model: "jimeng-video-seedance-2.5-draft", resolution: "1080p", operation: "generate-from-draft", duration: source.duration, hasVideo: source.hasVideo, referenceVideoSeconds: source.referenceVideoSeconds }, config);
  const benefit = source.hasVideo ? "seedance_25_draft_1080p_output" : "seedance_25_draft_1080p_no_input_video_output";
  if (quote.benefitType !== benefit || !quote.chargeInputVideoDuration) throw Error("原样片1080p官方报价未确认，未提交高清生成");
  return { quote, config };
}
export async function quoteSeedanceDraftUpgrade(source: SourceQuote, token: string) {
  return (await draftUpgradePricing(source, token)).quote;
}

/** Append the official GenerateFromDraft process to the original draft; never regenerate its prompt. */
export async function submitSeedanceDraftUpgrade(source: DraftSource, originalQuote: SourceQuote, token: string, hooks: SeedanceSubmitHooks) {
  assertDraftSourceAvailable(source);
  if (source.duration !== originalQuote.duration || source.hasVideo !== originalQuote.hasVideo || source.referenceVideoSeconds !== originalQuote.referenceVideoSeconds) throw Error("原样片冻结配置不匹配，未提交高清生成");
  hooks.beforeSubmit();
  const fresh = readDraftSource(await request("post", "/mweb/v1/get_history_by_ids", token, { timeout: 15_000, data: { history_ids: [source.historyId] } }), source.historyId);
  if (["historyId", "itemId", "finishedTime", "draftContent", "submitId"].some(key => fresh[key as keyof DraftSource] !== source[key as keyof DraftSource])) throw Error("原样片来源已变化，未提交高清生成");
  hooks.beforeSubmit();
  const { quote, config } = await draftUpgradePricing(originalQuote, token);
  hooks.beforeSubmit();
  const { draft, rootModel } = buildGenerateFromDraft(fresh);
  if (rootModel !== config.modelReqKey) throw Error("原样片模型绑定不匹配，未提交高清生成");
  const submitId = randomUUID();
  await hooks.onQuoted({ ...quote, submitId, draftId: String(draft.id) });
  const commerce = { benefit_type: quote.benefitType, resource_id: "generate_video", resource_id_type: "str", resource_sub_type: "aigc" };
  hooks.beforeSubmit();
  const result = await request("post", "/mweb/v1/aigc_draft/generate", token, { beforeSubmit: hooks.beforeSubmit, onSubmitting: hooks.onSubmitting, params: { web_version: "7.5.0", da_version: "3.3.30", aigc_features: "app_lip_sync", web_component_open_flag: 1 }, data: { submit_id: submitId, extend: { root_model: rootModel, m_video_commerce_info: commerce, m_video_commerce_info_list: [commerce] }, draft_content: JSON.stringify(draft), http_common_info: { aid: 513695 } } });
  const historyId = result?.aigc_data?.history_record_id;
  if (!historyId || String(historyId) === source.historyId) throw Error("即梦高清提交结果未确认；未自动重提");
  hooks.onSubmitted(String(historyId));
}
