import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";

import { importCodexGeneratedImage, importCodexImage } from "./codex-image.js";
import { materializeCodexAttachment } from "./codex-image-input.js";
import { CODEX_APP_DYNAMIC_TOOLS, codexDynamicTools } from "./codex-tools.js";
import { rebindRequiredStatus } from "./connection-status.mjs";

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
  }) {
    super();
    this.runtime = runtime;
    this.ready = ready;
    this.logger = logger;
    this.linkStore = linkStore;
    this.attachments = attachments;
    this.dynamicTools = dynamicTools;
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
    const created = await this.runtime.createSession(settings);
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

  statusForSession(sessionId) {
    const status = this.rebindStates.get(String(sessionId));
    return status ? structuredClone(status) : null;
  }

  captureRequestOwnership(request) {
    const threadId = requiredIdentity(
      request.params?.threadId ?? request.params?.conversationId,
      "threadId",
    );
    const sessionId = this.dshSessionForThread(threadId);
    if (!sessionId) throw requestOwnershipError(request, "has no owning DSH Session");
    if (this.rebindStates.has(sessionId)) throw requestOwnershipError(request, "requires rebind");
    return Object.freeze({
      requestId: String(request.id),
      sessionId,
      threadId,
      turnId: optionalIdentity(request.params?.turnId),
      itemId: optionalIdentity(request.params?.itemId ?? request.params?.callId),
      epoch: this.bindingEpochs.get(sessionId) ?? 0,
    });
  }

  assertRequestOwnership(ownership, request) {
    const currentThread = this.links.get(ownership.sessionId);
    const currentEpoch = this.bindingEpochs.get(ownership.sessionId) ?? 0;
    const currentTurn = optionalIdentity(request.params?.turnId);
    const currentItem = optionalIdentity(request.params?.itemId ?? request.params?.callId);
    if (String(request.id) !== ownership.requestId
      || currentThread !== ownership.threadId
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
    const dshTools = options.tools ?? [];
    this.dshToolNames.set(sessionId, new Set(dshTools.map(tool => tool.name)));
    const threadId = await this.ensureThread(
      sessionId,
      codexDynamicTools(dshTools, this.dynamicTools),
      inheritedCodexProvenance(options.messages),
    );
    const queue = new ActivityQueue(options.signal);
    const onActivity = (message) => {
      const candidate = message.params?.threadId ?? message.params?.thread?.id;
      if (candidate === threadId) queue.push(message);
    };
    const stopActivity = subscribeRuntimeActivity(this.runtime, onActivity);

    let turnId = null;
    try {
      const started = await this.runtime.sendMessage(threadId, {
        ...input,
        ...config,
        reasoningSummary: "auto",
      });
      turnId = started.id;
      this.recordOwnedTurn(sessionId, turnId);
      const state = createStreamState();
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
        yield { type: "finish", reason: { kind: "stop" }, replayState: { threadId, turnId } };
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
      stopActivity();
      queue.close();
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
      return commandOutputDelta(state, key, "raw", params.delta ?? "");
    }
    if (message.method === "item/commandExecution/outputDelta") {
      if (state.completed.has(params.itemId)) return [];
      const key = state.commandKeys.get(params.itemId) ?? commandItemKey(params.itemId);
      return commandOutputDelta(state, key, "native", params.delta ?? "");
    }
    if (message.method === "item/started") {
      if (params.item?.type === "commandExecution") {
        state.commandKeys.set(params.item.id, commandOutputKey(params.item));
      }
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
      return completeTextItem(state, item.id, "text", item.text ?? "");
    }
    if (item.type === "commandExecution") {
      const key = state.commandKeys.get(item.id) ?? commandOutputKey(item);
      state.closedCommands.add(key);
      return completeCommandOutput(state, key, item.aggregatedOutput);
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
    const replay = message.source.replayState;
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
}

function createStreamState() {
  return {
    nextIndex: 0,
    blocks: new Map(),
    completed: new Set(),
    commandKeys: new Map(),
    commandSources: new Map(),
    closedCommands: new Set(),
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

function completeCommandOutput(state, id, aggregatedOutput) {
  const completeText = typeof aggregatedOutput === "string" ? aggregatedOutput : "";
  const sources = state.commandSources.get(id);
  const chunks = [];
  if (sources && completeText.startsWith(sources.native)) {
    const suffix = completeText.slice(sources.native.length);
    if (suffix) chunks.push(...commandOutputDelta(state, id, "native", suffix));
  }
  let block = state.blocks.get(id);
  if (!block && !completeText) return chunks;
  if (!block) {
    block = { index: state.nextIndex++, type: "text", text: "", closed: false };
    state.blocks.set(id, block);
    chunks.push({ type: "block-start", index: block.index, blockType: "text" });
  }
  if (block.closed) return chunks;
  if (completeText.startsWith(block.text) && completeText.length > block.text.length) {
    const delta = completeText.slice(block.text.length);
    block.text = completeText;
    chunks.push({ type: "text-delta", index: block.index, text: delta });
  } else if (completeText && completeText !== block.text && !sources?.raw) {
    block.text = completeText;
  }
  block.closed = true;
  chunks.push({ type: "block-end", index: block.index, block: { type: "text", text: block.text } });
  return chunks;
}

function commandOutputDelta(state, id, source, delta) {
  if (!id || !delta) return [];
  let sources = state.commandSources.get(id);
  if (!sources) {
    sources = { raw: "", native: "" };
    state.commandSources.set(id, sources);
  }
  const previous = sources[source];
  sources[source] += delta;
  const other = sources[source === "raw" ? "native" : "raw"];
  const comparable = other.startsWith(previous) ? other.slice(previous.length) : "";
  const commonLength = commonPrefixLength(delta, comparable);
  const duplicateLength = commonLength === delta.length || commonLength === comparable.length
    ? commonLength
    : 0;
  return textDelta(state, id, "text", delta.slice(duplicateLength));
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
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
