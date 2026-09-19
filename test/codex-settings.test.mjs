import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = name => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const [host, client, card, controller, readme, acceptance] = await Promise.all([
  read("host-plugin.js"),
  read("src/client/index.ts"),
  read("src/client/CodexCard.tsx"),
  read("src/client/codex-card-controller.ts"),
  read("README.zh.md"),
  read("docs/reliability-acceptance.md"),
]);

test("Codex runtime owns one DSH settings namespace on both sides", () => {
  assert.match(host, /CODEX_SETTINGS_NAMESPACE = ["']relay-codex["']/);
  assert.match(host, /settings\?\.installSection\(ctx, CODEX_SETTINGS_NAMESPACE/);
  assert.match(host, /codexCommand: z\.string\(\)\.default\(""\)/);
  assert.match(client, /ctx\.settingsScope\.bind\(\{ namespace: CODEX_SETTINGS_NAMESPACE \}\)/);
  assert.match(client, /name: 'settings\.plugin\.item'/);
  assert.match(client, /key: CODEX_SETTINGS_NAMESPACE/);
});

test("the settings card exposes staged runtime choices and reset semantics", () => {
  assert.match(card, /runtimeAuto/);
  assert.match(card, /runtimeBundled/);
  assert.match(card, /runtimePath/);
  assert.match(card, /runtimeRestartHint/);
  assert.match(card, /props\.reset/);
  assert.match(card, /props\.discard/);
  assert.match(controller, /scope\.set\('codexCommand'/);
  assert.match(controller, /scope\.unset\('codexCommand'/);
  assert.match(controller, /private draftMode: CodexRuntimeMode \| undefined/);
  assert.match(controller, /this\.draftMode = mode/);
  assert.match(controller, /mode === 'path' && command\.trim\(\) === ''/);
});

test("the documented acceptance path points at the plugin configuration page", () => {
  assert.match(readme, /设置 → 插件 → 插件配置 → Codex 运行时/);
  assert.match(acceptance, /C3 Settings UI and persistence/);
  assert.match(acceptance, /codex-settings\.test\.mjs/);
});
