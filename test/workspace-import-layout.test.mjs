import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Codex footer action remains compact in every sidebar width", async () => {
  const css = await readFile(new URL("../src/client/WorkspaceImportAction.module.css", import.meta.url), "utf8");
  const trigger = css.match(/\.trigger\s*\{(?<rules>[^}]*)\}/s)?.groups?.rules ?? "";

  assert.match(trigger, /width:\s*34px;/);
  assert.match(trigger, /min-width:\s*34px;/);
  assert.match(trigger, /height:\s*34px;/);
  assert.match(trigger, /flex:\s*0 0 34px;/);
  assert.doesNotMatch(trigger, /width:\s*100%;/);

  const compact = css.match(/\.trigger\[data-compact='true'\]\s*\{(?<rules>[^}]*)\}/s)?.groups?.rules ?? "";
  assert.match(compact, /width:\s*28px;/);
  assert.match(compact, /min-width:\s*28px;/);
  assert.match(compact, /height:\s*28px;/);
  assert.match(compact, /flex-basis:\s*28px;/);
});
