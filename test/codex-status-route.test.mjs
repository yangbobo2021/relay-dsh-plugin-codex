import assert from "node:assert/strict";
import test from "node:test";

import { createCodexStatusHandler } from "../codex-status-route.js";

test("Codex status route returns global and session-specific sanitized state", () => {
  const runtime = { status: () => ({ state: "connected", code: "CODEX_APP_SERVER_CONNECTED" }) };
  const adapter = {
    statusForSession: id => id === "fork-child"
      ? { state: "rebind-required", code: "CODEX_REBIND_REQUIRED" }
      : null,
  };
  const handler = createCodexStatusHandler({ runtime, adapter });

  const global = responseHarness();
  handler({ method: "GET", url: "/api/relay/codex/status" }, global.response);
  assert.equal(global.status(), 200);
  assert.equal(global.body().state, "connected");

  const child = responseHarness();
  handler({ method: "GET", url: "/api/relay/codex/status?sessionId=fork-child" }, child.response);
  assert.equal(child.body().state, "rebind-required");
});

test("Codex status route is read-only", () => {
  const handler = createCodexStatusHandler({
    runtime: { status: () => ({ state: "connected" }) },
    adapter: { statusForSession: () => null },
  });
  const output = responseHarness();
  handler({ method: "POST", url: "/api/relay/codex/status" }, output.response);
  assert.equal(output.status(), 405);
  assert.equal(output.headers().allow, "GET");
});

function responseHarness() {
  let status;
  let headers;
  let body = "";
  return {
    response: {
      writeHead(nextStatus, nextHeaders) { status = nextStatus; headers = nextHeaders; },
      end(chunk = "") { body += chunk; },
    },
    status: () => status,
    headers: () => headers,
    body: () => JSON.parse(body),
  };
}
