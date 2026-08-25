export const CODEX_STATUS_PATH = "/api/relay/codex/status";

export async function fetchCodexStatus(sessionId, fetchImpl = fetch) {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const response = await fetchImpl(`${CODEX_STATUS_PATH}${query}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !validStatus(body)) {
    throw new Error(body?.message ?? `Codex status failed with HTTP ${response.status}`);
  }
  return body;
}

export function statusLocaleKey(status) {
  if (!status) return "statusLoading";
  if (status.state === "connected") return "statusConnected";
  if (status.state === "not-started") return "statusNotStarted";
  if (status.state === "starting") return "statusStarting";
  if (status.state === "rebind-required") return "statusRebindRequired";
  if (status.state === "unavailable") return "statusUnavailable";
  return "statusConnectionFailed";
}

function validStatus(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.state === "string"
    && typeof value.code === "string"
    && typeof value.message === "string";
}
