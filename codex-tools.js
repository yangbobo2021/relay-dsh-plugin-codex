import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_APP_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "codex_app",
    description: "Tools provided by the Codex app.",
    tools: [
      {
        type: "function",
        name: "load_workspace_dependencies",
        description: "Locate the configured bundled workspace dependency runtime paths for this local desktop thread, including Node.js, Python, and useful libraries for working with spreadsheets, slide decks, Word documents, and PDFs. This is read-only and takes no arguments.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  },
];

export function codexDynamicTools(dshTools = [], builtins = CODEX_APP_DYNAMIC_TOOLS) {
  const tools = dshTools.map(tool => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: structuredClone(tool.parameters),
  }));
  return tools.length === 0
    ? structuredClone(builtins)
    : [...structuredClone(builtins), {
        type: "namespace",
        name: "dsh",
        description: "Tools contributed to this conversation through the DSH plugin runtime.",
        tools,
      }];
}

export async function handleCodexServerRequest(ctx, { adapter, runtime, request }) {
  const threadId = request.params?.threadId ?? request.params?.conversationId;
  const sessionId = threadId ? adapter.dshSessionForInteractionThread(threadId) : null;
  const agent = sessionId ? ctx.agents.get(sessionId) : null;
  if (!agent) {
    runtime.rejectRequest(request.id, new Error("Codex request has no owning live DSH Session"));
    return;
  }

  try {
    if (request.method === "item/tool/call" || request.method === "item/dynamicTool/call") {
      await handleDynamicTool(runtime, request, adapter, agent, sessionId);
      return;
    }
    if (isApproval(request.method)) {
      const ownership = adapter.captureRequestOwnership(request);
      const outcome = await ctx.approval.request({
        agent,
        toolName: approvalToolName(request),
        reason: approvalReason(request),
      });
      adapter.assertRequestOwnership(ownership, request);
      await runtime.resolveRequest(request.id, {
        action: outcome === "allowed-once" ? "accept" : "decline",
      });
      return;
    }
    if (request.method === "item/tool/requestUserInput") {
      const ownership = adapter.captureRequestOwnership(request);
      const questions = normalizeQuestions(request.params?.questions ?? []);
      const answer = await ctx.userQuestions.ask({ agent, questions });
      adapter.assertRequestOwnership(ownership, request);
      await runtime.resolveRequest(request.id, { answers: normalizeAnswers(answer) });
      return;
    }
    runtime.rejectRequest(request.id, new Error(`Unsupported Codex interaction ${request.method}`));
  } catch (error) {
    runtime.rejectRequest(request.id, error);
  }
}

async function handleDynamicTool(runtime, request, adapter, agent, sessionId) {
  const { namespace, name: tool } = requestedTool(request.params);
  if ((namespace === "codex_app" || !namespace) && tool === "load_workspace_dependencies") {
    const result = workspaceDependenciesResult();
    runtime.respondDynamicTool(request.id, result.success, result.text);
    return;
  }
  if (namespace === "codex_app") {
    runtime.respondDynamicTool(request.id, false, `Unsupported Codex app tool ${tool}.`);
    return;
  }
  if (namespace === "dsh") {
    if (!adapter.hasDshTool(sessionId, tool)) {
      runtime.respondDynamicTool(request.id, false, `DSH tool ${tool} is not available for this DSH turn.`);
      return;
    }
    const ownership = adapter.captureRequestOwnership(request);
    const signal = adapter.signalForInteractionThread(request.params?.threadId)
      ?? request.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const result = await agent.ctx.tools.execute({
      callId: `codex:${request.id}`,
      name: tool,
      arguments: requestedArguments(request.params),
      agent,
      signal,
    });
    signal.throwIfAborted();
    adapter.assertRequestOwnership(ownership, request);
    runtime.respondDynamicTool(request.id, !result.isError, toolResultText(result));
    return;
  }
  runtime.respondDynamicTool(request.id, false, `Unknown Codex app tool ${tool}.`);
}

function requestedArguments(params = {}) {
  const raw = params.arguments ?? params.input ?? {};
  if (typeof raw !== "string") return raw;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toolResultText(result) {
  const text = (result.content ?? []).map((block) => {
    if (block?.type === "text") return block.text;
    try { return JSON.stringify(block); } catch { return String(block); }
  }).filter(Boolean).join("\n");
  if (text) return text;
  if (!result.isError && result.value !== undefined) {
    return typeof result.value === "string" ? result.value : JSON.stringify(result.value);
  }
  return result.isError ? (result.error?.message ?? "DSH tool failed") : "DSH tool completed.";
}

function requestedTool(params = {}) {
  const tool = params.tool;
  const namespace = typeof params.namespace === "string" ? params.namespace : null;
  if (typeof tool === "string") return splitToolName(namespace, tool);
  if (tool && typeof tool === "object") {
    return splitToolName(
      typeof tool.namespace === "string" ? tool.namespace : namespace,
      typeof tool.name === "string" ? tool.name : "",
    );
  }
  return splitToolName(namespace, typeof params.name === "string" ? params.name : "");
}

function splitToolName(namespace, name) {
  const match = /^([^.:]+)[.:](.+)$/.exec(name);
  if (match) return { namespace: namespace ?? match[1], name: match[2] };
  return { namespace, name };
}

function workspaceDependenciesResult() {
  const root = primaryRuntimeRoot();
  const dependencies = join(root, "dependencies");
  const version = runtimeVersion(root);
  const paths = [
    ["Git executable", "bin/fallback/git"],
    ["Node.js executable", "node/bin/node"],
    ["Node.js packages", "node/node_modules"],
    ["pnpm executable", "bin/fallback/pnpm"],
    ["Python executable", "python/bin/python3"],
    ["Python packages", "python"],
    ["Override binaries", "bin/override"],
    ["Fallback binaries", "bin/fallback"],
  ].map(([label, relative]) => [label, join(dependencies, relative)])
    .filter(([, path]) => existsSync(path));
  const available = paths.some(([label]) => label === "Node.js executable" || label === "Python executable");
  if (!available) return { success: false, text: "No bundled Node.js or Python runtime was found. Use available system tools or configure CODEX_PRIMARY_RUNTIME_ROOT; do not assume Desktop dependencies are installed." };
  return { success: true, text: [
    "These local runtime paths exist. Individual packages have not been exhaustively validated.",
    "",
    "### Workspace Dependencies",
    `- Bundle version: \`${version}\``,
    ...paths.map(([label, path]) => `- ${label}: \`${path}\``),
  ].join("\n") };
}

function primaryRuntimeRoot() {
  return process.env.CODEX_PRIMARY_RUNTIME_ROOT
    ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime");
}

function runtimeVersion(root) {
  const manifest = join(root, "runtime.json");
  if (!existsSync(manifest)) return "unknown";
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    return parsed.bundleVersion ?? "unknown";
  } catch {
    return "unknown";
  }
}

function isApproval(method) {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval"
    || method === "execCommandApproval"
    || method === "applyPatchApproval";
}

function approvalToolName(request) {
  if (request.method.includes("fileChange") || request.method === "applyPatchApproval") return "Codex file change";
  if (request.method.includes("permissions")) return "Codex permissions";
  return "Codex command";
}

function approvalReason(request) {
  const command = request.params?.command;
  if (typeof command === "string" && command.trim()) return command.trim();
  if (Array.isArray(command)) return command.join(" ");
  return request.params?.reason ?? "Codex requires permission to continue.";
}

function normalizeQuestions(input) {
  return input.slice(0, 3).map((question, index) => ({
    id: requiredString(question.id ?? `question-${index + 1}`, "question id"),
    header: String(question.header ?? "Codex").slice(0, 12),
    question: requiredString(question.question ?? question.prompt, "question"),
    options: Array.isArray(question.options)
      ? question.options.slice(0, 3).map(option => typeof option === "string"
        ? { label: option, description: option }
        : { label: String(option.label), description: String(option.description ?? option.label) })
      : [],
    multiSelect: Boolean(question.multiSelect),
  }));
}

function normalizeAnswers(answer) {
  if (!Array.isArray(answer?.answers)) return {};
  return Object.fromEntries(answer.answers.map((item) => [
    item.id,
    item.custom ? [...item.selected, item.custom] : item.selected,
  ]));
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
