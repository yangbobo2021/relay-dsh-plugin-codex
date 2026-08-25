import assert from "node:assert/strict";
import test from "node:test";

import {
  codexConnectionFailure,
  connectedCodexConnectionStatus,
  initialCodexConnectionStatus,
  rebindRequiredStatus,
  startingCodexConnectionStatus,
} from "../connection-status.mjs";

test("Codex connection lifecycle exposes stable user-facing states", () => {
  assert.equal(initialCodexConnectionStatus(1).state, "not-started");
  assert.equal(startingCodexConnectionStatus(2).state, "starting");
  assert.equal(connectedCodexConnectionStatus(3).state, "connected");
  assert.equal(connectedCodexConnectionStatus(3).action, null);
});

test("executable and bundled runtime failures are actionable without raw spawn errors", () => {
  const missingExecutable = codexConnectionFailure(Object.assign(
    new Error("spawn codex ENOENT"),
    { code: "CODEX_EXECUTABLE_NOT_FOUND" },
  ), 1);
  assert.equal(missingExecutable.state, "unavailable");
  assert.equal(missingExecutable.code, "CODEX_EXECUTABLE_NOT_FOUND");
  assert.doesNotMatch(`${missingExecutable.message} ${missingExecutable.action}`, /spawn|ENOENT/i);
  assert.match(missingExecutable.action, /RELAY_CODEX_COMMAND/);

  for (const code of ["CODEX_RUNTIME_MISSING", "CODEX_PLATFORM_UNSUPPORTED"]) {
    const status = codexConnectionFailure(Object.assign(new Error("unavailable"), { code }), 1);
    assert.equal(status.state, "unavailable");
    assert.equal(status.code, code);
    assert.match(status.action, /RELAY_CODEX_COMMAND/);
  }
});

test("protocol and process failures remain distinct from installation failures", () => {
  const status = codexConnectionFailure(Object.assign(new Error("initialize failed"), {
    code: "CODEX_APP_SERVER_EXITED",
  }), 1);
  assert.equal(status.state, "connection-failed");
  assert.equal(status.code, "CODEX_APP_SERVER_EXITED");
  assert.match(status.action, /Restart DSH/);
});

test("rebind-required status preserves original Codex provenance", () => {
  const status = rebindRequiredStatus({
    threadId: "thread-original",
    turnId: "turn-original",
    itemId: "item-original",
  }, 1);
  assert.equal(status.state, "rebind-required");
  assert.equal(status.code, "CODEX_REBIND_REQUIRED");
  assert.match(status.message, /thread-original/);
  assert.match(status.message, /turn-original/);
  assert.match(status.message, /item-original/);
  assert.match(status.action, /did not create a replacement/);
});
