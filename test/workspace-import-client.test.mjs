import assert from "node:assert/strict";
import test from "node:test";

import {
  importCodexWorkspace,
  ndjsonFrames,
  refreshImportedWorkspace,
  resolveImportWorkspace,
  scanCodexWorkspace,
} from "../src/client/workspace-import-client.mjs";

test("Workspace target resolution prefers the current Session owner then recent Workspace", () => {
  const workspaces = {
    recentWorkspaceId: "workspace-recent",
    items: [
      { workspaceId: "workspace-current", title: "Current", path: "/current", sessionIds: ["session-1"] },
      { workspaceId: "workspace-recent", title: "Recent", path: "/recent", sessionIds: [] },
    ],
  };

  assert.equal(resolveImportWorkspace(workspaces, { current: "session-1" }).workspaceId, "workspace-current");
  assert.equal(resolveImportWorkspace(workspaces, { current: undefined }).workspaceId, "workspace-recent");
  assert.equal(resolveImportWorkspace({ items: [], recentWorkspaceId: undefined }, {}), null);
});

test("post-import refresh loads Sessions before Workspace membership", async () => {
  const calls = [];
  await refreshImportedWorkspace(
    { refresh: async () => { calls.push("sessions") } },
    { refresh: async () => { calls.push("workspaces") } },
  );
  assert.deepEqual(calls, ["sessions", "workspaces"]);
});

test("scan uses the aggregate endpoint and surfaces server failures", async () => {
  const requests = [];
  const fetchOk = async (path, init) => {
    requests.push({ path, init });
    return new Response(JSON.stringify({ summary: { found: 2, existing: 1, recoverable: 0, ready: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await scanCodexWorkspace("/workspace/relay", fetchOk);
  assert.equal(result.summary.ready, 1);
  assert.deepEqual(JSON.parse(requests[0].init.body), { action: "scan", cwd: "/workspace/relay" });

  await assert.rejects(
    scanCodexWorkspace("/workspace/missing", async () => new Response(
      JSON.stringify({ message: "Workspace is not registered in DSH" }),
      { status: 404, headers: { "content-type": "application/json" } },
    )),
    /Workspace is not registered in DSH/,
  );
});

test("NDJSON parsing survives arbitrary chunk boundaries", async () => {
  const frames = [];
  for await (const frame of ndjsonFrames(stream([
    '{"type":"pro',
    'gress","completed":1}\n{"type":"complete",',
    '"result":{"imported":1}}\n',
  ]))) frames.push(frame);
  assert.deepEqual(frames, [
    { type: "progress", completed: 1 },
    { type: "complete", result: { imported: 1 } },
  ]);
});

test("import sends selected Thread IDs, forwards progress, and requires one complete frame", async () => {
  const updates = [];
  let importBody = null;
  const complete = await importCodexWorkspace("/workspace/relay", {
    threadIds: ["thread-2"],
    onProgress: update => updates.push(update),
  }, async (_path, init) => {
    importBody = JSON.parse(init.body);
    return new Response(
      stream([
        '{"type":"progress","completed":1,"total":1}\n',
        '{"type":"complete","result":{"found":1,"imported":1,"existing":0,"failed":0,"failures":[]}}\n',
      ]),
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    );
  });
  assert.equal(updates.length, 1);
  assert.equal(complete.imported, 1);
  assert.deepEqual(importBody, {
    action: "import",
    cwd: "/workspace/relay",
    threadIds: ["thread-2"],
  });

  await assert.rejects(
    importCodexWorkspace("/workspace/relay", {}, async () => new Response(
      stream(['{"type":"progress","completed":1}\n']),
      { status: 200 },
    )),
    /ended before completion/,
  );
  await assert.rejects(
    importCodexWorkspace("/workspace/relay", {}, async () => new Response(
      stream(['{"type":"error","message":"App Server unavailable"}\n']),
      { status: 200 },
    )),
    /App Server unavailable/,
  );
});

function stream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
