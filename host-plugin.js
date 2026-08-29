import { fileURLToPath } from "node:url";
import { PluginHost } from "./internal/plugin-sdk.mjs";
import { createCodexExecutionPlugin } from "./plugin.mjs";
import { createDshCodexPlugin } from "./dsh-plugin.js";
import { installManagedPreset } from "./preset.js";
export const name = "relay-dsh-plugin-codex";
export const inject = [
  "agents", "approval", "attachments", "llm", "sessions", "sessionPersistence", "tools", "typert",
  "userQuestions", "webServer", "workspaceRegistry", "sessionTitle",
];

export async function apply(ctx, config = {}) {
  const host = new PluginHost();
  const release = ctx.effect(() => () => host.dispose(), "relay.codex()");
  try {
    await installManagedPreset(fileURLToPath(new URL("../presets/relay-codex", import.meta.url)), "relay-codex");
    await host.activate([
      createCodexExecutionPlugin({
        client: config.codex?.client, command: config.codexCommand, args: config.codexArgs,
        requestTimeoutMs: config.codexRequestTimeoutMs, cwd: config.cwd,
      }),
      createDshCodexPlugin(ctx, config),
    ]);
  } catch (error) {
    await release();
    throw error;
  }
}
