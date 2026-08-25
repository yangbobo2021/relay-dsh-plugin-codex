import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchCodexStatus,
  statusLocaleKey,
} from "../src/client/codex-status-client.mjs";

test("client status reads global or session-scoped Codex state", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          state: "rebind-required",
          code: "CODEX_REBIND_REQUIRED",
          message: "Rebind required.",
          action: "Return to the original Session.",
          changedAt: 1,
        };
      },
    };
  };

  const status = await fetchCodexStatus("child session", fetchImpl);
  assert.equal(calls[0].url, "/api/relay/codex/status?sessionId=child%20session");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(statusLocaleKey(status), "statusRebindRequired");
  assert.equal(statusLocaleKey(null), "statusLoading");
});

test("invalid status responses fail instead of inventing a connected state", async () => {
  await assert.rejects(fetchCodexStatus(undefined, async () => ({
    ok: true,
    status: 200,
    async json() { return { state: "connected" }; },
  })), /Codex status failed/);
  assert.equal(statusLocaleKey({ state: "connection-failed" }), "statusConnectionFailed");
  assert.equal(statusLocaleKey({ state: "unavailable" }), "statusUnavailable");
});
