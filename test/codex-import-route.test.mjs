import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  CODEX_IMPORT_PATH,
  createCodexImportHandler,
  registerCodexImportRoute,
} from "../codex-import-route.js";

test("Codex import registers one exact DSH Web route", () => {
  let registration = null;
  const dispose = () => {};
  const result = registerCodexImportRoute({
    webServer: {
      register(value) {
        registration = value;
        return dispose;
      },
    },
    workspaceRegistry: registry(),
  }, { importer: importer() });

  assert.equal(result, dispose);
  assert.equal(registration.kind, "exact");
  assert.equal(registration.path, CODEX_IMPORT_PATH);
  assert.equal(typeof registration.handler, "function");
});

test("scan returns eligible Thread identities for only the selected registered Workspace", async () => {
  const service = importer();
  const handler = createCodexImportHandler({ importer: service, workspaceRegistry: registry() });
  const response = responseRecorder();

  await handler(request({ body: { action: "scan", cwd: "/workspace/relay" } }), response);

  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    workspace: { title: "Relay", path: "/workspace/relay" },
    summary: { found: 3, existing: 1, recoverable: 1, ready: 2 },
    candidates: [
      {
        id: "thread-ready",
        title: "Ready title",
        cwd: "/workspace/relay",
        updatedAt: 30,
        status: "ready",
      },
      {
        id: "thread-recoverable",
        title: "Recoverable preview",
        cwd: "/workspace/relay",
        updatedAt: 20,
        status: "recoverable",
      },
    ],
  });
  assert.deepEqual(service.scans, ["/workspace/relay"]);
});

test("import streams monotonic progress and a final aggregate result", async () => {
  const service = importer();
  const handler = createCodexImportHandler({ importer: service, workspaceRegistry: registry() });
  const response = responseRecorder();

  await handler(request({
    body: { action: "import", cwd: "/workspace/relay", threadIds: ["thread-ready"] },
  }), response);

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/x-ndjson; charset=utf-8");
  assert.deepEqual(response.lines, [
    { type: "progress", completed: 1, total: 2, found: 3, imported: 1, existing: 0, failed: 0 },
    { type: "progress", completed: 2, total: 2, found: 3, imported: 1, existing: 1, failed: 0 },
    { type: "complete", result: { found: 3, imported: 1, existing: 1, failed: 0 } },
  ]);
  assert.deepEqual(service.imports, [{ cwd: "/workspace/relay", threadIds: ["thread-ready"] }]);
});

test("import keeps the omitted threadIds contract for compatible clients", async () => {
  const service = importer();
  const handler = createCodexImportHandler({ importer: service, workspaceRegistry: registry() });
  const response = responseRecorder();

  await handler(request({ body: { action: "import", cwd: "/workspace/relay" } }), response);

  assert.equal(response.status, 200);
  assert.deepEqual(service.imports, [{ cwd: "/workspace/relay", threadIds: undefined }]);
});

test("route rejects unsafe methods, bodies, Workspaces, and remote callers", async () => {
  const service = importer();
  const handler = createCodexImportHandler({
    importer: service,
    workspaceRegistry: registry(),
    token: "import-secret",
    maxBodyBytes: 128,
  });

  const wrongMethod = responseRecorder();
  await handler(request({ method: "GET" }), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const remote = responseRecorder();
  await handler(request({
    remoteAddress: "10.0.0.8",
    body: { action: "scan", cwd: "/workspace/relay" },
  }), remote);
  assert.equal(remote.status, 403);

  const authorizedRemote = responseRecorder();
  await handler(request({
    remoteAddress: "10.0.0.8",
    headers: { authorization: "Bearer import-secret" },
    body: { action: "scan", cwd: "/workspace/relay" },
  }), authorizedRemote);
  assert.equal(authorizedRemote.status, 200);

  const unknownWorkspace = responseRecorder();
  await handler(request({ body: { action: "scan", cwd: "/workspace/other" } }), unknownWorkspace);
  assert.equal(unknownWorkspace.status, 404);

  const invalidAction = responseRecorder();
  await handler(request({ body: { action: "delete", cwd: "/workspace/relay" } }), invalidAction);
  assert.equal(invalidAction.status, 400);

  const invalidContentType = responseRecorder();
  await handler(request({
    body: { action: "scan", cwd: "/workspace/relay" },
    headers: { "content-type": "text/plain" },
  }), invalidContentType);
  assert.equal(invalidContentType.status, 400);

  const malformed = responseRecorder();
  await handler(request({ rawBody: "{" }), malformed);
  assert.equal(malformed.status, 400);

  const oversized = responseRecorder();
  await handler(request({
    body: { action: "scan", cwd: "/workspace/relay", padding: "x".repeat(200) },
  }), oversized);
  assert.equal(oversized.status, 413);
  const duplicateIds = responseRecorder();
  await handler(request({
    body: { action: "import", cwd: "/workspace/relay", threadIds: ["same", "same"] },
  }), duplicateIds);
  assert.equal(duplicateIds.status, 400);
  assert.equal(service.scans.length, 1);
  assert.equal(service.imports.length, 0);
});

function importer() {
  return {
    scans: [],
    imports: [],
    async scanWorkspace(cwd) {
      this.scans.push(cwd);
      return {
        summary: { found: 3, existing: 1, recoverable: 1, ready: 2 },
        entries: [
          {
            thread: { id: "thread-ready", name: "Ready title", preview: "ignored", cwd, updatedAt: 30 },
            status: "ready",
          },
          {
            thread: { id: "thread-recoverable", name: null, preview: "Recoverable\npreview", cwd, updatedAt: 20 },
            status: "recoverable",
          },
          {
            thread: { id: "thread-existing", name: "Bound", preview: "bound", cwd, updatedAt: 10 },
            status: "existing",
          },
        ],
      };
    },
    async importWorkspace(cwd, { threadIds, onProgress }) {
      this.imports.push({ cwd, threadIds });
      onProgress({ completed: 1, total: 2, found: 3, imported: 1, existing: 0, failed: 0 });
      onProgress({ completed: 2, total: 2, found: 3, imported: 1, existing: 1, failed: 0 });
      return { found: 3, imported: 1, existing: 1, failed: 0 };
    },
  };
}

function registry() {
  return {
    async resolveByPath(path) {
      return path === "/workspace/relay"
        ? { title: "Relay", path: "/workspace/relay" }
        : undefined;
    },
  };
}

function request({
  body,
  rawBody,
  method = "POST",
  remoteAddress = "127.0.0.1",
  headers = {},
} = {}) {
  const encoded = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const stream = Readable.from(encoded === undefined ? [] : [encoded]);
  stream.method = method;
  stream.headers = { "content-type": "application/json", ...headers };
  stream.socket = { remoteAddress };
  return stream;
}

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: "",
    json: null,
    lines: [],
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(body = "") {
      this.body += body;
      this.lines = this.body.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    },
    end(body = "") {
      if (body) this.body += body;
      if (this.headers?.["content-type"]?.startsWith("application/json")) {
        this.json = this.body ? JSON.parse(this.body) : null;
      } else {
        this.lines = this.body.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      }
    },
  };
}
