import assert from "node:assert/strict";
import test from "node:test";

import {
  workspaceImportUpdatedAtDate,
  workspaceImportUiPolicy,
} from "../src/client/workspace-import-ui-policy.mjs";

test("Workspace import UI policy covers every control state", () => {
  assert.deepEqual(workspaceImportUiPolicy("no-workspace"), {
    canClose: true, primary: "close", primaryDisabled: false,
  });
  assert.deepEqual(workspaceImportUiPolicy("scanning"), {
    canClose: true, primary: "close", primaryDisabled: false,
  });
  assert.deepEqual(workspaceImportUiPolicy("summary", 0), {
    canClose: true, secondary: "cancel", primary: "import-selected", primaryDisabled: true,
  });
  assert.deepEqual(workspaceImportUiPolicy("summary", 2), {
    canClose: true, secondary: "cancel", primary: "import-selected", primaryDisabled: false,
  });
  assert.deepEqual(workspaceImportUiPolicy("importing", 2), {
    canClose: false, primary: "importing", primaryDisabled: true,
  });
  assert.deepEqual(workspaceImportUiPolicy("error"), {
    canClose: true, secondary: "cancel", primary: "retry", primaryDisabled: false,
  });
  assert.deepEqual(workspaceImportUiPolicy("complete", 0, 1), {
    canClose: true, secondary: "close", primary: "retry", primaryDisabled: false,
  });
  assert.deepEqual(workspaceImportUiPolicy("complete", 0, 0), {
    canClose: true, primary: "close", primaryDisabled: false,
  });
});

test("Workspace import renders App Server epoch seconds as real dates", () => {
  assert.equal(workspaceImportUpdatedAtDate(1_700_000_000)?.toISOString(), "2023-11-14T22:13:20.000Z");
  assert.equal(workspaceImportUpdatedAtDate(1_700_000_000_000)?.toISOString(), "2023-11-14T22:13:20.000Z");
  assert.equal(workspaceImportUpdatedAtDate("invalid"), null);
  assert.equal(workspaceImportUpdatedAtDate(null), null);
});
