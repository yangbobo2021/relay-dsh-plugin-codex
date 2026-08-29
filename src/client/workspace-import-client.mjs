import { CODEX_IMPORT_PATH } from "../../codex-import-contract.mjs";

export function resolveImportWorkspace(workspaces, sessions) {
  const current = sessions?.current;
  if (current !== undefined) {
    const owner = workspaces?.items?.find(workspace => workspace.sessionIds?.includes(current));
    if (owner) return owner;
  }
  const recent = workspaces?.recentWorkspaceId;
  return workspaces?.items?.find(workspace => workspace.workspaceId === recent) ?? null;
}

export async function scanCodexWorkspace(cwd, fetchImpl = fetch) {
  const response = await fetchImpl(CODEX_IMPORT_PATH, requestInit("scan", cwd));
  const body = await readJsonResponse(response);
  if (!response.ok) throw new Error(body?.message ?? `Codex import scan failed with HTTP ${response.status}`);
  return body;
}

export async function importCodexWorkspace(cwd, { threadIds, onProgress } = {}, fetchImpl = fetch) {
  const response = await fetchImpl(CODEX_IMPORT_PATH, requestInit("import", cwd, threadIds));
  if (!response.ok) {
    const body = await readJsonResponse(response);
    throw new Error(body?.message ?? `Codex import failed with HTTP ${response.status}`);
  }
  let completed = null;
  for await (const frame of ndjsonFrames(response.body)) {
    if (frame?.type === "progress") onProgress?.(frame);
    if (frame?.type === "complete") completed = frame.result;
    if (frame?.type === "error") throw new Error(frame.message ?? "Codex import failed");
  }
  if (completed === null) throw new Error("Codex import response ended before completion");
  return completed;
}

export async function refreshImportedWorkspace(sessions, workspaces) {
  await sessions.refresh();
  await workspaces.refresh();
}

export async function* ndjsonFrames(body) {
  if (!body || typeof body.getReader !== "function") throw new Error("Codex import response has no readable body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield parseFrame(line);
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    const finalLine = buffer.trim();
    if (finalLine) yield parseFrame(finalLine);
  } finally {
    reader.releaseLock();
  }
}

function requestInit(action, cwd, threadIds) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      cwd,
      ...(threadIds === undefined ? {} : { threadIds }),
    }),
  };
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseFrame(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error("Codex import returned malformed progress data");
  }
}
