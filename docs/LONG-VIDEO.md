# Seedance 2.5 超长视频

这是本机协议适配说明。2026-10-22 已完成构建和离线项目测试；没有部署或付费生成验证，不能将代码接入等同于当前账号可用或已验证成片。官网静态依据与原始哈希见相邻无限画布工程 `docs/JIMENG-LONG-VIDEO-RESEARCH.md`。

## 调用合同

- 持久任务入口仍为 `/v1/tasks`，模型为 `jimeng-video-seedance-2.5-long`，清晰度只接受 `720p`，输出整数秒数为 30–180；实际范围与步长必须满足当前执行账号的 `long_video_config.duration_ms`。普通 2.5 和样片仍为 4–30 秒。
- `/v1/videos/policy` 返回 `longVideoPolicy: "official-long-video-v1"`；调用方必须先核对，不能向旧 CPA 降级提交普通模型。
- `/v1/videos/quote` 使用同一长模型；可用报价返回 `mode: "long"`、`durationRange: {min,max,step}`（秒）及精确专属 `benefitType`。范围来自支持当前所选时长的账号能力交集；缺能力、报价或支付策略时返回不可用，不使用静态价格。
- 参考图 / 视频 / 音频仍限 30 / 10 / 10，总数 50；视频与音频各自总长不超过 30.2 秒，并再次满足执行账号实时素材规则。长输出不放宽参考素材时长。实际视频时长来自上传探测，客户端估值不参与最终冻结。

## 账号、输入与价格

长模式与普通模式共享官网模型键 `dreamina_seedance_45_pro`，但使用独立内部模型身份，动态列表去重和合并不能覆盖普通模型。长模式仅在当前账号明确开放 `long_video`、720p 及专属商业分支时出现；提交前重新读取原执行账号能力。

输入使用 `long_video_input.material_list/meta_list`，包括纯文本场景；不同时写 `unified_edit_input`，不猜填官网当前转换器未使用的 `long_video_config`。草稿、组件及视频输入最低版本为 `3.3.21`，草稿版本 `3.3.28`。长模式提示词只放入 meta_list，顶层 prompt 为空；task extra / metrics 标识为 `functionMode: "long_video"`、`generatorFeature: "longVideo"`。

720p 分别使用 `long_video_price` / `no_input_video_long_video_price`，对应 `seedance_25_long_video_720p_output` / `seedance_25_long_video_720p_no_input_video_output`。根据官网当前分辨率价格结构，计费秒数为目标输出秒数加真实参考视频总秒数，不加音频。原价、现价及最低计费单位从原账号官网权益获取；不额外乘普通模式活动折扣。

## 一次提交与最终结算

继续使用既有持久视频队列。长模式的官方 `submit_id` 在付费前与账号、模型、时长、计费项、实时报价和能力范围一起写入原任务 `quote_json`，然后仅发送一次生成 POST。返回 `history_id` 后沿原账号与编号查询。回执不明保留任务及占用，不换号、不自动重提。

长视频只接受官网状态 50、唯一成片 item、完成时间、匹配的 history / submit 身份，以及 `origin_video.video_url` 或 `transcoded_video.origin.video_url`。状态 21 与分段队列都不能提前成功；多个 item 或缺少完整成片身份时继续原编号查询。媒体落库方还须核对完整 MP4 的实际尺寸及输出时长，不把短片段当作目标成片。

30 分钟 deadline 只限制未付费的排队 / 上传准备；已提交且有原 history 的视频不会因它超时释放预留或自动失败。成功成片的实际消费仍按原账号、原 submit 匹配唯一 `Checked` 账单；不使用估算或余额差。长模式账单额外回传 `mode: "long"` 与冻结计费项；账单不明继续待核账与原号查询。

本次未新增数据库列、迁移、账号或生产数据写入；原任务和样片转高清逻辑保留。部署时需要与 NAS / Web 的长模型合同共同准备候选及回滚，不能只发布模型按钮。历史长任务与真实逐单账单尚无本轮付费验证；不支持的账号应在付费前明确拒绝。
