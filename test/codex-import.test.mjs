import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexDshAdapter } from "../codex-adapter.js";
import { CodexWorkspaceImporter } from "../codex-import.mjs";
import { CodexLinkStore } from "../codex-link-store.js";

const FAILURE_BOUNDARIES = ["prepared", "hydrated", "attached", "finalized"];

for (const boundary of FAILURE_BOUNDARIES) {
  test(`Workspace import recovers idempotently after the ${boundary} boundary`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), `relay-codex-import-${boundary}-`));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const linkPath = join(directory, "links.json");
    const runtime = new ImportRuntime([thread("codex-thread-1")]);
    const target = new ImportTarget({ failAt: boundary });
    const first = importer(runtime, target, linkPath);

    const failed = await first.importWorkspace("/workspace/relay");
    assert.equal(failed.imported, 0);
    assert.equal(failed.failed, 1);
    assert.equal(failed.failures[0].thread, "codex-th...ad-1");
    assert.equal(failed.failures[0].message.includes("codex-thread-1"), false);
    assert.equal(target.sessions.size, 1);

    target.failAt = null;
    const second = importer(runtime, target, linkPath);
    const recovered = await second.importWorkspace("/workspace/relay");
    assert.equal(recovered.imported, 1);
    assert.equal(recovered.failed, 0);
    assert.equal(target.sessions.size, 1);
    assert.equal(target.history.size, 1);
    assert.equal(target.attachments.size, 1);
    assert.equal(second.adapter.bindingForThread("codex-thread-1").importState, "committed");

    const repeated = await second.importWorkspace("/workspace/relay");
    assert.equal(repeated.imported, 0);
    assert.equal(repeated.existing, 1);
    assert.equal(repeated.failed, 0);
    assert.equal(target.sessions.size, 1);
    assert.equal(target.history.size, 1);
    assert.equal(target.attachments.size, 1);
  });
}

test("Workspace import summarizes inventory and preserves successes across a partial batch failure", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-import-batch-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const linkPath = join(directory, "links.json");
  const runtime = new ImportRuntime([
    thread("codex-good", 30),
    thread("codex-bad", 20),
    thread("codex-existing", 10),
  ]);
  const target = new ImportTarget({ failThreadId: "codex-bad", failAt: "hydrated" });
  const service = importer(runtime, target, linkPath);
  service.adapter.bindImportedThread("existing-session", "codex-existing", config());
  service.adapter.markImportState("existing-session", "committed");

  const scan = await service.scanWorkspace("/workspace/relay");
  assert.deepEqual(scan.summary, {
    found: 3,
    existing: 1,
    recoverable: 0,
    ready: 2,
  });

  const progress = [];
  const first = await service.importWorkspace("/workspace/relay", {
    onProgress: update => progress.push(update),
  });
  assert.deepEqual(first, {
    found: 3,
    imported: 1,
    existing: 1,
    failed: 1,
    failures: [{ thread: "codex-bad", message: "simulated hydrated failure for codex-bad" }],
  });
  assert.deepEqual(progress.map(update => update.completed), [1, 2, 3]);
  assert.ok(service.adapter.bindingForThread("codex-good"));
  assert.equal(service.adapter.bindingForThread("codex-bad").importState, "session-created");
  assert.deepEqual((await service.scanWorkspace("/workspace/relay")).summary, {
    found: 3,
    existing: 2,
    recoverable: 1,
    ready: 1,
  });

  target.failAt = null;
  target.failThreadId = null;
  const retry = await service.importWorkspace("/workspace/relay");
  assert.deepEqual(retry, { found: 3, imported: 1, existing: 2, failed: 0, failures: [] });
  assert.equal(service.adapter.bindingForThread("codex-bad").importState, "committed");
  assert.equal(runtime.created, 0);
});

test("selected Workspace import validates every Thread before mutating and preserves inventory order", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-import-selected-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = new ImportRuntime([
    thread("codex-older", 10),
    thread("codex-newer", 30),
    thread("codex-middle", 20),
  ]);
  const target = new ImportTarget();
  const service = importer(runtime, target, join(directory, "links.json"));
  service.adapter.bindImportedThread("existing-session", "codex-middle", config());
  service.adapter.markImportState("existing-session", "committed");

  const scan = await service.scanWorkspace("/workspace/relay");
  assert.deepEqual(scan.entries.map(entry => entry.thread.id), [
    "codex-newer", "codex-middle", "codex-older",
  ]);

  await assert.rejects(
    service.importWorkspace("/workspace/relay", { threadIds: ["codex-newer", "codex-unknown"] }),
    /is not available in this Workspace/,
  );
  await assert.rejects(
    service.importWorkspace("/workspace/relay", { threadIds: ["codex-middle"] }),
    /already bound to DSH/,
  );
  await assert.rejects(
    service.importWorkspace("/workspace/relay", { threadIds: ["codex-newer", "codex-newer"] }),
    /selected more than once/,
  );
  await assert.rejects(
    service.importWorkspace("/workspace/relay", { threadIds: [42] }),
    /must be non-empty strings/,
  );
  assert.equal(target.prepareCalls, 0);

  const progress = [];
  const result = await service.importWorkspace("/workspace/relay", {
    threadIds: ["codex-older"],
    onProgress: update => progress.push(update),
  });
  assert.deepEqual(result, {
    found: 1,
    imported: 1,
    existing: 0,
    failed: 0,
    failures: [],
  });
  assert.deepEqual(progress.map(update => ({ completed: update.completed, total: update.total })), [
    { completed: 1, total: 1 },
  ]);
  assert.equal(service.adapter.bindingForThread("codex-newer"), null);
  assert.equal(service.adapter.bindingForThread("codex-older").importState, "committed");
});

test("concurrent Workspace imports coalesce each Thread transaction", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-import-concurrent-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = new ImportRuntime([thread("codex-concurrent")]);
  const target = new ImportTarget({ prepareDelayMs: 5 });
  const service = importer(runtime, target, join(directory, "links.json"));

  const [left, right] = await Promise.all([
    service.importWorkspace("/workspace/relay"),
    service.importWorkspace("/workspace/relay"),
  ]);

  assert.equal(left.failed, 0);
  assert.equal(right.failed, 0);
  assert.equal(target.prepareCalls, 1);
  assert.equal(target.sessions.size, 1);
  assert.equal(service.adapter.bindingForThread("codex-concurrent").importState, "committed");
});

function importer(runtime, target, linkPath) {
  const adapter = new CodexDshAdapter({
    runtime,
    ready: Promise.resolve(),
    linkStore: new CodexLinkStore(linkPath),
  });
  return Object.assign(new CodexWorkspaceImporter({
    runtime,
    adapter,
    target,
    logger: { warn() {} },
  }), { adapter });
}

class ImportRuntime {
  constructor(threads) {
    this.threads = threads;
    this.created = 0;
    this.models = [{
      id: "codex-test",
      displayName: "Codex Test",
      isDefault: true,
      defaultReasoningEffort: "medium",
    }];
  }

  async listWorkspaceThreads() {
    return structuredClone(this.threads);
  }

  async createSession() {
    this.created += 1;
    throw new Error("import must not create a Codex Thread");
  }
}

class ImportTarget {
  constructor({ failAt = null, failThreadId = null, prepareDelayMs = 0 } = {}) {
    this.failAt = failAt;
    this.failThreadId = failThreadId;
    this.prepareDelayMs = prepareDelayMs;
    this.prepareCalls = 0;
    this.sessions = new Set();
    this.history = new Set();
    this.attachments = new Set();
    this.finalized = new Set();
  }

  async prepare(input) {
    this.prepareCalls += 1;
    if (this.prepareDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.prepareDelayMs));
    this.sessions.add(input.binding.sessionId);
    this.maybeFail("prepared", input.thread.id);
    return input;
  }

  async hydrate(input) {
    this.history.add(input.binding.sessionId);
    this.maybeFail("hydrated", input.thread.id);
  }

  async attach(input) {
    this.attachments.add(input.binding.sessionId);
    this.maybeFail("attached", input.thread.id);
  }

  async finalize(input) {
    this.finalized.add(input.binding.sessionId);
    this.maybeFail("finalized", input.thread.id);
  }

  async release() {}

  maybeFail(boundary, threadId) {
    if (this.failAt === boundary && (this.failThreadId === null || this.failThreadId === threadId)) {
      throw new Error(`simulated ${boundary} failure for ${threadId}`);
    }
  }
}

function thread(id, updatedAt = 1) {
  return {
    id,
    sessionId: id,
    name: null,
    preview: id,
    cwd: "/workspace/relay",
    status: { type: "idle" },
    createdAt: 1,
    updatedAt,
    ephemeral: false,
  };
}

function config() {
  return {
    model: "codex-test",
    effort: "medium",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    cwd: "/workspace/relay",
  };
}
