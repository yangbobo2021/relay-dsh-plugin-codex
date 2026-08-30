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

  const composite = css.match(/\.compositeIcon\s*\{(?<rules>[^}]*)\}/s)?.groups?.rules ?? "";
  assert.match(composite, /position:\s*relative;/);
  assert.match(composite, /width:\s*23px;/);
  assert.match(composite, /height:\s*22px;/);

  const badge = css.match(/\.providerBadge\s*\{(?<rules>[^}]*)\}/s)?.groups?.rules ?? "";
  assert.match(badge, /position:\s*absolute;/);
  assert.match(badge, /right:\s*0;/);
  assert.match(badge, /bottom:\s*0;/);
  assert.match(badge, /width:\s*13px;/);
  assert.match(badge, /height:\s*13px;/);

  const compactComposite = css.match(/\.trigger\[data-compact='true'\] \.compositeIcon\s*\{(?<rules>[^}]*)\}/s)?.groups?.rules ?? "";
  assert.match(compactComposite, /width:\s*21px;/);
  assert.match(compactComposite, /height:\s*19px;/);

  const compactBadge = css.match(/\.trigger\[data-compact='true'\] \.providerBadge\s*\{(?<rules>[^}]*)\}/s)?.groups?.rules ?? "";
  assert.match(compactBadge, /width:\s*11px;/);
  assert.match(compactBadge, /height:\s*11px;/);
});
