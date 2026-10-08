import { randomUUID } from "node:crypto";
import { imageSize } from "image-size";
import { request, uploadFile } from "./core.ts";
import { resolveVideoModelConfig } from "./models.ts";
import { seedanceInput } from "./seedance-contract.ts";
import { seedanceUploadUser, uploadSeedanceReference } from "./seedance-upload.ts";

const node = (fields: Record<string, unknown>) => ({ type: "", id: randomUUID(), ...fields });

/** One paid POST only. The caller persists its account and history ID before polling. */
export async function submitSeedanceVideo(input: ReturnType<typeof seedanceInput>, token: string, hooks: { beforeSubmit(): void; onSubmitted(id: string): void; onSubmitting?(): void }) {
  const config = await resolveVideoModelConfig(input.model, token);
  if (config.source !== "dynamic" || config.raw?.model_status !== 0) throw Error("当前账号未确认可用视频模型，未提交生成");
  if (!config.supportedResolutions.includes(input.resolution) || !config.supportedDurations?.includes(input.duration)) throw Error("当前账号不支持所选视频参数，未提交生成");
  const is25 = input.model === "jimeng-video-seedance-2.5", materials: Record<string, unknown>[] = [];
  let userId = "";
  for (const ref of input.references) {
    hooks.beforeSubmit();
    if (ref.kind === "image") {
      const data = Buffer.from(ref.url.slice(ref.url.indexOf(",") + 1), "base64");
      const { width, height, type } = imageSize(data);
      if (width < 300 || height < 300 || width > 6000 || height > 6000 || width / height < 0.4 || width / height > 2.5) throw Error("参考图尺寸不符合模型限制，未提交生成");
      const uploaded = await uploadFile(token, ref.url);
      materials.push(node({ material_type: "image", image_info: node({ type: "image", source_from: "upload", platform_type: 1, name: "", image_uri: uploaded.image_uri, uri: uploaded.image_uri, width, height, format: type }) }));
    } else {
      userId ||= await seedanceUploadUser(token, ref.kind, hooks.beforeSubmit);
      materials.push(node({ material_type: ref.kind, [`${ref.kind}_info`]: node({ type: ref.kind, source_from: "upload", name: "", ...await uploadSeedanceReference(token, ref as { kind: "video" | "audio"; url: string }, is25 ? 30 : 15, hooks.beforeSubmit, userId) }) }));
    }
  }
  for (const kind of ["video", "audio"]) {
    const total = materials.reduce((sum, material) => sum + Number((material[`${kind}_info`] as any)?.duration || 0), 0);
    if (total > (is25 ? 30200 : kind === "video" ? 15200 : 15000)) throw Error("参考音视频总时长超限，未提交生成");
  }
  const prices = config.raw?.commercial_config?.resolution_price_configs?.find((price: any) => price.resolution === input.resolution);
  const price = is25 && !input.references.some(ref => ref.kind === "video") ? prices?.no_input_video_price : prices?.price;
  if (!price?.benefit_type) throw Error("当前视频计费项未确认，未提交生成");
  const commerce = { benefit_type: price.benefit_type, resource_id: "generate_video", resource_id_type: "str", resource_sub_type: "aigc" };
  const componentId = randomUUID();
  const metaList = materials.map((material, index) => node({ meta_type: material.material_type, text: "", material_ref: node({ material_idx: index }) }));
  metaList.push(node({ meta_type: "text", text: input.prompt }) as any);
  const videoInput = node({ min_version: materials.length ? "3.3.9" : "3.0.5", prompt: input.prompt, duration_ms: input.duration * 1000, fps: 24, resolution: input.resolution, video_mode: 2, ...(materials.length ? { unified_edit_input: node({ material_list: materials, meta_list: metaList }) } : {}) });
  const draft = node({ type: "draft", min_version: materials.length ? "3.3.9" : "3.0.5", is_from_tsn: true, version: "3.3.28", main_component_id: componentId, component_list: [node({ id: componentId, type: "video_base_component", min_version: materials.length ? "3.3.9" : "1.0.0", generate_type: "gen_video", aigc_mode: "workbench", abilities: node({ gen_video: node({ text_to_video_params: node({ model_req_key: config.modelReqKey, priority: 0, seed: Math.floor(Math.random() * 2147483647), video_aspect_ratio: input.ratio, video_gen_inputs: [videoInput] }) }) }) })] });
  hooks.beforeSubmit();
  hooks.onSubmitting?.();
  const result = await request("post", "/mweb/v1/aigc_draft/generate", token, { params: { web_version: "7.5.0", da_version: "3.3.28", aigc_features: "app_lip_sync", web_component_open_flag: 1 }, data: { submit_id: randomUUID(), extend: { root_model: config.modelReqKey, m_video_commerce_info: commerce, m_video_commerce_info_list: [commerce] }, draft_content: JSON.stringify(draft), http_common_info: { aid: 513695 } } });
  const historyId = result?.aigc_data?.history_record_id;
  if (!historyId) throw Error("即梦视频提交结果未确认；未自动重提");
  hooks.onSubmitted(String(historyId));
}
