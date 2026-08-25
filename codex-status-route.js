export const CODEX_STATUS_PATH = "/api/relay/codex/status";

export function registerCodexStatusRoute(ctx, { runtime, adapter }) {
  return ctx.webServer.register({
    kind: "exact",
    path: CODEX_STATUS_PATH,
    handler: createCodexStatusHandler({ runtime, adapter }),
  });
}

export function createCodexStatusHandler({ runtime, adapter }) {
  if (!runtime?.status || !adapter?.statusForSession) {
    throw new Error("Codex status route requires runtime and adapter status providers");
  }
  return (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, {
        allow: "GET",
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(`${JSON.stringify({ error: "method_not_allowed" })}\n`);
      return;
    }
    const url = new URL(request.url ?? CODEX_STATUS_PATH, "http://relay.invalid");
    const sessionId = url.searchParams.get("sessionId");
    const status = sessionId ? adapter.statusForSession(sessionId) ?? runtime.status() : runtime.status();
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(`${JSON.stringify(status)}\n`);
  };
}
