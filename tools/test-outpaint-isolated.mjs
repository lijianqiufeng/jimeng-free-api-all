import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, ".private"), { recursive: true });
const output = mkdtempSync(join(root, ".private", "native-outpaint-tests-")), data = mkdtempSync(join(tmpdir(), "cpa-native-outpaint-test-"));
const bundle = join(output, "native-outpaint.test.mjs"), environment = {};
for (const [name, value] of Object.entries(process.env)) if (/^(path|systemroot|windir|comspec|temp|tmp|home|userprofile|localappdata|appdata)$/i.test(name)) environment[name] = value;
// Only package this new mock test; no product build and no inherited business configuration.
await build({ entryPoints: [join(root, "tests/native-outpaint.test.ts")], bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, tsconfig: join(root, "tsconfig.json") });
const pattern = process.argv[2];
const child = spawnSync(process.execPath, ["--require", join(root, "tools/test-cpa-offline.cjs"), "--test", "--test-force-exit", ...(pattern ? ["--test-name-pattern", pattern] : []), bundle], { cwd: root, env: { ...environment, NODE_ENV: "test", VERCEL: "1", DATA_DIR: data, DB_PATH: join(data, "outpaint.sqlite"), MEDIA_DIR: join(data, "media"), JIMENG_ACCOUNT_POOL_KEY: "isolated-native-outpaint-fixture", JIMENG_BROWSER_TRANSPORT: "off" }, encoding: "utf8", timeout: 60_000 });
writeFileSync(join(output, "test.log"), `${child.stdout || ""}\n${child.stderr || ""}`, "utf8");
writeFileSync(join(output, "receipt.json"), JSON.stringify({ exitCode: child.status, testNamePattern: pattern || null, isolatedDataDir: data, isolatedDbPath: join(data, "outpaint.sqlite"), inheritedCredentials: false, unmockedNetworkBlocked: true, productBuild: false }, null, 2), "utf8");
console.log((child.stdout || "").split(/\r?\n/).filter(line => /^[ℹ✔✖]|^# (tests|pass|fail)|^not ok/.test(line)).join("\n"));
console.log(`Private test logs: ${output}`);
if (child.status !== 0) { console.error(child.stderr || child.error || "See retained private test log"); process.exitCode = child.status ?? 1; }
