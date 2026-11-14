import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { generateVideoWithRetry, DEFAULT_MODEL } from '@/api/controllers/videos.ts';
import { markCredentialFailure, markCredentialSuccess, resolveAuthorization } from '@/api/controllers/auth.ts';
import util from '@/lib/util.ts';
import db from '@/lib/database.ts';
import { SEEDANCE_MODELS } from '@/api/controllers/seedance-contract.ts';
import { quoteVideo } from '@/api/controllers/video-quote.ts';
import { tokenSplit } from '@/api/controllers/core.ts';

function appendUploadedPaths(value: any, target: string[]) {
    if (!value) return;
    if (Array.isArray(value)) {
        value.forEach(item => appendUploadedPaths(item, target));
        return;
    }
    const path = value.filepath || value.path;
    if (typeof path === 'string' && path) target.push(path);
}

export default {

    prefix: '/v1/videos',

    get: {
        '/policy': async (request: Request) => {
            request.validate('headers.authorization', _.isString);
            if (!tokenSplit(request.headers.authorization).some(token => db.validateApiKey(token).valid)) return new Response({ error: 'API Key 无效' }, { statusCode: 401 });
            return { accountPolicy: 'super-only', videoQueuePolicy: 'serial-submit-on-accepted-v2', longVideoPolicy: 'official-long-video-v1' };
        },
        '/quote': async (request: Request) => {
            request.validate('headers.authorization', _.isString);
            return quoteVideo(request.headers.authorization, request.query);
        }
    },

    post: {

        '/generations': async (request: Request) => {
            return new Response({ error: '同步视频生成已停止；请使用 /v1/tasks 持久视频队列，不自动降级或重提' }, { statusCode: 400 });
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.prompt', _.isString)
                .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
                .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
                .validate('body.duration', v => _.isUndefined(v) || _.isInteger(v))
                .validate('body.file_paths', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.response_format', v => _.isUndefined(v) || _.isString(v))
                .validate('headers.authorization', _.isString);

            // refresh_token切分
            // 随机挑选一个refresh_token
            const credential = await resolveAuthorization(request.headers.authorization, undefined, request.body.model || DEFAULT_MODEL, true, true);
            const token = credential.token;
            const statsKey = credential.managedKey || token;

            const {
                model = DEFAULT_MODEL,
                prompt,
                ratio,
                resolution,
                duration,
                file_paths = [],
                response_format = "url"
            } = request.body;

            // 处理文件上传
            let filePaths = [...file_paths];
            const files: Record<string, any> = request.files || {};
            if (!_.isEmpty(files)) {
                Object.values(files).forEach(file => appendUploadedPaths(file, filePaths));
            }

            // 生成视频
            let videoUrl;
            try {
                videoUrl = await generateVideoWithRetry(
                    model,
                    prompt,
                    {
                        ratio,
                        resolution,
                        duration,
                        filePaths
                    },
                    token
                );
                markCredentialSuccess(credential);
            } catch (error) {
                markCredentialFailure(credential);
                throw error;
            }

            // 记录统计和媒体
            try {
                db.recordCall(statsKey, model, 0);
                if (videoUrl) db.saveMedia('video', videoUrl, model, prompt, statsKey);
            } catch (e) {
                // 忽略数据库错误
            }

            // 根据response_format返回不同格式的结果
            if (response_format === "b64_json") {
                const videoBase64 = await util.fetchFileBASE64(videoUrl);
                return {
                    created: util.unixTimestamp(),
                    data: [{
                        b64_json: videoBase64,
                        revised_prompt: prompt
                    }]
                };
            } else {
                return {
                    created: util.unixTimestamp(),
                    data: [{
                        url: videoUrl,
                        revised_prompt: prompt
                    }]
                };
            }
        }

    }

}
