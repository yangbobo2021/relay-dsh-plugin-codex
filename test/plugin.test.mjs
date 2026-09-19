import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PluginHost } from "../internal/plugin-sdk.mjs";
import { CodexRuntimeController, createCodexExecutionPlugin } from "../plugin.mjs";

test("Codex plugin exposes operation capabilities and releases subscriptions", async () => {
  const client = new FakeCodexClient();
  const host = new PluginHost();
  await host.activate([createCodexExecutionPlugin({ client, cwd: "/workspace" })]);
  const execution = host.capabilities.require("relay.execution.codex.v1", "^1.0.0");
  const terminal = host.capabilities.require("relay.terminal.codex.v1", "^1.0.0");

  await execution.whenReady();
  assert.equal(execution.status().state, "connected");
  assert.deepEqual(execution.status().runtime, {
    source: "fake",
    path: "/fake/codex",
    modelCount: 1,
  });
  assert.deepEqual(execution.listModels().map((model) => model.id), ["codex-test"]);
  assert.equal(typeof execution.forkSession, "function");
  assert.equal("runtime" in execution, false);
  assert.equal("client" in execution, false);
  const requests = [];
  const stop = execution.subscribeRequest((request) => requests.push(request.id));
  client.emit("serverRequest", { id: "request-1", method: "test", params: {} });
  assert.deepEqual(requests, ["request-1"]);
  stop();
  client.emit("serverRequest", { id: "request-2", method: "test", params: {} });
  assert.deepEqual(requests, ["request-1"]);

  assert.equal(await terminal.request("terminal/test", {}), "ok");
  await host.dispose();
  assert.equal(client.closed, true);
});

test("a missing configured executable keeps the plugin loaded with actionable unavailable status", async () => {
  const host = new PluginHost();
  await host.activate([createCodexExecutionPlugin({
    command: process.platform === "win32" ? "Z:\\relay-missing\\codex.exe" : "/relay/missing/codex",
    requestTimeoutMs: 1_000,
  })]);
  const execution = host.capabilities.require("relay.execution.codex.v1", "^1.0.0");

  await assert.rejects(execution.whenReady(), (error) => {
    assert.equal(error.code, "CODEX_EXECUTABLE_NOT_FOUND");
    assert.doesNotMatch(error.message, /spawn|ENOENT/i);
    return true;
  });
  assert.deepEqual(execution.status(), {
    state: "unavailable",
    code: "CODEX_EXECUTABLE_NOT_FOUND",
    message: "Codex could not start because the configured executable was not found.",
    action: "Remove the invalid codexCommand or RELAY_CODEX_COMMAND override, or set it to an absolute Codex executable path.",
    changedAt: execution.status().changedAt,
  });
  await host.dispose();
});

test("runtime reload replaces the App Server and model catalog without replacing the capability", async () => {
  const clients = [];
  const controller = new CodexRuntimeController({
    cwd: "/workspace",
    clientFactory(command) {
      const client = new FakeCodexClient(command);
      clients.push(client);
      return client;
    },
  });
  const catalogRefreshes = [];
  const host = new PluginHost();
  await host.activate([createCodexExecutionPlugin({
    controller,
    command: "runtime-one",
    onReload: event => catalogRefreshes.push(event.models.map(model => model.id)),
  })]);
  const execution = host.capabilities.require("relay.execution.codex.v1", "^1.0.0");
  await execution.whenReady();
  const reloaded = [];
  controller.on("reloaded", (event) => reloaded.push(event.command));
  const capability = execution;

  await controller.reload("runtime-two");

  assert.equal(execution, capability);
  assert.deepEqual(execution.listModels().map((model) => model.id), ["runtime-two"]);
  assert.deepEqual(reloaded, ["runtime-two"]);
  assert.deepEqual(catalogRefreshes, [["runtime-two"]]);
  assert.equal(clients[0].closed, true);
  assert.equal(clients[1].closed, false);
  await host.dispose();
});

test("runtime reload waits for an active turn and preserves the existing session", async () => {
  const clients = [];
  const controller = new CodexRuntimeController({
    cwd: "/workspace",
    clientFactory(command) {
      const client = new FakeCodexClient(command);
      clients.push(client);
      return client;
    },
  });
  const host = new PluginHost();
  await host.activate([createCodexExecutionPlugin({ controller, command: "runtime-one" })]);
  const execution = host.capabilities.require("relay.execution.codex.v1", "^1.0.0");
  await execution.whenReady();
  const session = {
    id: "thread-1", sessionId: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }],
    updatedAt: 1,
  };
  controller.current.runtime.sessions.set(session.id, session);

  let settled = false;
  const reload = controller.reload("runtime-two").then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(clients[0].closed, false);

  session.turns[0].status = "completed";
  controller.current.runtime.emit("change");
  await reload;

  assert.equal(execution.hasSession(session.id), true);
  assert.deepEqual(execution.getSession(session.id).turns, session.turns);
  assert.equal(clients[0].closed, true);
  await host.dispose();
});

test("a failed runtime reload leaves the previous runtime usable", async () => {
  const clients = [];
  const controller = new CodexRuntimeController({
    cwd: "/workspace",
    clientFactory(command) {
      const client = new FakeCodexClient(command);
      if (command === "runtime-bad") client.start = async () => { throw new Error("candidate unavailable"); };
      clients.push(client);
      return client;
    },
  });
  const host = new PluginHost();
  await host.activate([createCodexExecutionPlugin({ controller, command: "runtime-one" })]);
  const execution = host.capabilities.require("relay.execution.codex.v1", "^1.0.0");
  await execution.whenReady();

  await assert.rejects(controller.reload("runtime-bad"), (error) => {
    assert.match(error.cause?.message ?? "", /candidate unavailable/);
    return true;
  });
  assert.deepEqual(execution.listModels().map((model) => model.id), ["runtime-one"]);
  assert.equal(clients[0].closed, false);
  assert.equal(clients[1].closed, true);
  await host.dispose();
});

class FakeCodexClient extends EventEmitter {
  constructor(runtime = "/fake/codex") {
    super();
    this.closed = false;
    this.runtimeInfo = { source: "fake", path: runtime, modelCount: 1 };
    this.modelId = runtime === "/fake/codex" ? "codex-test" : runtime;
  }

  async start() {}

  async request(method) {
    if (method === "model/list") return { data: [{ id: this.modelId, isDefault: true }] };
    if (method === "account/read") return null;
    if (method === "thread/list") return { data: [] };
    if (method === "terminal/test") return "ok";
    throw new Error(`unexpected request ${method}`);
  }

  respond() {}
  respondError() {}
  async close() { this.closed = true; }
}
