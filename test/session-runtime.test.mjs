import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexSessionRuntime } from "../session-runtime.mjs";

test("Codex threads keep their context across turns, switching, and resume", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();

  const tools = [{ type: "function", name: "relay_wait", description: "wait", inputSchema: {} }];
  const first = await runtime.createSession({ model: "codex-test", effort: "medium", dynamicTools: tools });
  await runtime.sendMessage(first.id, { text: "first turn" });
  await runtime.sendMessage(first.id, { text: "second turn" });
  const second = await runtime.createSession({ dynamicTools: tools });
  await runtime.sendMessage(second.id, { text: "other thread" });
  await runtime.resumeSession(first.id, { dynamicTools: tools });
  await runtime.sendMessage(first.id, { text: "third turn" });
  await tick();

  assert.equal(runtime.snapshot().selectedSessionId, first.id);
  assert.equal(runtime.getSession(first.id).turns.length, 3);
  assert.equal(runtime.getSession(second.id).turns.length, 1);
  const firstStart = client.requests.find(request => request.method === "thread/start");
  assert.deepEqual(firstStart.params.dynamicTools, tools);
  assert.equal(firstStart.params.permissions, ":workspace");
  assert.deepEqual(firstStart.params.runtimeWorkspaceRoots, ["/workspace/relay"]);
  assert.deepEqual(firstStart.params.config, { "features.realtime_conversation": false });
  assert.equal(firstStart.params.personality, "friendly");
  assert.equal(firstStart.params.experimentalRawEvents, true);
  assert.equal(Object.hasOwn(firstStart.params, "serviceTier"), false);
  const firstResume = client.requests.find(request => request.method === "thread/resume");
  assert.deepEqual(firstResume.params.dynamicTools, tools);
  assert.equal(firstResume.params.config, undefined);
  assert.equal(Object.hasOwn(firstResume.params, "serviceTier"), false);
  const firstTurn = client.requests.find(request => request.method === "turn/start");
  assert.deepEqual(firstTurn.params.input, [{ type: "text", text: "first turn", text_elements: [] }]);
  assert.equal(firstTurn.params.summary, "auto");
  assert.equal(firstTurn.params.sandboxPolicy.networkAccess, false);
  assert.equal(firstTurn.params.permissions, null);
  assert.equal(firstTurn.params.runtimeWorkspaceRoots, null);
  assert.match(firstTurn.params.clientUserMessageId, /^[0-9a-f-]{36}$/);
  assert.equal(firstTurn.params.model, null);
  assert.equal(firstTurn.params.effort, null);
  for (const request of client.requests.filter(request => request.method === "turn/start")) {
    assert.equal(Object.hasOwn(request.params, "serviceTier"), false,
      "turn/start must inherit native speed settings, not clear priority with null");
  }
  assert.equal(firstTurn.params.outputSchema, null);
  assert.equal(firstTurn.params.approvalsReviewer, "user");
  await runtime.close();
});

test("Codex forks branch through App Server thread/fork at the requested completed turn", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const parent = await runtime.createSession({ model: "codex-test", effort: "medium" });
  await runtime.sendMessage(parent.id, { text: "parent turn" });
  await tick();

  const child = await runtime.forkSession(parent.id, {
    lastTurnId: "turn-1",
    model: "codex-test",
    effort: "low",
    sandbox: "read-only",
    approvalPolicy: "never",
  });

  assert.notEqual(child.id, parent.id);
  assert.equal(child.forkedFromId, parent.id);
  assert.deepEqual(child.turns.map(turn => turn.id), ["turn-1"]);
  const fork = client.requests.find(request => request.method === "thread/fork");
  assert.deepEqual(fork.params, {
    threadId: parent.id,
    lastTurnId: "turn-1",
    cwd: "/workspace/relay",
    model: "codex-test",
    modelProvider: null,
    config: { "features.realtime_conversation": false },
    approvalsReviewer: "user",
    approvalPolicy: "never",
    permissions: ":read-only",
    runtimeWorkspaceRoots: [],
    baseInstructions: null,
    developerInstructions: null,
    ephemeral: false,
    threadSource: "relay.codex",
  });
  assert.equal(client.requests.filter(request => request.method === "thread/start").length, 1);
  await runtime.close();
});

test("explicit Hook trust bypass reaches every Thread lifecycle request", async () => {
  const client = new FakeCodexClient({
    bypassHookTrust: true,
  });
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const tools = [{ type: "function", name: "relay_wait", description: "wait", inputSchema: {} }];
  const parent = await runtime.createSession({ dynamicTools: tools });
  await runtime.sendMessage(parent.id, { text: "parent turn" });
  await tick();
  await runtime.forkSession(parent.id, { lastTurnId: "turn-1" });
  await runtime.resumeSession(parent.id, { dynamicTools: tools });

  const start = client.requests.find(request => request.method === "thread/start");
  const fork = client.requests.find(request => request.method === "thread/fork");
  const resume = client.requests.find(request => request.method === "thread/resume");
  assert.deepEqual(start.params.config, {
    "features.realtime_conversation": false,
    bypass_hook_trust: true,
  });
  assert.deepEqual(fork.params.config, {
    "features.realtime_conversation": false,
    bypass_hook_trust: true,
  });
  assert.deepEqual(resume.params.config, { bypass_hook_trust: true });
  assert.deepEqual(start.params.dynamicTools, tools);
  assert.deepEqual(resume.params.dynamicTools, tools);
  await runtime.close();
});

test("Codex image turns use native localImage input and attachment metadata", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession({ model: "codex-test", effort: "medium" });

  await runtime.sendMessage(session.id, {
    text: "what is this?",
    localImages: [{ label: "screen.png", path: "/tmp/screen.png", fsPath: "/tmp/screen.png" }],
  });

  const turn = client.requests.find(request => request.method === "turn/start");
  assert.equal(turn.params.input[0].type, "text");
  assert.match(turn.params.input[0].text, /# Files mentioned by the user:/);
  assert.match(turn.params.input[0].text, /## screen\.png: \/tmp\/screen\.png/);
  assert.match(turn.params.input[0].text, /## My request:\nwhat is this\?/);
  assert.deepEqual(turn.params.input[1], { type: "localImage", path: "/tmp/screen.png" });
  assert.deepEqual(turn.params.attachments, [{
    label: "screen.png",
    path: "/tmp/screen.png",
    fsPath: "/tmp/screen.png",
  }]);
  assert.equal(turn.params.sandboxPolicy, null);
  assert.equal(turn.params.permissions, ":workspace");
  assert.equal(turn.params.runtimeWorkspaceRoots[0], "/workspace/relay");
  assert.match(turn.params.runtimeWorkspaceRoots[1], /\/\.codex\/visualizations\/\d{4}\/\d{2}\/\d{2}\/thread-1$/);
  await runtime.close();
});

test("business Turns request public reasoning summaries and internal callers can disable them", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession({ model: "codex-test", effort: "high" });

  await runtime.sendMessage(session.id, { text: "business reasoning" });
  await runtime.sendMessage(session.id, { text: "auxiliary reasoning", reasoningSummary: "none" });

  const turns = client.requests.filter(request => request.method === "turn/start");
  assert.deepEqual(turns.map(turn => turn.params.summary), ["auto", "none"]);
  await runtime.close();
});

test("model and reasoning changes are synced through native thread settings updates", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession({ model: "codex-test", effort: "medium" });

  await runtime.sendMessage(session.id, { text: "initial settings" });
  assert.equal(client.requests.filter(request => request.method === "thread/settings/update").length, 0);

  await runtime.sendMessage(session.id, { text: "use high effort", effort: "high" });
  const effortUpdateIndex = client.requests.findIndex(request => request.method === "thread/settings/update");
  const effortTurnIndex = client.requests.findLastIndex(request => request.method === "turn/start");
  assert.ok(effortUpdateIndex >= 0);
  assert.ok(effortUpdateIndex < effortTurnIndex);
  assert.deepEqual(client.requests[effortUpdateIndex], {
    method: "thread/settings/update",
    params: {
      threadId: session.id,
      model: "codex-test",
      effort: "high",
      multiAgentMode: "explicitRequestOnly",
    },
  });

  await runtime.sendMessage(session.id, { text: "high again", effort: "high" });
  assert.equal(client.requests.filter(request => request.method === "thread/settings/update").length, 1);

  await runtime.close();
});

test("settings sync still detects adapter-side session mutation before send", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession({ model: "codex-test", effort: "medium" });

  Object.assign(runtime.sessions.get(session.id), { model: "codex-test", effort: "high" });
  await runtime.sendMessage(session.id, { text: "adapter already mutated runtime session" });

  const update = client.requests.find(request => request.method === "thread/settings/update");
  assert.deepEqual(update.params, {
    threadId: session.id,
    model: "codex-test",
    effort: "high",
    multiAgentMode: "explicitRequestOnly",
  });
  await runtime.close();
});

test("App Server notifications remain incremental and server requests remain interactive", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  const activity = [];
  const requests = [];
  runtime.on("activity", message => activity.push(message));
  runtime.on("request", request => requests.push(request));
  await runtime.initialize();
  const session = await runtime.createSession();

  client.notify("item/reasoning/summaryTextDelta", {
    threadId: session.id, turnId: "turn-live", itemId: "reason-1", summaryIndex: 0, delta: "Inspecting.",
  });
  client.notify("item/commandExecution/outputDelta", {
    threadId: session.id, turnId: "turn-live", itemId: "command-1", delta: "result\n",
  });
  client.serverRequest("approval-1", "item/commandExecution/requestApproval", {
    threadId: session.id, turnId: "turn-live", command: "git status",
  });

  assert.deepEqual(activity.map(message => message.method), [
    "item/reasoning/summaryTextDelta", "item/commandExecution/outputDelta",
  ]);
  assert.equal(requests[0].id, "approval-1");
  assert.equal(runtime.snapshot().pendingRequests.length, 1);
  await runtime.resolveRequest("approval-1", { action: "accept" });
  assert.deepEqual(client.responses.at(-1), { id: "approval-1", result: { decision: "accept" } });
  await runtime.close();
});

test("raw response items expose only validated active code-mode shell output", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  const activity = [];
  runtime.on("activity", message => activity.push(message));
  await runtime.initialize();
  const session = await runtime.createSession();
  const base = { threadId: session.id, turnId: "turn-raw-shell" };

  client.notify("rawResponseItem/completed", {
    ...base,
    item: { type: "message", role: "developer", content: [{ type: "input_text", text: "private" }] },
  });
  client.notify("rawResponseItem/completed", {
    ...base,
    item: { type: "custom_tool_call", call_id: "other-1", name: "other", input: "text('ignore')" },
  });
  client.notify("rawResponseItem/completed", {
    ...base,
    item: { type: "custom_tool_call_output", call_id: "other-1", output: "{\"session_id\":7,\"wall_time_seconds\":1,\"output\":\"ignore\"}" },
  });
  client.notify("rawResponseItem/completed", {
    ...base,
    item: { type: "custom_tool_call", call_id: "exec-1", name: "exec", input: "code mode" },
  });
  client.notify("rawResponseItem/completed", {
    ...base,
    item: {
      type: "custom_tool_call_output",
      call_id: "exec-1",
      output: [
        { type: "input_text", text: "Script running" },
        { type: "encrypted_content", encrypted_content: "private" },
        { type: "input_text", text: "{\"session_id\":7319,\"wall_time_seconds\":1.1,\"output\":\"FIRST\\n\"}" },
      ],
    },
  });

  assert.deepEqual(activity, [{
    method: "item/codeModeShell/outputDelta",
    params: {
      threadId: session.id,
      turnId: "turn-raw-shell",
      processId: "7319",
      delta: "FIRST\n",
    },
  }]);
  assert.equal(JSON.stringify(activity).includes("private"), false);
  await runtime.close();
});

test("dynamic tool replies, question answers, permission replies, and interruption use App Server protocol", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession();

  client.serverRequest("tool-1", "item/tool/call", { threadId: session.id });
  runtime.respondDynamicTool("tool-1", true, "waiting");
  assert.deepEqual(client.responses.at(-1).result, {
    success: true,
    contentItems: [{ type: "inputText", text: "waiting" }],
  });

  client.serverRequest("question-1", "item/tool/requestUserInput", { threadId: session.id });
  await runtime.resolveRequest("question-1", { answers: { choice: ["yes"] } });
  assert.deepEqual(client.responses.at(-1).result, { answers: { choice: { answers: ["yes"] } } });

  client.serverRequest("permission-1", "item/permissions/requestApproval", {
    threadId: session.id, permissions: { network: true },
  });
  await runtime.resolveRequest("permission-1", { action: "accept" });
  assert.deepEqual(client.responses.at(-1).result, {
    permissions: { network: true }, scope: "turn",
  });

  await runtime.interruptTurn(session.id, "turn-live");
  assert.deepEqual(client.requests.at(-1), {
    method: "turn/interrupt", params: { threadId: session.id, turnId: "turn-live" },
  });
  await runtime.close();
});

test("turn interruption terminates only background processes owned by the interrupted Turn", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession();
  client.notify("turn/started", {
    threadId: session.id,
    turn: { id: "turn-live", status: "inProgress", error: null, items: [] },
  });
  client.notify("item/started", {
    threadId: session.id,
    turnId: "turn-live",
    item: {
      type: "commandExecution",
      id: "command-target",
      processId: "42",
      command: "sleep 15; write-late-marker",
      status: "inProgress",
    },
  });
  client.backgroundTerminals = [
    { itemId: "command-target", processId: "42", command: "write-late-marker" },
    { itemId: "command-unrelated", processId: "99", command: "keep-running" },
  ];

  await runtime.interruptTurn(session.id, "turn-live");

  assert.deepEqual(client.backgroundTerminals, [
    { itemId: "command-unrelated", processId: "99", command: "keep-running" },
  ]);
  assert.deepEqual(client.requests
    .filter(request => request.method.startsWith("thread/backgroundTerminals/")
      || request.method === "turn/interrupt")
    .map(request => [request.method, request.params.processId ?? null]), [
      ["thread/backgroundTerminals/list", null],
      ["thread/backgroundTerminals/terminate", "42"],
      ["turn/interrupt", null],
      ["thread/backgroundTerminals/list", null],
      ["thread/backgroundTerminals/list", null],
    ]);
  await runtime.close();
});

test("turn interruption fails closed when targeted process cleanup cannot be confirmed", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession();
  client.notify("turn/started", {
    threadId: session.id,
    turn: { id: "turn-live", status: "inProgress", error: null, items: [] },
  });
  client.notify("item/started", {
    threadId: session.id,
    turnId: "turn-live",
    item: {
      type: "commandExecution",
      id: "command-target",
      processId: "42",
      command: "sleep 15; write-late-marker",
      status: "inProgress",
    },
  });
  client.backgroundTerminals = [
    { itemId: "command-target", processId: "42", command: "write-late-marker" },
  ];
  client.unterminableProcessIds.add("42");

  await assert.rejects(runtime.interruptTurn(session.id, "turn-live"), error => {
    assert.equal(error.code, "CODEX_TURN_INTERRUPT_CLEANUP_FAILED");
    assert.equal(error.threadId, session.id);
    assert.equal(error.turnId, "turn-live");
    return true;
  });
  assert.equal(client.requests.some(request => request.method === "turn/interrupt"), true);
  assert.equal(client.backgroundTerminals.length, 1);
  await runtime.close();
});

test("cancellation catches code-mode processes before item notifications without killing earlier work", async () => {
  const client = new FakeCodexClient();
  client.startTurn = () => ({ turn: { id: "turn-early", status: "inProgress", items: [], error: null } });
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession();
  const earlier = { itemId: "earlier-server", processId: "99", command: "keep-running" };
  client.backgroundTerminals = [earlier];
  await runtime.sendMessage(session.id, { text: "run the long command" });
  client.backgroundTerminals.push({ itemId: "not-yet-announced", processId: "42", command: "long-command" });
  assert.equal(runtime.getSession(session.id).turns[0].items.length, 0);

  await runtime.interruptTurn(session.id, "turn-early");

  assert.deepEqual(client.backgroundTerminals, [earlier]);
  const terminate = client.requests.findIndex(r => r.method === "thread/backgroundTerminals/terminate");
  const interrupt = client.requests.findIndex(r => r.method === "turn/interrupt");
  assert.ok(terminate >= 0 && terminate < interrupt);
  assert.equal(client.requests[terminate].params.processId, "42");
  await runtime.close();
});

test("late native commands after cancellation are stopped without reopening the old turn or touching the new one", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession();
  client.notify("turn/started", { threadId: session.id, turn: { id: "old", status: "inProgress", items: [] } });
  await runtime.interruptTurn(session.id, "old");
  client.notify("turn/completed", { threadId: session.id, turn: { id: "old", status: "interrupted", items: [] } });
  client.notify("turn/started", { threadId: session.id, turn: { id: "new", status: "inProgress", items: [] } });
  client.backgroundTerminals = [{ itemId: "late-old", processId: "42" }, { itemId: "keep-new", processId: "99" }];
  const late = { threadId: session.id, turnId: "old", item: { id: "late-old", type: "commandExecution", status: "inProgress", processId: "42" } };
  client.notify("item/started", late);
  client.notify("item/started", late);
  client.notify("turn/diff/updated", { threadId: session.id, turnId: "old", diff: "late diff" });
  client.notify("turn/plan/updated", { threadId: session.id, turnId: "old", plan: [] });
  client.notify("item/commandExecution/outputDelta", { threadId: session.id, turnId: "old", itemId: "late-old", delta: "late output\n" });
  client.notify("item/started", { threadId: session.id, turnId: "new", item: { id: "keep-new", type: "commandExecution", status: "inProgress", processId: "99" } });
  await tick();
  assert.deepEqual(client.backgroundTerminals, [{ itemId: "keep-new", processId: "99" }]);
  assert.equal(client.requests.filter(r => r.method === "thread/backgroundTerminals/terminate" && r.params.processId === "42").length, 1);
  assert.equal(runtime.getSession(session.id).turns.find(t => t.id === "old").status, "interrupted");
  assert.equal(runtime.getSession(session.id).turns.find(t => t.id === "new").status, "inProgress");
  await runtime.close();
});

test("failure to stop a late command is observable instead of silently swallowed", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession();
  client.notify("turn/started", { threadId: session.id, turn: { id: "old", status: "inProgress", items: [] } });
  await runtime.interruptTurn(session.id, "old");
  client.notify("turn/completed", { threadId: session.id, turn: { id: "old", status: "interrupted", items: [] } });
  client.unterminableProcessIds.add("42");
  const errors=[];runtime.on("activity", e => { if(e.method === "error")errors.push(e); });
  client.notify("item/started", { threadId: session.id, turnId: "old", item: { id: "late", type: "commandExecution", status: "inProgress", processId: "42" } });
  await tick();
  assert.equal(errors[0].params.error.code, "CODEX_TURN_INTERRUPT_CLEANUP_FAILED");
  assert.equal(runtime.getSession(session.id).turns.find(t => t.id === "old").error.code, "CODEX_TURN_INTERRUPT_CLEANUP_FAILED");
  await runtime.close();
});

test("turn interruption catches a background process that appears during the interrupt race", async () => {
  const client = new InterruptRaceCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession();
  client.notify("turn/started", {
    threadId: session.id,
    turn: { id: "turn-live", status: "inProgress", error: null, items: [] },
  });
  client.notify("item/started", {
    threadId: session.id,
    turnId: "turn-live",
    item: {
      type: "commandExecution",
      id: "command-race",
      processId: null,
      command: "sleep 15; write-late-marker",
      status: "inProgress",
    },
  });

  await runtime.interruptTurn(session.id, "turn-live");

  assert.deepEqual(client.backgroundTerminals, []);
  assert.equal(client.requests.some(request => (
    request.method === "thread/backgroundTerminals/terminate"
      && request.params.processId === "84"
  )), true);
  await runtime.close();
});

test("only Relay-owned Codex threads are discovered and can be resumed after restart", async () => {
  const client = new FakeCodexClient();
  const first = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await first.initialize();
  const created = await first.createSession({ model: "codex-test", effort: "low" });
  await first.sendMessage(created.id, { text: "persist this turn" });
  await tick();
  await first.close();

  client.connected = true;
  client.threads.set("unrelated", { ...client.thread("unrelated", "/workspace/relay"), threadSource: null });
  const second = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await second.initialize();
  assert.ok(second.getSession(created.id));
  assert.equal(second.getSession("unrelated"), null);
  const resumed = await second.resumeSession(created.id);
  assert.equal(resumed.turns.length, 1);
  await second.close();
});

test("Workspace inventory paginates with explicit source kinds and enforces canonical cwd boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-codex-inventory-"));
  const workspace = join(root, "workspace");
  const alias = join(root, "workspace-alias");
  const sibling = join(root, "workspace-other");
  const child = join(workspace, "child");
  const client = new PagedInventoryClient({ workspace, sibling, child });
  try {
    await Promise.all([
      mkdir(child, { recursive: true }),
      mkdir(sibling, { recursive: true }),
    ]);
    await symlink(workspace, alias);
    const runtime = new CodexSessionRuntime({ client, cwd: alias });
    await runtime.initialize();
    client.requests.length = 0;

    const threads = await runtime.listWorkspaceThreads({ cwd: alias });

    assert.deepEqual(threads.map(thread => thread.id), ["thread-exact", "thread-alias"]);
    const listRequests = client.requests.filter(request => request.method === "thread/list");
    assert.equal(listRequests.length, 2);
    assert.equal(listRequests[0].params.cursor, null);
    assert.equal(listRequests[1].params.cursor, "page-2");
    assert.equal(listRequests[0].params.archived, false);
    assert.deepEqual(listRequests[0].params.sourceKinds, [
      "cli", "vscode", "exec", "appServer", "unknown",
    ]);
    assert.equal(listRequests[0].params.cwd, alias);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace inventory rejects missing cwd and repeated App Server cursors", async () => {
  const client = new RepeatingCursorClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });

  await assert.rejects(runtime.listWorkspaceThreads({ cwd: " " }), /Workspace cwd is required/);
  await assert.rejects(
    runtime.listWorkspaceThreads({ cwd: "/workspace/relay" }),
    /thread\/list repeated cursor loop/,
  );
  assert.equal(client.requests.filter(request => request.method === "thread/list").length, 2);
});

test("historical hydration reads turns without resuming or starting the Codex Thread", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const source = client.thread("existing-thread", "/workspace/relay");
  source.turns.push({
    id: "turn-old",
    status: "completed",
    items: [
      { type: "userMessage", id: "user-old", content: [{ type: "text", text: "old question" }] },
      { type: "agentMessage", id: "answer-old", text: "old answer", phase: "final_answer" },
    ],
  });
  client.threads.set(source.id, source);
  client.requests.length = 0;

  const read = await runtime.readThread(source.id);

  assert.equal(read.id, source.id);
  assert.equal(read.turns.length, 1);
  assert.deepEqual(client.requests, [{
    method: "thread/read",
    params: { threadId: source.id, includeTurns: true },
  }]);
  assert.equal(runtime.getSession(source.id), null);
  await runtime.close();
});

test("ephemeral auxiliary threads carry isolated instructions and are released", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();

  const session = await runtime.createSession({
    model: "codex-test",
    sandbox: ":read-only",
    approvalPolicy: "never",
    dynamicTools: [],
    baseInstructions: "Generate a title.",
    developerInstructions: "Do not call tools.",
    ephemeral: true,
    serviceName: "relay_codex_auxiliary",
    threadSource: "relay.codex.auxiliary",
  });
  const start = client.requests.find(request => request.method === "thread/start");
  assert.equal(start.params.ephemeral, true);
  assert.equal(start.params.experimentalRawEvents, false);
  assert.equal(start.params.baseInstructions, "Generate a title.");
  assert.equal(start.params.developerInstructions, "Do not call tools.");
  assert.deepEqual(start.params.dynamicTools, []);
  assert.equal(start.params.permissions, ":read-only");
  assert.deepEqual(start.params.runtimeWorkspaceRoots, []);
  assert.equal(session.sandbox, "read-only");
  assert.equal(session.ephemeral, true);

  await runtime.releaseSession(session.id);
  assert.equal(runtime.getSession(session.id), null);
  assert.deepEqual(client.requests.at(-1), {
    method: "thread/unsubscribe", params: { threadId: session.id },
  });
  await runtime.close();
});

test("resume and settings notifications preserve acknowledged native settings without masking a pending user override", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const created = await runtime.createSession({ model: "codex-test", effort: "high" });
  const originalRequest = client.request.bind(client);
  client.request = async (method, params) => {
    const result = await originalRequest(method, params);
    return method === "thread/resume" ? { ...result, model: "codex-test", reasoningEffort: "low", serviceTier: "priority" } : result;
  };
  await runtime.resumeSession(created.id, { model: "codex-test", effort: "high" });
  assert.equal(runtime.getSession(created.id).nativeSettings.serviceTier, "priority");
  assert.equal(runtime.getSession(created.id).nativeSettings.effort, "low");
  await runtime.sendMessage(created.id, { text: "continue with the requested effort" });
  assert.equal(client.requests.find(r => r.method === "thread/settings/update").params.effort, "high");
  client.notify("thread/settings/updated", { threadId: created.id, threadSettings: {
    model: "codex-test", effort: "low", serviceTier: null,
  } });
  assert.equal(runtime.getSession(created.id).nativeSettings.serviceTier, null);
  await runtime.sendMessage(created.id, { text: "continue after native settings change" });
  assert.equal(client.requests.filter(r => r.method === "thread/settings/update").length, 2);
  assert.ok(client.requests.filter(r => r.method === "turn/start").every(r => !Object.hasOwn(r.params, "serviceTier")));
  await runtime.close();
});

test("an unexpected App Server exit settles running turns and clears pending interactions", async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/relay" });
  await runtime.initialize();
  const session = await runtime.createSession();
  client.notify("turn/started", { threadId: session.id, turn: { id: "running", status: "inProgress", items: [] } });
  client.serverRequest("pending", "item/tool/requestUserInput", { threadId: session.id });
  const activity = [];
  runtime.on("activity", message => activity.push(message));
  const waiting = runtime.waitForTurn(session.id, "running", { timeoutMs: 1000 });
  client.emit("exit", { code: 1 });
  const completed = await waiting;
  assert.equal(completed.status, "failed");
  assert.equal(completed.error.code, "CODEX_APP_SERVER_EXITED");
  assert.equal(runtime.pendingRequests.size, 0);
  assert.equal(activity.filter(m => m.method === "turn/completed").length, 1);
  await runtime.close();
});

class FakeCodexClient extends EventEmitter {
  constructor({ bypassHookTrust = false } = {}) {
    super();
    this.bypassHookTrust = bypassHookTrust;
    this.connected = true;
    this.requests = [];
    this.responses = [];
    this.errors = [];
    this.threads = new Map();
    this.threadSequence = 0;
    this.turnSequence = 0;
    this.backgroundTerminals = [];
    this.unterminableProcessIds = new Set();
  }

  async start() {}
  async close() { this.connected = false; }

  async request(method, params = {}) {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "model/list") return { data: [model()] };
    if (method === "account/read") return { account: { type: "chatgpt", planType: "test" }, requiresOpenaiAuth: true };
    if (method === "thread/list") {
      return { data: [...this.threads.values()].filter(thread => thread.cwd === params.cwd && !thread.ephemeral).map(thread => ({ ...structuredClone(thread), turns: [] })) };
    }
    if (method === "thread/start") {
      const thread = this.thread(`thread-${++this.threadSequence}`, params.cwd);
      thread.threadSource = params.threadSource;
      thread.ephemeral = Boolean(params.ephemeral);
      this.threads.set(thread.id, thread);
      return { thread: structuredClone(thread) };
    }
    if (method === "thread/fork") {
      const source = this.threads.get(params.threadId);
      if (!source) throw new Error(`unknown thread ${params.threadId}`);
      const lastTurnIndex = source.turns.findIndex(turn => turn.id === params.lastTurnId);
      if (lastTurnIndex === -1) throw new Error(`unknown turn ${params.lastTurnId}`);
      const thread = structuredClone(source);
      thread.id = `thread-${++this.threadSequence}`;
      thread.sessionId = thread.id;
      thread.forkedFromId = source.id;
      thread.cwd = params.cwd ?? source.cwd;
      thread.threadSource = params.threadSource;
      thread.ephemeral = Boolean(params.ephemeral);
      thread.turns = thread.turns.slice(0, lastTurnIndex + 1);
      this.threads.set(thread.id, thread);
      return {
        thread: structuredClone(thread),
        model: params.model,
        reasoningEffort: "low",
        approvalPolicy: params.approvalPolicy,
        cwd: thread.cwd,
      };
    }
    if (method === "thread/resume") return { thread: structuredClone(this.threads.get(params.threadId)) };
    if (method === "thread/read") return { thread: structuredClone(this.threads.get(params.threadId)) };
    if (method === "thread/settings/update") return {};
    if (method === "turn/start") return this.startTurn(params);
    if (method === "turn/interrupt") return {};
    if (method === "thread/backgroundTerminals/list") {
      return { data: structuredClone(this.backgroundTerminals), nextCursor: null };
    }
    if (method === "thread/backgroundTerminals/terminate") {
      if (this.unterminableProcessIds.has(String(params.processId))) {
        throw new Error(`could not terminate process ${params.processId}`);
      }
      const index = this.backgroundTerminals.findIndex(terminal => (
        String(terminal.processId) === String(params.processId)
      ));
      if (index === -1) return { terminated: false };
      this.backgroundTerminals.splice(index, 1);
      return { terminated: true };
    }
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    throw new Error(`unexpected request ${method}`);
  }

  respond(id, result) { this.responses.push({ id, result: structuredClone(result) }); }
  respondError(id, code, message) { this.errors.push({ id, code, message }); }
  notify(method, params) { this.emit("notification", { method, params: structuredClone(params) }); }
  serverRequest(id, method, params) { this.emit("serverRequest", { id, method, params: structuredClone(params) }); }

  startTurn(params) {
    const thread = this.threads.get(params.threadId);
    const id = `turn-${++this.turnSequence}`;
    const user = { type: "userMessage", id: `${id}-user`, content: structuredClone(params.input) };
    const answer = { type: "agentMessage", id: `${id}-answer`, text: `completed ${id}`, phase: "final_answer" };
    const turn = { id, status: "completed", error: null, items: [user, answer] };
    thread.turns.push(turn);
    queueMicrotask(() => {
      this.notify("turn/started", { threadId: thread.id, turn: { id, status: "inProgress", error: null, items: [] } });
      this.notify("item/completed", { threadId: thread.id, turnId: id, item: answer });
      this.notify("turn/completed", { threadId: thread.id, turn });
    });
    return { turn: { id, status: "inProgress", error: null, items: [] } };
  }

  thread(id, cwd) {
    const now = Date.now() / 1000;
    return { id, sessionId: id, name: null, preview: "", cwd, status: { type: "idle" }, createdAt: now, updatedAt: now, turns: [] };
  }
}

class PagedInventoryClient extends FakeCodexClient {
  constructor({ workspace, sibling, child }) {
    super();
    this.workspace = workspace;
    this.sibling = sibling;
    this.child = child;
  }

  async request(method, params = {}) {
    if (method !== "thread/list") return super.request(method, params);
    this.requests.push({ method, params: structuredClone(params) });
    if (params.cursor === "page-2") {
      return {
        data: [
          inventoryThread("thread-alias", this.workspace, 20),
          inventoryThread("thread-exact", this.workspace, 10),
          inventoryThread("thread-child", this.child, 9),
          { ...inventoryThread("thread-ephemeral", this.workspace, 8), ephemeral: true },
        ],
        nextCursor: null,
      };
    }
    return {
      data: [
        inventoryThread("thread-exact", this.workspace, 10),
        inventoryThread("thread-sibling", this.sibling, 7),
      ],
      nextCursor: "page-2",
    };
  }
}

class InterruptRaceCodexClient extends FakeCodexClient {
  async request(method, params = {}) {
    const result = await super.request(method, params);
    if (method === "turn/interrupt") {
      this.backgroundTerminals.push({
        itemId: "command-race",
        processId: "84",
        command: "write-late-marker",
      });
    }
    return result;
  }
}

class RepeatingCursorClient extends FakeCodexClient {
  async request(method, params = {}) {
    if (method !== "thread/list") return super.request(method, params);
    this.requests.push({ method, params: structuredClone(params) });
    return { data: [], nextCursor: "loop" };
  }
}

function inventoryThread(id, cwd, updatedAt) {
  return {
    id,
    sessionId: id,
    name: null,
    preview: id,
    cwd,
    status: { type: "idle" },
    createdAt: 1,
    updatedAt,
    turns: [],
    ephemeral: false,
  };
}

function model() {
  return {
    id: "codex-test", displayName: "Codex Test", isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
