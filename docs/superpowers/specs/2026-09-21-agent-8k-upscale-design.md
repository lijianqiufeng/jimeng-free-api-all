# 即梦 Agent 8K 智能高清设计

## 目标

在现有即梦 CPA 中新增独立的异步智能高清任务接口。调用方只提交一张原图，服务端固定使用即梦 Agent 自动模式和提示词“帮我8k高清放大”，复用现有管理 API Key、账号池、账号固定、冷却与凭据加密能力。

管理控制台增加“智能高清”页面：选择原图、提交任务、显示进度，成功后通过可拖动分割线比较左侧原图与右侧增强图。

成功标准采用即梦返回的 8K 标签，不额外下载结果校验像素。API 和界面必须明确这是“上游标记 8K”，不能表述为已独立验证实际像素。

## 范围

本轮包含：

- CPA 原生 Agent 任务 API。
- 单图 data URL 输入及严格类型、大小校验。
- SQLite 持久化、幂等、取消和重启恢复。
- 每任务固定一个账号、该账号自己的 Agent workspace，以及该任务独立的 conversation。
- Agent 提交与原任务结果查询。
- 管理台原图选择、任务恢复和前后对比滑杆。
- 控制器、HTTP 路由和前端纯逻辑测试。

本轮不包含：

- 无限画布侧接入。
- 即梦视频。
- 普通 4K `super_resolution`。
- Agent 自由提示词。
- 失败后自动换账号、自动重提或自动降级。
- 真实付费 8K 验收。
- NAS 部署。

## 方案选择

采用即梦原生 Agent 会话链路，而不是普通图片生成或浏览器自动化。

已验证的上游创建入口是：

```text
/mweb/v1/creation_agent/v2/conversation
```

请求需要账号自己的 workspace、任务独立的 conversation 和参考图 `uri`；引用既有生成资产时还携带 `item_id`。这些标识不能从一次抓包中硬编码，也不能跨账号共享。

普通 `aigc_draft/generate` 的 `super_resolution` 可作为未来独立 4K 功能，但不能冒充本功能。浏览器自动化依赖页面和浏览器登录状态，不进入 NAS 服务。

## HTTP 契约

### 创建任务

```http
POST /v1/upscale/tasks
Authorization: Bearer jm_...
Content-Type: application/json
```

```json
{
  "id": "upscale_稳定任务ID",
  "image": "data:image/png;base64,..."
}
```

约束：

- `id` 由调用方生成，格式与现有 Canvas 任务一致：16–100 位字母、数字、下划线或连字符。
- `image` 只接受 PNG、JPEG、WebP data URL。
- 单图上限 25 MB。
- 不接受服务端文件路径、`file:` URL 或 HTTP URL。
- 提示词由服务端固定，不接受调用方覆盖。

首次成功预留任务返回 HTTP 202；同 ID、同归属、同指纹返回 HTTP 200；同 ID 但输入或归属不同返回 HTTP 409。

响应：

```json
{
  "id": "upscale_稳定任务ID",
  "status": "running",
  "providerLabel": null
}
```

### 查询任务

```http
GET /v1/upscale/tasks/:id
Authorization: Bearer jm_...
```

成功响应：

```json
{
  "id": "upscale_稳定任务ID",
  "status": "succeeded",
  "providerLabel": "8K",
  "creditsUsed": 4,
  "data": [
    { "url": "https://..." }
  ]
}
```

`providerLabel` 与 `creditsUsed` 仅在上游明确返回时填写；不得根据模型名、提示词或余额差猜测。

### 停止等待

```http
DELETE /v1/upscale/tasks/:id
Authorization: Bearer jm_...
```

提交前的取消阻止付费请求。提交后的取消只停止 CPA 等待，响应必须说明即梦任务可能继续运行，积分以即梦结算为准。

## 数据模型

新增 `agent_upscale_tasks`：

- `id`：主键。
- `owner`：管理 API Key ID。
- `fingerprint`：规范化输入 SHA-256。
- `status`：`submitting`、`running`、`succeeded`、`failed`、`canceled`。
- `account_id`：固定账号池账号。
- `credential`：任务运行期间使用的加密 session；终态清空。
- `workspace_id`：该账号的 Agent workspace。
- `conversation_id`：当前任务独立生成的 Agent 会话 ID。
- `reference_item_id`、`reference_uri`：上传后得到的参考图标识。
- `provider_task_id`：上游任务/会话返回的稳定标识。
- `provider_label`、`credits_used`：上游明确报告的结果信息。
- `result`、`error`：脱敏结果与错误。
- `deadline`、`checked_at`：绝对截止与查询节流。

新增 `jimeng_agent_sessions`：

- `account_id`：主键，与账号池账号一一对应。
- `workspace_id`：该账号可复用的 Agent workspace。
- `updated_at`：最后确认时间。

任务保存自己的 workspace/conversation 快照；workspace 缓存刷新不能改变已提交任务，conversation 不在任务之间复用。

## 创建流程

1. 校验 `jm_` Key、任务 ID 和图片。
2. 规范化输入并计算指纹。
3. 查询已有任务并执行幂等/冲突判断。
4. 从账号池选择一个可用账号并预留 `submitting` 行。
5. 使用同一账号上传参考图，获得 Agent 可用的 `uri`、签名 URL 与宽高；已有生成资产可额外携带 `item_id`。
6. 读取或初始化该账号自己的 workspace，并为当前任务生成独立 conversation ID。
7. 最后检查任务仍为 `submitting` 且未过期。
8. 仅发送一次 Agent 创建请求，固定提示词“帮我8k高清放大”与自动模式。
9. 保存上游稳定标识并切换为 `running`。

付费 POST 超时或响应不确定时，任务进入明确失败：“提交结果未确认；为避免重复扣积分未自动重提”。不得自动重新发送。

## 查询与恢复

- 同一任务最多每 5 秒执行一次上游查询或会话续接。
- 同进程内同任务查询合并为一个 Promise。
- 临时网络失败保留 `running`，允许后续继续查询原任务。
- 成功时提取结果 URL、上游 8K 标签和明确积分报告，写入终态并清空任务凭据。
- 上游明确失败时写入脱敏错误并清空凭据。
- 到达绝对截止前最后查询一次；仍无终态则标记超时，不重新生成。
- 服务重启时，已有上游稳定标识的任务可继续查询；停在 `submitting` 且没有稳定标识的任务标记为“提交结果未确认”，不重提。

## 账号与失败处理

- 一个任务的上传、Agent 创建、结果查询必须始终使用同一账号。
- workspace 只能属于对应账号；conversation 每任务独立，禁止跨账号或跨任务复用。
- 4013 使用一小时基础冷却，并沿用账号池指数退避与随机抖动。
- 1015、401、403 进入账号冷却并在管理台显示状态；不自动删除账号。
- 只读状态查询成功不得清除生成任务建立的风控冷却。
- 不自动换账号，不自动重提，不自动改走普通 4K。
- HTTP 响应和日志不得包含 Cookie、sessionid、管理 Key、完整上游请求体或私有素材地址。

## 管理台

新增独立“智能高清”Tab：

- API Key 输入沿用当前浏览器会话存储。
- 支持点击选择和拖放一张 PNG/JPEG/WebP。
- 选择后立即显示原图预览和文件大小。
- “开始智能高清”生成稳定任务 ID并调用创建接口。
- 提交后按钮锁定，轮询同一任务；不允许重复点击产生新任务。
- 最近一个未完成任务 ID 保存在浏览器会话中；原图 Blob 以任务 ID 为键保存在 IndexedDB，避免大图超过 `sessionStorage` 容量。页面刷新后恢复原图并继续查询。
- 失败时显示脱敏原因和“未自动重提”。

成功后对比组件：

- 原图和增强图使用相同容器、相同 `object-fit` 和尺寸。
- 左侧显示原图，右侧显示增强图。
- 中间竖线默认 50%，可用鼠标、触摸和键盘调整。
- 对比位置限制在 0–100%。
- 显示“原图”“即梦增强图”“上游标记 8K”。
- 提供分别查看原图和增强图的入口。
- 不显示“实际像素已验证”。

## 测试

先写失败测试，再实现。

控制器测试：

- 输入类型、大小和任务 ID 校验。
- 相同任务幂等，不重复付费提交。
- 同 ID 不同输入或归属返回冲突。
- 取消先于创建的 tombstone 阻止提交。
- 账号在上传、创建和查询间保持固定。
- 不同账号不共享 workspace/conversation。
- 付费 POST 超时不重发。
- 重启时未知提交不重发。
- 4013、1015 和普通临时查询失败的冷却/状态语义。
- 成功、失败、超时、取消终态解析。
- 响应与错误不泄露凭据和上游请求体。

HTTP 集成测试：

- 无效、禁用和非 `jm_` Key 返回 401。
- 创建、查询、删除的状态码与响应体。
- 路由参数及 JSON 错误不变成 500。

管理台纯逻辑测试：

- 最近任务恢复。
- 对比位置限制。
- 终态后停止轮询。
- 失败后不自动创建新任务。

回归：

- `npm run build`。
- `node tools/test-canvas-tasks.mjs`。
- 新增 Agent 8K 专项测试。
- `git diff --check`。

测试使用隔离数据库和模拟网络，禁止读取生产数据库、真实 Cookie 或发送真实付费请求。

## 发布边界

本轮只完成本地代码和模拟验证，不部署 NAS，不调用真实 8K。

后续真实验收需另行确认：

- 账号仍有效。
- 使用哪一个测试账号。
- 最多允许消耗的积分。
- 结果是否需要人工核对对比效果。

部署时必须先在线备份并保留：

- `jimeng.db`。
- 账号池加密密钥。
- 已有账号、管理 API Key、媒体和管理控制台配置。
- 当前生产 release 与镜像回滚入口。

CPA 发布完成并验证新接口后，才能单独规划无限画布接入。
