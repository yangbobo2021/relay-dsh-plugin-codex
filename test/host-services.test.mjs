import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { handleCodexServerRequest } from "../codex-tools.js";
import { inject } from "../host-plugin.js";

const INTERACTION_SERVICES = ["approval", "userQuestions"];

test("the Host plugin declares every DSH interaction service it consumes", () => {
  for (const service of INTERACTION_SERVICES) {
    assert.ok(inject.includes(service), `missing required Host injection: ${service}`);
  }
});

test("the interaction bridge specification names its required services and fail-closed behavior", async () => {
  const specification = await readFile(
    new URL("../docs/spec/dsh-interaction-bridge.md", import.meta.url),
    "utf8",
  );
  for (const service of INTERACTION_SERVICES) {
    assert.match(specification, new RegExp(`\\b${service}\\b`));
  }
  assert.match(specification, /required Host injections/);
  assert.match(specification, /must not bypass DSH approval or\s+question handling/);
});

test("Codex interactions resolve through sibling DSH service providers", async (context) => {
  const agent = { id: "dsh-1" };
  const calls = { approvals: [], questions: [] };
  const services = {
    agents: { get: id => id === agent.id ? agent : null },
    approval: {
      async request(input) {
        calls.approvals.push(input);
        return "allowed-once";
      },
    },
    attachments: {},
    llm: {},
    sessions: {},
    sessionPersistence: {},
    tools: {},
    typert: {},
    userQuestions: {
      async ask(input) {
        calls.questions.push(input);
        return { answers: [{ id: "choice", selected: ["Continue"], custom: "with tests" }] };
      },
    },
    webServer: {},
    workspaceRegistry: {},
    sessionTitle: {},
  };
  const { consumer, dispose } = await composeHostContext(services);
  context.after(dispose);
  const runtime = new InteractionRuntime();
  const adapter = {
    dshSessionForThread: id => id === "thread-1" ? agent.id : null,
    captureRequestOwnership(request) {
      return { requestId: request.id, threadId: request.params.threadId };
    },
    assertRequestOwnership(ownership, request) {
      assert.equal(ownership.requestId, request.id);
      assert.equal(ownership.threadId, request.params.threadId);
    },
  };

  await handleCodexServerRequest(consumer, {
    adapter,
    runtime,
    request: {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "printf APPROVAL_ALLOW_4207",
      },
    },
  });
  await handleCodexServerRequest(consumer, {
    adapter,
    runtime,
    request: {
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        questions: [{
          id: "choice",
          header: "Action",
          question: "Continue?",
          options: [{ label: "Continue", description: "Continue the Turn." }],
        }],
      },
    },
  });

  assert.equal(runtime.rejected.length, 0);
  assert.equal(calls.approvals.length, 1);
  assert.equal(calls.approvals[0].agent, agent);
  assert.equal(calls.approvals[0].toolName, "Codex command");
  assert.equal(calls.questions.length, 1);
  assert.equal(calls.questions[0].agent, agent);
  assert.deepEqual(runtime.resolved, [
    { id: "approval-1", response: { action: "accept" } },
    { id: "question-1", response: { answers: { choice: ["Continue", "with tests"] } } },
  ]);
});

async function composeHostContext(services) {
  const root = new Context();
  const fibers = [];
  for (const [name, value] of Object.entries(services)) {
    fibers.push(await root.plugin({
      name: `provider:${name}`,
      apply(ctx) { ctx.provide(name, value); },
    }));
  }
  let consumer;
  fibers.push(await root.plugin({
    name: "relay-dsh-plugin-codex",
    inject,
    apply(ctx) { consumer = ctx; },
  }));
  return {
    consumer,
    async dispose() {
      for (const fiber of fibers.reverse()) await fiber.dispose();
    },
  };
}

class InteractionRuntime {
  constructor() {
    this.resolved = [];
    this.rejected = [];
  }

  async resolveRequest(id, response) {
    this.resolved.push({ id, response });
  }

  rejectRequest(id, error) {
    this.rejected.push({ id, error });
  }
}
