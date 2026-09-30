import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("public/index.html", "utf8");
const inlineScript = /<script>\s*([\s\S]*?)<\/script>\s*<\/body>/.exec(html)?.[1];
assert.ok(inlineScript);

function page(fetch: (url: string, options?: { method?: string }) => Promise<unknown>) {
  const values = new Map<string, string>();
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      value: id === "upscale-api-key" ? "jm_test_key" : "",
      files: id === "upscale-file" ? [{ type: "image/png", size: 128 }] : [],
      classList: { add() {}, remove() {}, toggle() {} },
      style: { setProperty() {} },
      addEventListener() {},
      setAttribute() {},
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [], createElement: () => ({}) },
    sessionStorage: { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
    JimengUpscaleUI: {
      clampComparison: (value: number) => value,
      createTaskId: () => "upscale_console_test_123456",
      putOriginal: async () => {},
      getOriginal: async () => null,
      deleteOriginal: async () => {},
      isTerminalStatus: (status: string) => ["succeeded", "failed", "canceled"].includes(status),
    },
    FileReader: class {
      result = "data:image/png;base64,YQ==";
      onload?: () => void;
      readAsDataURL() { this.onload?.(); }
    },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    fetch,
    confirm: () => true,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    console,
  });
  vm.runInContext(inlineScript!, context);
  return { context, values, element };
}

test("console does not create a paid task when the previous task cannot be checked", async () => {
  let posts = 0;
  const harness = page(async (url, options) => {
    if (url === "/dashboard/status") return { json: async () => ({ setupComplete: false }) };
    if (options?.method === "POST") posts++;
    throw Error("temporary network failure");
  });
  harness.values.set("jimengUpscaleTaskId", "upscale_previous_123456789");
  await vm.runInContext("startUpscale()", harness.context);
  assert.equal(posts, 0);
  assert.equal(harness.values.get("jimengUpscaleTaskId"), "upscale_previous_123456789");
});

test("console keeps an existing task ID after a 404 with the current key", async () => {
  let posts = 0;
  const harness = page(async (url, options) => {
    if (url === "/dashboard/status") return { json: async () => ({ setupComplete: false }) };
    if (options?.method === "POST") posts++;
    return { ok: false, status: 404, json: async () => ({ error: "任务不存在" }) };
  });
  harness.values.set("jimengUpscaleTaskId", "upscale_previous_123456789");
  await vm.runInContext("startUpscale()", harness.context);
  assert.equal(posts, 0);
  assert.equal(harness.values.get("jimengUpscaleTaskId"), "upscale_previous_123456789");
});

test("console remembers the ID before POST and queries it after a lost response", async () => {
  let posts = 0;
  let gets = 0;
  let idAtPost = "";
  let resolutionAtPost = "";
  let harness: ReturnType<typeof page>;
  harness = page(async (url, options) => {
    if (url === "/dashboard/status") return { json: async () => ({ setupComplete: false }) };
    if (options?.method === "POST") {
      posts++;
      idAtPost = harness.values.get("jimengUpscaleTaskId") || "";
      resolutionAtPost = JSON.parse((options as any).body).resolution;
      throw Error("response lost");
    }
    if (url.startsWith("/v1/upscale/tasks/")) {
      gets++;
      return { ok: true, status: 200, json: async () => ({ status: "running" }) };
    }
    throw Error(`unexpected request ${url}`);
  });
  harness.element("upscale-resolution").value = "4k";
  await vm.runInContext("startUpscale()", harness.context);
  await new Promise(setImmediate);
  assert.equal(posts, 1);
  assert.equal(idAtPost, "upscale_console_test_123456");
  assert.equal(resolutionAtPost, "4k");
  assert.equal(harness.values.get("jimengUpscaleTaskId"), idAtPost);
  assert.ok(gets >= 1);
  await vm.runInContext("startUpscale()", harness.context);
  assert.equal(posts, 1);
});

test("console reports a 4K upstream label without claiming 8K", async () => {
  const harness = page(async () => ({ json: async () => ({ setupComplete: false }) }));
  await vm.runInContext("renderUpscaleSuccess('upscale_4k_result_123456', { status: 'succeeded', resolution: '4k', providerLabel: '4K', data: [{ url: 'https://fixture.invalid/result.png' }] })", harness.context);
  assert.equal(harness.element("upscale-provider-label").textContent, "上游标记 4K");
  assert.match(harness.element("upscale-status").textContent || "", /4K/);
});
