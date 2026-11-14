import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { SeedanceBrowserTransport, seedanceBrowser, usesSeedanceBrowser } from "../src/lib/seedance-browser.ts";
import { request } from "../src/api/controllers/core.ts";

const origin = "https://jimeng.jianying.com", path = "/mweb/v1/aigc_draft/generate";
const input = (token = "account-a") => ({ token, params: { aid: 513695 }, headers: { Cookie: "secret", "User-Agent": "wrong", "Sec-Fetch-Site": "same-origin", Sign: "fixture" }, data: { submit_id: "unique-test-submit", extend: { root_model: "dreamina_seedance_40_pro" }, draft_content: "fixture" } });
function harness(options: { fail?: string; ready?: () => void } = {}) {
  const contexts: any[] = [], calls: any[] = [];
  let posted = 0, aborted = 0, evaluations = 0, browserClosed = false;
  const transport = new SeedanceBrowserTransport(async () => ({
    isConnected: () => !browserClosed,
    close: async () => { browserClosed = true; },
    newContext: async () => {
      let routeHandler: any;
      const context = { cookies: [] as any[], closed: false,
        addCookies: async (cookies: any[]) => { context.cookies = cookies; },
        close: async () => { context.closed = true; },
        route: async (_pattern: string, callback: any) => { routeHandler = callback; },
        newPage: async () => ({
          isClosed: () => context.closed, url: () => `${origin}/ai-tool/video/generate`,
          goto: async () => {
            await send("unsolicited page generation");
            if (options.fail === "prepare") throw Error("private page failure");
          },
          waitForFunction: async () => { options.ready?.(); },
          evaluate: async (_fn: unknown, payload: any) => {
            evaluations++; calls.push(payload);
            await send(payload.body);
            await send(payload.body); // Even a page SDK retry must not submit twice.
            if (options.fail === "timeout") throw Object.assign(Error("timeout private detail"), { code: "ETIMEDOUT" });
            return { status: 200, statusText: "OK", text: JSON.stringify({ ret: "0", data: { aigc_data: { history_record_id: "original-history" } } }) };
          },
        }),
      };
      async function send(body: string) {
        await routeHandler({ request: () => ({ url: () => origin + path, method: () => "POST", postData: () => body }), abort: async () => { aborted++; }, continue: async () => { posted++; } });
      }
      contexts.push(context); return context;
    },
  } as any));
  return { transport, contexts, calls, counts: () => ({ posted, aborted, evaluations }) };
}

test("only explicitly enabled affected Seedance submissions use the browser", () => {
  process.env.JIMENG_BROWSER_TRANSPORT = "on";
  try {
    assert.ok(usesSeedanceBrowser("POST", path, input().data));
    for (const model of ["high_aes_general_v50", "dreamina_seedance_40_mini", "dreamina_seedance_40_pro_vision"]) assert.equal(usesSeedanceBrowser("POST", path, { extend: { root_model: model } }), false);
    assert.equal(usesSeedanceBrowser("GET", path, input().data), false);
    assert.equal(usesSeedanceBrowser("POST", "/mweb/v1/get_history_by_ids", input().data), false);
  } finally { delete process.env.JIMENG_BROWSER_TRANSPORT; }
  assert.equal(usesSeedanceBrowser("POST", path, input().data), false);
});

test("official page accounts are isolated and only the exact payload is sent once", async () => {
  const h = harness();
  try {
    await h.transport.request(input());
    await h.transport.request(input("account-b"));
    await h.transport.request(input());
    assert.equal(h.contexts.length, 2);
    assert.deepEqual(h.contexts.map(c => [...new Set(c.cookies.map((v: any) => v.value))]), [["account-a"], ["account-b"]]);
    assert.deepEqual(h.counts(), { posted: 3, aborted: 5, evaluations: 3 });
    assert.equal(h.calls[0].body, JSON.stringify(input().data));
    assert.deepEqual(h.calls[0].headers, { Sign: "fixture" });
  } finally { await h.transport.close(); }
});

test("browser preparation failure and cancellation during page load submit nothing", async () => {
  const failed = harness({ fail: "prepare" });
  let canceled = false, marked = 0;
  const stopped = harness({ ready: () => { canceled = true; } });
  try {
    await assert.rejects(failed.transport.request(input()), /浏览器准备失败，未提交生成/);
    await assert.rejects(stopped.transport.request({ ...input(), beforeSubmit() { if (canceled) throw Error("canceled"); }, onSubmitting() { marked++; } }), /canceled/);
    assert.equal(failed.counts().posted + stopped.counts().posted + marked, 0);
  } finally { await failed.transport.close(); await stopped.transport.close(); }
});

test("a timed-out browser POST is never replayed and its account context closes", async () => {
  const h = harness({ fail: "timeout" });
  try {
    await assert.rejects(h.transport.request(input()), /timeout/);
    assert.equal(h.counts().posted, 1);
    assert.equal(h.counts().evaluations, 1);
    assert.equal(h.contexts[0].closed, true);
  } finally { await h.transport.close(); }
});

test("core never retries browser risk rejection or uncertain submission through axios", async () => {
  const old = seedanceBrowser.request, oldAdapter = axios.defaults.adapter;
  let calls = 0, direct = 0;
  process.env.JIMENG_BROWSER_TRANSPORT = "on";
  axios.defaults.adapter = async () => { direct++; throw Error("unmocked network forbidden"); };
  try {
    seedanceBrowser.request = async () => { calls++; return { status: 200, statusText: "OK", headers: {}, config: {} as any, data: { ret: 4013, errmsg: "risk rejected" } }; };
    await assert.rejects(request("post", path, "fixture", { data: input().data }), /4013/);
    seedanceBrowser.request = async () => { calls++; throw Object.assign(Error("timeout"), { code: "ETIMEDOUT" }); };
    await assert.rejects(request("post", path, "fixture", { data: input().data }), /timeout/);
    assert.equal(calls, 2); assert.equal(direct, 0);
  } finally { seedanceBrowser.request = old; axios.defaults.adapter = oldAdapter; delete process.env.JIMENG_BROWSER_TRANSPORT; }
});
