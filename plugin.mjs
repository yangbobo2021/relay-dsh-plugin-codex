import { EventEmitter } from "node:events";
import { definePlugin } from "./internal/plugin-sdk.mjs";
import { CodexAppServerClient, RELAY_CODEX_APP_SERVER_ARGS } from "./app-server-client.mjs";
import { CodexSessionRuntime } from "./session-runtime.mjs";

export const CODEX_EXECUTION_CAPABILITY = "relay.execution.codex.v1";
export const CODEX_TERMINAL_CAPABILITY = "relay.terminal.codex.v1";

export function createCodexExecutionPlugin(config = {}) {
  const controller = config.controller ?? new CodexRuntimeController(config);
  return definePlugin({
    manifest: {
      id: "relay.execution.codex",
      version: "1.0.0",
      provides: {
        [CODEX_EXECUTION_CAPABILITY]: "1.0.0",
        [CODEX_TERMINAL_CAPABILITY]: "1.0.0",
      },
      optional: { "relay.logging.v1": "^1.0.0" },
      permissions: ["process:codex-app-server", "filesystem:workspace"],
    },
    activate({ capabilities, defer }) {
      const logger = capabilities.optional("relay.logging.v1") ?? console;
      controller.logger = logger;
      controller.onReload = config.onReload;
      const ready = controller.start(config.command);
      defer(() => controller.close());
      void ready.catch((error) => {
        logger.error?.(`Relay Codex App Server failed to initialize: ${error?.stack ?? error}`);
      });

      return {
        capabilities: {
          [CODEX_EXECUTION_CAPABILITY]: executionCapability(controller),
          [CODEX_TERMINAL_CAPABILITY]: terminalCapability(controller),
        },
      };
    },
  });
}

export class CodexRuntimeController extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...config };
    this.cwd = config.cwd ?? process.cwd();
    this.current = null;
    this.ready = null;
    this.started = false;
    this.closed = false;
    this.reloadPromise = null;
    this.desiredCommand = undefined;
    this.logger = console;
    this.onReload = null;
  }

  async start(command) {
    if (this.started) return this.ready;
    this.started = true;
    this.desiredCommand = command;
    const entry = this.createCandidate(command, this.createClient(command));
    this.current = entry;
    this.ready = entry.ready;
    this.attach(entry);
    try {
      await entry.ready;
    } catch (error) {
      await entry.runtime.close().catch(() => {});
      throw error;
    }
    if (!this.closed && this.desiredCommand !== command) {
      void this.reload(this.desiredCommand).catch((error) => this.logReloadFailure(error));
    }
    return entry.ready;
  }

  async reload(command) {
    this.desiredCommand = command;
    if (!this.started || this.closed) return;
    if (this.reloadPromise) return this.reloadPromise;
    let succeeded = false;
    this.reloadPromise = this.processReload().then((result) => {
      succeeded = true;
      return result;
    }).finally(() => {
      this.reloadPromise = null;
      if (succeeded && !this.closed && this.desiredCommand !== this.current?.command) {
        void this.reload(this.desiredCommand).catch((error) => this.logReloadFailure(error));
      }
    });
    return this.reloadPromise;
  }

  async processReload() {
    const previous = this.current;
    if (!previous) return;
    if (!previous.runtime.isReloadSafe()) {
      await waitForRuntimeChange(previous.runtime, () => previous.runtime.isReloadSafe());
      if (this.closed || this.desiredCommand === previous.command) return;
    }
    const command = this.desiredCommand;
    if (command === previous.command) return;
    const candidate = await this.startCandidate(command, this.createClient(command));
    try {
      candidate.runtime.adoptStateFrom(previous.runtime);
      this.detach(previous);
      this.current = candidate;
      this.ready = candidate.ready;
      this.attach(candidate);
      await previous.runtime.close();
      this.onReload?.({ command, models: candidate.runtime.models });
      this.emit("reloaded", { command });
      return command;
    } catch (error) {
      await candidate.runtime.close().catch(() => {});
      throw error;
    }
  }

  async startCandidate(command, client) {
    const entry = this.createCandidate(command, client);
    try {
      await entry.ready;
      return entry;
    } catch (error) {
      await entry.runtime.close().catch(() => {});
      throw error;
    }
  }

  createCandidate(command, client) {
    const runtime = new CodexSessionRuntime({ client, cwd: this.cwd });
    const ready = runtime.initialize();
    return { command, client, runtime, ready };
  }

  createClient(command) {
    if (this.config.client && !this.current) return this.config.client;
    if (typeof this.config.clientFactory === "function") {
      return this.config.clientFactory(command);
    }
    return createAppServerClient({ ...this.config, command });
  }

  attach(entry) {
    const forward = (event) => (...args) => this.emit(event, ...args);
    entry.forwarders = [
      [entry.runtime, "activity", forward("activity")],
      [entry.runtime, "request", forward("request")],
      [entry.runtime, "change", forward("change")],
      [entry.runtime, "connectionStatus", forward("connectionStatus")],
      [entry.client, "notification", forward("notification")],
    ];
    for (const [emitter, event, listener] of entry.forwarders) emitter.on(event, listener);
  }

  detach(entry) {
    for (const [emitter, event, listener] of entry.forwarders ?? []) emitter.off(event, listener);
    entry.forwarders = [];
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.current) {
      this.current.runtime.emit("change");
      this.detach(this.current);
      await this.current.runtime.close();
    }
  }

  logReloadFailure(error) {
    this.current?.runtime.addDiagnostic?.(
      `Codex runtime reload failed: ${error?.message ?? error}`,
    );
    this.logger.error?.(`Relay Codex runtime reload failed: ${error?.stack ?? error}`);
    this.emit("change");
  }

  whenReady() { return this.ready ?? Promise.reject(notStartedError()); }
  status() { return this.current?.runtime.status() ?? initialUnavailableStatus(); }
  listModels() { return structuredClone(this.current?.runtime.models ?? []); }
  hasSession(sessionId) { return this.current?.runtime.sessions.has(sessionId) ?? false; }
  getSession(...args) { return this.current?.runtime.getSession(...args) ?? null; }
  patchSession(sessionId, patch) {
    const session = this.current?.runtime.sessions.get(sessionId);
    if (session) Object.assign(session, structuredClone(patch));
    return Boolean(session);
  }
  listWorkspaceThreads(...args) { return this.current.runtime.listWorkspaceThreads(...args); }
  readThread(...args) { return this.current.runtime.readThread(...args); }
  createSession(...args) { return this.current.runtime.createSession(...args); }
  forkSession(...args) { return this.current.runtime.forkSession(...args); }
  resumeSession(...args) { return this.current.runtime.resumeSession(...args); }
  sendMessage(...args) { return this.current.runtime.sendMessage(...args); }
  interruptTurn(...args) { return this.current.runtime.interruptTurn(...args); }
  releaseSession(...args) { return this.current.runtime.releaseSession(...args); }
  resolveRequest(...args) { return this.current.runtime.resolveRequest(...args); }
  respondDynamicTool(...args) { return this.current.runtime.respondDynamicTool(...args); }
  rejectRequest(...args) { return this.current.runtime.rejectRequest(...args); }
  request(...args) { return this.current.client.request(...args); }
  subscribeActivity(listener) { return subscribe(this, "activity", listener); }
  subscribeRequest(listener) { return subscribe(this, "request", listener); }
  subscribeStatus(listener) { return subscribe(this, "connectionStatus", listener); }
  subscribeNotification(listener) { return subscribe(this, "notification", listener); }
}

function createAppServerClient(config) {
  try {
    return new CodexAppServerClient({
      command: config.command,
      args: config.args ?? RELAY_CODEX_APP_SERVER_ARGS,
      requestTimeoutMs: positiveInteger(config.requestTimeoutMs, 60_000),
    });
  } catch (error) {
    return new FailedCodexClient(error);
  }
}

class FailedCodexClient extends EventEmitter {
  constructor(error) {
    super();
    this.error = error;
    this.process = null;
  }

  async start() { throw this.error; }
  async request() { throw this.error; }
  respond() { throw this.error; }
  respondError() {}
  async close() {}
}

function executionCapability(runtime) {
  return Object.freeze({
    whenReady: () => runtime.whenReady(),
    status: () => runtime.status(),
    subscribeStatus: (listener) => runtime.subscribeStatus(listener),
    listModels: () => runtime.listModels(),
    hasSession: (sessionId) => runtime.hasSession(sessionId),
    getSession: (sessionId) => runtime.getSession(sessionId),
    patchSession: (sessionId, patch) => runtime.patchSession(sessionId, patch),
    async listWorkspaceThreads(...args) {
      await runtime.whenReady();
      return runtime.listWorkspaceThreads(...args);
    },
    async readThread(...args) {
      await runtime.whenReady();
      return runtime.readThread(...args);
    },
    createSession: runtime.createSession.bind(runtime),
    forkSession: runtime.forkSession.bind(runtime),
    resumeSession: runtime.resumeSession.bind(runtime),
    sendMessage: runtime.sendMessage.bind(runtime),
    interruptTurn: runtime.interruptTurn.bind(runtime),
    releaseSession: runtime.releaseSession.bind(runtime),
    resolveRequest: runtime.resolveRequest.bind(runtime),
    respondDynamicTool: runtime.respondDynamicTool.bind(runtime),
    rejectRequest: runtime.rejectRequest.bind(runtime),
    subscribeActivity: (listener) => runtime.subscribeActivity(listener),
    subscribeRequest: (listener) => runtime.subscribeRequest(listener),
  });
}

function terminalCapability(client) {
  return Object.freeze({
    whenReady: () => client.whenReady(),
    request: client.request.bind(client),
    subscribeNotification: listener => client.subscribeNotification(listener),
  });
}

function waitForRuntimeChange(runtime, predicate) {
  return new Promise((resolve) => {
    const check = () => {
      if (!predicate()) return;
      runtime.off("change", check);
      resolve();
    };
    runtime.on("change", check);
    check();
  });
}

function notStartedError() {
  const error = new Error("Codex runtime has not started");
  error.code = "CODEX_RUNTIME_NOT_STARTED";
  return error;
}

function initialUnavailableStatus() {
  return { state: "unavailable", code: "CODEX_RUNTIME_NOT_STARTED", message: "Codex runtime has not started." };
}

function subscribe(emitter, event, listener) {
  emitter.on(event, listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    emitter.off(event, listener);
  };
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
