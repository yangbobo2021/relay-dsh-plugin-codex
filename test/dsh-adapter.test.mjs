import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BlockAssembler, createMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";

import {
  CODEX_THREAD_ACTIVE_WRITER,
  CodexDshAdapter,
} from "../codex-adapter.js";
import {
  allowedRealPath,
  detectImageMediaType,
  importCodexGeneratedImage,
  importCodexImage,
} from "../codex-image.js";
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
  assert.equal(runtime.sent[0].message.reasoningSummary, "auto");
  assert.equal(chunks.find(chunk => chunk.type === "reasoning-delta").text, "Checked the workspace.");
  assert.ok(chunks.some(chunk => chunk.type === "text-delta" && chunk.text === "ok\n"));
  assert.ok(chunks.some(chunk => chunk.type === "text-delta" && chunk.text === "done"));
  assert.equal(chunks.at(-1).replayState.threadId, "thread-1");
  assert.deepEqual([...adapter.ownedTurnIdsForSession(agent.id)], []);
  assert.deepEqual(agent.appended, []);
  assert.equal(runtime.createdConfig.dynamicTools.some(tool => tool.name === "relay_wait_for_event"), false);
  const codexAppTools = runtime.createdConfig.dynamicTools.find(tool => tool.type === "namespace" && tool.name === "codex_app");
  assert.deepEqual(codexAppTools.tools.map(tool => tool.name), ["load_workspace_dependencies"]);
});

test("an empty App Server reasoning item creates no empty DSH disclosure", async () => {
  const runtime = new EmptyReasoningRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  const chunks = await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    reasoningEffort: "high",
    sessionId: agent.id,
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "answer only" }] }],
  }));

  assert.equal(chunks.some(chunk => chunk.blockType === "reasoning" || chunk.block?.type === "reasoning"), false);
  assert.equal(chunks.filter(chunk => chunk.type === "text-delta").map(chunk => chunk.text).join(""), "done");
  assert.equal(chunks.at(-1).reason.kind, "stop");
});

test("command output streams before completion and settles without duplication", async () => {
  const runtime = new StreamingCommandRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);
  const iterator = adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "run the delayed marker command" }],
    }],
  })[Symbol.asyncIterator]();

  const chunks = [];
  let firstMarker = null;
  while (!firstMarker) {
    const next = await iterator.next();
    assert.equal(next.done, false, "stream ended before the first command marker");
    chunks.push(next.value);
    if (next.value.type === "text-delta" && next.value.text.includes("STREAM_FIRST_4102")) {
      firstMarker = next.value;
    }
  }
  assert.equal(runtime.commandCompleted, false, "first marker was delayed until command completion");

  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    chunks.push(next.value);
  }

  const commandBlock = chunks.find(chunk =>
    chunk.type === "block-end"
      && chunk.block?.type === "text"
      && chunk.block.text.includes("STREAM_FIRST_4102"));
  assert.equal(commandBlock.block.text, "STREAM_FIRST_4102\nREPEATED_LINE\nREPEATED_LINE\nSTREAM_LAST_8604\n");
  assert.equal(commandBlock.block.text.match(/STREAM_FIRST_4102/g)?.length, 1);
  assert.equal(commandBlock.block.text.match(/STREAM_LAST_8604/g)?.length, 1);
  assert.equal(commandBlock.block.text.match(/REPEATED_LINE/g)?.length, 2);
  assert.equal(chunks.filter(chunk => chunk.type === "text-delta" && chunk.text === "done").length, 1);
  assert.equal(chunks.some(chunk => chunk.blockType === "tool-call" || chunk.block?.type === "tool-call"), false);
  assert.equal(chunks.filter(chunk => chunk.type === "finish").length, 1);
  assert.equal(chunks.at(-1).reason.kind, "stop");

  const assembler = new BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  assert.deepEqual(assembler.message().content, [
    { type: "text", text: "STREAM_FIRST_4102\nREPEATED_LINE\nREPEATED_LINE\nSTREAM_LAST_8604\n" },
    { type: "text", text: "done" },
  ]);

  const persisted = Session.create(SessionId("command-output-persistence"));
  persisted.append("turn/start", { turn: 1 });
  persisted.append("assistant/message", {
    turn: 1,
    step: 1,
    message: createMessage({
      role: "assistant",
      content: assembler.message().content,
      source: { kind: "model", provider: "relay-codex", model: "codex-test" },
    }),
  }, { surfaceOp: "append" });
  persisted.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  const stored = JSON.parse(JSON.stringify({ header: persisted.header, events: persisted.events }));
  const reloaded = Session.fromRestore(SessionId("command-output-persistence"), stored.events, stored.header);
  assert.deepEqual(reloaded.deriveMessages()[0].content, assembler.message().content);
});

test("command completion backfills output, reconciles snapshots, and ignores empty or late data", async () => {
  const runtime = new CommandCompletionRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  const chunks = await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "exercise command completion edges" }],
    }],
  }));

  const assembler = new BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  assert.deepEqual(assembler.message().content, [
    { type: "text", text: "COMPLETION_ONLY\n" },
    { type: "text", text: "CROSS_SOURCE_SAME\n" },
    { type: "text", text: "AUTHORITATIVE_FINAL\n" },
    { type: "text", text: "done" },
  ]);
  assert.equal(JSON.stringify(assembler.message()).match(/CROSS_SOURCE_SAME/g)?.length, 1);
  assert.equal(chunks.some(chunk => JSON.stringify(chunk).includes("LATE_DELTA")), false);
  assert.equal(chunks.filter(chunk => chunk.type === "block-start").length, 4);
});

test("an unconfirmed command cleanup is surfaced instead of reporting a successful stop", async () => {
  const runtime = new HangingInterruptRuntime(new Error("background terminal remains"));
  const errors = [];
  const adapter = new CodexDshAdapter({
    runtime,
    ready: Promise.resolve(),
    logger: { error(message, details) { errors.push({ message, details }); } },
  });
  const agent = fakeAgent();
  adapter.attachAgent(agent);
  const controller = new AbortController();
  const output = collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    signal: controller.signal,
    messages: [{
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "run a long command" }],
    }],
  }));
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();

  const chunks = await output;

  assert.deepEqual(runtime.interruptions, [{ threadId: "thread-1", turnId: "turn-hanging" }]);
  assert.equal(chunks.at(-1).reason.kind, "error");
  assert.equal(chunks.at(-1).reason.failure.code, "CODEX_TURN_INTERRUPT_CLEANUP_FAILED");
  assert.match(chunks.at(-1).reason.failure.message, /late side effects/i);
  assert.deepEqual(errors, [{
    message: "Codex interrupted work could not be confirmed terminated",
    details: {
      threadId: "thread-1",
      turnId: "turn-hanging",
      code: "CODEX_TURN_INTERRUPT_CLEANUP_FAILED",
    },
  }]);
});

test("a confirmed command cleanup preserves the standard aborted Turn result", async () => {
  const runtime = new HangingInterruptRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);
  const controller = new AbortController();
  const output = collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    signal: controller.signal,
    messages: [{
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "run a long command" }],
    }],
  }));
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();

  const chunks = await output;

  assert.deepEqual(runtime.interruptions, [{ threadId: "thread-1", turnId: "turn-hanging" }]);
  assert.equal(chunks.at(-1).reason.kind, "aborted");
  assert.equal(chunks.at(-1).reason.failure.code, "ABORTED");
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

test("DSH attachment images are read, materialized, and forwarded in order", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-dsh-input-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(directory, "codex-home");
  context.after(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(directory, { recursive: true, force: true });
  });
  const first = pngFixture("first-image");
  const second = pngFixture("second-image");
  const stored = new Map([
    ["first", first],
    ["second", second],
  ]);
  const reads = [];
  const attachments = {
    async readImage(ref, signal) {
      signal?.throwIfAborted();
      reads.push(ref.attachmentId);
      return { ref, data: Uint8Array.from(stored.get(ref.attachmentId)) };
    },
  };
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve(), attachments });
  const agent = fakeAgent({ cwd: workspace });
  adapter.attachAgent(agent);

  await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{
      role: "user",
      source: { kind: "user" },
      content: [
        { type: "image", attachment: { attachmentId: "first", mediaType: "image/png", name: "clipboard.png" } },
        { type: "image", attachment: { attachmentId: "second", mediaType: "image/png", name: "clipboard.png" } },
        { type: "text", text: "read both markers" },
      ],
    }],
  }));

  assert.deepEqual(reads, ["first", "second"]);
  assert.equal(runtime.sent[0].message.text, "read both markers");
  assert.deepEqual(runtime.sent[0].message.localImages.map(image => image.label), ["clipboard.png", "clipboard.png"]);
  assert.deepEqual(await readFile(runtime.sent[0].message.localImages[0].path), first);
  assert.deepEqual(await readFile(runtime.sent[0].message.localImages[1].path), second);
  assert.notEqual(runtime.sent[0].message.localImages[0].path, runtime.sent[0].message.localImages[1].path);
  assert.deepEqual(await readdir(workspace), []);
});

test("invalid DSH image attachments fail before Codex Thread creation", async (t) => {
  const scenarios = [
    { name: "missing reference", block: { type: "image" }, attachments: { async readImage() {} }, code: "CODEX_IMAGE_INPUT_INVALID" },
    { name: "service unavailable", attachments: null, code: "CODEX_IMAGE_ATTACHMENTS_UNAVAILABLE" },
    { name: "read failure", attachments: { async readImage() { throw new Error("corrupt"); } }, code: "CODEX_IMAGE_READ_FAILED" },
    { name: "invalid bytes", attachments: { async readImage(ref) { return { ref, data: Uint8Array.from([1, 2, 3]) }; } }, code: "CODEX_IMAGE_TYPE_UNSUPPORTED" },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const runtime = new FakeRuntime();
      const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve(), attachments: scenario.attachments });
      const agent = fakeAgent();
      adapter.attachAgent(agent);
      await assert.rejects(collect(adapter.stream({
        provider: "relay-codex",
        model: "codex-test",
        sessionId: agent.id,
        messages: [{ role: "user", source: { kind: "user" }, content: [
          scenario.block ?? { type: "image", attachment: { attachmentId: "broken", mediaType: "image/png" } },
          { type: "text", text: "describe image" },
        ] }],
      })), error => error.code === scenario.code);
      assert.equal(runtime.created, 0);
      assert.equal(runtime.sent.length, 0);
    });
  }
});

test("a pure DSH image message starts one Codex image Turn", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-pure-image-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  context.after(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(directory, { recursive: true, force: true });
  });
  const data = pngFixture("pure-image");
  const runtime = new FakeRuntime();
  const adapter = new CodexDshAdapter({
    runtime,
    ready: Promise.resolve(),
    attachments: { async readImage(ref) { return { ref, data: Uint8Array.from(data) }; } },
  });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{ role: "user", source: { kind: "user" }, content: [
      { type: "image", attachment: { attachmentId: "only-image", mediaType: "image/png" } },
    ] }],
  }));

  assert.equal(runtime.sent.length, 1);
  assert.equal(runtime.sent[0].message.text, "");
  assert.equal(runtime.sent[0].message.localImages.length, 1);
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
  assert.equal(mainCall.message.reasoningSummary, "auto");
  assert.equal(titleCall.message.reasoningSummary, "none");
  assert.deepEqual(runtime.released, [titleCall.threadId]);
  assert.ok(mainChunks.some(chunk => chunk.type === "text-delta" && chunk.text === "done"));
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
  assert.equal(runtime.sent[0].message.reasoningSummary, "none");
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
  const jpeg = await readFile(new URL("../docs/images/dsh-new-session-backends.jpg", import.meta.url));
  await writeFile(imagePath, jpeg);
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
  assert.equal(saved[0].mediaType, "image/jpeg");
  assert.equal(saved[0].name, "result.png");
  assert.equal(detectImageMediaType(saved[0].data), "image/jpeg");
  await importCodexGeneratedImage({
    id: "generated",
    result: `data:image/png;base64,${jpeg.toString("base64")}`,
  }, [workspace], attachments);
  assert.equal(saved[1].mediaType, "image/jpeg");
  assert.equal(saved[1].name, "codex-generated.jpg");
  await assert.rejects(importCodexImage(textPath, [workspace], attachments), /unsupported or malformed Codex image data/);
  await assert.rejects(allowedRealPath(outsidePath, [workspace]), /outside the Codex workspace/);
  await assert.rejects(allowedRealPath(join(workspace, "escaped.png"), [workspace]), /outside the Codex workspace/);
});

test("Codex image media types are derived from supported byte signatures", () => {
  const samples = [
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    [Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"],
    [Buffer.from("GIF89a", "ascii"), "image/gif"],
    [Buffer.from("RIFF0000WEBP", "ascii"), "image/webp"],
    [Buffer.from("not-an-image", "ascii"), null],
  ];

  for (const [data, expected] of samples) assert.equal(detectImageMediaType(data), expected);
});

test("the original JPEG-as-.png Session history replays without failing the DSH turn", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-history-image-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, "completed-clean.png");
  const jpeg = await readFile(new URL("../docs/images/dsh-new-session-backends.jpg", import.meta.url));
  await writeFile(imagePath, jpeg);

  assert.equal(imagePath.endsWith(".png"), true);
  assert.equal(detectImageMediaType(jpeg), "image/jpeg");

  const runtime = new ImageHistoryRuntime(imagePath);
  const warnings = [];
  const adapter = new CodexDshAdapter({
    runtime,
    ready: Promise.resolve(),
    logger: { warn(message, details) { warnings.push({ message, details }); } },
    attachments: {
      async saveImage(input) {
        assert.equal(input.mediaType, "image/jpeg");
        return {
          attachmentId: "sha256:history-image",
          mediaType: input.mediaType,
          bytes: input.data.length,
          width: 1,
          height: 1,
          name: input.name,
        };
      },
    },
  });
  const agent = fakeAgent({ id: "session-6f78fa6a-bc1d-4be9-b15b-264d5f743c05" });
  agent.session.header.cwd = directory;
  adapter.attachAgent(agent);

  const chunks = await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "continue" }] }],
  }));

  assert.equal(chunks.find(chunk => chunk.block?.type === "image")?.block.attachment.mediaType, "image/jpeg");
  assert.equal(chunks.find(chunk => chunk.block?.type === "text")?.block.text, "done after image");
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.deepEqual(warnings, []);
});

test("an invalid Codex image becomes a placeholder without failing the DSH turn", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-invalid-image-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, "broken.png");
  await writeFile(imagePath, "not an image");

  const warnings = [];
  const runtime = new ImageHistoryRuntime(imagePath);
  const adapter = new CodexDshAdapter({
    runtime,
    ready: Promise.resolve(),
    logger: { warn(message, details) { warnings.push({ message, details }); } },
    attachments: { async saveImage() { throw new Error("invalid image reached attachment storage"); } },
  });
  const agent = fakeAgent();
  agent.session.header.cwd = directory;
  adapter.attachAgent(agent);

  const chunks = await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "continue" }] }],
  }));

  assert.match(chunks.find(chunk => chunk.block?.text?.startsWith("Image preview unavailable"))?.block.text ?? "", /broken\.png/);
  assert.equal(chunks.find(chunk => chunk.block?.text === "done after image")?.block.text, "done after image");
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].details.itemId, "image-history-1");
  assert.equal(warnings[0].details.reason, "IMAGE_DATA_INVALID");
  assert.equal("error" in warnings[0].details, false);
});

test("a DSH image storage rejection is sanitized and does not fail the turn", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-rejected-image-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, "rejected.png");
  const jpeg = await readFile(new URL("../docs/images/dsh-new-session-backends.jpg", import.meta.url));
  await writeFile(imagePath, jpeg);

  const warnings = [];
  const runtime = new ImageHistoryRuntime(imagePath);
  const adapter = new CodexDshAdapter({
    runtime,
    ready: Promise.resolve(),
    logger: { warn(message, details) { warnings.push({ message, details }); } },
    attachments: { async saveImage() { throw new Error("decode failed at /private/customer/path"); } },
  });
  const agent = fakeAgent();
  agent.session.header.cwd = directory;
  adapter.attachAgent(agent);

  const chunks = await collect(adapter.stream({
    provider: "relay-codex",
    model: "codex-test",
    sessionId: agent.id,
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "continue" }] }],
  }));

  const serialized = JSON.stringify({ chunks, warnings });
  assert.equal(serialized.includes("/private/customer/path"), false);
  assert.match(chunks.find(chunk => chunk.block?.text?.startsWith("Image preview unavailable"))?.block.text ?? "", /rejected\.png/);
  assert.equal(chunks.find(chunk => chunk.block?.text === "done after image")?.block.text, "done after image");
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal(warnings[0].details.reason, "IMAGE_ATTACHMENT_REJECTED");
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

test("modern and legacy approval identities share the same fail-closed ownership boundary", async () => {
  const agent = fakeAgent();
  const adapterRuntime = new FakeRuntime();
  const adapter = new CodexDshAdapter({ runtime: adapterRuntime, ready: Promise.resolve() });
  adapter.attachAgent(agent);
  assert.equal(await adapter.ensureThread(agent.id), "thread-1");

  for (const [index, outcome] of ["rejected", "cancelled", "unavailable"].entries()) {
    const runtime = new InteractionRuntime();
    await handleCodexServerRequest({
      agents: { get: id => id === agent.id ? agent : null },
      approval: { async request() { return outcome; } },
      userQuestions: { async ask() { throw new Error("unexpected question"); } },
    }, {
      adapter,
      runtime,
      request: request(`decline-${index}`, "item/commandExecution/requestApproval", {
        turnId: `turn-${index}`,
        itemId: `item-${index}`,
        command: "git status",
      }),
    });
    assert.deepEqual(runtime.resolved, [{
      id: `decline-${index}`,
      response: { action: "decline" },
    }]);
    assert.equal(runtime.rejected.length, 0);
  }

  const legacyRuntime = new InteractionRuntime();
  await handleCodexServerRequest({
    agents: { get: id => id === agent.id ? agent : null },
    approval: { async request() { return "allowed-once"; } },
    userQuestions: { async ask() { throw new Error("unexpected question"); } },
  }, {
    adapter,
    runtime: legacyRuntime,
    request: {
      id: "legacy-approval",
      method: "execCommandApproval",
      params: {
        conversationId: "thread-1",
        callId: "legacy-call",
        command: ["git", "status"],
      },
    },
  });
  assert.deepEqual(legacyRuntime.resolved, [{
    id: "legacy-approval",
    response: { action: "accept" },
  }]);

  const missingOwnerRuntime = new InteractionRuntime();
  let approvalCalls = 0;
  await handleCodexServerRequest({
    agents: { get() { return null; } },
    approval: { async request() { approvalCalls += 1; return "allowed-once"; } },
    userQuestions: { async ask() { throw new Error("unexpected question"); } },
  }, {
    adapter,
    runtime: missingOwnerRuntime,
    request: request("unowned-approval", "item/commandExecution/requestApproval", {
      threadId: "unowned-thread",
      turnId: "unowned-turn",
      itemId: "unowned-item",
      command: "git status",
    }),
  });
  assert.equal(approvalCalls, 0);
  assert.equal(missingOwnerRuntime.resolved.length, 0);
  assert.match(missingOwnerRuntime.rejected[0].error.message, /no owning live DSH Session/);
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
      this.emit("activity", notification("item/reasoning/summaryPartAdded", threadId, turnId, {
        itemId: "reason-1", summaryIndex: 0,
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

class EmptyReasoningRuntime extends FakeRuntime {
  async sendMessage(threadId, message) {
    this.sent.push({ threadId, message });
    const turnId = "turn-empty-reasoning";
    queueMicrotask(() => {
      this.emit("activity", notification("item/started", threadId, turnId, {
        item: { type: "reasoning", id: "reason-empty", summary: [], content: [] },
      }));
      this.emit("activity", notification("item/completed", threadId, turnId, {
        item: { type: "reasoning", id: "reason-empty", summary: [], content: [] },
      }));
      this.emit("activity", notification("item/agentMessage/delta", threadId, turnId, {
        itemId: "answer-empty-reasoning", delta: "done",
      }));
      this.emit("activity", notification("item/completed", threadId, turnId, {
        item: { type: "agentMessage", id: "answer-empty-reasoning", text: "done", phase: "final_answer" },
      }));
      this.emit("activity", { method: "turn/completed", params: {
        threadId,
        turn: { id: turnId, status: "completed", error: null, items: [] },
      } });
    });
    return { id: turnId, status: "inProgress", items: [] };
  }
}

class StreamingCommandRuntime extends FakeRuntime {
  constructor() {
    super();
    this.commandCompleted = false;
  }

  async sendMessage(threadId, message) {
    this.sent.push({ threadId, message });
    const turnId = "turn-streaming-command";
    queueMicrotask(() => {
      this.emit("activity", notification("item/started", threadId, turnId, {
        item: {
          type: "commandExecution",
          id: "command-streaming",
          processId: "4102",
          command: "printf first; sleep; printf last",
          status: "inProgress",
        },
      }));
      this.emit("activity", notification("item/codeModeShell/outputDelta", threadId, turnId, {
        processId: "4102",
        delta: "STREAM_FIRST_4102\n",
      }));
      this.emit("activity", notification("item/commandExecution/outputDelta", threadId, turnId, {
        itemId: "command-streaming",
        delta: "REPEATED_LINE\n",
      }));
      this.emit("activity", notification("item/commandExecution/outputDelta", threadId, turnId, {
        itemId: "command-streaming",
        delta: "REPEATED_LINE\n",
      }));
      setTimeout(() => {
        this.emit("activity", notification("item/commandExecution/outputDelta", threadId, turnId, {
          itemId: "command-streaming",
          delta: "STREAM_LAST_8604\n",
        }));
        this.commandCompleted = true;
        const command = {
          type: "commandExecution",
          id: "command-streaming",
          processId: "4102",
          command: "printf first; sleep; printf last",
          status: "completed",
          exitCode: 0,
          aggregatedOutput: "STREAM_LAST_8604\n",
        };
        this.emit("activity", notification("item/completed", threadId, turnId, { item: command }));
        this.emit("activity", notification("item/agentMessage/delta", threadId, turnId, {
          itemId: "answer-streaming-command",
          delta: "done",
        }));
        const answer = {
          type: "agentMessage",
          id: "answer-streaming-command",
          text: "done",
          phase: "final_answer",
        };
        this.emit("activity", notification("item/completed", threadId, turnId, { item: answer }));
        this.emit("activity", {
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, status: "completed", error: null, items: [command, answer] },
          },
        });
      }, 30);
    });
    return { id: turnId, status: "inProgress", items: [] };
  }
}

class CommandCompletionRuntime extends FakeRuntime {
  async sendMessage(threadId, message) {
    this.sent.push({ threadId, message });
    const turnId = "turn-command-completion";
    queueMicrotask(() => {
      const completionOnly = {
        type: "commandExecution",
        id: "command-completion-only",
        command: "printf completion-only",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "COMPLETION_ONLY\n",
      };
      this.emit("activity", notification("item/completed", threadId, turnId, { item: completionOnly }));

      const empty = {
        type: "commandExecution",
        id: "command-empty",
        command: "true",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "",
      };
      this.emit("activity", notification("item/completed", threadId, turnId, { item: empty }));

      this.emit("activity", notification("item/started", threadId, turnId, {
        item: {
          type: "commandExecution",
          id: "command-cross-source-duplicate",
          processId: "duplicate-process",
          command: "printf same",
          status: "inProgress",
        },
      }));
      this.emit("activity", notification("item/codeModeShell/outputDelta", threadId, turnId, {
        processId: "duplicate-process",
        delta: "CROSS_SOURCE_SAME\n",
      }));
      this.emit("activity", notification("item/commandExecution/outputDelta", threadId, turnId, {
        itemId: "command-cross-source-duplicate",
        delta: "CROSS_SOURCE_SAME\n",
      }));
      const duplicate = {
        type: "commandExecution",
        id: "command-cross-source-duplicate",
        processId: "duplicate-process",
        command: "printf same",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "CROSS_SOURCE_SAME\n",
      };
      this.emit("activity", notification("item/completed", threadId, turnId, { item: duplicate }));

      this.emit("activity", notification("item/commandExecution/outputDelta", threadId, turnId, {
        itemId: "command-reconciled",
        delta: "STALE_PARTIAL",
      }));
      const reconciled = {
        type: "commandExecution",
        id: "command-reconciled",
        command: "replace output",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "AUTHORITATIVE_FINAL\n",
      };
      this.emit("activity", notification("item/completed", threadId, turnId, { item: reconciled }));
      this.emit("activity", notification("item/commandExecution/outputDelta", threadId, turnId, {
        itemId: "command-reconciled",
        delta: "LATE_DELTA",
      }));

      const answer = {
        type: "agentMessage",
        id: "answer-command-completion",
        text: "done",
        phase: "final_answer",
      };
      this.emit("activity", notification("item/completed", threadId, turnId, { item: answer }));
      this.emit("activity", {
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: "completed",
            error: null,
            items: [completionOnly, empty, duplicate, reconciled, answer],
          },
        },
      });
    });
    return { id: turnId, status: "inProgress", items: [] };
  }
}

class ImageHistoryRuntime extends FakeRuntime {
  constructor(imagePath) {
    super();
    this.imagePath = imagePath;
  }

  async sendMessage(threadId, message) {
    this.sent.push({ threadId, message });
    const turnId = "turn-history-1";
    queueMicrotask(() => {
      this.emit("activity", notification("item/completed", threadId, turnId, {
        item: { type: "imageView", id: "image-history-1", path: this.imagePath },
      }));
      this.emit("activity", notification("item/completed", threadId, turnId, {
        item: { type: "agentMessage", id: "answer-history-1", text: "done after image", phase: "final_answer" },
      }));
      this.emit("activity", { method: "turn/completed", params: {
        threadId,
        turn: { id: turnId, status: "completed", error: null, items: [] },
      } });
    });
    return { id: turnId, status: "inProgress", items: [] };
  }
}

class HangingInterruptRuntime extends FakeRuntime {
  constructor(interruptError = null) {
    super();
    this.interruptError = interruptError;
    this.interruptions = [];
  }

  async sendMessage(threadId, message) {
    this.sent.push({ threadId, message });
    return { id: "turn-hanging", status: "inProgress", items: [] };
  }

  async interruptTurn(threadId, turnId) {
    this.interruptions.push({ threadId, turnId });
    if (this.interruptError) {
      this.interruptError.code = "CODEX_TURN_INTERRUPT_CLEANUP_FAILED";
      throw this.interruptError;
    }
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

function fakeAgent({ id = "dsh-1", tools = null, cwd = "/workspace/relay" } = {}) {
  const appended = [];
  return {
    id,
    appended,
    ctx: tools ? { tools } : {},
    session: {
      header: { agentPreset: "relay-codex", cwd },
      events: [],
      append(type, data) { appended.push({ type, data }); },
    },
  };
}

function notification(method, threadId, turnId, rest) {
  return { method, params: { threadId, turnId, ...rest } };
}

function pngFixture(label) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(label),
  ]);
}

function request(id, method, params) {
  return { id, method, params: { threadId: "thread-1", turnId: "turn-1", ...params } };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
