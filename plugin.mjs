import { EventEmitter } from "node:events";
import { definePlugin } from "./internal/plugin-sdk.mjs";
import { CodexAppServerClient, NATIVE_CODEX_APP_SERVER_ARGS } from "./app-server-client.mjs";
import { CodexSessionRuntime } from "./session-runtime.mjs";

export const CODEX_EXECUTION_CAPABILITY = "relay.execution.codex.v1";
export const CODEX_TERMINAL_CAPABILITY = "relay.terminal.codex.v1";

export function createCodexExecutionPlugin(config = {}) {
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
      const client = config.client ?? createAppServerClient(config);
      const runtime = new CodexSessionRuntime({ client, cwd: config.cwd ?? process.cwd() });
      defer(() => runtime.close());
      const ready = runtime.initialize();
      void ready.catch((error) => {
        logger.error?.(`Relay Codex App Server failed to initialize: ${error?.stack ?? error}`);
      });

      return {
        capabilities: {
          [CODEX_EXECUTION_CAPABILITY]: executionCapability(runtime, ready),
          [CODEX_TERMINAL_CAPABILITY]: terminalCapability(client, ready),
        },
      };
    },
  });
}

function createAppServerClient(config) {
  try {
    return new CodexAppServerClient({
      command: config.command,
      args: config.args ?? NATIVE_CODEX_APP_SERVER_ARGS,
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

function executionCapability(runtime, ready) {
  return Object.freeze({
    whenReady: () => ready,
    status: () => runtime.status(),
    subscribeStatus: (listener) => subscribe(runtime, "connectionStatus", listener),
    listModels: () => structuredClone(runtime.models),
    hasSession: (sessionId) => runtime.sessions.has(sessionId),
    getSession: runtime.getSession.bind(runtime),
    patchSession(sessionId, patch) {
      const session = runtime.sessions.get(sessionId);
      if (session) Object.assign(session, structuredClone(patch));
      return Boolean(session);
    },
    async listWorkspaceThreads(...args) {
      await ready;
      return runtime.listWorkspaceThreads(...args);
    },
    async readThread(...args) {
      await ready;
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
    subscribeActivity: (listener) => subscribe(runtime, "activity", listener),
    subscribeRequest: (listener) => subscribe(runtime, "request", listener),
  });
}

function terminalCapability(client, ready) {
  return Object.freeze({
    whenReady: () => ready,
    request: client.request.bind(client),
    subscribeNotification: (listener) => subscribe(client, "notification", listener),
  });
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
