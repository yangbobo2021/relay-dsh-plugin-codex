import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import { CallId, createMessage, LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { CODEX_ACTIVITY_TOOL } from "./codex-activity-wire.mjs";

import { importCodexGeneratedImage, importCodexImage, importCodexMcpImage } from "./codex-image.js";
import { materializeCodexAttachment } from "./codex-image-input.js";
import { CODEX_APP_DYNAMIC_TOOLS, codexDynamicTools } from "./codex-tools.js";
import { rebindRequiredStatus } from "./connection-status.mjs";
import { CODEX_EXECUTION_GUIDANCE } from "./execution-guidance.mjs";

export const CODEX_PRESET = "relay-codex";
export const CODEX_PROVIDER = "relay-codex";
export const CODEX_THREAD_ACTIVE_WRITER = "CODEX_THREAD_ACTIVE_WRITER";
const CODEX_AUXILIARY_THREAD_SOURCE = "relay.codex.auxiliary";
const IMPORT_STATES = Object.freeze([
  "reserved", "session-created", "hydrated", "attached", "committed",
]);

export class CodexDshAdapter extends LlmAdapter {
  constructor({
    runtime,
    ready,
    linkStore = null,
    attachments = null,
    logger = console,
    dynamicTools = CODEX_APP_DYNAMIC_TOOLS,
    executionGuidance = true,
    executionMode = "enhanced",
  }) {
    super();
    this.runtime = runtime;
    this.ready = ready;
    this.logger = logger;
    this.linkStore = linkStore;
    this.attachments = attachments;
    if (!["enhanced", "native"].includes(executionMode)) {
      throw new Error(`Unknown Codex execution mode: ${executionMode}`);
    }
    this.executionMode = executionMode;
    this.dynamicTools = executionMode === "native" ? [] : dynamicTools;
    this.executionGuidance = executionMode !== "native" && executionGuidance ? CODEX_EXECUTION_GUIDANCE : undefined;
    this.links = new Map();
    this.settings = new Map();
    this.bindingModes = new Map();
    this.importStates = new Map();
    this.dshOwnedTurnIds = new Map();
    this.pendingThreads = new Map();
    this.agents = new Map();
    this.dshToolNames = new Map();
    this.appliedDynamicToolSignatures = new Map();
    this.rebindStates = new Map();
    this.bindingEpochs = new Map();
    this.subagentBindings = new Map();
    this.subagentBindingConflicts = new Set();
    this.activeRootTurns = new Map();
    this.activeTurnSignals = new Map();
    for (const [sessionId, record] of linkStore?.entries() ?? []) {
      if (record.threadId) this.links.set(sessionId, record.threadId);
      this.settings.set(sessionId, record.config);
      this.bindingModes.set(sessionId, record.bindingMode === "imported" ? "imported" : "native");
      if (record.bindingMode === "imported" && IMPORT_STATES.includes(record.importState)) {
        this.importStates.set(sessionId, record.importState);
      }
      if (Array.isArray(record.dshTurnIds)) {
        this.dshOwnedTurnIds.set(sessionId, new Set(record.dshTurnIds));
      }
    }
  }

  providerInfo() {
    return { id: CODEX_PROVIDER, name: "Codex" };
  }

  async listModels() {
    await this.ready;
    return runtimeModels(this.runtime)
      .sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)))
      .map((model) => ({
        provider: CODEX_PROVIDER,
        id: model.id,
        name: model.displayName ?? model.id,
        description: model.description,
        inputModalities: ["text", "image"],
      }));
  }

  async resolveModel(provider, model) {
    await this.ready;
    const info = runtimeModels(this.runtime).find((candidate) => candidate.id === model);
    return {
      provider,
      id: model,
      name: info?.displayName ?? model,
      inputModalities: ["text", "image"],
      ...(Array.isArray(info?.supportedReasoningEfforts)
        ? {
            reasoning: {
              efforts: info.supportedReasoningEfforts.map((effort) => ({
                id: effort.reasoningEffort ?? effort.id ?? effort,
                name: reasoningEffortName(effort.reasoningEffort ?? effort.id ?? effort),
              })),
              defaultEffort: info.defaultReasoningEffort,
            },
          }
        : {}),
    };
  }

  attachAgent(agent, requestedPreset = effectivePreset(agent.session)) {
    this.agents.set(String(agent.id), agent);
    if (requestedPreset !== CODEX_PRESET) {
      return false;
    }
    this.configuration(agent.id, agent.session.header.cwd);
    return true;
  }

  servesAgent(agent) {
    return effectivePreset(agent.session) === CODEX_PRESET;
  }

  detachAgent(sessionId) {
    const key = String(sessionId);
    this.agents.delete(key);
    this.dshToolNames.delete(key);
    this.appliedDynamicToolSignatures.delete(key);
    this.releaseSubagentBindings(key);
    this.bumpBindingEpoch(key);
  }

  configuration(sessionId, cwd) {
    const key = String(sessionId);
    const existing = this.settings.get(key);
    if (existing) return existing;
    const models = runtimeModels(this.runtime);
    const model = models.find((candidate) => candidate.isDefault) ?? models[0];
    const config = {
      model: model?.id ?? "gpt-5-codex",
      effort: model?.defaultReasoningEffort ?? null,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      cwd: cwd ?? process.cwd(),
    };
    this.settings.set(key, config);
    return config;
  }

  configure(sessionId, patch = {}) {
    const key = String(sessionId);
    const next = { ...this.configuration(key), ...compact(patch) };
    this.settings.set(key, next);
    const threadId = this.links.get(key);
    if (threadId) {
      patchRuntimeSession(this.runtime, threadId, next);
    }
    this.persistLink(key);
    return structuredClone(next);
  }

  async ensureThread(sessionId, dynamicTools = this.dynamicTools, inheritedProvenance = null) {
    const key = String(sessionId);
    const pending = this.pendingThreads.get(key);
    if (pending) return pending;
    const blocked = this.rebindStates.get(key);
    if (blocked && !sameProvenance(blocked.details, inheritedProvenance)) {
      throw rebindRequiredError(blocked);
    }
    const operation = (!this.links.has(key) && inheritedProvenance?.threadId
      ? this.forkInheritedThread(key, dynamicTools, inheritedProvenance)
      : this.createOrResumeThread(key, dynamicTools)).finally(() => {
      this.pendingThreads.delete(key);
    });
    this.pendingThreads.set(key, operation);
    return operation;
  }

  async forkInheritedThread(sessionId, dynamicTools, provenance) {
    await this.ready;
    const sourceSessionId = this.dshSessionForThread(provenance.threadId);
    if (!provenance.turnId
      || !sourceSessionId
      || sourceSessionId === sessionId
      || this.rebindStates.has(sourceSessionId)) {
      this.logger.error(
        `Codex App Server thread/fork was not authorized for child ${sessionId}: `
        + `thread=${provenance.threadId}, turn=${provenance.turnId ?? "missing"}, `
        + `sourceSession=${sourceSessionId ?? "missing"}, `
        + `sourceRequiresRebind=${sourceSessionId ? this.rebindStates.has(sourceSessionId) : false}`,
      );
      throw this.enterRebindRequired(sessionId, provenance);
    }
    const settings = { ...this.configuration(sessionId), dynamicTools };
    let forked;
    try {
      forked = await this.runtime.forkSession(provenance.threadId, {
        ...settings,
        lastTurnId: provenance.turnId,
      });
    } catch (cause) {
      this.logger.error(
        `Codex App Server thread/fork failed for thread ${provenance.threadId}, `
        + `turn ${provenance.turnId}: ${cause?.stack ?? cause}`,
      );
      throw this.enterRebindRequired(sessionId, provenance, cause);
    }
    const existingSession = this.dshSessionForThread(forked?.id);
    if (!forked?.id || forked.id === provenance.threadId
      || (existingSession && existingSession !== sessionId)) {
      throw this.enterRebindRequired(sessionId, provenance,
        new Error("Codex App Server returned an invalid or already-bound forked Thread"));
    }

    this.links.set(sessionId, forked.id);
    this.bindingModes.set(sessionId, "native");
    this.rebindStates.delete(sessionId);
    this.bumpBindingEpoch(sessionId);
    this.persistLink(sessionId);

    const signature = JSON.stringify(dynamicTools);
    const sourceSignature = this.appliedDynamicToolSignatures.get(sourceSessionId);
    if (sourceSignature !== signature) {
      try {
        await this.runtime.resumeSession(forked.id, settings);
      } catch (error) {
        throw persistedResumeError(sessionId, forked.id, error, this);
      }
    }
    this.appliedDynamicToolSignatures.set(sessionId, signature);
    return forked.id;
  }

  enterRebindRequired(sessionId, provenance, cause) {
    const status = rebindRequiredStatus(provenance);
    this.rebindStates.set(String(sessionId), status);
    this.bumpBindingEpoch(sessionId);
    return rebindRequiredError(status, cause);
  }

  async createOrResumeThread(sessionId, dynamicTools) {
    await this.ready;
    const settings = { ...this.configuration(sessionId), dynamicTools };
    const signature = JSON.stringify(dynamicTools);
    const linked = this.links.get(sessionId);
    if (linked && hasRuntimeSession(this.runtime, linked)) {
      if (this.appliedDynamicToolSignatures.get(sessionId) !== signature) {
        await this.runtime.resumeSession(linked, settings);
        this.appliedDynamicToolSignatures.set(sessionId, signature);
      }
      return linked;
    }
    if (linked) {
      try {
        await this.runtime.resumeSession(linked, settings);
        this.appliedDynamicToolSignatures.set(sessionId, signature);
        return linked;
      } catch (error) {
        throw persistedResumeError(sessionId, linked, error, this);
      }
    }
    const created = await this.runtime.createSession({
      ...settings,
      ...(this.executionGuidance ? { developerInstructions: settings.developerInstructions ?? this.executionGuidance } : {}),
    });
    this.links.set(sessionId, created.id);
    this.bumpBindingEpoch(sessionId);
    this.appliedDynamicToolSignatures.set(sessionId, signature);
    this.persistLink(sessionId);
    return created.id;
  }

  persistLink(sessionId) {
    this.linkStore?.set(sessionId, {
      threadId: this.links.get(sessionId) ?? null,
      config: this.configuration(sessionId),
      bindingMode: this.bindingModes.get(sessionId) ?? "native",
      ...(this.importStates.has(sessionId) ? { importState: this.importStates.get(sessionId) } : {}),
      ...(this.dshOwnedTurnIds.has(sessionId)
        ? { dshTurnIds: [...this.dshOwnedTurnIds.get(sessionId)].sort() }
        : {}),
    });
  }

  bindImportedThread(sessionId, threadId, config = {}) {
    const key = String(sessionId ?? "").trim();
    const candidate = String(threadId ?? "").trim();
    if (!key) throw new Error("DSH sessionId is required for an imported binding");
    if (!candidate) throw new Error("Codex threadId is required for an imported binding");
    const existingSession = this.dshSessionForThread(candidate);
    if (existingSession && existingSession !== key) {
      throw new Error(`Codex thread ${candidate} is already bound to DSH session ${existingSession}`);
    }
    const existingThread = this.links.get(key);
    if (existingThread && existingThread !== candidate) {
      throw new Error(`DSH session ${key} is already bound to Codex thread ${existingThread}`);
    }
    const nextConfig = { ...this.configuration(key, config.cwd), ...compact(config) };
    this.links.set(key, candidate);
    this.rebindStates.delete(key);
    this.bumpBindingEpoch(key);
    this.settings.set(key, nextConfig);
    this.bindingModes.set(key, "imported");
    if (!this.importStates.has(key)) this.importStates.set(key, "reserved");
    this.persistLink(key);
    return this.bindingForSession(key);
  }

  replaceImportedSession(oldSessionId, newSessionId) {
    const oldKey = String(oldSessionId ?? "").trim();
    const newKey = String(newSessionId ?? "").trim();
    if (!oldKey) throw new Error("Old DSH sessionId is required for an imported binding replacement");
    if (!newKey) throw new Error("New DSH sessionId is required for an imported binding replacement");
    if (oldKey === newKey) return this.bindingForSession(oldKey);
    if (this.bindingModes.get(oldKey) !== "imported") {
      throw new Error(`DSH session ${oldKey} is not an imported Codex binding`);
    }
    const threadId = this.links.get(oldKey);
    if (!threadId) throw new Error(`DSH session ${oldKey} is not bound to a Codex thread`);
    const existingSession = this.dshSessionForThread(threadId);
    if (existingSession && existingSession !== oldKey) {
      throw new Error(`Codex thread ${threadId} is already bound to DSH session ${existingSession}`);
    }
    const existingThread = this.links.get(newKey);
    if (existingThread && existingThread !== threadId) {
      throw new Error(`DSH session ${newKey} is already bound to Codex thread ${existingThread}`);
    }

    const config = structuredClone(this.configuration(oldKey));
    const ownedTurnIds = this.dshOwnedTurnIds.get(oldKey);
    const replacementRecord = {
      threadId,
      config,
      bindingMode: "imported",
      importState: "committed",
      ...(ownedTurnIds ? { dshTurnIds: [...ownedTurnIds].sort() } : {}),
    };
    this.linkStore?.replace(oldKey, newKey, replacementRecord);

    this.links.delete(oldKey);
    this.settings.delete(oldKey);
    this.bindingModes.delete(oldKey);
    this.importStates.delete(oldKey);
    this.dshOwnedTurnIds.delete(oldKey);
    this.appliedDynamicToolSignatures.delete(oldKey);

    this.links.set(newKey, threadId);
    this.rebindStates.delete(newKey);
    this.bumpBindingEpoch(oldKey);
    this.bumpBindingEpoch(newKey);
    this.settings.set(newKey, config);
    this.bindingModes.set(newKey, "imported");
    this.importStates.set(newKey, "committed");
    if (ownedTurnIds) this.dshOwnedTurnIds.set(newKey, new Set(ownedTurnIds));
    return this.bindingForSession(newKey);
  }

  markImportState(sessionId, state) {
    const key = String(sessionId);
    if (this.bindingModes.get(key) !== "imported") {
      throw new Error(`DSH session ${key} is not an imported Codex binding`);
    }
    const nextIndex = IMPORT_STATES.indexOf(state);
    if (nextIndex === -1) throw new Error(`unknown Codex import state ${state}`);
    const current = this.importStates.get(key) ?? "reserved";
    if (nextIndex >= IMPORT_STATES.indexOf(current)) {
      this.importStates.set(key, state);
      this.persistLink(key);
    }
    return this.bindingForSession(key);
  }

  bindingForSession(sessionId) {
    const key = String(sessionId);
    const threadId = this.links.get(key);
    if (!threadId) return null;
    return {
      sessionId: key,
      threadId,
      config: structuredClone(this.configuration(key)),
      bindingMode: this.bindingModes.get(key) ?? "native",
      importState: this.importStates.get(key) ?? null,
    };
  }

  bindingForThread(threadId) {
    const sessionId = this.dshSessionForThread(String(threadId));
    return sessionId ? this.bindingForSession(sessionId) : null;
  }

  ownedTurnIdsForSession(sessionId) {
    return new Set(this.dshOwnedTurnIds.get(String(sessionId)) ?? []);
  }

  recordOwnedTurn(sessionId, turnId) {
    const key = String(sessionId);
    if (this.bindingModes.get(key) !== "imported") return;
    const candidate = String(turnId ?? "").trim();
    if (!candidate) throw new Error("Codex turnId is required");
    let turns = this.dshOwnedTurnIds.get(key);
    if (!turns) {
      turns = new Set();
      this.dshOwnedTurnIds.set(key, turns);
    }
    if (turns.has(candidate)) return;
    turns.add(candidate);
    this.persistLink(key);
  }

  threadFor(sessionId) {
    return this.links.get(String(sessionId)) ?? null;
  }

  dshSessionForThread(threadId) {
    for (const [sessionId, candidate] of this.links) {
      if (candidate === threadId) return sessionId;
    }
    return null;
  }

  interactionBindingForThread(threadId) {
    const requestThreadId = optionalIdentity(threadId);
    if (!requestThreadId) return null;
    const directSessionId = this.dshSessionForThread(requestThreadId);
    if (directSessionId) {
      return Object.freeze({
        sessionId: directSessionId,
        rootThreadId: requestThreadId,
        requestThreadId,
      });
    }

    if (this.subagentBindingConflicts.has(requestThreadId)) return null;
    const observed = this.subagentBindings.get(requestThreadId);
    if (observed) {
      const visited = new Set();
      let currentThreadId = requestThreadId;
      while (currentThreadId !== observed.rootThreadId) {
        if (visited.has(currentThreadId) || this.subagentBindingConflicts.has(currentThreadId)) {
          return null;
        }
        visited.add(currentThreadId);
        const current = this.subagentBindings.get(currentThreadId);
        if (!current
          || current.sessionId !== observed.sessionId
          || current.rootThreadId !== observed.rootThreadId
          || current.epoch !== observed.epoch) {
          return null;
        }
        currentThreadId = current.parentThreadId;
      }
      if (this.links.get(observed.sessionId) !== observed.rootThreadId
        || (this.bindingEpochs.get(observed.sessionId) ?? 0) !== observed.epoch
        || this.rebindStates.has(observed.sessionId)
        || !this.activeRootTurns.has(observed.rootThreadId)) {
        return null;
      }
      return Object.freeze({
        sessionId: observed.sessionId,
        rootThreadId: observed.rootThreadId,
        requestThreadId,
      });
    }

    return null;
  }

  observeSubagentActivity(message) {
    if (message.method !== "item/started" && message.method !== "item/completed") return false;
    const item = message.params?.item;
    if (item?.type !== "subAgentActivity") return false;
    const parentThreadId = optionalIdentity(message.params?.threadId);
    const childThreadId = optionalIdentity(item.agentThreadId);
    if (!parentThreadId || !childThreadId || parentThreadId === childThreadId) return false;
    if (this.subagentBindingConflicts.has(childThreadId)) return false;
    const parent = this.interactionBindingForThread(parentThreadId);
    if (!parent) return false;
    const next = Object.freeze({
      sessionId: parent.sessionId,
      rootThreadId: parent.rootThreadId,
      parentThreadId,
      epoch: this.bindingEpochs.get(parent.sessionId) ?? 0,
    });
    const current = this.subagentBindings.get(childThreadId);
    if (current && !sameSubagentBinding(current, next)) {
      this.subagentBindings.delete(childThreadId);
      this.subagentBindingConflicts.add(childThreadId);
      return false;
    }
    this.subagentBindings.set(childThreadId, next);
    return true;
  }

  releaseSubagentBindings(sessionId, rootThreadId = null) {
    const key = String(sessionId);
    for (const [threadId, binding] of this.subagentBindings) {
      if (binding.sessionId === key && (!rootThreadId || binding.rootThreadId === rootThreadId)) {
        this.subagentBindings.delete(threadId);
      }
    }
  }

  dshSessionForInteractionThread(threadId) {
    return this.interactionBindingForThread(threadId)?.sessionId ?? null;
  }

  statusForSession(sessionId) {
    const status = this.rebindStates.get(String(sessionId));
    return status ? structuredClone(status) : null;
  }

  captureRequestOwnership(request) {
    const threadId = requiredIdentity(
      request.params?.threadId ?? request.params?.conversationId,
      "threadId",
    );
    const binding = this.interactionBindingForThread(threadId);
    if (!binding) throw requestOwnershipError(request, "has no owning DSH Session");
    if (this.rebindStates.has(binding.sessionId)) throw requestOwnershipError(request, "requires rebind");
    return Object.freeze({
      requestId: String(request.id),
      sessionId: binding.sessionId,
      threadId,
      rootThreadId: binding.rootThreadId,
      turnId: optionalIdentity(request.params?.turnId),
      itemId: optionalIdentity(request.params?.itemId ?? request.params?.callId),
      epoch: this.bindingEpochs.get(binding.sessionId) ?? 0,
    });
  }

  assertRequestOwnership(ownership, request) {
    const currentBinding = this.interactionBindingForThread(ownership.threadId);
    const currentEpoch = this.bindingEpochs.get(ownership.sessionId) ?? 0;
    const currentTurn = optionalIdentity(request.params?.turnId);
    const currentItem = optionalIdentity(request.params?.itemId ?? request.params?.callId);
    if (String(request.id) !== ownership.requestId
      || currentBinding?.sessionId !== ownership.sessionId
      || currentBinding?.rootThreadId !== ownership.rootThreadId
      || this.links.get(ownership.sessionId) !== ownership.rootThreadId
      || currentEpoch !== ownership.epoch
      || currentTurn !== ownership.turnId
      || currentItem !== ownership.itemId
      || !this.agents.has(ownership.sessionId)
      || this.rebindStates.has(ownership.sessionId)) {
      throw requestOwnershipError(request,
        `is stale for DSH Session ${ownership.sessionId}; rebind required`, ownership);
    }
    return true;
  }

  bumpBindingEpoch(sessionId) {
    const key = String(sessionId);
    this.bindingEpochs.set(key, (this.bindingEpochs.get(key) ?? 0) + 1);
  }

  hasDshTool(sessionId, name) {
    return this.dshToolNames.get(String(sessionId))?.has(name) === true;
  }

  signalForInteractionThread(threadId) {
    const binding = this.interactionBindingForThread(threadId);
    return binding ? this.activeTurnSignals.get(binding.rootThreadId) : undefined;
  }

  async *stream(options) {
    if (options.purpose) {
      yield* this.streamAuxiliary(options);
      return;
    }
    const sessionId = String(options.sessionId ?? "");
    if (!sessionId) throw new Error("Relay Codex adapter requires a DSH session id");
    const input = await latestUserInput(options.messages, this.attachments, options.signal);
    if (!input) throw new Error("Relay Codex adapter received no user text or image input");
    const agent = this.agents.get(sessionId);
    if (!agent) throw new Error(`Relay Codex adapter has no attached agent for ${sessionId}`);

    const nativePermissions = permissionConfiguration(agent.session.events);
    const config = this.configure(sessionId, {
      ...(options.provider === CODEX_PROVIDER ? { model: options.model } : {}),
      ...(options.provider === CODEX_PROVIDER ? { effort: options.reasoningEffort } : {}),
      ...nativePermissions,
      cwd: agent.session.header.cwd,
    });
    const dshTools = this.executionMode === "native" ? [] : options.tools ?? [];
    this.dshToolNames.set(sessionId, new Set(dshTools.map(tool => tool.name)));
    const threadId = await this.ensureThread(
      sessionId,
      codexDynamicTools(dshTools, this.dynamicTools),
      inheritedCodexProvenance(options.messages),
    );
    const queue = new ActivityQueue(options.signal);
    const onActivity = (message) => {
      this.observeSubagentActivity(message);
      const candidate = message.params?.threadId ?? message.params?.thread?.id;
      if (candidate === threadId) queue.push(message);
    };
    const stopActivity = subscribeRuntimeActivity(this.runtime, onActivity);
    this.activeRootTurns.set(threadId, (this.activeRootTurns.get(threadId) ?? 0) + 1);
    const turnController = new AbortController();
    const turnSignal = options.signal ? AbortSignal.any([options.signal, turnController.signal]) : turnController.signal;
    this.activeTurnSignals.set(threadId, turnSignal);

    let turnId = null;
    const state = createStreamState();
    const step = agent.session.events.findLast(event => event.type === "step/start");
    const turn = agent.session.events.findLast(event => event.type === "turn/start");
    state.location = { turn: turn?.data.turn ?? 1, step: step?.data.step ?? 1 };
    try {
      const started = await this.runtime.sendMessage(threadId, {
        ...input,
        ...config,
        reasoningSummary: "auto",
      });
      turnId = started.id;
      this.recordOwnedTurn(sessionId, turnId);
      let completedTurn = null;
      while (!completedTurn) {
        const message = await queue.next();
        const params = message.params ?? {};
        if (params.turnId && params.turnId !== turnId) continue;
        if (message.method === "turn/completed") {
          if (params.turn?.id !== turnId) continue;
          for (const item of params.turn.items ?? []) {
            for (const chunk of await this.completeItem(agent, threadId, turnId, item, state)) yield chunk;
          }
          completedTurn = params.turn;
          break;
        }
        for (const chunk of await this.projectActivity(agent, threadId, turnId, message, state)) yield chunk;
      }

      for (const block of state.blocks.values()) {
        if (block.closed) continue;
        block.closed = true;
        yield { type: "block-end", index: block.index, block: { type: block.type, text: block.text } };
      }
      if (completedTurn.status === "failed") {
        yield {
          type: "finish",
          reason: { kind: "error", failure: { message: completedTurn.error?.message ?? "Codex turn failed", code: "CODEX_TURN_FAILED" } },
        };
      } else {
        yield {
          type: "finish", reason: { kind: "stop" },
          replayState: { response: {
            threadId, turnId,
            codexPresentation: {
              version: 1,
              blocks: [...state.blocks].map(([itemId, block]) => ({
                index: block.index, itemId, phase: state.textPhases.get(itemId) ?? null,
              })),
            },
          } },
        };
      }
    } catch (error) {
      if (options.signal?.aborted) {
        yield await interruptedTurnFinish({
          runtime: this.runtime,
          logger: this.logger,
          threadId,
          turnId,
          cancelledMessage: "Codex turn cancelled",
        });
        return;
      }
      throw error;
    } finally {
      turnController.abort();
      if (this.activeTurnSignals.get(threadId) === turnSignal) this.activeTurnSignals.delete(threadId);
      // Interrupt RPCs can deliver the last stdout/settlement after next() has
      // rejected. Retain only already-owned commands, never new work or prose.
      if (options.signal?.aborted) {
        for (const message of queue.drain()) {
          const params = message.params ?? {};
          if ((params.turnId ?? params.turn?.id) !== turnId) continue;
          if (message.method === "item/commandExecution/outputDelta" && state.activityItems.has(params.itemId)
            || message.method === "item/codeModeShell/outputDelta"
              && [...state.commandKeys.values()].includes(commandProcessKey(params.processId))) {
            await this.projectActivity(agent, threadId, turnId, message, state);
          }
          const items = message.method === "item/completed" ? [params.item]
            : message.method === "turn/completed" ? params.turn.items ?? [] : [];
          for (const item of items) {
            if (item?.type === "commandExecution" && state.activityItems.has(item.id)) {
              await this.completeItem(agent, threadId, turnId, item, state);
            }
          }
        }
      }
      stopActivity();
      queue.close();
      const activeTurns = this.activeRootTurns.get(threadId) ?? 0;
      if (activeTurns <= 1) {
        this.releaseSubagentBindings(sessionId, threadId);
        this.activeRootTurns.delete(threadId);
      } else {
        this.activeRootTurns.set(threadId, activeTurns - 1);
      }
      for (const [id, item] of state.activityItems) {
        if (!state.completedActivities.has(id)) {
          const finalItem = item.type === "commandExecution"
            ? withCommandOutput(state, state.commandKeys.get(id) ?? commandOutputKey(item), item)
            : item;
          this.appendActivity(agent, threadId, turnId, { ...finalItem, status: "failed" }, "completed", state);
        }
      }
    }
  }

  async *streamAuxiliary(options) {
    await this.ready;
    const text = auxiliaryInput(options.messages);
    if (!text) throw new Error(`Relay Codex adapter received no ${options.purpose} input`);
    const sessionId = String(options.sessionId ?? "");
    const agent = this.agents.get(sessionId);
    const cwd = agent?.session.header.cwd ?? this.settings.get(sessionId)?.cwd ?? process.cwd();
    const created = await this.runtime.createSession({
      model: options.model,
      effort: options.reasoningEffort,
      sandbox: "read-only",
      approvalPolicy: "never",
      cwd,
      dynamicTools: [],
      baseInstructions: options.system,
      developerInstructions: auxiliaryInstructions(options.purpose),
      ephemeral: true,
      serviceName: "relay_codex_auxiliary",
      threadSource: CODEX_AUXILIARY_THREAD_SOURCE,
    });
    const threadId = created.id;
    const queue = new ActivityQueue(options.signal);
    const onActivity = (message) => {
      const candidate = message.params?.threadId ?? message.params?.thread?.id;
      if (candidate === threadId) queue.push(message);
    };
    const stopActivity = subscribeRuntimeActivity(this.runtime, onActivity);

    let turnId = null;
    try {
      const started = await this.runtime.sendMessage(threadId, {
        text,
        model: options.model,
        effort: options.reasoningEffort,
        sandbox: "read-only",
        approvalPolicy: "never",
        reasoningSummary: "none",
      });
      turnId = started.id;
      const state = createStreamState();
      let completedTurn = null;
      while (!completedTurn) {
        const message = await queue.next();
        const params = message.params ?? {};
        if (params.turnId && params.turnId !== turnId) continue;
        if (message.method === "turn/completed") {
          if (params.turn?.id !== turnId) continue;
          for (const item of params.turn.items ?? []) {
            for (const chunk of completeAuxiliaryItem(state, item)) yield chunk;
          }
          completedTurn = params.turn;
          break;
        }
        for (const chunk of projectAuxiliaryActivity(message, state)) yield chunk;
      }
      for (const block of state.blocks.values()) {
        if (block.closed) continue;
        block.closed = true;
        yield { type: "block-end", index: block.index, block: { type: block.type, text: block.text } };
      }
      if (completedTurn.status === "failed") {
        yield {
          type: "finish",
          reason: { kind: "error", failure: { message: completedTurn.error?.message ?? `Codex ${options.purpose} failed`, code: "CODEX_AUXILIARY_FAILED" } },
        };
      } else {
        yield { type: "finish", reason: { kind: "stop" } };
      }
    } catch (error) {
      if (options.signal?.aborted) {
        yield await interruptedTurnFinish({
          runtime: this.runtime,
          logger: this.logger,
          threadId,
          turnId,
          cancelledMessage: `Codex ${options.purpose} cancelled`,
        });
        return;
      }
      throw error;
    } finally {
      stopActivity();
      queue.close();
      await this.runtime.releaseSession(threadId);
    }
  }

  async projectActivity(agent, threadId, turnId, message, state) {
    const params = message.params ?? {};
    if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") {
      return textDelta(state, params.itemId, "reasoning", params.delta ?? "");
    }
    if (message.method === "item/agentMessage/delta") {
      return textDelta(state, params.itemId, "text", params.delta ?? "");
    }
    if (message.method === "item/codeModeShell/outputDelta") {
      const key = commandProcessKey(params.processId);
      if (state.closedCommands.has(key)) return [];
      recordCommandOutput(state, key, "raw", params.delta ?? "");
      return [];
    }
    if (message.method === "item/commandExecution/outputDelta") {
      if (state.completed.has(params.itemId)) return [];
      const key = state.commandKeys.get(params.itemId) ?? commandItemKey(params.itemId);
      recordCommandOutput(state, key, "native", params.delta ?? "");
      return [];
    }
    if (message.method === "item/started") {
      if (params.item?.type === "agentMessage" && params.item.phase) {
        state.textPhases.set(params.item.id, params.item.phase);
      }
      if (params.item?.type === "commandExecution") {
        state.commandKeys.set(params.item.id, commandOutputKey(params.item));
      }
      if (isCodexActivityItem(params.item)) this.appendActivity(agent, threadId, turnId, params.item, "started", state);
      return [];
    }
    if (message.method === "item/completed") {
      return this.completeItem(agent, threadId, turnId, params.item, state);
    }
    return [];
  }

  async completeItem(agent, threadId, turnId, item, state) {
    if (!item?.id || state.completed.has(item.id)) return [];
    state.completed.add(item.id);
    if (item.type === "reasoning") {
      return completeTextItem(state, item.id, "reasoning", reasoningText(item));
    }
    if (item.type === "agentMessage") {
      if (item.phase) state.textPhases.set(item.id, item.phase);
      return completeTextItem(state, item.id, "text", item.text ?? "");
    }
    if (item.type === "commandExecution") {
      const key = state.commandKeys.get(item.id) ?? commandOutputKey(item);
      state.closedCommands.add(key);
      this.appendActivity(agent, threadId, turnId, withCommandOutput(state, key, item), "completed", state);
      return [];
    }
    if (isCodexActivityItem(item)) this.appendActivity(agent, threadId, turnId, item, "completed", state);
    if (item.type === "mcpToolCall" && item.status === "completed") {
      const content = Array.isArray(item.result?.content) ? item.result.content : [];
      const images = content.map((entry, contentIndex) => ({ entry, contentIndex }))
        .filter(({ entry }) => entry?.type === "image");
      if (!this.attachments || images.length === 0) return [];
      const chunks = [];
      for (const { entry, contentIndex } of images) {
        const index = state.nextIndex++;
        try {
          const attachment = await importCodexMcpImage(entry, item.id, contentIndex, this.attachments);
          chunks.push(
            { type: "block-start", index, blockType: "image" },
            { type: "block-end", index, block: { type: "image", attachment } },
          );
        } catch (error) {
          const reason = imagePreviewFailureReason(error);
          this.logger.warn?.("Codex MCP image preview unavailable", {
            threadId,
            turnId,
            itemId: item.id,
            itemType: item.type,
            contentIndex,
            reason,
          });
          chunks.push(
            { type: "block-start", index, blockType: "text" },
            { type: "block-end", index, block: { type: "text", text: `MCP image preview unavailable: ${item.server}/${item.tool}.` } },
          );
        }
      }
      return chunks;
    }
    if (item.type === "imageGeneration" || item.type === "imageView") {
      if (!this.attachments) return [];
      const roots = [
        resolve(agent.session.header.cwd ?? process.cwd()),
        resolve(homedir(), ".codex", "generated_images"),
      ];
      const index = state.nextIndex++;
      try {
        const attachment = item.type === "imageGeneration"
          ? await importCodexGeneratedImage(item, roots, this.attachments)
          : await importCodexImage(item.path, roots, this.attachments);
        return [
          { type: "block-start", index, blockType: "image" },
          { type: "block-end", index, block: { type: "image", attachment } },
        ];
      } catch (error) {
        const label = basename(item.path ?? item.savedPath ?? `codex-${item.id}`);
        const reason = imagePreviewFailureReason(error);
        this.logger.warn?.("Codex image preview unavailable", {
          threadId,
          turnId,
          itemId: item.id,
          itemType: item.type,
          reason,
        });
        return [
          { type: "block-start", index, blockType: "text" },
          { type: "block-end", index, block: { type: "text", text: `Image preview unavailable: ${label}.` } },
        ];
      }
    }
    return [];
  }

  appendActivity(agent, threadId, turnId, item, phase, state) {
    const id = activityItemId(item);
    if (!id) return;
    const previous = state.activityItems.get(id) ?? {};
    const merged = mergeActivityItem(previous, item);
    state.activityItems.set(id, merged);
    if (!state.startedActivities.has(id)) {
      const payload = activityPayload(threadId, turnId, merged, "started");
      const callId = CallId(`relay-codex:${JSON.stringify([threadId, turnId, id])}`);
      const args = JSON.stringify(payload);
      // Native tool envelopes survive the official persistence vocabulary check.
      agent.session.append("assistant/message", {
        ...state.location,
        message: createMessage({
          role: "assistant",
          source: { kind: "model", provider: CODEX_PROVIDER, model: "codex" },
          content: [{ type: "tool-call", id: callId, name: CODEX_ACTIVITY_TOOL, arguments: args }],
        }),
      }, { surfaceOp: "append" });
      agent.session.append("tool/call", {
        ...state.location, callId, name: CODEX_ACTIVITY_TOOL, arguments: args,
      });
      state.startedActivities.add(id);
    }
    if (phase === "completed" && !state.completedActivities.has(id)) {
      const payload = activityPayload(threadId, turnId, merged, "completed");
      const callId = CallId(`relay-codex:${JSON.stringify([threadId, turnId, id])}`);
      agent.session.append("tool/result", {
        ...state.location,
        message: createMessage({
          role: "user",
          source: { kind: "tool", callId },
          content: [{
            type: "tool-result", toolCallId: callId,
            content: [{ type: "text", text: payload.activity.output ?? payload.activity.title }],
            isError: payload.activity.status === "error",
          }],
        }),
        meta: { codexActivity: payload },
      }, { surfaceOp: "append" });
      state.completedActivities.add(id);
    }
  }
}

function imagePreviewFailureReason(error) {
  const message = error instanceof Error ? error.message : "";
  if (message === "image path is outside the Codex workspace") return "IMAGE_PATH_OUTSIDE_ROOT";
  if (message === "Codex image result is not valid base64") return "IMAGE_BASE64_INVALID";
  if (message === "Codex image result has an invalid size") return "IMAGE_SIZE_INVALID";
  if (message === "unsupported or malformed Codex image data") return "IMAGE_DATA_INVALID";
  if (message === "Declared image type does not match its bytes.") return "IMAGE_TYPE_MISMATCH";
  return "IMAGE_ATTACHMENT_REJECTED";
}

async function interruptedTurnFinish({ runtime, logger, threadId, turnId, cancelledMessage }) {
  if (!turnId) {
    return { type: "finish", reason: { kind: "aborted", failure: { message: cancelledMessage, code: "ABORTED" } } };
  }
  try {
    await runtime.interruptTurn(threadId, turnId);
    return { type: "finish", reason: { kind: "aborted", failure: { message: cancelledMessage, code: "ABORTED" } } };
  } catch (error) {
    logger.error?.("Codex interrupted work could not be confirmed terminated", {
      threadId,
      turnId,
      code: error?.code ?? "CODEX_TURN_INTERRUPT_CLEANUP_FAILED",
    });
    return {
      type: "finish",
      reason: {
        kind: "error",
        failure: {
          message: "Codex stopped the response, but could not confirm that its active command was terminated. Check the Workspace for late side effects.",
          code: "CODEX_TURN_INTERRUPT_CLEANUP_FAILED",
        },
      },
    };
  }
}

function importedResumeError(threadId, cause) {
  if (isActiveWriterError(cause)) {
    const error = new LlmError(
      `Codex thread ${threadId} is still owned by another Codex App Server. `
      + "Switching Sessions may not release this process-level writer. Fully quit or restart "
      + "the owning Codex app, CLI, or App Server process, then retry this message in DSH. "
      + "DSH kept the original thread binding and did not create a replacement.",
      CODEX_THREAD_ACTIVE_WRITER,
      { cause },
    );
    error.retryable = true;
    error.threadId = threadId;
    return error;
  }
  return new Error(`Relay could not resume imported Codex thread ${threadId}: ${cause.message}`, { cause });
}

function persistedResumeError(sessionId, threadId, cause, adapter) {
  if (isActiveWriterError(cause)) return importedResumeError(threadId, cause);
  if (/\b(?:not found|does not exist|unknown thread)\b/i.test(cause?.message ?? "")) {
    const status = rebindRequiredStatus({ threadId });
    adapter.rebindStates.set(String(sessionId), status);
    adapter.bumpBindingEpoch(sessionId);
    return rebindRequiredError(status, cause);
  }
  const error = new LlmError(
    `Relay could not resume the Codex binding for DSH Session ${sessionId} and thread ${threadId}. `
    + "The original binding was preserved and no replacement Codex Thread was created. Retry after the Codex connection recovers.",
    "CODEX_THREAD_RESUME_FAILED",
    { cause },
  );
  error.retryable = true;
  error.threadId = threadId;
  error.sessionId = String(sessionId);
  return error;
}

function rebindRequiredError(status, cause) {
  const error = new LlmError(
    `${status.message} ${status.action}`,
    status.code,
    cause ? { cause } : undefined,
  );
  error.retryable = false;
  Object.assign(error, status.details ?? {});
  return error;
}

function inheritedCodexProvenance(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.source?.kind !== "model") continue;
    const replay = message.source.replayState?.response ?? message.source.replayState;
    if (message.source.provider !== CODEX_PROVIDER || !replay || typeof replay !== "object") continue;
    const threadId = optionalIdentity(replay.threadId);
    if (!threadId) continue;
    return {
      threadId,
      turnId: optionalIdentity(replay.turnId),
      itemId: optionalIdentity(replay.itemId),
    };
  }
  return null;
}

function sameProvenance(left, right) {
  return Boolean(left && right
    && left.threadId === right.threadId
    && (left.turnId ?? null) === (right.turnId ?? null)
    && (left.itemId ?? null) === (right.itemId ?? null));
}

function requestOwnershipError(request, reason, ownership = {}) {
  const threadId = optionalIdentity(request.params?.threadId) ?? ownership.threadId ?? "unknown";
  const turnId = optionalIdentity(request.params?.turnId) ?? ownership.turnId ?? "unknown";
  const itemId = optionalIdentity(request.params?.itemId) ?? ownership.itemId ?? "unknown";
  const error = new Error(
    `Codex approval ${request.id} ${reason}. Original thread ${threadId}, turn ${turnId}, item ${itemId}. `
    + "The approval was rejected without being sent to Codex.",
  );
  error.code = "CODEX_STALE_APPROVAL";
  error.threadId = threadId;
  error.turnId = turnId;
  error.itemId = itemId;
  return error;
}

function requiredIdentity(value, name) {
  const identity = optionalIdentity(value);
  if (!identity) throw new Error(`Codex request ${name} is required`);
  return identity;
}

function optionalIdentity(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isActiveWriterError(error) {
  return typeof error?.message === "string"
    && /\balready has an active writer\b/i.test(error.message);
}

class ActivityQueue {
  constructor(signal) {
    this.signal = signal;
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }

  push(value) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }

  next() {
    if (this.values.length) return Promise.resolve(this.values.shift());
    if (this.closed) return Promise.reject(new Error("Codex activity stream closed"));
    if (this.signal?.aborted) return Promise.reject(this.signal.reason ?? new Error("aborted"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      if (this.signal) {
        const abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(this.signal.reason ?? new Error("aborted"));
        };
        this.signal.addEventListener("abort", abort, { once: true });
        waiter.resolve = (value) => {
          this.signal.removeEventListener("abort", abort);
          resolve(value);
        };
      }
    });
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("Codex activity stream closed"));
  }

  drain() {
    return this.values.splice(0);
  }
}

function createStreamState() {
  return {
    nextIndex: 0,
    blocks: new Map(),
    textPhases: new Map(),
    completed: new Set(),
    commandKeys: new Map(),
    commandSources: new Map(),
    closedCommands: new Set(),
    activityItems: new Map(),
    startedActivities: new Set(),
    completedActivities: new Set(),
  };
}

function textDelta(state, id, type, delta) {
  if (!id || !delta) return [];
  let block = state.blocks.get(id);
  const chunks = [];
  if (!block) {
    block = { index: state.nextIndex++, type, text: "", closed: false };
    state.blocks.set(id, block);
    chunks.push({ type: "block-start", index: block.index, blockType: type });
  }
  if (block.closed) return chunks;
  block.text += delta;
  chunks.push({ type: type === "reasoning" ? "reasoning-delta" : "text-delta", index: block.index, text: delta });
  return chunks;
}

function completeTextItem(state, id, type, completeText) {
  const chunks = [];
  let block = state.blocks.get(id);
  if (!block && !completeText) return chunks;
  if (!block) {
    block = { index: state.nextIndex++, type, text: "", closed: false };
    state.blocks.set(id, block);
    chunks.push({ type: "block-start", index: block.index, blockType: type });
  }
  if (completeText && completeText.startsWith(block.text) && completeText.length > block.text.length) {
    const delta = completeText.slice(block.text.length);
    block.text = completeText;
    chunks.push({ type: type === "reasoning" ? "reasoning-delta" : "text-delta", index: block.index, text: delta });
  }
  if (!block.closed) {
    block.closed = true;
    chunks.push({ type: "block-end", index: block.index, block: { type, text: block.text } });
  }
  return chunks;
}

function withCommandOutput(state, key, item) {
  const output = commandOutputSnapshot(state, key, item.aggregatedOutput);
  return output ? { ...item, aggregatedOutput: output } : item;
}

function commandOutputSnapshot(state, id, aggregatedOutput) {
  const completeText = typeof aggregatedOutput === "string" ? aggregatedOutput : "";
  const sources = state.commandSources.get(id);
  if (!sources) return completeText;
  const raw = sources.raw ?? "";
  const native = sources.native ?? "";
  if (raw && native) {
    if (raw === native) return completeText || native;
    if (native.startsWith(raw)) return native;
    if (raw.startsWith(native)) return raw;
    if (completeText && completeText !== native && !native.endsWith(completeText)) return completeText;
    return `${raw}${native}`;
  }
  if (completeText && raw && completeText !== raw) return raw.endsWith(completeText) ? raw : completeText;
  if (completeText && native && completeText !== native) return native.endsWith(completeText) ? native : completeText;
  if (completeText) return completeText;
  if (native) return native;
  return raw;
}

function recordCommandOutput(state, id, source, delta) {
  if (!id || !delta) return;
  let sources = state.commandSources.get(id);
  if (!sources) {
    sources = { raw: "", native: "" };
    state.commandSources.set(id, sources);
  }
  sources[source] += delta;
}

function commandOutputKey(item) {
  return item?.processId != null ? commandProcessKey(item.processId) : commandItemKey(item?.id);
}

function commandProcessKey(processId) {
  return processId == null ? null : `command-process:${processId}`;
}

function commandItemKey(itemId) {
  return itemId == null ? null : `command-item:${itemId}`;
}

function permissionConfiguration(events) {
  let sandbox = "workspace-write";
  let approvalPolicy = "on-request";
  for (const event of events) {
    if (event.type === "sandbox/mode") sandbox = event.data.mode;
    if (event.type === "approval/policy") approvalPolicy = event.data.policy === "never" ? "never" : "on-request";
  }
  return { sandbox, approvalPolicy };
}

function reasoningText(item) {
  return [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join("\n\n");
}

function activityPayload(threadId, turnId, item, phase) {
  const activity = normalizeCodexActivity(item, phase);
  return { version: 1, threadId, turnId, itemId: String(activityItemId(item)), phase, activity };
}

function normalizeCodexActivity(item, phase) {
  const type = String(item.type ?? "toolUse");
  const failed = ["failed", "declined", "cancelled", "canceled"].includes(item.status)
    || (item.exitCode != null && Number(item.exitCode) !== 0)
    || item.result?.isError === true || item.error != null
    || (item.type === "dynamicToolCall" && item.success === false);
  const status = phase === "started" ? "running" : failed ? "error" : "completed";
  return bounded({
    type,
    status,
    title: codexActivityTitle(item),
    summary: codexActivitySummary(item),
    input: codexActivityInput(item),
    output: codexActivityOutput(item),
    exitCode: item.exitCode,
    commandActions: item.commandActions,
  });
}

function codexActivityTitle(item) {
  if (item.type === "commandExecution") return "Ran commands";
  if (item.type === "fileChange") return activityCountTitle(item.changes, "Edited a file", "Edited files");
  if (item.type === "imageView") return "Viewed an image";
  if (item.type === "imageGeneration") return "Generated an image";
  if (item.type === "webSearch") return "Searched web";
  if (item.type === "mcpToolCall") return mcpActivityTitle(item);
  if (item.type === "dynamicToolCall") return [item.namespace, item.tool ?? item.name].filter(Boolean).join(" / ") || "Dynamic Tool Call";
  if (item.type === "plan") return "Updated plan";
  return humanize(item.type ?? "Activity");
}

function codexActivitySummary(item) {
  if (item.type === "commandExecution") return firstLine(item.command);
  if (item.type === "fileChange") return summarizeValue(item.path ?? item.filePath ?? firstChangedPath(item.changes) ?? item.changes);
  if (item.type === "imageView" || item.type === "imageGeneration") return summarizeValue(item.path ?? item.savedPath ?? item.prompt);
  if (item.type === "webSearch") return summarizeValue(item.query ?? item.prompt);
  if (item.type === "mcpToolCall") return summarizeValue(item.server ? `${item.server}/${item.tool ?? item.name ?? ""}` : item.tool ?? item.name);
  return summarizeValue(item.summary ?? item.message ?? item.input ?? item.arguments);
}

function codexActivityInput(item) {
  if (item.type === "commandExecution") return item.command ? `$ ${item.command}` : undefined;
  if (item.type === "mcpToolCall") return item.arguments ?? item.input;
  return item.input ?? item.arguments ?? item.prompt ?? item.changes;
}

function codexActivityOutput(item) {
  if (item.type === "dynamicToolCall" && Array.isArray(item.contentItems) && item.contentItems.length > 0) {
    return item.contentItems.map(content => {
      if (typeof content.text === "string") return content.text;
      // Media is rendered through the attachment path, never as base64 text.
      return `[${content.type ?? "tool result"}]`;
    }).join("\n");
  }
  return item.aggregatedOutput ?? item.output ?? item.result ?? item.error;
}

function mcpActivityTitle(item) {
  const tool = String(item.tool ?? item.name ?? "");
  const server = String(item.server ?? "");
  const label = tool || server;
  if (!label) return "Used a tool";
  return humanize(label.replace(/[_-]+/g, " "));
}

function activityCountTitle(value, singular, plural) {
  return Array.isArray(value) && value.length > 1 ? plural : singular;
}

function firstChangedPath(changes) {
  if (!Array.isArray(changes)) return undefined;
  const first = changes.find(change => change?.path || change?.filePath);
  return first?.path ?? first?.filePath;
}

function bounded(value) {
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (entry === undefined || entry === null || entry === "") return [];
    const text = typeof entry === "string" ? entry : JSON.stringify(entry, null, 2);
    return [[key, text.length > 20_000 ? `${text.slice(0, 20_000)}\n...` : text]];
  }));
}

function isCodexActivityItem(item) {
  return item?.id && !["userMessage", "agentMessage", "reasoning"].includes(item.type);
}

function activityItemId(item) {
  return item?.id == null ? null : String(item.id);
}

function mergeActivityItem(previous, item) {
  return {
    ...previous,
    ...item,
    input: item.input ?? previous.input,
    arguments: item.arguments ?? previous.arguments,
    command: item.command ?? previous.command,
    tool: item.tool ?? previous.tool,
    name: item.name ?? previous.name,
    server: item.server ?? previous.server,
    aggregatedOutput: item.aggregatedOutput ?? previous.aggregatedOutput,
    output: item.output ?? previous.output,
    result: item.result ?? previous.result,
    error: item.error ?? previous.error,
  };
}

function summarizeValue(value) {
  if (value === undefined || value === null) return "";
  return firstLine(typeof value === "string" ? value : JSON.stringify(value));
}

function firstLine(value) {
  return String(value ?? "").split("\n")[0].slice(0, 240);
}

function humanize(value) {
  return String(value).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, letter => letter.toUpperCase());
}

function reasoningEffortName(value) {
  return String(value) === "xhigh" ? "Extra high" : humanize(value);
}

async function latestUserInput(messages, attachments, signal) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (message.source?.kind !== "user" && !isRelayActivation(message.source)) continue;
    const text = (message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const localImages = [];
    for (const block of message.content ?? []) {
      const image = await localImage(block, attachments, signal);
      if (image) localImages.push(image);
    }
    if (text || localImages.length > 0) return { text, localImages };
  }
  return null;
}

async function localImage(block, attachments, signal) {
  if (block?.type !== "image" && block?.type !== "file") return null;
  if (block.type === "file" && !isImageFile(block)) return null;
  const path = block.path
    ?? block.fsPath
    ?? block.filePath
    ?? block.localPath
    ?? block.source?.path
    ?? block.source?.fsPath
    ?? block.attachment?.path
    ?? block.attachment?.fsPath
    ?? block.attachment?.filePath
    ?? block.attachment?.localPath;
  if (!path && (block.type === "image" || block.attachment)) {
    return materializeCodexAttachment(block, attachments, signal);
  }
  if (!path) return null;
  return {
    path,
    fsPath: block.fsPath ?? block.attachment?.fsPath ?? path,
    label: block.label ?? block.name ?? block.filename ?? block.attachment?.name ?? basename(path),
  };
}

function isImageFile(block) {
  const mediaType = block.mediaType ?? block.mimeType ?? block.attachment?.mediaType ?? block.attachment?.mimeType;
  if (typeof mediaType === "string" && mediaType.startsWith("image/")) return true;
  const name = block.name ?? block.filename ?? block.path ?? block.fsPath ?? block.attachment?.name ?? "";
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
}

function auxiliaryInput(messages) {
  return messages.map((message) => {
    const text = (message?.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    return text ? `${message.role ?? "user"}: ${text}` : "";
  }).filter(Boolean).join("\n\n");
}

function auxiliaryInstructions(purpose) {
  return [
    `This is an isolated DSH ${purpose} request, not a user conversation turn.`,
    "Return only the requested text transformation.",
    "Do not call tools, inspect files, modify state, ask questions, or continue any other task.",
  ].join(" ");
}

function projectAuxiliaryActivity(message, state) {
  const params = message.params ?? {};
  if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") {
    return textDelta(state, params.itemId, "reasoning", params.delta ?? "");
  }
  if (message.method === "item/agentMessage/delta") {
    return textDelta(state, params.itemId, "text", params.delta ?? "");
  }
  if (message.method === "item/completed") return completeAuxiliaryItem(state, params.item);
  return [];
}

function completeAuxiliaryItem(state, item) {
  if (!item?.id || state.completed.has(item.id)) return [];
  state.completed.add(item.id);
  if (item.type === "reasoning") return completeTextItem(state, item.id, "reasoning", reasoningText(item));
  if (item.type === "agentMessage") return completeTextItem(state, item.id, "text", item.text ?? "");
  return [];
}

function isRelayActivation(source) {
  return source?.kind === "plugin" && source.plugin === "relay";
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function sameSubagentBinding(left, right) {
  return left.sessionId === right.sessionId
    && left.rootThreadId === right.rootThreadId
    && left.parentThreadId === right.parentThreadId
    && left.epoch === right.epoch;
}

function runtimeModels(runtime) {
  return typeof runtime.listModels === "function" ? runtime.listModels() : [...runtime.models];
}

function hasRuntimeSession(runtime, sessionId) {
  return typeof runtime.hasSession === "function"
    ? runtime.hasSession(sessionId)
    : runtime.sessions.has(sessionId);
}

function patchRuntimeSession(runtime, sessionId, patch) {
  if (typeof runtime.patchSession === "function") return runtime.patchSession(sessionId, patch);
  const session = runtime.sessions.get(sessionId);
  if (session) Object.assign(session, patch);
  return Boolean(session);
}

function subscribeRuntimeActivity(runtime, listener) {
  if (typeof runtime.subscribeActivity === "function") return runtime.subscribeActivity(listener);
  runtime.on("activity", listener);
  return () => runtime.off("activity", listener);
}

function effectivePreset(session) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event.type === "agent-preset/selected") return event.data.agentPreset;
  }
  return session.header.agentPreset;
}
