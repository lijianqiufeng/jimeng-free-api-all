import { build } from "esbuild";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const isolated = mkdtempSync(join(tmpdir(), "jimeng-agent-upscale-tests-"));
const entries = process.argv.slice(2);
if (!entries.length) entries.push("tests/agent-upscale-protocol.test.ts");
const files = [];
for (const [index, entry] of entries.entries()) {
  const outfile = join(isolated, `test-${index}.mjs`);
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile, absWorkingDir: root });
  files.push(outfile);
}
symlinkSync(join(root, "node_modules"), join(isolated, "node_modules"), process.platform === "win32" ? "junction" : "dir");
const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
Object.assign(env, { NODE_PATH: join(root, "node_modules"), DATA_DIR: isolated, DB_PATH: join(isolated, "test.sqlite"), MEDIA_DIR: join(isolated, "media"), JIMENG_ACCOUNT_POOL_KEY: "isolated-fake-key", VERCEL: "1", SERVER_ENV: "isolated-test" });
const result = spawnSync(process.execPath, ["--test", "--test-force-exit", ...files], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exitCode = result.status ?? 1;
