import { createHash } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright-core";

const ORIGIN = "https://jimeng.jianying.com";
const GENERATE = "/mweb/v1/aigc_draft/generate";
const MODELS = new Set(["dreamina_seedance_40_pro", "dreamina_seedance_40"]);
type Input = { token: string; params: Record<string, unknown>; headers: Record<string, string>; data: any; beforeSubmit?: () => void; onSubmitting?: () => void; signal?: AbortSignal };
type Session = { context: BrowserContext; page: Page; body: string | null; sent: boolean; closing?: Promise<void> };

export function supportsSeedanceBrowser(method: string, uri: string, data: any) {
  return method.toLowerCase() === "post" && uri === GENERATE && MODELS.has(data?.extend?.root_model);
}

/** Backwards compatible opt-in used before the dashboard transport modes existed. */
export function usesSeedanceBrowser(method: string, uri: string, data: any) {
  return process.env.JIMENG_BROWSER_TRANSPORT === "on" && supportsSeedanceBrowser(method, uri, data);
}

async function launchBrowser() {
  const { chromium } = await import("playwright-core");
  return chromium.launch({ headless: true, executablePath: process.env.JIMENG_BROWSER_EXECUTABLE || (process.platform === "linux" ? "/usr/bin/chromium-browser" : undefined),
    ...(process.platform === "win32" && !process.env.JIMENG_BROWSER_EXECUTABLE ? { channel: "msedge" } : {}), args: ["--disable-dev-shm-usage"] });
}

/** Official page SDK transport. One submission, no direct-to-browser replay or timeout retry. */
export class SeedanceBrowserTransport {
  private browser?: Browser;
  private sessions = new Map<string, Session>();
  private tail: Promise<unknown> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private launch = launchBrowser) {}

  request(input: Input) {
    input.signal?.throwIfAborted();
    let started = false, abort: (() => void) | undefined;
    const work = this.tail.then(() => { started = true; input.signal?.throwIfAborted(); return this.execute(input); });
    this.tail = work.catch(() => {});
    if (!input.signal) return work;
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => { if (!started) reject(input.signal!.reason || Error("视频请求已中断")); };
      input.signal!.addEventListener("abort", abort, { once: true });
      if (input.signal!.aborted) abort();
    });
    return Promise.race([work, canceled]).finally(() => input.signal!.removeEventListener("abort", abort!));
  }

  async close() {
    clearTimeout(this.idle);
    this.sessions.clear();
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close();
  }

  private closeSession(session: Session): Promise<void> {
    return session.closing ||= (async () => {
      let closed!: () => void;
      const ended = new Promise<void>(resolve => { closed = resolve; });
      session.context.once?.("close", closed);
      try { await session.context.close(); }
      catch {
        // An unsuccessful close is not proof that this paid request has left the browser.
        if (!session.page?.isClosed()) await ended;
      } finally { session.context.off?.("close", closed); }
    })();
  }

  private async prepare(token: string, signal?: AbortSignal): Promise<Session> {
    signal?.throwIfAborted();
    const key = createHash("sha256").update(token).digest("hex");
    if (!this.browser?.isConnected()) { this.sessions.clear(); this.browser = await this.launch(); }
    const existing = this.sessions.get(key);
    if (existing && !existing.page.isClosed()) return existing;
    if (existing) { await this.closeSession(existing); this.sessions.delete(key); }
    if (this.sessions.size >= 2) {
      const [oldKey, old] = this.sessions.entries().next().value!;
      await this.closeSession(old); this.sessions.delete(oldKey);
    }
    const context = await this.browser.newContext({ locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block" });
    const session: Session = { context, page: undefined!, body: null, sent: false };
    const abort = () => { void this.closeSession(session); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await context.addCookies(["sessionid", "sessionid_ss", "sid_tt"].map(name => ({ name, value: token, domain: ".jianying.com", path: "/", secure: true, httpOnly: true })));
      // The page itself must never create a job. Only our exact one-shot payload can pass.
      await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() === "POST" && (url.pathname === GENERATE || url.pathname.includes("/creation_agent/"))) {
          if (url.origin !== ORIGIN || url.pathname !== GENERATE || !session.body || session.sent || request.postData() !== session.body) return route.abort();
          session.sent = true;
        }
        await route.continue();
      });
      session.page = await context.newPage();
      await session.page.goto(`${ORIGIN}/ai-tool/video/generate`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await session.page.waitForFunction(() => Boolean((globalThis as any).bdms), undefined, { timeout: 20_000 });
      if (new URL(session.page.url()).origin !== ORIGIN) throw Error("Unexpected page origin");
      this.sessions.set(key, session);
      return session;
    } catch { await this.closeSession(session); signal?.throwIfAborted(); throw Error("当前账号浏览器准备失败，未提交生成"); }
    finally { signal?.removeEventListener("abort", abort); }
  }

  private async execute(input: Input) {
    clearTimeout(this.idle);
    let session: Session | undefined;
    const abort = () => { if (session) void this.closeSession(session); };
    try {
      input.signal?.throwIfAborted();
      if (!MODELS.has(input.data?.extend?.root_model) || typeof input.data?.submit_id !== "string" || !input.data.submit_id) throw Error("当前账号浏览器请求参数未确认，未提交生成");
      input.beforeSubmit?.();
      session = await this.prepare(input.token, input.signal);
      input.signal?.addEventListener("abort", abort, { once: true });
      input.signal?.throwIfAborted();
      input.beforeSubmit?.();
      const url = new URL(GENERATE, ORIGIN);
      for (const [key, value] of Object.entries(input.params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      const headers = Object.fromEntries(Object.entries(input.headers).filter(([key]) => !/^(cookie|origin|referer|host|content-length|accept-encoding|connection|user-agent|sec-)/i.test(key)));
      session.body = JSON.stringify(input.data); session.sent = false;
      input.onSubmitting?.();
      const response = await session.page.evaluate(async ({ url, headers, body }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        try {
          const response = await fetch(url, { method: "POST", credentials: "include", redirect: "error", headers: { ...headers, "Content-Type": "application/json" }, body, signal: controller.signal });
          return { status: response.status, statusText: response.statusText, text: await response.text() };
        } finally { clearTimeout(timeout); }
      }, { url: url.href, headers, body: session.body });
      if (!session.sent) throw Error("Browser did not observe the expected request");
      return { status: response.status, statusText: response.statusText, headers: {}, config: {} as any, data: JSON.parse(response.text) };
    } catch (error) {
      if (session) {
        for (const [key, value] of this.sessions) if (value === session) this.sessions.delete(key);
        await this.closeSession(session);
      }
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
      await session?.closing;
      if (session) session.body = null;
      this.idle = setTimeout(() => { void this.close().catch(() => {}); }, 5 * 60_000);
      this.idle.unref();
    }
  }
}

export const seedanceBrowser = new SeedanceBrowserTransport();
