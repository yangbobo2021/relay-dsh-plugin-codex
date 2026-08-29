import { createHash } from "node:crypto";

const IMPORT_STATE_ORDER = Object.freeze([
  "reserved", "session-created", "hydrated", "attached", "committed",
]);

export class CodexWorkspaceImporter {
  constructor({ runtime, adapter, target, logger = console }) {
    if (!runtime?.listWorkspaceThreads) throw new Error("Codex import requires Workspace Thread inventory");
    if (!adapter?.bindImportedThread) throw new Error("Codex import requires a DSH binding adapter");
    if (!["prepare", "hydrate", "attach", "finalize"].every(method => typeof target?.[method] === "function")) {
      throw new Error("Codex import requires a complete DSH Session target");
    }
    this.runtime = runtime;
    this.adapter = adapter;
    this.target = target;
    this.logger = logger;
    this.pendingThreads = new Map();
  }

  async scanWorkspace(cwd) {
    const threads = (await this.runtime.listWorkspaceThreads({ cwd }))
      .toSorted(compareInventoryThreads);
    const entries = threads.map((thread) => {
      const binding = this.adapter.bindingForThread(thread.id);
      if (!binding) return { thread, binding: null, status: "ready" };
      if (binding.bindingMode === "imported" && binding.importState !== "committed") {
        return { thread, binding, status: "recoverable" };
      }
      return { thread, binding, status: "existing" };
    });
    const existing = entries.filter(entry => entry.status === "existing").length;
    const recoverable = entries.filter(entry => entry.status === "recoverable").length;
    return {
      cwd,
      entries,
      summary: {
        found: entries.length,
        existing,
        recoverable,
        ready: entries.length - existing,
      },
    };
  }

  async importWorkspace(cwd, { threadIds, onProgress } = {}) {
    const inventory = await this.scanWorkspace(cwd);
    const entries = selectedImportEntries(inventory.entries, threadIds);
    const result = {
      found: threadIds === undefined ? inventory.summary.found : entries.length,
      imported: 0,
      existing: 0,
      failed: 0,
      failures: [],
    };
    let completed = 0;

    for (const entry of entries) {
      if (entry.status === "existing") {
        result.existing += 1;
      } else {
        try {
          await this.importThread(entry.thread, cwd, entry.binding);
          result.imported += 1;
        } catch (error) {
          result.failed += 1;
          const thread = shortThreadId(entry.thread.id);
          const message = publicErrorMessage(error, entry.thread.id, thread);
          result.failures.push({ thread, message });
          this.logger.warn?.(`Codex import failed for ${thread}: ${message}`);
        }
      }
      completed += 1;
      onProgress?.({ completed, total: entries.length, ...result });
    }

    return result;
  }

  async importThread(thread, workspaceCwd, existingBinding = null) {
    const pending = this.pendingThreads.get(thread.id);
    if (pending) return pending;
    const operation = this.runImportThread(thread, workspaceCwd, existingBinding)
      .finally(() => { this.pendingThreads.delete(thread.id); });
    this.pendingThreads.set(thread.id, operation);
    return operation;
  }

  async runImportThread(thread, workspaceCwd, existingBinding = null) {
    let binding = existingBinding;
    if (!binding) {
      const sessionId = importedSessionId(thread.id);
      binding = this.adapter.bindImportedThread(sessionId, thread.id, {
        ...this.adapter.configuration(sessionId, thread.cwd),
        cwd: thread.cwd,
      });
    }
    if (binding.bindingMode !== "imported") return binding.sessionId;
    if (binding.importState === "committed") return binding.sessionId;

    let transaction = null;
    try {
      transaction = await this.target.prepare({ thread, binding, workspaceCwd });
      binding = this.adapter.markImportState(binding.sessionId, "session-created");
      if (before(binding.importState, "hydrated")) {
        await this.target.hydrate(transaction);
        binding = this.adapter.markImportState(binding.sessionId, "hydrated");
      }
      if (before(binding.importState, "attached")) {
        await this.target.attach(transaction);
        binding = this.adapter.markImportState(binding.sessionId, "attached");
      }
      if (before(binding.importState, "committed")) {
        await this.target.finalize(transaction);
        binding = this.adapter.markImportState(binding.sessionId, "committed");
      }
      return binding.sessionId;
    } finally {
      if (transaction !== null) await this.target.release?.(transaction);
    }
  }
}

export function importedSessionId(threadId) {
  const digest = createHash("sha256").update(String(threadId)).digest("hex").slice(0, 24);
  return `codex-import-${digest}`;
}

function before(current, target) {
  return IMPORT_STATE_ORDER.indexOf(current) < IMPORT_STATE_ORDER.indexOf(target);
}

function compareInventoryThreads(left, right) {
  const updated = timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
  return updated === 0 ? String(left.id).localeCompare(String(right.id)) : updated;
}

function timestampValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function selectedImportEntries(entries, threadIds) {
  if (threadIds === undefined) return entries;
  if (!Array.isArray(threadIds) || threadIds.length === 0) {
    throw new Error("At least one Codex Thread must be selected");
  }
  const selected = new Set();
  for (const rawId of threadIds) {
    if (typeof rawId !== "string") throw new Error("Selected Codex Thread IDs must be non-empty strings");
    const threadId = rawId.trim();
    if (!threadId) throw new Error("Selected Codex Thread IDs must be non-empty strings");
    if (selected.has(threadId)) throw new Error(`Codex Thread ${shortThreadId(threadId)} was selected more than once`);
    selected.add(threadId);
  }
  const inventory = new Map(entries.map(entry => [entry.thread.id, entry]));
  for (const threadId of selected) {
    const entry = inventory.get(threadId);
    if (!entry) throw new Error(`Codex Thread ${shortThreadId(threadId)} is not available in this Workspace`);
    if (entry.status === "existing") throw new Error(`Codex Thread ${shortThreadId(threadId)} is already bound to DSH`);
  }
  return entries.filter(entry => selected.has(entry.thread.id));
}

function shortThreadId(threadId) {
  const value = String(threadId);
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function publicErrorMessage(error, threadId, shortId) {
  const message = error?.message ?? String(error);
  return String(message).replaceAll(String(threadId), shortId);
}
