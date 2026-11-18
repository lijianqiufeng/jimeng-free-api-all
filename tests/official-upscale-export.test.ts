import test from "node:test";
import assert from "node:assert/strict";
import { officialUpscaleImage } from "@/api/controllers/official-image-export.ts";

const address = "https://p26-dreamina-sign.byteimg.com/fixture.png?fixture=original";
function provider(custom: Record<string, any> = {}) {
  const calls: string[] = [];
  const read = async (path: string, data: any) => {
    calls.push(path);
    if (path.endsWith("get_settings")) return { user_custom_settings: { close_watermark: custom.enabled ?? true } };
    if (path.endsWith("get_history_by_ids")) {
      assert.deepEqual(data.history_ids, ["history"]);
      return { history: { history_record_id: "history", status: 50, task: { submit_id: custom.submit || "submit" },
        item_list: [{ common_attr: { id: "item-1" }, image: { large_images: [{ width: 5474, height: 8192 }] } }] } };
    }
    assert.equal(path, "/mweb/v1/get_local_item_list"); assert.equal(data.is_for_video_download, false);
    assert.deepEqual(data.item_id_list, ["item-1"]); assert.equal(data.pack_item_opt.need_data_integrity, true);
    assert.deepEqual(data.image_info.image_scene_list.map((x: any) => x.width), [2400,1080,900,720,480,360]);
    const item = { common_attr: { id: custom.item || "item-1" }, image: { large_images: [{width:custom.width || 5474,height:8192,image_url:custom.url || address}] } };
    return { item_list: custom.duplicate ? [item,item] : [item] };
  };
  return { calls, read };
}
test("original account export returns unmodified signed full image and makes only three read calls", async () => {
  const p=provider();assert.equal(await officialUpscaleImage(p.read,"history","submit"),address);assert.equal(p.calls.length,3);
});
test("opt-out, mismatched job or image, different size and unrecognized origins keep the original rendition", async () => {
  for(const options of [{enabled:false},{submit:"other"},{item:"other"},{width:2048},{url:"https://example.invalid/fixture.png"},{duplicate:true}]) {
    const p=provider(options);assert.equal(await officialUpscaleImage(p.read,"history","submit"),undefined);
    if(options.enabled===false) assert.equal(p.calls.length,1);
  }
});
