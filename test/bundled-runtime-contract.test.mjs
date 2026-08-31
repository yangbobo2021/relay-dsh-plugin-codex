import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("bundled runtime supports session settings and background inventory without Desktop or login", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-contract-"));
  await mkdir(join(directory, "codex"));
  const clientUrl = new URL("../app-server-client.mjs", import.meta.url).href;
  const runtimeUrl = new URL("../session-runtime.mjs", import.meta.url).href;
  const source = `
    import assert from "node:assert/strict";
    import { CodexAppServerClient } from ${JSON.stringify(clientUrl)};
    import { CodexSessionRuntime } from ${JSON.stringify(runtimeUrl)};
    const client = new CodexAppServerClient({ requestTimeoutMs: 15_000 });
    const diagnostics = [];
    client.on("diagnostic", message => diagnostics.push(message));
    assert.equal(client.commandSource, "bundled");
    const runtime = new CodexSessionRuntime({ client, cwd: process.cwd() });
    try {
      await client.start();
      const session = await runtime.createSession({ model: "gpt-5.6-sol", effort: "high",
        sandbox: "danger-full-access", approvalPolicy: "never", ephemeral: true });
      assert.ok(session.id);
      assert.deepEqual(await runtime.listBackgroundTerminals(session.id), []);
      await runtime.syncThreadSettings(session.id, { model: "gpt-5.6-sol", effort: "low" });
      await runtime.syncThreadSettings(session.id, { model: "gpt-5.6-sol", effort: "high" });
      assert.deepEqual(await runtime.listBackgroundTerminals(session.id), []);
      console.log("BUNDLED_PROTOCOL_OK");
    } catch (error) {
      console.error(diagnostics.join("\\n").slice(-6000));
      throw error;
    } finally { await runtime.close(); }
  `;
  try {
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: directory,
      env: { ...process.env, CODEX_HOME: join(directory, "codex"), PATH: "",
        RELAY_CODEX_COMMAND: "", OPENAI_API_KEY: "", CODEX_API_KEY: "" },
      timeout: 45_000, windowsHide: true,
    });
    assert.match(stdout, /BUNDLED_PROTOCOL_OK/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
