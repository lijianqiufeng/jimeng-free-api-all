import { build } from 'esbuild';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.');
const isolated = mkdtempSync(join(tmpdir(), 'jimeng-canvas-tests-'));
const outfile = join(isolated, 'tests.mjs');
symlinkSync(join(root, 'node_modules'), join(isolated, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await build({ entryPoints: ['tests/canvas-tasks.test.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile, absWorkingDir: root });
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
Object.assign(env, { NODE_PATH: join(root, 'node_modules'), DATA_DIR: isolated, DB_PATH: join(isolated, 'test.sqlite'), MEDIA_DIR: join(isolated, 'media'), JIMENG_ACCOUNT_POOL_KEY: 'isolated-fake-key', VERCEL: '1', SERVER_ENV: 'isolated-test' });
console.log(`隔离目录：${isolated}；网络仅允许模拟，无真实积分消耗`);
const result = spawnSync(process.execPath, ['--test', '--test-force-exit', outfile], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exitCode = result.status ?? 1;
