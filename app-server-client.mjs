import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { codexSpawnError, resolveCodexLaunch } from "./codex-command.mjs";

const NATIVE_CODEX_CLIENT_INFO = {
  name: "relay_codex",
  title: "DSH Codex",
  version: "0.1.5",
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
  } = {}) {
    super();
    const launch = resolveCodexLaunch({ command });
    this.command = launch.command;
    this.commandSource = launch.source;
    this.appServerArgs = [...args];
    this.bypassHookTrust = args.includes(BYPASS_HOOK_TRUST_FLAG);
    this.args = [...launch.argsPrefix, ...args];
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientInfo = structuredClone(clientInfo);
    this.capabilities = structuredClone(capabilities);
    this.process = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async start() {
    if (this.process) return;
    this.closed = false;
    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const output = readline.createInterface({ input: this.process.stdout });
    output.on("line", (line) => this.handleLine(line));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => this.emit("diagnostic", String(chunk)));
    this.process.stdin.on("error", (error) => this.handleStdinError(error));
    this.process.once("error", (error) => {
      this.process = null;
      this.failAll(codexSpawnError(error, this.command, this.commandSource));
    });
    this.process.once("exit", (code, signal) => {
      this.process = null;
      if (!this.closed) {
        this.failAll(new Error(`codex app-server exited (${signal ?? code})`));
      }
      this.emit("exit", { code, signal });
    });

    await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: this.capabilities,
    });
    this.notify("initialized", {});
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
    if (!this.process) return;
    const child = this.process;
    this.process = null;
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
