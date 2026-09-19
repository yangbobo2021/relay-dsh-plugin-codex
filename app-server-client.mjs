import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { codexSpawnError, resolveCodexLaunch } from "./codex-command.mjs";

const NATIVE_CODEX_CLIENT_INFO = {
  name: "relay_codex",
  title: "DSH Codex",
  version: "0.1.6-rc.1",
};

export const RELAY_CODEX_APP_SERVER_ARGS = [
  "-c",
  "features.code_mode_host=true",
  "-c",
  "features.shell_snapshot=false",
  "app-server",
  "--analytics-default-enabled",
];

const BYPASS_HOOK_TRUST_FLAG = "--dangerously-bypass-hook-trust";

const NATIVE_CODEX_CAPABILITIES = {
  experimentalApi: true,
  mcpServerOpenaiFormElicitation: false,
  // This host has no Desktop attestation provider or MCP App HTML renderer.
  requestAttestation: false,
  optOutNotificationMethods: [
    "thread/environment/connected",
    "thread/environment/disconnected",
    "externalAgentConfig/import/progress",
    "thread/compacted",
    "windows/worldWritableWarning",
    "turn/moderationMetadata",
    "authStatusChange",
    "loginChatGptComplete",
    "codex/event/task_started",
    "codex/event/agent_reasoning",
    "codex/event/agent_message",
    "codex/event/task_complete",
    "codex/event/mcp_tool_call_begin",
    "codex/event/mcp_tool_call_end",
    "codex/event/exec_command_begin",
    "codex/event/exec_command_end",
    "codex/event/exec_command_output_delta",
    "codex/event/exec_approval_request",
    "codex/event/apply_patch_approval_request",
    "codex/event/background_event",
    "codex/event/turn_diff",
    "codex/event/get_history_entry_response",
    "codex/event/agent_reasoning_delta",
    "codex/event/agent_reasoning_section_break",
    "codex/event/agent_message_delta",
    "codex/event/stream_error",
    "codex/event/error",
    "codex/event/turn_aborted",
    "codex/event/plan_delta",
    "codex/event/plan_update",
    "codex/event/patch_apply_begin",
    "codex/event/patch_apply_end",
    "codex/event/item_started",
    "codex/event/item_completed",
    "codex/event/user_message",
    "codex/event/agent_reasoning_raw_content",
    "codex/event/agent_reasoning_raw_content_delta",
    "codex/event/web_search_begin",
    "codex/event/web_search_end",
    "codex/event/mcp_list_tools_response",
    "codex/event/list_skills_response",
    "codex/event/list_remote_skills_response",
    "codex/event/remote_skill_downloaded",
    "codex/event/list_custom_prompts_response",
    "codex/event/raw_response_item",
    "codex/event/agent_message_content_delta",
    "codex/event/reasoning_content_delta",
    "codex/event/reasoning_raw_content_delta",
    "codex/event/warning",
    "codex/event/undo_started",
    "codex/event/undo_completed",
    "codex/event/shutdown_complete",
    "codex/event/entered_review_mode",
    "codex/event/exited_review_mode",
    "codex/event/view_image_tool_call",
    "codex/event/mcp_startup_update",
    "codex/event/mcp_startup_complete",
    "codex/event/remote_task_created",
    "codex/event/thread_rolled_back",
    "codex/event/thread_name_updated",
    "codex/event/elicitation_request",
    "codex/event/dynamic_tool_call_request",
    "codex/event/request_user_input",
    "codex/event/terminal_interaction",
    "codex/event/token_count",
    "codex/event/deprecation_notice",
    "thread/closed",
    "rawResponse/completed",
    "warning",
  ],
};

export class CodexAppServerClient extends EventEmitter {
  constructor({
    command,
    args = RELAY_CODEX_APP_SERVER_ARGS,
    requestTimeoutMs = 30_000,
    clientInfo = NATIVE_CODEX_CLIENT_INFO,
    capabilities = NATIVE_CODEX_CAPABILITIES,
    launchOptions = {},
  } = {}) {
    super();
    this.launch = resolveCodexLaunch({ command, ...launchOptions });
    this.command = this.launch.command;
    this.commandSource = this.launch.source;
    this.launchMode = this.launch.mode;
    this.appServerArgs = [...args];
    this.bypassHookTrust = args.includes(BYPASS_HOOK_TRUST_FLAG);
    this.args = [...this.launch.argsPrefix, ...args];
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientInfo = structuredClone(clientInfo);
    this.capabilities = structuredClone(capabilities);
    this.process = null;
    this.initialModels = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async start() {
    if (this.process) return;
    try {
      await this.startLaunch(this.launch);
    } catch (error) {
      if (this.closed || !this.launch.fallback) throw error;
      this.emit(
        "diagnostic",
        `Automatic Codex runtime at ${this.launch.command} failed preflight: `
        + `${error?.code ?? "ERROR"} ${error?.message ?? error}; falling back to bundled runtime.`,
      );
      await this.stopProcess();
      this.launch = this.launch.fallback;
      this.applyLaunch(this.launch);
      try {
        await this.startLaunch(this.launch);
      } catch (fallbackError) {
        fallbackError.cause ??= error;
        throw fallbackError;
      }
    }
  }

  async startLaunch(launch) {
    this.closed = false;
    this.applyLaunch(launch);
    this.initialModels = null;
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;

    const output = readline.createInterface({ input: child.stdout });
    output.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.emit("diagnostic", String(chunk)));
    child.stdin.on("error", (error) => this.handleStdinError(error));
    child.once("error", (error) => {
      if (this.process !== child) return;
      this.process = null;
      this.failAll(codexSpawnError(error, this.command, this.commandSource));
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      this.process = null;
      if (!this.closed) {
        this.failAll(new Error(`codex app-server exited (${signal ?? code})`));
      }
      this.emit("exit", { code, signal });
    });

    try {
      await this.request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: this.capabilities,
      });
      this.notify("initialized", {});
      const models = await this.request("model/list", { limit: 50, includeHidden: false });
      assertUsableModelList(models);
      this.initialModels = structuredClone(models);
    } catch (error) {
      await this.stopProcess();
      throw error;
    }
  }

  applyLaunch(launch) {
    this.command = launch.command;
    this.commandSource = launch.source;
    this.launchMode = launch.mode;
    this.args = [...launch.argsPrefix, ...this.appServerArgs];
  }

  get runtimeInfo() {
    return {
      source: this.commandSource,
      path: this.launch.argsPrefix[0] ?? this.command,
      modelCount: Array.isArray(this.initialModels?.data) ? this.initialModels.data.length : 0,
    };
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(appServerNotRunningError());
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  respondError(id, code, message) {
    this.write({ id, error: { code, message } });
  }

  async close() {
    this.closed = true;
    this.failAll(new Error("codex app-server client closed"));
    await this.stopProcess();
  }

  async stopProcess() {
    if (!this.process) return;
    const child = this.process;
    this.process = null;
    this.failAll(new Error("codex app-server process stopped"));
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("diagnostic", `invalid app-server JSON: ${error.message}\n${line}`);
      return;
    }

    if (message.id != null && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message ?? `${pending.method} failed`);
          error.code = message.error.code;
          error.data = message.error.data;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (message.id != null && message.method) {
      this.emit("serverRequest", message);
      return;
    }
    if (message.method) {
      this.emit("notification", message);
    }
  }

  write(message) {
    if (!this.process?.stdin?.writable) {
      throw appServerNotRunningError();
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleStdinError(error) {
    this.emit("diagnostic", `codex app-server stdin failed: ${error.message}`);
    this.failAll(error);
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function appServerNotRunningError() {
  const error = new Error("Codex App Server is not running. Restart DSH and inspect the Codex status in Settings.");
  error.code = "CODEX_APP_SERVER_NOT_RUNNING";
  return error;
}

function assertUsableModelList(result) {
  if (!Array.isArray(result?.data)) {
    const error = new Error("Codex App Server returned an invalid model/list response.");
    error.code = "CODEX_MODEL_LIST_INVALID";
    throw error;
  }
  if (!result.data.some((model) => typeof model?.id === "string" && model.id.trim())) {
    const error = new Error("Codex App Server returned no usable models.");
    error.code = "CODEX_MODEL_LIST_EMPTY";
    throw error;
  }
}
