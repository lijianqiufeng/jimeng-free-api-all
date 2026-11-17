# 即梦 Seedance 2.5 Flash 接入与归档

2026-11-17配套画布Web／API上线，已发布来源为`seedance25-flash-20261117-r1`，源码快照`94f412c8f5786774d5796379bc593773020ed6f21771fa69b6a7af10697df980`，镜像`sha256:989241cf68a6fa6dc32c13b529eb18f610226cea490f47a523bb2da728d389f3`。本次Git归档不重新测试、构建、发布或调用上游。

## 接入范围

- 对外模型ID：`jimeng-video-seedance-2.5-flash`；实际官方请求key：`dreamina_seedance_45_flash`。
- 官方目录确认480p／720p、4–30秒、24fps；最多10张图片／5段视频／5段音频，总参考20份。1080p、样片和超限参数拒绝提交。
- Flash独立权益为`seedance_25_flash_{480p|720p}_{output|no_input_video}`，无参考视频的键不追加普通2.5的`_output`后缀；不回退普通2.5报价。
- 720p当时官方报价19积分／秒；480p当时7积分／秒、原价9，实际以账号最新官方冻结报价为准。有视频时沿原计费时长规则计算，不再次乘折扣。
- 同一2.5参考提交结构，保留报价→提交前检查→实际POST→原history编号回执顺序。原账号优先级、保留积分、截止、幂等和原任务查询／保存行为不变，无数据库schema或依赖变化。

## 归档与验证边界

仅在上次已发布归档`d65a8d691bf02671ab28beb12140036321b17908`上追加3份运行源码、目录fixture和4项独立回归；145份冻结输入按Git文本换行归一核对，其中144份一致；fixture仅将官方图标的过期签名URL改为不可访问的示例地址，模型与计费字段保持，原始fixture私有保留。本机原视频开发分支及其未提交内容保留，没有自动合并CPA main。

上述4项／23条断言和实际9份编译文件、隔离启动是接入发布阶段的证据，不是本次归档重新执行。真实模型目录／权益读取原始证据、失败、备份和候选均保留在画布私有目录；fixture只含公开模型参数，不携带账号、token或Cookie。没有用真实付费生成验证Flash产出。

回归文件为`tests/seedance-flash.test.ts`，依赖与接口均在文件内模拟。原运行还使用画布维护的隔离入口和禁止未模拟fetch的预加载；不得在加载业务模块后才设置独立DATA_DIR／DB_PATH／MEDIA_DIR，不得继承NAS环境或凭据。归档只保留有效测试与fixture，不把当次私有包装目录作为项目结构提交。

配套整批交付、任务与数据保护见[画布交付记录](https://github.com/lijianqiufeng/infinite-canvas/blob/main/docs/STUDIO-ALL-FLASH-HARD-DELIVERY.md)。保留原任务、成果、失败记录和备份，不恢复停止调查或重提付费任务。发布工作流只由release或手动触发，本次仅推送归档分支，不新建release／tag。
