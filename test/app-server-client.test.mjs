import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServerClient, NATIVE_CODEX_APP_SERVER_ARGS } from "../app-server-client.mjs";

test("default App Server launch arguments match native Codex Desktop", () => {
  const client = new CodexAppServerClient();
  assert.deepEqual(client.appServerArgs, NATIVE_CODEX_APP_SERVER_ARGS);
  assert.equal(client.command, process.execPath);
  assert.equal(client.commandSource, "bundled");
});

test("a missing Codex executable reports an actionable configuration error", async () => {
  const client = new CodexAppServerClient({
    command: missingCodexPath(),
    requestTimeoutMs: 1_000,
  });
  await assert.rejects(client.start(), (error) => {
    assert.equal(error.code, "CODEX_EXECUTABLE_NOT_FOUND");
    return /RELAY_CODEX_COMMAND/.test(error.message);
  });
});

function missingCodexPath() {
  return process.platform === "win32" ? "Z:\\relay-missing\\codex.exe" : "/relay/missing/codex";
}

test("JSON-RPC requests resolve, reject, and time out with their method context", async () => {
  const writes = [];
  const client = new CodexAppServerClient({ requestTimeoutMs: 15 });
  client.process = {
    stdin: {
      writable: true,
      write: (line) => writes.push(JSON.parse(line)),
    },
  };

  const resolved = client.request("model/list");
  client.handleLine(JSON.stringify({ id: writes[0].id, result: { data: [] } }));
  assert.deepEqual(await resolved, { data: [] });

  const rejected = client.request("thread/resume");
  client.handleLine(JSON.stringify({
    id: writes[1].id,
    error: { code: -32_000, message: "thread missing", data: { threadId: "x" } },
  }));
  await assert.rejects(rejected, (error) => {
    assert.equal(error.code, -32_000);
    assert.deepEqual(error.data, { threadId: "x" });
    return /thread missing/.test(error.message);
  });

  await assert.rejects(client.request("turn/start"), /turn\/start timed out after 15ms/);
  client.process = null;
});

test("long-running App Server requests can disable the client timeout", async () => {
  const writes = [];
  const client = new CodexAppServerClient({ requestTimeoutMs: 5 });
  client.process = {
    stdin: {
      writable: true,
      write: (line) => writes.push(JSON.parse(line)),
    },
  };

  const running = client.request("command/exec", {}, { timeoutMs: null });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(client.pending.get(writes[0].id)?.timer, null);
  client.handleLine(JSON.stringify({ id: writes[0].id, result: { exitCode: 0 } }));
  assert.deepEqual(await running, { exitCode: 0 });
  client.process = null;
});

test("invalid protocol lines remain diagnostic and server requests stay interactive", () => {
  const client = new CodexAppServerClient();
  const diagnostics = [];
  const requests = [];
  client.on("diagnostic", (message) => diagnostics.push(message));
  client.on("serverRequest", (message) => requests.push(message));

  client.handleLine("not-json");
  client.handleLine(JSON.stringify({
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: { command: "pwd" },
  }));

  assert.match(diagnostics[0], /invalid app-server JSON/);
  assert.equal(requests[0].id, "approval-1");
});

test("an App Server child exit rejects initialization and reports the exit", async () => {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: ["-e", "process.stdin.resume(); setTimeout(() => process.exit(7), 20)"],
    requestTimeoutMs: 1_000,
  });
  let exit = null;
  client.on("exit", (details) => {
    exit = details;
  });

  await assert.rejects(client.start(), /codex app-server exited \(7\)/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(exit.code, 7);
});

test("initialization advertises native Codex Desktop capabilities by default", async () => {
  const fixture = [
    "const readline = require('node:readline')",
    "const input = readline.createInterface({ input: process.stdin })",
    "input.on('line', (line) => {",
    "  const message = JSON.parse(line)",
    "  if (message.method !== 'initialize') return",
    "  const capabilities = message.params.capabilities",
    "  if (message.params.clientInfo.name !== 'Codex Desktop') process.exit(8)",
    "  if (capabilities.experimentalApi !== true || capabilities.requestAttestation !== true) process.exit(9)",
    "  if (capabilities.mcpServerOpenaiFormElicitation !== false) process.exit(10)",
    "  if (!capabilities.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes?.includes('text/html+skybridge')) process.exit(11)",
    "  if (!capabilities.optOutNotificationMethods?.includes('codex/event/task_started')) process.exit(12)",
    "  if (capabilities.optOutNotificationMethods?.includes('command/exec/outputDelta')) process.exit(13)",
    "  process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fixture' } }) + '\\n')",
    "})",
  ].join("\n");
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: ["-e", fixture],
    requestTimeoutMs: 1_000,
  });

  await client.start();
  assert.ok(client.process);
  await client.close();
});

test("initialization client identity and capabilities can be overridden", async () => {
  const writes = [];
  const client = new CodexAppServerClient({
    clientInfo: { name: "relay_codex", title: "Relay Codex", version: "test" },
    capabilities: { experimentalApi: true, requestAttestation: false },
    requestTimeoutMs: 15,
  });
  client.process = {
    stdin: {
      writable: true,
      write: (line) => writes.push(JSON.parse(line)),
    },
  };

  const initialized = client.request("initialize", {
    clientInfo: client.clientInfo,
    capabilities: client.capabilities,
  });
  assert.equal(writes[0].params.clientInfo.name, "relay_codex");
  assert.equal(writes[0].params.capabilities.requestAttestation, false);
  client.handleLine(JSON.stringify({ id: writes[0].id, result: { userAgent: "fixture" } }));
  await initialized;
  client.process = null;
});

test("a closed App Server stdin rejects pending work without an unhandled stream error", async () => {
  const client = new CodexAppServerClient({ requestTimeoutMs: 1_000 });
  client.process = { stdin: { writable: true, write() {} } };
  const pending = client.request("model/list");
  const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  client.handleStdinError(error);
  await assert.rejects(pending, /EPIPE/);
  assert.equal(client.pending.size, 0);
  client.process = null;
});

test("requests made while App Server is stopped carry an actionable stable code", async () => {
  const client = new CodexAppServerClient();
  await assert.rejects(client.request("model/list"), (error) => {
    assert.equal(error.code, "CODEX_APP_SERVER_NOT_RUNNING");
    assert.match(error.message, /Restart DSH/);
    return true;
  });
});
