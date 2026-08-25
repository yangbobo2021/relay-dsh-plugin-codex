import assert from "node:assert/strict";
import test from "node:test";

import { installModelSelection } from "../model-selection.mjs";

test("switching a blank Session from Standard to Codex selects Codex capabilities", async () => {
  const harness = modelHarness({ preset: "standard", provider: "standard" });
  const stop = installModelSelection(
    harness.ctx, "relay-codex", "relay-codex", "relay-claude", { retryDelaysMs: [1, 2] },
  );
  await harness.settle();
  harness.setPreset("relay-codex");

  await waitFor(() => harness.currentProvider() === "relay-codex");
  assert.deepEqual(harness.selections.at(-1), {
    sessionId: "session-1",
    provider: "relay-codex",
    model: "codex-default",
    reasoningEffort: "medium",
  });
  stop();
});

test("Standard, Codex, and Claude round trips follow only the selected backend", async () => {
  const harness = modelHarness({ preset: "standard", provider: "standard" });
  const stopCodex = installModelSelection(
    harness.ctx, "relay-codex", "relay-codex", "relay-claude", { retryDelaysMs: [1] },
  );
  const stopClaude = installModelSelection(
    harness.ctx, "relay-claude", "relay-claude", "relay-codex", { retryDelaysMs: [1] },
  );
  await harness.settle();

  for (const [preset, provider] of [
    ["relay-codex", "relay-codex"],
    ["relay-claude", "relay-claude"],
    ["relay-codex", "relay-codex"],
    ["standard", "standard"],
  ]) {
    harness.setPreset(preset);
    await waitFor(() => harness.currentProvider() === provider);
  }
  assert.deepEqual(harness.selections.map(selection => selection.provider), [
    "relay-codex", "relay-claude", "relay-codex", "standard",
  ]);
  stopCodex();
  stopClaude();
});

test("a stale model query cannot overwrite a newer backend selection", async () => {
  const first = Promise.withResolvers();
  const harness = modelHarness({ preset: "standard", provider: "standard", firstQuery: first.promise });
  const stop = installModelSelection(
    harness.ctx, "relay-codex", "relay-codex", "relay-claude", { retryDelaysMs: [1] },
  );
  harness.setPreset("relay-codex");
  harness.setPreset("relay-claude");
  first.resolve(harness.response());
  await harness.settle();

  assert.equal(harness.selections.some(selection => selection.provider === "relay-codex"), false);
  stop();
});

test("Codex model discovery retries when its provider group is initially unavailable", async () => {
  const harness = modelHarness({ preset: "relay-codex", provider: "standard", codexReadyAfter: 2 });
  const stop = installModelSelection(
    harness.ctx, "relay-codex", "relay-codex", "relay-claude", { retryDelaysMs: [1, 2, 4] },
  );

  await waitFor(() => harness.currentProvider() === "relay-codex");
  assert.ok(harness.modelQueries() >= 3);
  stop();
});

test("a rejected model selection retries instead of silently keeping Standard", async () => {
  const harness = modelHarness({ preset: "relay-codex", provider: "standard", selectFails: 1 });
  const stop = installModelSelection(
    harness.ctx, "relay-codex", "relay-codex", "relay-claude", { retryDelaysMs: [1, 2] },
  );

  await waitFor(() => harness.currentProvider() === "relay-codex");
  assert.equal(harness.selections.length, 2);
  stop();
});

test("non-blank Sessions are never rewritten by preset synchronization", async () => {
  const harness = modelHarness({ preset: "standard", provider: "standard", blank: false });
  const stop = installModelSelection(harness.ctx, "relay-codex", "relay-codex", "relay-claude");
  harness.setPreset("relay-codex");
  await harness.settle();
  assert.deepEqual(harness.selections, []);
  assert.equal(harness.modelQueries(), 0);
  stop();
});

function modelHarness({
  preset,
  provider,
  blank = true,
  firstQuery = null,
  codexReadyAfter = 0,
  selectFails = 0,
}) {
  let state = { current: "session-1", byId: { "session-1": { id: "session-1", blank, agentPreset: preset } } };
  let currentProvider = provider;
  let queries = 0;
  const listeners = new Set();
  const selections = [];
  const response = () => ({ result: { ok: true, value: {
    current: { provider: currentProvider },
    groups: [
      { id: "standard", models: [{ id: "standard-default" }] },
      ...(queries > codexReadyAfter
        ? [{ id: "relay-codex", models: [{ id: "codex-default", reasoning: { defaultEffort: "medium" } }] }]
        : []),
      { id: "relay-claude", models: [{ id: "claude-default" }] },
    ],
  } } });
  const api = { sessions: {
    async models() {
      queries += 1;
      if (queries === 1 && firstQuery) return firstQuery;
      return response();
    },
    async selectModel(selection) {
      selections.push(selection);
      if (selections.length <= selectFails) {
        return { result: { ok: false, error: { code: "not-ready", message: "models changed" } } };
      }
      currentProvider = selection.provider;
      return { result: { ok: true, value: selection } };
    },
  } };
  return {
    ctx: {
      get: () => ({ api }),
      sessions: { list: {
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      } },
    },
    selections,
    response,
    currentProvider: () => currentProvider,
    modelQueries: () => queries,
    setPreset(agentPreset) {
      state = { ...state, byId: { ...state.byId, "session-1": { ...state.byId["session-1"], agentPreset } } };
      for (const listener of listeners) listener();
    },
    settle: () => new Promise(resolve => setTimeout(resolve, 10)),
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for model selection");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
