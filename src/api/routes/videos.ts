import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import db from "@/lib/database.ts";
import { quoteVideo } from "@/api/controllers/video-quote.ts";
import { tokenSplit } from "@/api/controllers/core.ts";

export default {
  prefix: "/v1/videos",

  get: {
    "/policy": async (request: Request) => {
      request.validate("headers.authorization", _.isString);
      if (!tokenSplit(request.headers.authorization).some(token => db.validateApiKey(token).valid)) {
        return new Response({ error: "API Key 无效" }, { statusCode: 401 });
      }
      return {
        accountPolicy: "super-only",
        videoQueuePolicy: "serial-submit-on-accepted-v2",
        longVideoPolicy: "official-long-video-v1",
      };
    },
    "/quote": async (request: Request) => {
      request.validate("headers.authorization", _.isString);
      return quoteVideo(request.headers.authorization, request.query);
    },
  },

  post: {
    "/generations": async () => new Response(
      { error: "同步视频生成已停止；请使用 /v1/tasks 持久视频队列，不自动降级或重提" },
      { statusCode: 400 },
    ),
  },
};