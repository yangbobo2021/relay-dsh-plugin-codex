export const CODEX_CONNECTION_STATES = Object.freeze([
  "not-started",
  "starting",
  "connected",
  "connection-failed",
  "unavailable",
  "rebind-required",
]);

export function initialCodexConnectionStatus(now = Date.now()) {
  return Object.freeze({
    state: "not-started",
    code: "CODEX_APP_SERVER_NOT_STARTED",
    message: "Codex App Server has not started yet.",
    action: "Wait for DSH to finish starting the Codex plugin.",
    changedAt: now,
  });
}

export function startingCodexConnectionStatus(now = Date.now()) {
  return Object.freeze({
    state: "starting",
    code: "CODEX_APP_SERVER_STARTING",
    message: "Codex App Server is starting.",
    action: "Wait for the connection to finish.",
    changedAt: now,
  });
}

export function connectedCodexConnectionStatus(now = Date.now()) {
  return Object.freeze({
    state: "connected",
    code: "CODEX_APP_SERVER_CONNECTED",
    message: "Codex App Server is connected.",
    action: null,
    changedAt: now,
  });
}

export function codexConnectionFailure(error, now = Date.now()) {
  const code = typeof error?.code === "string" ? error.code : "CODEX_APP_SERVER_CONNECTION_FAILED";
  if (code === "CODEX_EXECUTABLE_NOT_FOUND") {
    return failure("unavailable", code,
      "Codex could not start because the configured executable was not found.",
      "Remove the invalid codexCommand or RELAY_CODEX_COMMAND override, or set it to an absolute Codex executable path.",
      now);
  }
  if (code === "CODEX_RUNTIME_MISSING") {
    return failure("unavailable", code,
      "The Codex App Server runtime for this computer is unavailable.",
      "Reinstall relay-dsh-plugin-codex so the platform runtime is restored, or set RELAY_CODEX_COMMAND to an absolute compatible executable.",
      now);
  }
  if (code === "CODEX_PLATFORM_UNSUPPORTED") {
    return failure("unavailable", code,
      "The bundled Codex App Server does not support this operating system or CPU architecture.",
      "Set RELAY_CODEX_COMMAND to an absolute path for a compatible Codex executable.",
      now);
  }
  if (code === "CODEX_APP_SERVER_NOT_RUNNING") {
    return failure("connection-failed", code,
      "Codex App Server is not running.",
      "Restart DSH. If the problem continues, inspect the Codex status in Settings and verify Codex authentication.",
      now);
  }
  return failure("connection-failed", code,
    "DSH could not connect to Codex App Server.",
    "Restart DSH and verify Codex authentication. If it still fails, inspect the Codex status diagnostics.",
    now);
}

export function codexOperationalError(error) {
  const status = codexConnectionFailure(error);
  const wrapped = new Error(`${status.message} ${status.action ?? ""}`.trim(), { cause: error });
  wrapped.code = status.code;
  return wrapped;
}

export function rebindRequiredStatus({ threadId, turnId = null, itemId = null }, now = Date.now()) {
  const provenance = [
    `original thread ${threadId}`,
    ...(turnId ? [`turn ${turnId}`] : []),
    ...(itemId ? [`item ${itemId}`] : []),
  ].join(", ");
  return failure("rebind-required", "CODEX_REBIND_REQUIRED",
    `This forked DSH Session could not establish a safe Codex child binding from ${provenance}.`,
    "Return to the original DSH Session and retry Fork after fixing the reported condition. Relay did not create a replacement Codex Thread.",
    now, { threadId, turnId, itemId });
}

function failure(state, code, message, action, changedAt, details) {
  return Object.freeze({
    state,
    code,
    message,
    action,
    changedAt,
    ...(details === undefined ? {} : { details: Object.freeze({ ...details }) }),
  });
}
