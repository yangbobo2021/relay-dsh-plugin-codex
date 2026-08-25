import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_THREAD_ACTIVE_WRITER,
  CodexDshAdapter,
} from "../codex-adapter.js";
import { allowedRealPath, importCodexGeneratedImage, importCodexImage } from "../codex-image.js";
import { CodexLinkStore } from "../codex-link-store.js";
import { CODEX_APP_DYNAMIC_TOOLS, handleCodexServerRequest } from "../codex-tools.js";


test("the Codex preset streams reasoning and answers into the native DSH conversation", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    reasoningEffort: "high",
    sessionId: agent.id,
    messages: [
      { role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "runtime context" }] },
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "actual question" }] },
    ],
  })) chunks.push(chunk);

  assert.equal(runtime.sent[0].message.text, "actual question");
  assert.equal(runtime.sent[0].message.model, "codex-test");
  assert.equal(chunks.find(chunk => chunk.type === "reasoning-delta").text, "Checked the workspace.");
  assert.equal(chunks.find(chunk => chunk.type === "text-delta").text, "done");
  assert.equal(chunks.at(-1).replayState.threadId, "thread-1");
  assert.deepEqual([...adapter.ownedTurnIdsForSession(agent.id)], []);
  assert.deepEqual(agent.appended, []);
  assert.equal(runtime.createdConfig.dynamicTools.some(tool => tool.name === "relay_wait_for_event"), false);
  const codexAppTools = runtime.createdConfig.dynamicTools.find(tool => tool.type === "namespace" && tool.name === "codex_app");
  assert.deepEqual(codexAppTools.tools.map(tool => tool.name), ["load_workspace_dependencies"]);
});

test("Codex reasoning efforts use compact native selector labels", async () => {
  const runtime = new FakeRuntime();
  runtime.models = [{
    id: "codex-test",
    displayName: "Codex Test",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
      { reasoningEffort: "xhigh", description: "Deep reasoning for complex tasks" },
    ],
  }];
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });

  const model = await adapter.resolveModel("relay-codex", "codex-test");
  assert.deepEqual(model.reasoning.efforts, [
    { id: "low", name: "Low" },
    { id: "xhigh", name: "Extra high" },
  ]);
});

test("a Relay activation reaches Codex instead of replaying the previous human message", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  for await (const _chunk of adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "wait for the event" }] },
      { role: "user", source: { kind: "plugin", plugin: "system" }, content: [{ type: "text", text: "generic context" }] },
      {
        role: "user",
        source: { kind: "plugin", plugin: "relay" },
        content: [{ type: "text", text: "[RELAY EXTERNAL EVENT]\nevent_json: {\"marker\":\"ready\"}" }],
      },
    ],
  })) {}

  assert.equal(runtime.sent[0].message.text, "[RELAY EXTERNAL EVENT]\nevent_json: {\"marker\":\"ready\"}");
});

test("user image messages are forwarded as Codex local image inputs", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  for await (const _chunk of adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{
      role: "user",
      source: { kind: "user" },
      content: [
        { type: "text", text: "这个图片是什么？" },
        { type: "image", path: "/tmp/codex-clipboard.png", name: "codex-clipboard.png" },
      ],
    }],
  })) {}

  assert.equal(runtime.sent[0].message.text, "这个图片是什么？");
  assert.deepEqual(runtime.sent[0].message.localImages, [{
    path: "/tmp/codex-clipboard.png",
    fsPath: "/tmp/codex-clipboard.png",
    label: "codex-clipboard.png",
  }]);
});

test("Codex permissions follow effective DSH knobs, not failed preset intent", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  agent.session.events.push(
    { type: "permission/preset", data: { preset: "workspace-write" } },
    { type: "sandbox/mode", data: { mode: "workspace-write" } },
    { type: "approval/policy", data: { policy: "ask" } },
    { type: "permission/preset", data: { preset: "read-only" } },
    {
      type: "command/done",
      data: {
        kind: "error",
        text: 'cannot change sandbox mode from "workspace-write" to "read-only"',
      },
    },
  );
  adapter.attachAgent(agent);

  await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "permission check" }] }],
  }));

  assert.equal(runtime.sent[0].message.sandbox, "workspace-write");
  assert.equal(runtime.sent[0].message.approvalPolicy, "on-request");
});

test("automatic title generation uses an isolated ephemeral Codex thread", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  const [mainChunks, titleChunks] = await Promise.all([
    collect(adapter.stream({
      provider: "relay-codex",
      model: "codex-test",
      sessionId: agent.id,
      messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "list project files" }] }],
    })),
    collect(adapter.stream({
      provider: "relay-codex",
      model: "codex-test",
      sessionId: agent.id,
      purpose: "session-title",
      system: "Generate a concise title.",
      messages: [{
        role: "user",
        source: { kind: "plugin", plugin: "dsh-session-title-llm" },
        content: [{ type: "text", text: "Generate the session title from this JSON array: [\"list project files\"]" }],
      }],
    })),
  ]);

  const mainCall = runtime.sent.find(call => call.message.text === "list project files");
  const titleCall = runtime.sent.find(call => call.message.text.includes("Generate the session title"));
  const auxiliaryConfig = runtime.createdConfigs.find(config => config.ephemeral === true);
  assert.ok(mainCall);
  assert.ok(titleCall);
  assert.notEqual(mainCall.threadId, titleCall.threadId);
  assert.equal(adapter.threadFor(agent.id), mainCall.threadId);
  assert.deepEqual(auxiliaryConfig.dynamicTools, []);
  assert.equal(auxiliaryConfig.sandbox, "read-only");
  assert.equal(auxiliaryConfig.approvalPolicy, "never");
  assert.equal(auxiliaryConfig.threadSource, "relay.codex.auxiliary");
  assert.match(auxiliaryConfig.developerInstructions, /Do not call tools/);
  assert.deepEqual(runtime.released, [titleCall.threadId]);
  assert.equal(mainChunks.find(chunk => chunk.type === "text-delta").text, "done");
  assert.equal(titleChunks.find(chunk => chunk.type === "text-delta").text, "项目文件查询");
  assert.deepEqual(agent.appended, []);
});

test("an unrelated DSH plugin message cannot enter the main Codex thread", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  await assert.rejects(() => collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{
      role: "user",
      source: { kind: "plugin", plugin: "unrelated" },
      content: [{ type: "text", text: "must not become a business turn" }],
    }],
  })), /no user text/);
  assert.equal(runtime.sent.length, 0);
  assert.equal(runtime.created, 0);
});

test("a failed automatic title releases its temporary thread without changing the main link", async () => {
  const runtime = new FakeRuntime();
  runtime.sendMessage = async (threadId, message) => {
    runtime.sent.push({ threadId, message });
    throw new Error("title service unavailable");
  };
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  await assert.rejects(() => collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    purpose: "session-title",
    messages: [{
      role: "user",
      source: { kind: "plugin", plugin: "dsh-session-title-llm" },
      content: [{ type: "text", text: "title input" }],
    }],
  })), /title service unavailable/);
  assert.deepEqual(runtime.released, ["thread-1"]);
  assert.equal(adapter.threadFor(agent.id), null);
  assert.equal(agent.appended.length, 0);
});

test("DSH compaction also runs outside the bound Codex thread", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  const chunks = await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    purpose: "compaction",
    system: "Summarize the supplied conversation.",
    messages: [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "first request" }] },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      {
        role: "user",
        source: { kind: "plugin", plugin: "dsh-compaction-basic" },
        content: [{ type: "text", text: "produce the compact summary" }],
      },
    ],
  }));

  assert.match(runtime.sent[0].message.text, /user: first request/);
  assert.match(runtime.sent[0].message.text, /assistant: first answer/);
  assert.match(runtime.sent[0].message.text, /user: produce the compact summary/);
  assert.equal(runtime.createdConfigs[0].ephemeral, true);
  assert.equal(adapter.threadFor(agent.id), null);
  assert.equal(agent.appended.length, 0);
  assert.equal(chunks.find(chunk => chunk.type === "text-delta").text, "done");
});

test("DSH-to-Codex links and configuration survive host restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-links-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "links.json");
  const firstRuntime = new FakeRuntime();
  const first = new CodexDshAdapter({ runtime: firstRuntime, ready: Promise.resolve(), linkStore: new CodexLinkStore(path) });
  first.configure("dsh-1", { model: "codex-test", effort: "high", sandbox: "read-only" });
  const threadId = await first.ensureThread("dsh-1");

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.sessions["dsh-1"].threadId, threadId);
  const secondRuntime = new FakeRuntime();
  const second = new CodexDshAdapter({ runtime: secondRuntime, ready: Promise.resolve(), linkStore: new CodexLinkStore(path) });
  assert.equal(await second.ensureThread("dsh-1"), threadId);
  assert.equal(second.configuration("dsh-1").sandbox, "read-only");
  assert.equal(secondRuntime.created, 0);
  assert.equal(secondRuntime.resumed, 1);
});

test("imported bindings are one-to-one, durable, and never replace a failed resume", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-import-links-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "links.json");
  const firstRuntime = new FailingResumeRuntime();
  const first = new CodexDshAdapter({
    runtime: firstRuntime,
    ready: Promise.resolve(),
    linkStore: new CodexLinkStore(path),
  });
  const binding = first.bindImportedThread("dsh-import-1", "codex-existing-1", {
    model: "codex-test",
    effort: "medium",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    cwd: "/workspace/relay",
  });

  assert.equal(binding.sessionId, "dsh-import-1");
  assert.equal(binding.threadId, "codex-existing-1");
  assert.equal(binding.importState, "reserved");
  assert.deepEqual(first.bindImportedThread("dsh-import-1", "codex-existing-1", binding.config), binding);
  assert.throws(
    () => first.bindImportedThread("dsh-import-2", "codex-existing-1", binding.config),
    /already bound to DSH session dsh-import-1/,
  );
  assert.throws(
    () => first.bindImportedThread("dsh-import-1", "codex-existing-2", binding.config),
    /already bound to Codex thread codex-existing-1/,
  );
  assert.throws(() => first.markImportState("dsh-import-1", "not-a-state"), /unknown Codex import state/);
  assert.deepEqual(first.markImportState("dsh-import-1", "committed"), {
    ...binding,
    importState: "committed",
  });
  assert.equal(first.markImportState("dsh-import-1", "hydrated").importState, "committed");
  await assert.rejects(first.ensureThread("dsh-import-1"), (error) => {
    assert.equal(error.code, CODEX_THREAD_ACTIVE_WRITER);
    assert.equal(error.retryable, true);
    assert.equal(error.threadId, "codex-existing-1");
    assert.match(error.message, /Switching Sessions may not release this process-level writer/);
    assert.match(error.message, /Fully quit or restart the owning Codex app, CLI, or App Server process/);
    assert.match(error.message, /did not create a replacement/);
    return true;
  });
  assert.equal(firstRuntime.created, 0);
  assert.equal(first.threadFor("dsh-import-1"), "codex-existing-1");

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.sessions["dsh-import-1"].bindingMode, "imported");
  assert.equal(persisted.sessions["dsh-import-1"].importState, "committed");

  const secondRuntime = new FailingResumeRuntime();
  const second = new CodexDshAdapter({
    runtime: secondRuntime,
    ready: Promise.resolve(),
    linkStore: new CodexLinkStore(path),
  });
  await assert.rejects(second.ensureThread("dsh-import-1"), {
    code: CODEX_THREAD_ACTIVE_WRITER,
    retryable: true,
    threadId: "codex-existing-1",
  });
  assert.equal(secondRuntime.created, 0);
  assert.equal(second.bindingForThread("codex-existing-1").importState, "committed");
});

test("an imported active-writer conflict retries the same Thread after owner release", async () => {
  const runtime = new ActiveThenResumeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  adapter.bindImportedThread("dsh-import-retry", "codex-existing-retry", {
    cwd: "/workspace/relay",
  });
  adapter.markImportState("dsh-import-retry", "committed");

  await assert.rejects(adapter.ensureThread("dsh-import-retry"), {
    code: CODEX_THREAD_ACTIVE_WRITER,
    retryable: true,
  });
  assert.equal(await adapter.ensureThread("dsh-import-retry"), "codex-existing-retry");
  assert.equal(runtime.resumed, 2);
  assert.equal(runtime.created, 0);
  assert.equal(adapter.threadFor("dsh-import-retry"), "codex-existing-retry");
});

test("DSH-owned Codex Turn IDs survive adapter restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-owned-turns-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "links.json");
  const first = new CodexDshAdapter({
    runtime: new FakeRuntime(),
    ready: Promise.resolve(),
    linkStore: new CodexLinkStore(path),
  });
  first.bindImportedThread("dsh-owned-turns", "codex-owned-turns", { cwd: "/workspace/relay" });
  first.recordOwnedTurn("dsh-owned-turns", "turn-b");
  first.recordOwnedTurn("dsh-owned-turns", "turn-a");

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(persisted.sessions["dsh-owned-turns"].dshTurnIds, ["turn-a", "turn-b"]);
  const second = new CodexDshAdapter({
    runtime: new FakeRuntime(),
    ready: Promise.resolve(),
    linkStore: new CodexLinkStore(path),
  });
  assert.deepEqual([...second.ownedTurnIdsForSession("dsh-owned-turns")].sort(), ["turn-a", "turn-b"]);
});

test("an imported binding can move to a rebuilt DSH Session", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-rebuilt-links-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "links.json");
  const first = new CodexDshAdapter({
    runtime: new FakeRuntime(),
    ready: Promise.resolve(),
    linkStore: new CodexLinkStore(path),
  });
  first.bindImportedThread("dsh-old", "codex-thread-rebuild", { cwd: "/workspace/relay" });
  first.markImportState("dsh-old", "committed");
  first.recordOwnedTurn("dsh-old", "owned-turn");

  const moved = first.replaceImportedSession("dsh-old", "dsh-new");

  assert.equal(moved.sessionId, "dsh-new");
  assert.equal(moved.threadId, "codex-thread-rebuild");
  assert.equal(moved.importState, "committed");
  assert.equal(first.bindingForSession("dsh-old"), null);
  assert.equal(first.bindingForThread("codex-thread-rebuild").sessionId, "dsh-new");
  assert.deepEqual([...first.ownedTurnIdsForSession("dsh-new")], ["owned-turn"]);

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.sessions["dsh-old"], undefined);
  assert.equal(persisted.sessions["dsh-new"].threadId, "codex-thread-rebuild");
  assert.equal(persisted.sessions["dsh-new"].bindingMode, "imported");
  assert.equal(persisted.sessions["dsh-new"].importState, "committed");

  const second = new CodexDshAdapter({
    runtime: new FakeRuntime(),
    ready: Promise.resolve(),
    linkStore: new CodexLinkStore(path),
  });
  assert.equal(second.bindingForThread("codex-thread-rebuild").sessionId, "dsh-new");
  assert.deepEqual([...second.ownedTurnIdsForSession("dsh-new")], ["owned-turn"]);
});

test("a failed persisted binding replacement leaves the old imported binding intact", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-rebuilt-rollback-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "links.json");
  const linkStore = new CodexLinkStore(path);
  const adapter = new CodexDshAdapter({
    runtime: new FakeRuntime(),
    ready: Promise.resolve(),
    linkStore,
  });
  adapter.bindImportedThread("dsh-old", "codex-thread-rebuild", { cwd: "/workspace/relay" });
  adapter.markImportState("dsh-old", "committed");
  adapter.recordOwnedTurn("dsh-old", "owned-turn");
  linkStore.replace = () => { throw new Error("simulated persistence failure"); };
  linkStore.delete = () => { throw new Error("non-atomic delete attempted"); };

  assert.throws(
    () => adapter.replaceImportedSession("dsh-old", "dsh-new"),
    /simulated persistence failure|non-atomic delete attempted/,
  );
  assert.equal(adapter.bindingForSession("dsh-old").threadId, "codex-thread-rebuild");
  assert.equal(adapter.bindingForSession("dsh-new"), null);
  assert.deepEqual([...adapter.ownedTurnIdsForSession("dsh-old")], ["owned-turn"]);

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.sessions["dsh-old"].threadId, "codex-thread-rebuild");
  assert.equal(persisted.sessions["dsh-new"], undefined);
});

test("an imported Session records Codex Turns started through DSH", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  adapter.bindImportedThread("dsh-import-stream", "codex-import-stream", { cwd: "/workspace/relay" });
  adapter.markImportState("dsh-import-stream", "committed");
  const agent = fakeAgent({ id: "dsh-import-stream" });
  adapter.attachAgent(agent);

  await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "continue" }] },
    ],
  }));

  assert.deepEqual([...adapter.ownedTurnIdsForSession(agent.id)], ["turn-1"]);
});

test("concurrent first messages create one Codex thread", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const [left, right] = await Promise.all([adapter.ensureThread("dsh-1"), adapter.ensureThread("dsh-1")]);
  assert.equal(left, right);
  assert.equal(runtime.created, 1);
});

test("a forked DSH Session branches through App Server and binds the child Thread", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const parentThreadId = await adapter.ensureThread("dsh-fork-parent");
  const child = fakeAgent({ id: "dsh-fork-child" });
  adapter.attachAgent(child);

  const chunks = await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: child.id,
    messages: [
      {
        role: "assistant",
        source: {
          kind: "model",
          provider: "relay-codex",
          model: "codex-test",
          replayState: {
            threadId: parentThreadId,
            turnId: "turn-original",
            itemId: "item-original",
          },
        },
        content: [{ type: "text", text: "parent answer" }],
      },
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "continue in fork" }] },
    ],
  }));

  assert.equal(runtime.created, 1);
  assert.equal(runtime.forked.length, 1);
  assert.equal(runtime.forked[0].threadId, parentThreadId);
  assert.equal(runtime.forked[0].config.lastTurnId, "turn-original");
  assert.equal(runtime.forked[0].config.model, "codex-test");
  assert.ok(Array.isArray(runtime.forked[0].config.dynamicTools));
  assert.equal(adapter.threadFor(child.id), "thread-fork-1");
  assert.equal(runtime.sent.at(-1).threadId, "thread-fork-1");
  assert.equal(adapter.statusForSession(child.id), null);
  assert.equal(chunks.at(-1).reason.kind, "stop");
});

test("an inherited fork without a completed Turn fails closed before App Server fork", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({
    runtime, ready: Promise.resolve(), logger: { error() {}, warn() {} },
  });
  const parentThreadId = await adapter.ensureThread("dsh-fork-parent");

  await assert.rejects(adapter.ensureThread("dsh-fork-child", undefined, {
    threadId: parentThreadId,
    turnId: null,
    itemId: "item-original",
  }), (error) => {
    assert.equal(error.code, "CODEX_REBIND_REQUIRED");
    assert.equal(error.threadId, parentThreadId);
    assert.equal(error.itemId, "item-original");
    assert.match(error.message, /did not create a replacement/);
    return true;
  });

  assert.equal(runtime.forked.length, 0);
  assert.equal(runtime.created, 1);
  assert.equal(adapter.threadFor("dsh-fork-child"), null);
});

test("an inherited Thread without a DSH owner cannot authorize an App Server fork", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({
    runtime, ready: Promise.resolve(), logger: { error() {}, warn() {} },
  });

  await assert.rejects(adapter.ensureThread("dsh-fork-child", undefined, {
    threadId: "thread-from-imported-history",
    turnId: "turn-original",
    itemId: "item-original",
  }), { code: "CODEX_REBIND_REQUIRED" });

  assert.equal(runtime.forked.length, 0);
  assert.equal(runtime.created, 0);
  assert.equal(adapter.threadFor("dsh-fork-child"), null);
});

test("App Server fork failure stays fail-closed and can retry the same provenance", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({
    runtime, ready: Promise.resolve(), logger: { error() {}, warn() {} },
  });
  const parentThreadId = await adapter.ensureThread("dsh-fork-parent");
  const provenance = { threadId: parentThreadId, turnId: "turn-original", itemId: "item-original" };
  runtime.forkError = new Error("lastTurnId is still in progress");

  await assert.rejects(adapter.ensureThread("dsh-fork-child", undefined, provenance), (error) => {
    assert.equal(error.code, "CODEX_REBIND_REQUIRED");
    assert.equal(error.threadId, parentThreadId);
    assert.equal(error.turnId, "turn-original");
    return true;
  });
  assert.equal(adapter.threadFor("dsh-fork-child"), null);
  assert.equal(runtime.created, 1);

  runtime.forkError = null;
  assert.equal(
    await adapter.ensureThread("dsh-fork-child", undefined, provenance),
    "thread-fork-1",
  );
  assert.equal(adapter.statusForSession("dsh-fork-child"), null);
});

test("concurrent first messages create one App Server fork for the child Session", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const parentThreadId = await adapter.ensureThread("dsh-fork-parent");
  const provenance = { threadId: parentThreadId, turnId: "turn-original", itemId: "item-original" };

  const [left, right] = await Promise.all([
    adapter.ensureThread("dsh-fork-child", undefined, provenance),
    adapter.ensureThread("dsh-fork-child", undefined, provenance),
  ]);

  assert.equal(left, right);
  assert.equal(runtime.forked.length, 1);
  assert.equal(runtime.created, 1);
});

test("a missing persisted native Thread requires rebind and never creates a replacement", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-native-rebind-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "links.json");
  const first = new CodexDshAdapter({
    runtime: new FakeRuntime(), ready: Promise.resolve(), linkStore: new CodexLinkStore(path),
  });
  const original = await first.ensureThread("dsh-native");

  const runtime = new MissingResumeRuntime();
  const second = new CodexDshAdapter({
    runtime, ready: Promise.resolve(), linkStore: new CodexLinkStore(path),
  });
  await assert.rejects(second.ensureThread("dsh-native"), {
    code: "CODEX_REBIND_REQUIRED",
    threadId: original,
  });
  assert.equal(runtime.created, 0);
  assert.equal(second.threadFor("dsh-native"), original);
  assert.equal(second.statusForSession("dsh-native").state, "rebind-required");

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.sessions["dsh-native"].threadId, original);
});

test("an existing Codex thread refreshes when the DSH tool surface changes", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);
  const base = {
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "continue" }] }],
  };

  await collect(adapter.stream(base));
  await collect(adapter.stream({ ...base, tools: [{
    name: "late_probe",
    description: "A tool installed after the thread was created.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  }] }));

  assert.equal(runtime.created, 1);
  assert.equal(runtime.resumed, 1);
  assert.deepEqual(runtime.sessions.get("thread-1").dynamicTools.find(tool => tool.name === "dsh").tools.map(tool => tool.name), ["late_probe"]);
});

test("Codex images are imported through the DSH attachment store and cannot escape allowlisted roots", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-images-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const outside = join(directory, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  const imagePath = join(workspace, "result.png");
  const textPath = join(workspace, "secret.txt");
  const outsidePath = join(outside, "outside.png");
  await writeFile(imagePath, "png-bytes");
  await writeFile(textPath, "not-an-image");
  await writeFile(outsidePath, "outside");
  await symlink(outsidePath, join(workspace, "escaped.png"));
  const saved = [];
  const attachments = {
    async saveImage(input) {
      saved.push(input);
      return { attachmentId: "att-1", mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 };
    },
  };

  const ref = await importCodexImage(imagePath, [workspace], attachments);
  assert.equal(ref.attachmentId, "att-1");
  assert.equal(saved[0].mediaType, "image/png");
  await importCodexGeneratedImage({ id: "generated", result: Buffer.from("png-bytes").toString("base64") }, [workspace], attachments);
  assert.equal(saved[1].name, "codex-generated.png");
  await assert.rejects(importCodexImage(textPath, [workspace], attachments), /unsupported Codex image type/);
  await assert.rejects(allowedRealPath(outsidePath, [workspace]), /outside the Codex workspace/);
  await assert.rejects(allowedRealPath(join(workspace, "escaped.png"), [workspace]), /outside the Codex workspace/);
});

test("Codex interactions use DSH approval and question services without Relay Event tools", async () => {
  const agent = fakeAgent();
  const adapterRuntime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime: adapterRuntime, ready: Promise.resolve() });
  adapter.attachAgent(agent);
  assert.equal(await adapter.ensureThread(agent.id), "thread-1");
  const calls = { approvals: [], questions: [] };
  const ctx = {
    agents: { get: id => id === agent.id ? agent : null },
    approval: { async request(input) { calls.approvals.push(input); return "allowed-once"; } },
    userQuestions: {
      async ask(input) {
        calls.questions.push(input);
        return { answers: [{ id: "choice", selected: ["Continue"], custom: "with tests" }] };
      },
    },
  };
  const runtime = new InteractionRuntime();

  await handleCodexServerRequest(ctx, {
    adapter, runtime,
    request: request("wait-1", "item/tool/call", { tool: "relay_wait_for_event", arguments: { event_type: "build.ready", description: "Continue release" } }),
  });
  assert.equal(runtime.dynamic.at(-1).success, false);
  assert.match(runtime.dynamic.at(-1).text, /Unknown Codex app tool relay_wait_for_event/);

  await handleCodexServerRequest(ctx, {
    adapter, runtime,
    request: request("approval-1", "item/commandExecution/requestApproval", {
      itemId: "item-approval", command: "git status",
    }),
  });
  assert.equal(calls.approvals[0].agent, agent);
  assert.equal(runtime.resolved.at(-1).response.action, "accept");

  await handleCodexServerRequest(ctx, {
    adapter, runtime,
    request: request("question-1", "item/tool/requestUserInput", {
      questions: [{ id: "choice", header: "Action", question: "Continue?", options: [{ label: "Continue" }] }],
    }),
  });
  assert.deepEqual(runtime.resolved.at(-1).response.answers, { choice: ["Continue", "with tests"] });
});

test("disconnect/reconnect stale approval replay fails closed when its Session binding changes", async () => {
  const agent = fakeAgent({ id: "dsh-approval-child" });
  const adapterRuntime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime: adapterRuntime, ready: Promise.resolve() });
  adapter.attachAgent(agent);
  assert.equal(await adapter.ensureThread(agent.id), "thread-1");
  let releaseApproval;
  const approvalStarted = Promise.withResolvers();
  const runtime = new InteractionRuntime();
  const pending = handleCodexServerRequest({
    agents: { get: id => id === agent.id ? agent : null },
    approval: {
      request() {
        approvalStarted.resolve();
        return new Promise(resolve => { releaseApproval = resolve; });
      },
    },
    userQuestions: { async ask() { throw new Error("unexpected question"); } },
  }, {
    adapter,
    runtime,
    request: request("approval-stale", "item/commandExecution/requestApproval", {
      turnId: "turn-original",
      itemId: "item-original",
      command: "git status",
    }),
  });

  await approvalStarted.promise;
  // A browser disconnect leaves the Host-side approval pending. Reconnection
  // may replay that same request, but a changed owner/binding makes it stale.
  adapter.detachAgent(agent.id);
  releaseApproval("allowed-once");
  await pending;

  assert.equal(runtime.resolved.length, 0);
  assert.equal(runtime.rejected.length, 1);
  assert.equal(runtime.rejected[0].error.code, "CODEX_STALE_APPROVAL");
  assert.match(runtime.rejected[0].error.message, /thread thread-1/);
  assert.match(runtime.rejected[0].error.message, /turn turn-original/);
  assert.match(runtime.rejected[0].error.message, /item item-original/);
  assert.match(runtime.rejected[0].error.message, /rejected without being sent to Codex/);
});

test("Codex exposes and executes only the generic DSH tools assembled for the turn", async () => {
  const calls = [];
  const runtime = new FakeRuntime();
  const agent = fakeAgent({
    tools: {
      async execute(input) {
        calls.push(input);
        return { isError: false, value: { echoed: input.arguments.value }, content: [{ type: "text", text: `echo:${input.arguments.value}` }] };
      },
    },
  });
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  adapter.attachAgent(agent);

  await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "use the probe" }] }],
    tools: [{
      name: "cross_plugin_probe",
      description: "Probe a separately installed DSH plugin.",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    }],
  }));

  const dshNamespace = runtime.createdConfig.dynamicTools.find(tool => tool.type === "namespace" && tool.name === "dsh");
  assert.deepEqual(dshNamespace.tools, [{
    type: "function",
    name: "cross_plugin_probe",
    description: "Probe a separately installed DSH plugin.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  }]);

  const interactions = new InteractionRuntime();
  await handleCodexServerRequest({
    agents: { get: id => id === agent.id ? agent : null },
    approval: { async request() { throw new Error("unexpected approval"); } },
    userQuestions: { async ask() { throw new Error("unexpected question"); } },
  }, {
    adapter,
    runtime: interactions,
    request: request("probe-1", "item/dynamicTool/call", {
      namespace: "dsh",
      name: "cross_plugin_probe",
      arguments: JSON.stringify({ value: "ok" }),
    }),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, agent);
  assert.deepEqual(calls[0].arguments, { value: "ok" });
  assert.equal(interactions.dynamic.at(-1).success, true);
  assert.equal(interactions.dynamic.at(-1).text, "echo:ok");

  await handleCodexServerRequest({
    agents: { get: id => id === agent.id ? agent : null },
    approval: { async request() { throw new Error("unexpected approval"); } },
    userQuestions: { async ask() { throw new Error("unexpected question"); } },
  }, {
    adapter,
    runtime: interactions,
    request: request("hidden-1", "item/dynamicTool/call", {
      namespace: "dsh",
      name: "not_in_this_turn",
      arguments: "{}",
    }),
  });
  assert.equal(calls.length, 1);
  assert.equal(interactions.dynamic.at(-1).success, false);
  assert.match(interactions.dynamic.at(-1).text, /not available for this DSH turn/);
});

test("Relay exposes only the executable Codex app workspace dependency tool", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-runtime-"));
  const previousRuntimeRoot = process.env.CODEX_PRIMARY_RUNTIME_ROOT;
  process.env.CODEX_PRIMARY_RUNTIME_ROOT = directory;
  context.after(async () => {
    if (previousRuntimeRoot === undefined) delete process.env.CODEX_PRIMARY_RUNTIME_ROOT;
    else process.env.CODEX_PRIMARY_RUNTIME_ROOT = previousRuntimeRoot;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, "runtime.json"), JSON.stringify({ bundleVersion: "99.test" }));

  const codexAppNamespace = CODEX_APP_DYNAMIC_TOOLS.find(tool => tool.type === "namespace" && tool.name === "codex_app");
  assert.deepEqual(codexAppNamespace.tools.map(tool => tool.name), ["load_workspace_dependencies"]);

  const agent = fakeAgent();
  const adapter = { dshSessionForThread: threadId => threadId === "thread-1" ? agent.id : null };
  const ctx = {
    agents: { get: id => id === agent.id ? agent : null },
    approval: { async request() { throw new Error("unexpected approval"); } },
    userQuestions: { async ask() { throw new Error("unexpected question"); } },
  };
  const runtime = new InteractionRuntime();

  await handleCodexServerRequest(ctx, {
    adapter,
    runtime,
    request: request("deps-1", "item/dynamicTool/call", {
      namespace: "codex_app",
      name: "load_workspace_dependencies",
      arguments: "{}",
    }),
  });
  assert.equal(runtime.dynamic.at(-1).success, true);
  assert.match(runtime.dynamic.at(-1).text, /Bundle version: `99\.test`/);
  assert.match(runtime.dynamic.at(-1).text, /Node\.js executable: `.*dependencies\/node\/bin\/node`/);
  assert.match(runtime.dynamic.at(-1).text, /Python executable: `.*dependencies\/python\/bin\/python3`/);

  await handleCodexServerRequest(ctx, {
    adapter,
    runtime,
    request: request("terminal-1", "item/dynamicTool/call", {
      namespace: "codex_app",
      name: "read_thread_terminal",
      arguments: "{}",
    }),
  });
  assert.equal(runtime.dynamic.at(-1).success, false);
  assert.match(runtime.dynamic.at(-1).text, /Unsupported Codex app tool read_thread_terminal/);
});

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.models = [{
      id: "codex-test", displayName: "Codex Test", isDefault: true, defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    }];
    this.sessions = new Map();
    this.sent = [];
    this.created = 0;
    this.resumed = 0;
    this.createdConfigs = [];
    this.forked = [];
    this.forkSequence = 0;
    this.forkError = null;
    this.released = [];
  }

  async createSession(config) {
    await new Promise(resolve => setTimeout(resolve, 2));
    this.createdConfig = config;
    this.createdConfigs.push(structuredClone(config));
    const session = { id: `thread-${++this.created}`, turns: [], ...config };
    this.sessions.set(session.id, session);
    return session;
  }

  async resumeSession(threadId, config) {
    this.resumed += 1;
    this.sessions.set(threadId, { id: threadId, turns: [], ...config });
    return this.sessions.get(threadId);
  }

  async forkSession(threadId, config) {
    if (this.forkError) throw this.forkError;
    this.forked.push({ threadId, config: structuredClone(config) });
    const session = { id: `thread-fork-${++this.forkSequence}`, turns: [], ...config };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendMessage(threadId, message) {
    this.sent.push({ threadId, message });
    const turnId = "turn-1";
    const answerText = message.text.includes("Generate the session title") ? "项目文件查询" : "done";
    queueMicrotask(() => {
      this.emit("activity", notification("item/started", threadId, turnId, {
        item: { type: "reasoning", id: "reason-1", summary: [], content: [] },
      }));
      this.emit("activity", notification("item/reasoning/summaryTextDelta", threadId, turnId, {
        itemId: "reason-1", summaryIndex: 0, delta: "Checked the workspace.",
      }));
      this.emit("activity", notification("item/completed", threadId, turnId, {
        item: { type: "reasoning", id: "reason-1", summary: ["Checked the workspace."], content: [] },
      }));
      this.emit("activity", notification("item/started", threadId, turnId, {
        item: { type: "commandExecution", id: "command-1", command: "pwd", status: "inProgress" },
      }));
      this.emit("activity", notification("item/completed", threadId, turnId, {
        item: { type: "commandExecution", id: "command-1", command: "pwd", status: "completed", aggregatedOutput: "ok\n" },
      }));
      this.emit("activity", notification("item/agentMessage/delta", threadId, turnId, { itemId: "answer-1", delta: answerText }));
      this.emit("activity", notification("item/completed", threadId, turnId, {
        item: { type: "agentMessage", id: "answer-1", text: answerText, phase: "final_answer" },
      }));
      this.emit("activity", { method: "turn/completed", params: {
        threadId, turn: { id: turnId, status: "completed", error: null, items: [] },
      } });
    });
    return { id: turnId, status: "inProgress", items: [] };
  }

  async interruptTurn() {}

  async releaseSession(threadId) {
    this.released.push(threadId);
    this.sessions.delete(threadId);
  }
}

class FailingResumeRuntime extends FakeRuntime {
  async resumeSession() {
    this.resumed += 1;
    throw new Error("thread already has an active writer");
  }
}

class MissingResumeRuntime extends FakeRuntime {
  async resumeSession() {
    this.resumed += 1;
    throw new Error("thread not found");
  }
}

class ActiveThenResumeRuntime extends FakeRuntime {
  async resumeSession(threadId, config) {
    if (this.resumed++ === 0) throw new Error("thread already has an active writer");
    this.sessions.set(threadId, { id: threadId, turns: [], ...config });
    return this.sessions.get(threadId);
  }
}

class InteractionRuntime {
  constructor() { this.dynamic = []; this.resolved = []; this.rejected = []; }
  respondDynamicTool(id, success, text) { this.dynamic.push({ id, success, text }); }
  async resolveRequest(id, response) { this.resolved.push({ id, response }); }
  rejectRequest(id, error) { this.rejected.push({ id, error }); }
}

function fakeAgent({ id = "dsh-1", tools = null } = {}) {
  const appended = [];
  return {
    id,
    appended,
    ctx: tools ? { tools } : {},
    session: {
      header: { agentPreset: "relay-codex", cwd: "/workspace/relay" },
      events: [],
      append(type, data) { appended.push({ type, data }); },
    },
  };
}

function notification(method, threadId, turnId, rest) {
  return { method, params: { threadId, turnId, ...rest } };
}

function request(id, method, params) {
  return { id, method, params: { threadId: "thread-1", turnId: "turn-1", ...params } };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
