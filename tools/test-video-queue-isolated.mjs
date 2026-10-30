import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowed = [
  "account-selection", "agent-upscale-client", "agent-upscale-protocol", "agent-upscale-routes", "agent-upscale-tasks",
  "canvas-tasks", "premium-images", "seedance-browser", "seedance-draft", "seedance-draft-upgrade", "seedance-tasks",
  "seedance-upload", "task-errors", "upscale-console", "upscale-ui", "video-billing", "video-queue",
  "video-queue-settings", "video-quote", "outpaint-billing",
];
const requested = process.argv.slice(2);
const tests = !requested.length || requested.length === 1 && requested[0] === "all" ? [...allowed] : requested;
if (tests.some(name => !allowed.includes(name))) throw Error("Only explicit isolated regression test names or 'all' are accepted");
mkdirSync(join(root, ".private"), { recursive: true });
const output = mkdtempSync(join(root, ".private", "video-queue-tests-"));
const environment = {};
for (const [name, value] of Object.entries(process.env)) if (/^(path|systemroot|windir|comspec|temp|tmp|home|userprofile|localappdata|appdata)$/i.test(name)) environment[name] = value;
for (const name of tests) {
  const data = mkdtempSync(join(tmpdir(), "cpa-video-queue-test-")), bundle = join(output, `${name}.test.mjs`);
  await build({ entryPoints: [join(root, `tests/${name}.test.ts`)], bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, tsconfig: join(root, "tsconfig.json") });
  const child = spawnSync(process.execPath, ["--require", join(root, "tools/test-cpa-offline.cjs"), "--test", "--test-force-exit", bundle], { cwd: root, env: { ...environment, NODE_ENV: "test", VERCEL: "1", DATA_DIR: data, MEDIA_DIR: join(data, "media"), DB_PATH: join(data, "queue.sqlite"), JIMENG_ACCOUNT_POOL_KEY: "isolated-video-queue-test", JIMENG_BROWSER_TRANSPORT: "off" }, encoding: "utf8", timeout: 60_000 });
  writeFileSync(join(output, `${name}.log`), `${child.stdout || ""}\n${child.stderr || ""}`);
  console.log(`${child.status === 0 ? "PASS" : "FAIL"} ${name}: ${data}`);
  console.log((child.stdout || "").split(/\r?\n/).filter(line => /^[ℹ✔✖]|^# (tests|pass|fail)|^not ok/.test(line)).join("\n"));
  if (child.status !== 0) { console.error(child.stderr || child.error || "See retained test log"); process.exitCode = child.status ?? 1; break; }
}
console.log(`Private test logs: ${output}`);
