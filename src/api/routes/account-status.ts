import Request from "@/lib/request/Request.ts";

import { markCredentialFailure, markCredentialSuccess, resolveAuthorization } from "@/api/controllers/auth.ts";
import { getCredit } from "@/api/controllers/core.ts";
import accountPool from "@/lib/account-pool.ts";
import { validateApiKey } from "@/lib/database.ts";
import Response from "@/lib/response/Response.ts";

let refreshing: Promise<unknown> | undefined;
let refreshAt = 0;

export default {
  prefix: "/v1/account",
  get: {
    "/credits": async (request: Request) => {
      const key = /^Bearer (jm_[A-Za-z0-9_-]+)$/.exec(request.headers.authorization || "")?.[1];
      if (!key || !validateApiKey(key).valid) return new Response({ error: "API Key 无效" }, { statusCode: 401 });
      if (!refreshing && Date.now() >= refreshAt) {
        refreshAt = Date.now() + 5 * 60_000;
        refreshing = (async () => {
          for (const account of accountPool.list()) {
            if (!account.enabled || account.cooldownUntil && Date.parse(account.cooldownUntil) > Date.now()) continue;
            await accountPool.refreshStatus(account.id).catch(() => undefined);
          }
        })().finally(() => { refreshing = undefined; });
      }
      return { accounts: accountPool.list().map(({ id, enabled, cooldownUntil, status }) => ({ id, enabled, cooldownUntil, status })) };
    },
    "/status": async (request: Request) => {
      request.validate("headers.authorization", (value) => typeof value === "string");
      const credential = await resolveAuthorization(request.headers.authorization, request.headers["x-jimeng-account-id"]);
      try {
        if (credential.accountId) {
          const account = await accountPool.refreshStatus(credential.accountId);
          // A read-only balance success must not clear a generation risk cooldown.
          return {
            account: {
              id: account.id,
              name: account.name,
              enabled: account.enabled,
              status: account.status,
            },
          };
        }

        const credits = await getCredit(credential.token);
        markCredentialSuccess(credential);
        return { account: { status: { ...credits, membership: "unknown" } } };
      } catch (error) {
        markCredentialFailure(credential);
        throw error;
      }
    },
  },
};
