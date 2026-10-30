# 原生图片扩图任务

## 已部署官方消费回执（真实付费未验收）

新任务启用版本化官方账单读取：成功后按原账号、historyId和submitId复用已有消费记录读取器，匹配唯一Checked记录；返回`billing`、`creditsUsed`，缺少或未结算回执返回`billingPending`，不按余额差额猜值。整次扩图只返回一笔消费，不按四张结果重复计费。

新增可空`native_outpaint_tasks.billing_json`列，历史行保留NULL，不追查旧任务账单。新任务先持久化版本标记，账单延迟不妨碍原成果返回；后续GET只沿原任务查询、耐久保存回执，不再上传或生成。回退保留最新数据库、新列、原凭据和成果；此能力需要调用方NAS API与Web配套支持。

本轮新增4项账单解析与1项原任务持久化隔离检查，均使用独立数据库及模拟网络通过；已随`sku-outpaint-harddeploy-20261030-r1`配套NAS API／Web强硬发布，原CMD、同设备新旧原模块WAL／FULL和旧版保留新列检查通过，在线备份及原证据保留。冻结源码`3918838c9091a8e10be60bc972cc9847c1a3fc77f51eb88ec484e77e676938c2`、镜像`sha256:65bd025abfa10d69e47571d486a0aaa1f95f7a1920ac92e10d8d159dfa549ada`；仅叠加本次审查的正式源码增量，未发布本机视频分支其他差异。没有真实官网账单或付费调用。下文为原接入说明，不将其旧验证状态当成本轮官方计费实测。

官网 `unified_generate → outpainting` 独立任务入口已在此前发布，本次补充官方消费回执；真实付费验收仍未完成。它不使用普通 `blend` 提示词，也不进入 Agent 高清对话。原图保持原始字节上传，完整成果交给调用方保存，不裁切、回贴或重采样。

## 接口

- `POST /v1/outpaint/tasks`
- `GET /v1/outpaint/tasks/:id`
- `DELETE /v1/outpaint/tasks/:id`

只接受有效的管理端 `jm_` Bearer Key，原生 Session ID 不可直接调用。可选 `X-Jimeng-Account-Id` 绑定当前 Key 已有租约；读取、取消及回执始终沿用原账号。

`JIMENG_NATIVE_OUTPAINT_CREATE_ENABLED` 仅显式设为 `false` 时暂停新ID创建，返回503，且不解析账号或持久化原图；默认开放。已有ID仍按原归属和输入校验后幂等读取，GET、DELETE和原任务查询继续可用。回退时可关闭新提交并隐藏Web入口，同时保留新版任务查询，不能退回不认识原生任务的旧CPA后宣称原任务仍可恢复。

创建 JSON：

```json
{
  "id": "native_outpaint_stable_id",
  "image": "data:image/png;base64,...",
  "prompt": "自然延续背景",
  "left": 0.5,
  "right": 0.5,
  "top": 0,
  "bottom": 0,
  "maxSize": 2048,
  "ratio": "4:3"
}
```

以上仅示意字段，比例和最长边必须按真实源图计算。`image` 接受 PNG/JPEG/WebP data URL，原图尺寸由成熟图片解析库读取，不接受外部 URI、URL、工作区或 submitId 覆盖。`prompt` 可省略，最长 2000 字符。

左右扩展量分别乘原图宽度，上下扩展量分别乘原图高度。若原图为 W×H，目标画布是 `W×(1+left+right)`、`H×(1+top+bottom)`；`maxSize` 必须等于该未缩画布最长边四舍五入后的值，`ratio` 必须与画布一致。首轮仅开放当前工作台八种比例：1:1、3:4、16:9、4:3、9:16、2:3、3:2、21:9；这不代表官网只有八种比例。

本地安全限制为原图不超过 25MB/3200万像素、原图及目标最长边不超过8192、目标不超过3200万像素。超限明确拒绝并建议减小倍率，不用缩小原图或降低 maxSize 掩盖过大的布局；这些是本地边界，尚非真实上游限额验收。

JPEG 的 EXIF 方向由 `image-size` 读取，方向5–8只交换几何宽高，与浏览器及NAS的显示方向一致；上传原始字节不转码、不旋转。上游上传插件若返回宽高，必须与这个显示宽高精确一致，不符时在付费提交前拒绝。

创建成功返回202，相同归属、相同输入及相同账号请求的原 ID 返回200，参数或归属冲突返回409。查询无归属或账号不符返回404。响应包含 `id/operation=outpaint/status/accountId`、四向比例、`ratio/maxSize/sourceWidth/sourceHeight`，以及 `submission.state/submitId/historyId`。成功时 `data[]` 按原历史的图片顺序保留全部1–4张成果，每项为 `{index,itemId?,url,width?,height?}`；`index` 从0开始，`itemId` 只取真实 `common_attr.id` 或 `item.id`。缺少身份或宽高时保持缺失，不造ID、不用目标尺寸冒充。错误文案不透出原始请求、Cookie 或凭据。

即梦原生扩图通常一次返回4张，只有同一原历史明确完成（status=50）且全部图片URL就绪后才标记成功；运行中先出现一张不能提前结束。1–4张是本地接纳边界，超过4张返回 `uncertain/result_count_unconfirmed`，保留原账号、submitId、historyId和凭据，等待原编号查询确认，不静默截断。四张成果来自同一次原生提交，不能拆成四次生成。

输入解码、指纹和加密落盘同时最多处理2个请求，繁忙时返回429且不登记、不生成。已登记的输入以现有视频队列的加密私有文件方式原子落盘，等待队列不保留原图大字符串；按原账号每次1个、全部账号共2个执行上传及提交，之后释放槽位供后续原任务使用。排队不切换账号、不延长创建时的deadline；取消排队会删除该任务精确绑定的私有输入，超时在提交前停止。实际付费前再次核对Key与原账号启用状态。

## 耐久身份与取消

新表 `native_outpaint_tasks` 独立保存输入指纹、原账号、加密凭据、固定 submitId、上传 URI 和原 historyId。付费发送前先持久化提交标记，再通过已有签名客户端发送一次 `/mweb/v1/aigc_draft/generate`。超时或缺回执标记为 `uncertain`，同 ID 不再生成；已取得原 historyId 时仅查询 `/mweb/v1/get_history_by_ids`。重启不会恢复付费 POST，也不会切换账号重试。

工作区和history的数字或字符串`0`均不是有效身份；无效缓存工作区在付费前停止且保留原登记，无效history回执保留原账号、submitId和待核状态，不查询`0`或重发。成果itemId的`0`视为缺失，沿用原索引及URL对象路径校验，不把四个默认`0`判作四张重复成果，也不伪造itemId。

状态包括 `preparing/submitting/running/uncertain/succeeded/failed/canceled`。`submission.state` 区分准备、未提交、已受理、回执未确认及明确拒绝。没有真实账单证据，因此不返回猜测的 `creditsUsed`。

DELETE 在准备阶段中断上传并阻止生成；已发送后只停止本地等待，响应明确提示上游可能继续，保留原身份以便查询成果。后续 GET 仍只查该原 history；读回真实成果后返回 succeeded，允许调用方的手动“查询原任务”取回已付费成果。没有使用未经证实的上游取消 body，也不把本地取消声称为上游已经取消。不存在任务的取消会留下归属墓碑，阻止迟到的同 ID 创建。

成功任务仍保留加密的原凭据。后续GET以5秒冷却只查询该原history，刷新可能过期的签名成果URL；有itemId时按首次接受的身份归回原顺序，无itemId时核对原index及URL的origin/path（忽略签名query）。数量、身份或已知宽高变化时保留全部旧成果并明确 `result_refresh_unconfirmed`；短时查询失败、回执身份不符或迟到失败状态也保留既有成功事实，不重新上传或生成。成功结果从不因刷新失败降级为失败。

## 静态协议来源与未验证部分

本轮使用已冻结的官网公开源码追踪 `home-tool-image-outpaint → Q6 → LOh/HzX → generateByDraft`。上传图组件为 `unified_generate`，能力代码 `outpainting`，原图通过资源列表上传；当前分支没有 mask。`DANode` 空 type/UUID、图片资源 `image_uri` 和 `uri` 双字段、`draft.version=3.3.32`、图片组件最低版本3.0.2均按 schema 构造，未套用普通生成版本或 Agent 协议。

冻结官网弹窗的 `metricsExtra.generateCount` 明确为1，本地保持该原值；这个统计字段不能按实际返回四张改成4，也不表示应发送四次任务。

主要公开资源：

- [弹窗](https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/ies/dreamina/web/jimeng/static/js/async/home-tool-image-outpaint.931aaa66b0.js)，SHA-256 `80eb474cf53ce57566b0a1190fba68f170bddffcaf983f99ecf0a58594ba7345`。
- [LOh converter](https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/ies/dreamina/web/jimeng/static/js/async/4s.a4c3e330c5.js)，SHA-256 `d8c97e17dc3951bdfec1723b2e993081fbf1ea178170c5c7667bafceb16561f4`。
- [资源 schema](https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/ies/dreamina/web/jimeng/static/js/async/spn.b12433f2d7.js)，SHA-256 `670f2ce18375b9982c939dece6cb4f6bffee4363f3c78ac7a68116803f6fa709`。
- [版本与能力 schema](https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/ies/dreamina/web/jimeng/static/js/async/t7v.67fcecfb70.js)，SHA-256 `9c303fe19f84336e7ebd351f7ee1367d20576de8cad5dfbee6f3fd9980c452da`。

仍未验证当前账号资格、真实请求被受理、实际扣分、成果完整性和扩图效果；不应把 mock 通过记为真实出图验收。后续部署须单独审查这组改动，不能将本地尚未部署的视频分支工作整体带入生产。

## 专项离线验证

`node tools/test-outpaint-isolated.mjs` 只打包新 mock 测试，在导入业务模块前清除业务环境继承并设置独立 `DATA_DIR/DB_PATH/MEDIA_DIR`，由预加载守卫禁止未模拟网络。它不运行生产构建、旧套件、真实上传或生成；失败和通过日志都保留在不同的私有目录。

资源并发、排队取消与超时、EXIF原字节和成功URL刷新增量验证使用 `node tools/test-outpaint-isolated.mjs 'resource slots|EXIF uses|signed URL refresh'`，只执行这3项新增mock，不重复此前专项。

多成果增量验证使用 `node tools/test-outpaint-isolated.mjs 'multi-result'`，只执行3项新增mock：明确完成前不提前接纳、一次提交保留四张、签名刷新维持原成果顺序、数量/身份变化保留旧成果、超过四张待核及仅查询原历史恢复。

默认身份补正分批仅执行新增scope：`'zero native'`前两项、随后`'zero native result identities'`一项，以及`'native create gate'`一项。各批均使用独立净化环境与数据库；前批通过后未重跑，既有专项和真实付费不在这些记录中。
