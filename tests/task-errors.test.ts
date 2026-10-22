import { test } from "node:test";
import assert from "node:assert/strict";
import { publicJimengFailure } from "../src/api/controllers/task-errors.ts";
test("official public reasons survive generic errors for images and videos", () => {
  assert.equal(publicJimengFailure({ fail_code: 999, fail_msg: "common error", fail_starling_message: "你上传的图片不符合平台规则，请修改后重试" }), "你上传的图片不符合平台规则，请修改后重试");
  assert.equal(publicJimengFailure({ fail_code: 888, fail_msg: "common error", fail_starling_message: "视频内容不符合平台规则，请修改后重试" }), "视频内容不符合平台规则，请修改后重试");
  assert.match(publicJimengFailure({ fail_code: 150100, fail_msg: "common error", failed_item_list: [{ gen_result_data: { result_msg: "SystemBusy" } }] }), /服务繁忙.*150100/);
  assert.match(publicJimengFailure({ fail_code: 777, fail_msg: "内部 cookie=private https://example.test/token" }), /上游未提供具体原因/);
  assert.match(publicJimengFailure({ fail_code: 2038 }), /审核未通过/);
});
