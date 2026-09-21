import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sandbox = vm.createContext({});
vm.runInContext(fs.readFileSync("public/upscale-ui.js", "utf8"), sandbox);
const ui = (sandbox as { JimengUpscaleUI: {
  clampComparison: (value: unknown) => number;
  isTerminalStatus: (status: string) => boolean;
  createTaskId: (random?: (array: Uint8Array) => Uint8Array) => string;
} }).JimengUpscaleUI;

test("comparison position is clamped", () => {
  assert.equal(ui.clampComparison(-1), 0);
  assert.equal(ui.clampComparison(50), 50);
  assert.equal(ui.clampComparison(101), 100);
});

test("only terminal states stop polling", () => {
  assert.equal(ui.isTerminalStatus("running"), false);
  assert.equal(ui.isTerminalStatus("submitting"), false);
  assert.equal(ui.isTerminalStatus("succeeded"), true);
  assert.equal(ui.isTerminalStatus("failed"), true);
  assert.equal(ui.isTerminalStatus("canceled"), true);
});

test("task IDs satisfy the backend contract", () => {
  assert.match(ui.createTaskId(() => new Uint8Array(16).fill(7)), /^[A-Za-z0-9_-]{16,100}$/);
});
