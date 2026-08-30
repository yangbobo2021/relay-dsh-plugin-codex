window.__ModuleLoader__.load({
	id: "relay-dsh-plugin-codex",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region advanced-debug-preference.mjs
		const ADVANCED_DEBUG_STORAGE_KEY = "relay.ui.advanced-debug";
		var AdvancedDebugPreference = class {
			constructor({ storage = availableStorage(), eventTarget = availableEventTarget() } = {}) {
				this.storage = storage;
				this.eventTarget = eventTarget;
				this.listeners = /* @__PURE__ */ new Set();
				this.value = readPreference(storage);
				this.onStorage = (event) => {
					if (event?.key !== "relay.ui.advanced-debug") return;
					this.update(readPreference(this.storage), false);
				};
				this.eventTarget?.addEventListener?.("storage", this.onStorage);
			}
			getSnapshot = () => this.value;
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			};
			set(enabled) {
				this.update(Boolean(enabled), true);
			}
			dispose() {
				this.eventTarget?.removeEventListener?.("storage", this.onStorage);
				this.listeners.clear();
			}
			update(next, persist) {
				if (persist) writePreference(this.storage, next);
				if (next === this.value) return;
				this.value = next;
				for (const listener of this.listeners) listener();
			}
		};
		function readPreference(storage) {
			try {
				return storage?.getItem?.(ADVANCED_DEBUG_STORAGE_KEY) === "true";
			} catch {
				return false;
			}
		}
		function writePreference(storage, enabled) {
			try {
				storage?.setItem?.(ADVANCED_DEBUG_STORAGE_KEY, enabled ? "true" : "false");
			} catch {}
		}
		function availableStorage() {
			try {
				return globalThis.localStorage;
			} catch {
				return;
			}
		}
		function availableEventTarget() {
			return globalThis.window;
		}
		//#endregion
		//#region model-selection.mjs
		const DEFAULT_RETRY_DELAYS_MS = Object.freeze([
			50,
			250,
			1e3
		]);
		function installModelSelection(ctx, preset, provider, otherProvider, { retryDelaysMs = DEFAULT_RETRY_DELAYS_MS } = {}) {
			const connection = ctx.get("connection");
			const operations = /* @__PURE__ */ new Map();
			const desired = /* @__PURE__ */ new Map();
			const pending = /* @__PURE__ */ new Set();
			const retryTimers = /* @__PURE__ */ new Map();
			let stopped = false;
			let nextGeneration = 1;
			const clearRetry = (id) => {
				const timer = retryTimers.get(id);
				if (timer !== void 0) clearTimeout(timer);
				retryTimers.delete(id);
			};
			const currentTarget = (id, target) => {
				const list = ctx.sessions.list.getSnapshot();
				const latest = list.byId[id];
				return !stopped && list.current === id && latest?.blank === true && desired.get(id)?.generation === target.generation && latest.agentPreset === target.selectedPreset;
			};
			const retry = (id, target) => {
				if (!currentTarget(id, target) || retryTimers.has(id)) return;
				const delay = retryDelaysMs[target.retry];
				if (delay === void 0) return;
				target.retry += 1;
				retryTimers.set(id, setTimeout(() => {
					retryTimers.delete(id);
					if (currentTarget(id, target)) reconcile(id, target);
				}, delay));
			};
			const reconcile = async (id, target) => {
				if (!currentTarget(id, target) || operations.has(id)) return;
				operations.set(id, target.generation);
				try {
					const response = await connection.api.sessions.models({ sessionId: id });
					if (!currentTarget(id, target)) return;
					const { result } = response;
					if (!result.ok) {
						retry(id, target);
						return;
					}
					const currentProvider = result.value.current.provider;
					const group = target.selectedPreset === preset ? result.value.groups.find((candidate) => candidate.id === provider) : currentProvider === provider ? result.value.groups.find((candidate) => candidate.id !== provider && candidate.id !== otherProvider) : null;
					if (target.selectedPreset === preset && currentProvider === provider) return;
					if (!group || group.models.length === 0) {
						retry(id, target);
						return;
					}
					const model = group.models[0];
					const selection = await connection.api.sessions.selectModel({
						sessionId: id,
						provider: group.id,
						model: model.id,
						...model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}
					});
					if (!currentTarget(id, target)) return;
					if (!selection.result.ok) {
						retry(id, target);
						return;
					}
					clearRetry(id);
				} catch {
					retry(id, target);
				} finally {
					operations.delete(id);
					if (pending.delete(id)) sync();
				}
			};
			const sync = () => {
				if (stopped) return;
				const list = ctx.sessions.list.getSnapshot();
				const id = list.current;
				if (id === void 0 || list.byId[id]?.blank !== true) return;
				const selectedPreset = list.byId[id]?.agentPreset;
				if (selectedPreset !== preset && selectedPreset === otherProvider) return;
				const desiredKey = `${selectedPreset ?? "standard"}`;
				let target = desired.get(id);
				if (!target || target.key !== desiredKey) {
					clearRetry(id);
					target = {
						key: desiredKey,
						selectedPreset,
						generation: nextGeneration++,
						retry: 0
					};
					desired.set(id, target);
				}
				if (operations.has(id)) {
					pending.add(id);
					return;
				}
				reconcile(id, target);
			};
			const off = ctx.sessions.list.subscribe(sync);
			sync();
			return () => {
				stopped = true;
				off();
				for (const id of retryTimers.keys()) clearRetry(id);
			};
		}
		//#endregion
		//#region \0relay-css-module:./src/client/AdvancedDebug.module.css.mjs
		const css$1 = ".Y4qSZW_section{width:100%;max-width:780px;color:var(--dsw-alias-label-primary)}.Y4qSZW_settingRow{border-bottom:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:20px;min-height:58px;padding:8px 0;display:flex}.Y4qSZW_statusRow{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:flex-start;gap:10px;min-height:70px;padding:10px 0;display:flex}.Y4qSZW_statusDot{background:var(--dsw-alias-label-tertiary);border-radius:50%;flex:none;width:8px;height:8px;margin-top:6px}.Y4qSZW_statusRow[data-codex-status=connected] .Y4qSZW_statusDot{background:#27a65b}.Y4qSZW_statusRow[data-codex-status=connection-failed] .Y4qSZW_statusDot,.Y4qSZW_statusRow[data-codex-status=unavailable] .Y4qSZW_statusDot,.Y4qSZW_statusRow[data-codex-status=rebind-required] .Y4qSZW_statusDot{background:#d94841}.Y4qSZW_settingCopy code{color:var(--dsw-alias-label-tertiary);font-size:11px}.Y4qSZW_statusBadge{border-radius:999px;padding:2px 7px;font-size:11px;font-weight:600;line-height:16px}.Y4qSZW_statusError{color:#d94841;background:#d9484124}.Y4qSZW_statusRebind{color:#a95d00;background:#c26a0029}.Y4qSZW_settingCopy{flex-direction:column;gap:2px;min-width:0;display:flex}.Y4qSZW_settingCopy strong{font-size:14px;font-weight:500;line-height:20px}.Y4qSZW_settingCopy span{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.Y4qSZW_switch{cursor:pointer;flex:none;width:36px;height:20px;display:inline-flex;position:relative}.Y4qSZW_switch input{opacity:0;width:1px;height:1px;position:absolute}.Y4qSZW_switch span{background:var(--dsw-alias-fill-l2);border-radius:10px;width:100%;transition:background-color .12s}.Y4qSZW_switch span:after{background:var(--dsw-alias-bg-layer-1);content:\"\";border-radius:50%;width:16px;height:16px;transition:transform .12s;position:absolute;top:2px;left:2px;box-shadow:0 1px 3px #0003}.Y4qSZW_switch input:checked+span{background:var(--dsw-alias-state-business-primary)}.Y4qSZW_switch input:checked+span:after{transform:translate(16px)}.Y4qSZW_switch input:focus-visible+span{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.Y4qSZW_marker{display:none}[data-relay-simple-conversation=true] [role=tablist]{display:none}";
		const tagId$1 = "relay-dsh-plugin-codex/AdvancedDebug.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "relay-dsh-plugin-codex";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var AdvancedDebug_module_css_default = {
			"marker": "Y4qSZW_marker",
			"section": "Y4qSZW_section",
			"settingCopy": "Y4qSZW_settingCopy",
			"settingRow": "Y4qSZW_settingRow",
			"statusBadge": "Y4qSZW_statusBadge",
			"statusDot": "Y4qSZW_statusDot",
			"statusError": "Y4qSZW_statusError",
			"statusRebind": "Y4qSZW_statusRebind",
			"statusRow": "Y4qSZW_statusRow",
			"switch": "Y4qSZW_switch"
		};
		//#endregion
		//#region src/client/codex-status-client.mjs
		const CODEX_STATUS_PATH = "/api/relay/codex/status";
		async function fetchCodexStatus(sessionId, fetchImpl = fetch) {
			const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
			const response = await fetchImpl(`${CODEX_STATUS_PATH}${query}`, {
				method: "GET",
				headers: { accept: "application/json" }
			});
			const body = await response.json().catch(() => null);
			if (!response.ok || !validStatus(body)) throw new Error(body?.message ?? `Codex status failed with HTTP ${response.status}`);
			return body;
		}
		function statusLocaleKey(status) {
			if (!status) return "statusLoading";
			if (status.state === "connected") return "statusConnected";
			if (status.state === "not-started") return "statusNotStarted";
			if (status.state === "starting") return "statusStarting";
			if (status.state === "rebind-required") return "statusRebindRequired";
			if (status.state === "unavailable") return "statusUnavailable";
			return "statusConnectionFailed";
		}
		function validStatus(value) {
			return value !== null && typeof value === "object" && typeof value.state === "string" && typeof value.code === "string" && typeof value.message === "string";
		}
		//#endregion
		//#region src/client/CodexStatus.tsx
		function useCodexStatus(sessionId, enabled = true) {
			const [status, setStatus] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				if (!enabled) {
					setStatus(null);
					return;
				}
				let active = true;
				const refresh = () => {
					fetchCodexStatus(sessionId).then((value) => {
						if (active) setStatus(value);
					}).catch(() => {
						if (active) setStatus({
							state: "connection-failed",
							code: "CODEX_STATUS_UNAVAILABLE",
							message: "DSH could not read Codex connection status.",
							action: "Restart DSH and try again.",
							changedAt: Date.now()
						});
					});
				};
				refresh();
				const timer = window.setInterval(refresh, 5e3);
				window.addEventListener("focus", refresh);
				return () => {
					active = false;
					window.clearInterval(timer);
					window.removeEventListener("focus", refresh);
				};
			}, [sessionId, enabled]);
			return status;
		}
		function CodexStatusBadge({ sessionId, useSessions, t }) {
			const preset = useSessions((state) => state.byId[sessionId]?.agentPreset);
			const status = useCodexStatus(String(sessionId), preset === "relay-codex");
			if (preset !== "relay-codex" || status === null || status.state === "connected") return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: `${AdvancedDebug_module_css_default.statusBadge} ${status.state === "rebind-required" ? AdvancedDebug_module_css_default.statusRebind : AdvancedDebug_module_css_default.statusError}`,
				title: `${status.message} ${status.action ?? ""}`.trim(),
				"data-codex-status": status.state,
				children: t(statusLocaleKey(status))
			});
		}
		//#endregion
		//#region src/client/AdvancedDebug.tsx
		function AdvancedDebugSection({ useAdvancedDebug, setAdvancedDebug, t }) {
			const enabled = useAdvancedDebug((value) => value);
			const codexStatus = useCodexStatus();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: AdvancedDebug_module_css_default.section,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: AdvancedDebug_module_css_default.statusRow,
					"data-codex-status": codexStatus?.state ?? "loading",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: AdvancedDebug_module_css_default.statusDot,
						"aria-hidden": "true"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: AdvancedDebug_module_css_default.settingCopy,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
								t("statusTitle"),
								": ",
								t(statusLocaleKey(codexStatus))
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: codexStatus === null ? t("statusLoadingDetail") : `${codexStatus.message} ${codexStatus.action ?? ""}`.trim() }),
							codexStatus !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: codexStatus.code })
						]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: AdvancedDebug_module_css_default.settingRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: AdvancedDebug_module_css_default.settingCopy,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("advancedDebug") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("advancedDebugDetail") })]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: AdvancedDebug_module_css_default.switch,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							role: "switch",
							"aria-label": t("advancedDebug"),
							checked: enabled,
							onChange: (event) => {
								setAdvancedDebug(event.currentTarget.checked);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { "aria-hidden": "true" })]
					})]
				})]
			});
		}
		function AdvancedDebugGuard({ useAdvancedDebug }) {
			const enabled = useAdvancedDebug((value) => value);
			const marker = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => {
				const header = marker.current?.closest("header");
				if (header === void 0 || header === null) return;
				if (enabled) header.removeAttribute("data-relay-simple-conversation");
				else {
					const selectChat = () => {
						const chatTab = header.querySelector("[role=\"tablist\"] [role=\"tab\"]");
						if (chatTab?.getAttribute("aria-selected") !== "true") chatTab?.click();
					};
					selectChat();
					header.setAttribute("data-relay-simple-conversation", "true");
					const observer = new MutationObserver(selectChat);
					observer.observe(header, {
						attributes: true,
						attributeFilter: ["aria-selected"],
						childList: true,
						subtree: true
					});
					return () => {
						observer.disconnect();
						header.removeAttribute("data-relay-simple-conversation");
					};
				}
				return () => {
					header.removeAttribute("data-relay-simple-conversation");
				};
			}, [enabled]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				ref: marker,
				className: AdvancedDebug_module_css_default.marker,
				"aria-hidden": "true"
			});
		}
		function HiddenSessionLogAction() {
			return null;
		}
		//#endregion
		//#region src/client/locales.ts
		const zh = {
			advancedNav: "高级",
			advancedDebug: "高级调试模式",
			advancedDebugDetail: "轨迹与诊断包",
			statusTitle: "Codex 连接",
			statusLoading: "正在读取",
			statusLoadingDetail: "正在读取 Codex App Server 状态。",
			statusConnected: "已连接",
			statusNotStarted: "未启动",
			statusStarting: "正在启动",
			statusConnectionFailed: "连接失败",
			statusUnavailable: "Codex 不可用",
			statusRebindRequired: "需要重新绑定",
			importAction: "导入 Codex 会话",
			importTitle: "导入 Codex 会话",
			importDescription: "将此工作区已有的 Codex 会话接入 DSH。",
			importWorkspaceLabel: "目标 Workspace",
			importChooseWorkspace: "选择要扫描和导入会话的 Workspace。",
			importScanAction: "扫描会话",
			importNoWorkspace: "请先打开一个工作区，再导入 Codex 会话。",
			importScanning: "正在查找此工作区的 Codex 会话...",
			importEmpty: "此工作区没有可导入的 Codex 会话。",
			importFound: "找到",
			importExisting: "已存在",
			importRecoverable: "待恢复",
			importReady: "可导入",
			importCandidates: "可导入的 Codex 会话",
			importSelected: "已选择",
			importSelectAll: "全选",
			importClearSelection: "清空",
			importStatusReady: "可导入",
			importStatusRecoverable: "待恢复",
			importSelectedAction: "导入所选会话",
			importImporting: "正在导入",
			importComplete: "所有会话均已接入 DSH。",
			importPartial: "导入已完成，部分会话需要重试。",
			importImported: "已导入",
			importFailures: "失败",
			importFailed: "导入失败。",
			close: "关闭",
			cancel: "取消",
			retry: "重试"
		};
		const en = {
			advancedNav: "Advanced",
			advancedDebug: "Advanced debugging",
			advancedDebugDetail: "Trajectory and diagnostic archive",
			statusTitle: "Codex connection",
			statusLoading: "Loading",
			statusLoadingDetail: "Reading Codex App Server status.",
			statusConnected: "Connected",
			statusNotStarted: "Not started",
			statusStarting: "Starting",
			statusConnectionFailed: "Connection failed",
			statusUnavailable: "Codex unavailable",
			statusRebindRequired: "Rebind required",
			importAction: "Import Codex Sessions",
			importTitle: "Import Codex Sessions",
			importDescription: "Connect existing Codex sessions for this Workspace to DSH.",
			importWorkspaceLabel: "Target Workspace",
			importChooseWorkspace: "Choose the Workspace whose sessions you want to scan and import.",
			importScanAction: "Scan sessions",
			importNoWorkspace: "Open a Workspace before importing Codex sessions.",
			importScanning: "Finding Codex sessions for this Workspace...",
			importEmpty: "No Codex sessions are available for this Workspace.",
			importFound: "Found",
			importExisting: "Existing",
			importRecoverable: "Recoverable",
			importReady: "Ready",
			importCandidates: "Codex sessions available to import",
			importSelected: "Selected",
			importSelectAll: "Select all",
			importClearSelection: "Clear",
			importStatusReady: "Ready",
			importStatusRecoverable: "Recoverable",
			importSelectedAction: "Import selected",
			importImporting: "Importing",
			importComplete: "All sessions are now available in DSH.",
			importPartial: "Import completed with sessions that need a retry.",
			importImported: "Imported",
			importFailures: "Failed",
			importFailed: "Import failed.",
			close: "Close",
			cancel: "Cancel",
			retry: "Retry"
		};
		//#endregion
		//#region codex-import-contract.mjs
		const CODEX_IMPORT_PATH = "/api/relay/codex/import";
		//#endregion
		//#region src/client/workspace-import-client.mjs
		function resolveImportWorkspace(workspaces, sessions) {
			const current = sessions?.current;
			if (current !== void 0) {
				const owner = workspaces?.items?.find((workspace) => workspace.sessionIds?.includes(current));
				if (owner) return owner;
			}
			const recent = workspaces?.recentWorkspaceId;
			return workspaces?.items?.find((workspace) => workspace.workspaceId === recent) ?? null;
		}
		async function scanCodexWorkspace(cwd, fetchImpl = fetch) {
			const response = await fetchImpl(CODEX_IMPORT_PATH, requestInit("scan", cwd));
			const body = await readJsonResponse(response);
			if (!response.ok) throw new Error(body?.message ?? `Codex import scan failed with HTTP ${response.status}`);
			return body;
		}
		async function importCodexWorkspace(cwd, { threadIds, onProgress } = {}, fetchImpl = fetch) {
			const response = await fetchImpl(CODEX_IMPORT_PATH, requestInit("import", cwd, threadIds));
			if (!response.ok) {
				const body = await readJsonResponse(response);
				throw new Error(body?.message ?? `Codex import failed with HTTP ${response.status}`);
			}
			let completed = null;
			for await (const frame of ndjsonFrames(response.body)) {
				if (frame?.type === "progress") onProgress?.(frame);
				if (frame?.type === "complete") completed = frame.result;
				if (frame?.type === "error") throw new Error(frame.message ?? "Codex import failed");
			}
			if (completed === null) throw new Error("Codex import response ended before completion");
			return completed;
		}
		async function refreshImportedWorkspace(sessions, workspaces) {
			await sessions.refresh();
			await workspaces.refresh();
		}
		async function* ndjsonFrames(body) {
			if (!body || typeof body.getReader !== "function") throw new Error("Codex import response has no readable body");
			const reader = body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			try {
				while (true) {
					const { done, value } = await reader.read();
					buffer += decoder.decode(value, { stream: !done });
					let newline = buffer.indexOf("\n");
					while (newline !== -1) {
						const line = buffer.slice(0, newline).trim();
						buffer = buffer.slice(newline + 1);
						if (line) yield parseFrame(line);
						newline = buffer.indexOf("\n");
					}
					if (done) break;
				}
				const finalLine = buffer.trim();
				if (finalLine) yield parseFrame(finalLine);
			} finally {
				reader.releaseLock();
			}
		}
		function requestInit(action, cwd, threadIds) {
			return {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action,
					cwd,
					...threadIds === void 0 ? {} : { threadIds }
				})
			};
		}
		async function readJsonResponse(response) {
			try {
				return await response.json();
			} catch {
				return null;
			}
		}
		function parseFrame(line) {
			try {
				return JSON.parse(line);
			} catch {
				throw new Error("Codex import returned malformed progress data");
			}
		}
		//#endregion
		//#region src/client/workspace-import-ui-policy.mjs
		function workspaceImportUiPolicy(phase, selected = 0, failed = 0, hasWorkspace = true) {
			if (phase === "importing") return Object.freeze({
				canClose: false,
				primary: "importing",
				primaryDisabled: true
			});
			if (phase === "summary") return Object.freeze({
				canClose: true,
				secondary: "cancel",
				primary: "import-selected",
				primaryDisabled: selected === 0
			});
			if (phase === "select-workspace") return Object.freeze({
				canClose: true,
				secondary: "cancel",
				primary: "scan",
				primaryDisabled: !hasWorkspace
			});
			if (phase === "error") return Object.freeze({
				canClose: true,
				secondary: "cancel",
				primary: "retry",
				primaryDisabled: false
			});
			if (phase === "complete" && failed > 0) return Object.freeze({
				canClose: true,
				secondary: "close",
				primary: "retry",
				primaryDisabled: false
			});
			return Object.freeze({
				canClose: true,
				primary: "close",
				primaryDisabled: false
			});
		}
		function workspaceImportUpdatedAtDate(value) {
			if (value === null || value === void 0) return null;
			const milliseconds = typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 0xe8d4a51000 ? value * 1e3 : value;
			const date = new Date(milliseconds);
			return Number.isNaN(date.getTime()) ? null : date;
		}
		//#endregion
		//#region \0relay-css-module:./src/client/WorkspaceImportAction.module.css.mjs
		const css = ".MJ4r_a_trigger{width:34px;min-width:34px;height:34px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;letter-spacing:0;background:0 0;border:0;border-radius:6px;flex:0 0 34px;justify-content:center;align-items:center;padding:0;display:flex}.MJ4r_a_trigger:hover{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}.MJ4r_a_trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}.MJ4r_a_trigger[data-compact=true]{flex-basis:28px;width:28px;min-width:28px;height:28px}.MJ4r_a_dialog{width:min(700px,100vw - 32px)}.MJ4r_a_workspaceChoice{flex-direction:column;gap:7px;min-width:0;display:flex}.MJ4r_a_workspaceChoice label{color:var(--dsw-alias-label-primary);letter-spacing:0;font-size:13px;font-weight:500;line-height:20px}.MJ4r_a_workspaceChoice select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1);width:100%;min-height:36px;color:var(--dsw-alias-label-primary);font:inherit;letter-spacing:0;border-radius:6px;padding:0 32px 0 10px;font-size:13px}.MJ4r_a_workspaceChoice select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.MJ4r_a_workspacePath{overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);letter-spacing:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px}.MJ4r_a_body{flex-direction:column;gap:18px;min-height:128px;display:flex}.MJ4r_a_workspace{border-bottom:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:3px;min-width:0;padding-bottom:12px;display:flex}.MJ4r_a_workspace strong{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);letter-spacing:0;font-size:14px;font-weight:500;line-height:20px}.MJ4r_a_workspace span{color:var(--dsw-alias-label-tertiary);letter-spacing:0;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px;overflow:hidden}.MJ4r_a_message,.MJ4r_a_error,.MJ4r_a_success,.MJ4r_a_partial{letter-spacing:0;margin:0;font-size:13px;line-height:20px}.MJ4r_a_message{color:var(--dsw-alias-label-secondary)}.MJ4r_a_error,.MJ4r_a_dangerValue{color:var(--dsw-alias-state-error-primary)}.MJ4r_a_success,.MJ4r_a_accentValue{color:var(--dsw-alias-state-success-primary)}.MJ4r_a_partial{color:var(--dsw-alias-state-error-secondary)}.MJ4r_a_metrics{border-top:1px solid var(--dsw-alias-border-l2);border-left:1px solid var(--dsw-alias-border-l2);grid-template-columns:repeat(2,minmax(0,1fr));margin:0;display:grid}.MJ4r_a_summary{flex-direction:column;gap:14px;min-width:0;display:flex}.MJ4r_a_selectionToolbar{min-height:28px;color:var(--dsw-alias-label-secondary);letter-spacing:0;justify-content:space-between;align-items:center;gap:12px;font-size:12px;line-height:18px;display:flex}.MJ4r_a_selectionToolbar>div{gap:4px;display:flex}.MJ4r_a_selectionToolbar button{min-height:28px;color:var(--dsw-alias-state-business-primary);cursor:pointer;font:inherit;letter-spacing:0;background:0 0;border:0;border-radius:4px;padding:0 8px}.MJ4r_a_selectionToolbar button:hover{background:var(--dsw-alias-fill-l2)}.MJ4r_a_selectionToolbar button:focus-visible,.MJ4r_a_candidates input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.MJ4r_a_candidates{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;max-height:min(390px,48vh);margin:0;padding:0;list-style:none;display:flex;overflow-y:auto}.MJ4r_a_candidates li{border-bottom:1px solid var(--dsw-alias-border-l2);min-width:0}.MJ4r_a_candidates label{cursor:pointer;grid-template-columns:18px minmax(0,1fr);gap:10px;min-width:0;padding:11px 4px;display:grid}.MJ4r_a_candidates input{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary);margin:2px 0 0}.MJ4r_a_candidateBody{flex-direction:column;gap:2px;min-width:0;display:flex}.MJ4r_a_candidateHeading{justify-content:space-between;align-items:flex-start;gap:12px;min-width:0;display:flex}.MJ4r_a_candidateHeading strong{overflow-wrap:anywhere;min-width:0;color:var(--dsw-alias-label-primary);letter-spacing:0;font-size:13px;font-weight:500;line-height:19px}.MJ4r_a_candidateHeading>span{color:var(--dsw-alias-state-success-primary);letter-spacing:0;flex:none;font-size:11px;line-height:18px}.MJ4r_a_candidateBody code,.MJ4r_a_candidateBody>span,.MJ4r_a_candidateBody time{overflow-wrap:anywhere;min-width:0;color:var(--dsw-alias-label-tertiary);letter-spacing:0;font-size:11px;line-height:17px}.MJ4r_a_candidateBody code{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.MJ4r_a_metric{border-right:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);min-width:0;padding:10px 12px}.MJ4r_a_metric dt{color:var(--dsw-alias-label-tertiary);letter-spacing:0;font-size:11px;line-height:16px}.MJ4r_a_metric dd{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;letter-spacing:0;margin:2px 0 0;font-size:18px;font-weight:500;line-height:24px}.MJ4r_a_progress{flex-direction:column;gap:10px;display:flex}.MJ4r_a_progressCopy{color:var(--dsw-alias-label-secondary);letter-spacing:0;justify-content:space-between;align-items:center;gap:16px;font-size:13px;line-height:20px;display:flex}.MJ4r_a_progressCopy strong{color:var(--dsw-alias-label-primary);font-weight:500}.MJ4r_a_progress progress{width:100%;height:6px;accent-color:var(--dsw-alias-state-business-primary)}.MJ4r_a_failures{flex-direction:column;gap:8px;margin:14px 0 0;padding:0;list-style:none;display:flex}.MJ4r_a_failures li{min-width:0;color:var(--dsw-alias-label-secondary);letter-spacing:0;grid-template-columns:minmax(88px,auto) minmax(0,1fr);gap:10px;font-size:12px;line-height:18px;display:grid}.MJ4r_a_failures code,.MJ4r_a_failures span{overflow-wrap:anywhere}.MJ4r_a_failures code{color:var(--dsw-alias-state-error-primary)}@media (width<=520px){.MJ4r_a_dialog{width:calc(100vw - 20px)}.MJ4r_a_metrics{grid-template-columns:minmax(0,1fr)}.MJ4r_a_selectionToolbar,.MJ4r_a_candidateHeading{flex-direction:column;align-items:flex-start}.MJ4r_a_candidateHeading{gap:2px}}";
		const tagId = "relay-dsh-plugin-codex/WorkspaceImportAction.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "relay-dsh-plugin-codex";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var WorkspaceImportAction_module_css_default = {
			"accentValue": "MJ4r_a_accentValue",
			"body": "MJ4r_a_body",
			"candidateBody": "MJ4r_a_candidateBody",
			"candidateHeading": "MJ4r_a_candidateHeading",
			"candidates": "MJ4r_a_candidates",
			"dangerValue": "MJ4r_a_dangerValue",
			"dialog": "MJ4r_a_dialog",
			"error": "MJ4r_a_error",
			"failures": "MJ4r_a_failures",
			"message": "MJ4r_a_message",
			"metric": "MJ4r_a_metric",
			"metrics": "MJ4r_a_metrics",
			"partial": "MJ4r_a_partial",
			"progress": "MJ4r_a_progress",
			"progressCopy": "MJ4r_a_progressCopy",
			"selectionToolbar": "MJ4r_a_selectionToolbar",
			"success": "MJ4r_a_success",
			"summary": "MJ4r_a_summary",
			"trigger": "MJ4r_a_trigger",
			"workspace": "MJ4r_a_workspace",
			"workspaceChoice": "MJ4r_a_workspaceChoice",
			"workspacePath": "MJ4r_a_workspacePath"
		};
		//#endregion
		//#region src/client/WorkspaceImportAction.tsx
		function WorkspaceImportAction({ wide, useWorkspaceImportWorkspaces, useWorkspaceImportSessions, scanWorkspace, importWorkspace, refreshWorkspaceState, t }) {
			const workspaces = useWorkspaceImportWorkspaces((value) => value);
			const availableTarget = resolveImportWorkspace(workspaces, useWorkspaceImportSessions((value) => value));
			const [open, setOpen] = (0, react.useState)(false);
			const [target, setTarget] = (0, react.useState)(null);
			const [phase, setPhase] = (0, react.useState)("idle");
			const [summary, setSummary] = (0, react.useState)(null);
			const [candidates, setCandidates] = (0, react.useState)([]);
			const [selectedIds, setSelectedIds] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [progress, setProgress] = (0, react.useState)(null);
			const [result, setResult] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const request = (0, react.useRef)(0);
			const close = () => {
				if (!workspaceImportUiPolicy(phase, selectedIds.size, result?.failed).canClose) return;
				request.current += 1;
				setOpen(false);
			};
			const scan = (workspace) => {
				const generation = ++request.current;
				setPhase("scanning");
				setSummary(null);
				setCandidates([]);
				setSelectedIds(/* @__PURE__ */ new Set());
				setProgress(null);
				setResult(null);
				setError("");
				scanWorkspace(workspace.path).then((response) => {
					if (request.current !== generation) return;
					setSummary(response.summary);
					setCandidates(response.candidates);
					setSelectedIds(new Set(response.candidates.map((candidate) => candidate.id)));
					setPhase("summary");
				}, (reason) => {
					if (request.current !== generation) return;
					setError(messageOf(reason));
					setPhase("error");
				});
			};
			const begin = () => {
				const selected = availableTarget ?? workspaces.items[0] ?? null;
				setTarget(selected);
				setOpen(true);
				if (selected === null) {
					setPhase("no-workspace");
					return;
				}
				setPhase("select-workspace");
			};
			const scanSelected = () => {
				if (target !== null) scan(target);
			};
			const importSelected = () => {
				const threadIds = candidates.filter((candidate) => selectedIds.has(candidate.id)).map((candidate) => candidate.id);
				if (target === null || summary === null || threadIds.length === 0 || phase === "importing") return;
				const generation = ++request.current;
				setPhase("importing");
				setProgress({
					completed: 0,
					total: threadIds.length,
					found: threadIds.length,
					imported: 0,
					existing: 0,
					failed: 0,
					failures: []
				});
				setError("");
				(async () => {
					try {
						const completed = await importWorkspace(target.path, threadIds, (update) => {
							if (request.current === generation) setProgress(update);
						});
						await refreshWorkspaceState();
						if (request.current !== generation) return;
						setResult(completed);
						setPhase("complete");
					} catch (reason) {
						if (request.current !== generation) return;
						setError(messageOf(reason));
						setPhase("error");
					}
				})();
			};
			const retry = () => {
				if (target !== null) scan(target);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: t("importAction"),
				side: "top",
				delayMs: 500,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: WorkspaceImportAction_module_css_default.trigger,
					"aria-label": t("importAction"),
					"data-provider": "codex",
					"data-compact": wide ? void 0 : "true",
					onClick: begin,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, { size: wide ? 18 : 16 })
				})
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose: close,
				title: t("importTitle"),
				closeLabel: t("close"),
				description: t("importDescription"),
				className: WorkspaceImportAction_module_css_default.dialog,
				footer: modalFooter({
					phase,
					selectedCount: selectedIds.size,
					result,
					close,
					scanSelected,
					retry,
					importSelected,
					t
				}),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: WorkspaceImportAction_module_css_default.body,
					"aria-live": "polite",
					children: [
						phase === "select-workspace" && target !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: WorkspaceImportAction_module_css_default.workspaceChoice,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									htmlFor: "codex-import-workspace",
									children: t("importWorkspaceLabel")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									id: "codex-import-workspace",
									value: target.workspaceId,
									"aria-describedby": "codex-import-workspace-help",
									onChange: (event) => {
										const selected = workspaces.items.find((workspace) => workspace.workspaceId === event.currentTarget.value);
										if (selected !== void 0) setTarget(selected);
									},
									children: workspaces.items.map((workspace) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: workspace.workspaceId,
										children: workspace.title
									}, workspace.workspaceId))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									id: "codex-import-workspace-help",
									className: WorkspaceImportAction_module_css_default.message,
									children: t("importChooseWorkspace")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: WorkspaceImportAction_module_css_default.workspacePath,
									title: target.path,
									children: target.path
								})
							]
						}),
						target !== null && phase !== "select-workspace" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: WorkspaceImportAction_module_css_default.workspace,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: target.title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								title: target.path,
								children: target.path
							})]
						}),
						phase === "no-workspace" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: WorkspaceImportAction_module_css_default.message,
							children: t("importNoWorkspace")
						}),
						phase === "scanning" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: WorkspaceImportAction_module_css_default.message,
							children: t("importScanning")
						}),
						phase === "summary" && summary !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SummaryView, {
							summary,
							candidates,
							selectedIds,
							onSelectionChange: setSelectedIds,
							t
						}),
						phase === "importing" && progress !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProgressView, {
							progress,
							t
						}),
						phase === "complete" && result !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ResultView, {
							result,
							t
						}),
						phase === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: WorkspaceImportAction_module_css_default.error,
							role: "alert",
							children: error || t("importFailed")
						})
					]
				})
			})] });
		}
		function SummaryView({ summary, candidates, selectedIds, onSelectionChange, t }) {
			const select = (id, checked) => {
				const next = new Set(selectedIds);
				if (checked) next.add(id);
				else next.delete(id);
				onSelectionChange(next);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: WorkspaceImportAction_module_css_default.summary,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
					className: WorkspaceImportAction_module_css_default.metrics,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: t("importFound"),
							value: summary.found
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: t("importExisting"),
							value: summary.existing
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: t("importRecoverable"),
							value: summary.recoverable
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: t("importReady"),
							value: summary.ready,
							accent: true
						})
					]
				}), candidates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: WorkspaceImportAction_module_css_default.message,
					children: t("importEmpty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: WorkspaceImportAction_module_css_default.selectionToolbar,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
						t("importSelected"),
						": ",
						selectedIds.size,
						" / ",
						candidates.length
					] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => onSelectionChange(new Set(candidates.map((candidate) => candidate.id))),
						children: t("importSelectAll")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => onSelectionChange(/* @__PURE__ */ new Set()),
						children: t("importClearSelection")
					})] })]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: WorkspaceImportAction_module_css_default.candidates,
					"aria-label": t("importCandidates"),
					children: candidates.map((candidate) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "checkbox",
						checked: selectedIds.has(candidate.id),
						onChange: (event) => select(candidate.id, event.currentTarget.checked)
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: WorkspaceImportAction_module_css_default.candidateBody,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: WorkspaceImportAction_module_css_default.candidateHeading,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: candidate.title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: candidate.status === "recoverable" ? t("importStatusRecoverable") : t("importStatusReady") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: candidate.id }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								title: candidate.cwd,
								children: candidate.cwd
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("time", {
								dateTime: dateTimeValue(candidate.updatedAt),
								children: formatUpdatedAt(candidate.updatedAt)
							})
						]
					})] }) }, candidate.id))
				})] })]
			});
		}
		function ProgressView({ progress, t }) {
			const maximum = Math.max(1, progress.total);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: WorkspaceImportAction_module_css_default.progress,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: WorkspaceImportAction_module_css_default.progressCopy,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("importImporting") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
						progress.completed,
						" / ",
						progress.total
					] })]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("progress", {
					value: progress.completed,
					max: maximum,
					"aria-label": t("importImporting")
				})]
			});
		}
		function ResultView({ result, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: result.failed > 0 ? WorkspaceImportAction_module_css_default.partial : WorkspaceImportAction_module_css_default.success,
					children: result.failed > 0 ? t("importPartial") : t("importComplete")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
					className: WorkspaceImportAction_module_css_default.metrics,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: t("importImported"),
							value: result.imported,
							accent: true
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: t("importExisting"),
							value: result.existing
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: t("importFailures"),
							value: result.failed,
							danger: result.failed > 0
						})
					]
				}),
				result.failures.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: WorkspaceImportAction_module_css_default.failures,
					"aria-label": t("importFailures"),
					children: result.failures.map((failure) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: failure.thread }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: failure.message })] }, failure.thread))
				})
			] });
		}
		function Metric({ label, value, accent = false, danger = false }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: WorkspaceImportAction_module_css_default.metric,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
					className: danger ? WorkspaceImportAction_module_css_default.dangerValue : accent ? WorkspaceImportAction_module_css_default.accentValue : void 0,
					children: value
				})]
			});
		}
		function modalFooter({ phase, selectedCount, result, close, scanSelected, retry, importSelected, t }) {
			const policy = workspaceImportUiPolicy(phase, selectedCount, result?.failed, phase !== "no-workspace");
			const actions = {
				cancel: close,
				close,
				"import-selected": importSelected,
				importing: void 0,
				retry,
				scan: scanSelected
			};
			const labels = {
				cancel: t("cancel"),
				close: t("close"),
				"import-selected": t("importSelectedAction"),
				importing: t("importImporting"),
				retry: t("retry"),
				scan: t("importScanAction")
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [policy.secondary !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				variant: "outline",
				onClick: actions[policy.secondary],
				children: labels[policy.secondary]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				variant: policy.primary === "close" ? "outline" : void 0,
				disabled: policy.primaryDisabled,
				onClick: actions[policy.primary],
				children: labels[policy.primary]
			})] });
		}
		function dateTimeValue(value) {
			return workspaceImportUpdatedAtDate(value)?.toISOString();
		}
		function formatUpdatedAt(value) {
			const date = workspaceImportUpdatedAtDate(value);
			return date === null ? "-" : new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			}).format(date);
		}
		function messageOf(reason) {
			return reason instanceof Error ? reason.message : String(reason);
		}
		//#endregion
		//#region codex-sync-contract.mjs
		const CODEX_SYNC_PATH = "/api/relay/codex/sync";
		//#endregion
		//#region src/client/session-open-sync.mjs
		const DSH_CURRENT_SESSION_STORAGE_KEY = "dsh.sessions.current";
		function observeSessionOpen(currentProvideInfo, syncSession, onError = console.warn, readFallbackSessionId = readPersistedDshCurrentSessionId) {
			let selectedSessionId = null;
			let selectionRevision = 0;
			let latestOperation = null;
			const runSync = async (sessionId, revision) => {
				for (let attempt = 0; attempt < 2; attempt += 1) try {
					await syncSession(sessionId, () => selectionRevision === revision && selectedSessionId === sessionId);
					return;
				} catch (error) {
					const stillSelected = selectionRevision === revision && selectedSessionId === sessionId;
					if (!stillSelected || attempt === 1) {
						if (stillSelected) selectedSessionId = null;
						onError(error);
						return;
					}
				}
			};
			const reconcile = () => {
				const sessionId = currentProvideInfo.getSnapshot()?.sessionId ?? readFallbackSessionId() ?? null;
				if (sessionId === null && latestOperation !== null) return;
				if (sessionId === selectedSessionId) return;
				selectedSessionId = sessionId;
				selectionRevision += 1;
				if (sessionId === null) return;
				const operation = runSync(String(sessionId), selectionRevision);
				latestOperation = operation;
				operation.finally(() => {
					if (latestOperation === operation) latestOperation = null;
				});
			};
			const unsubscribe = currentProvideInfo.subscribe(reconcile);
			reconcile();
			return unsubscribe;
		}
		async function syncOpenedCodexSession(sessionId, fetchImpl = fetch) {
			const response = await fetchImpl(CODEX_SYNC_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId })
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) throw new Error(body?.message ?? `Codex history sync failed with HTTP ${response.status}`);
			if (body?.status !== "synced" && body?.status !== "not-imported") throw new Error("Codex history sync returned an invalid response");
			return body;
		}
		async function syncOpenedCodexSessionAndRefresh(sessionId, refreshSessions, fetchImpl = fetch, openSession = null, writeCurrentSessionId = writePersistedDshCurrentSessionId, isLatestSelection = () => true) {
			const result = await syncOpenedCodexSession(sessionId, fetchImpl);
			const rebuiltSessionId = typeof result.rebuiltSessionId === "string" && result.rebuiltSessionId.trim() ? result.rebuiltSessionId : null;
			if (result.status === "synced" && (result.projectedMessages > 0 || rebuiltSessionId !== null)) await refreshSessions();
			if (rebuiltSessionId !== null && isLatestSelection()) {
				writeCurrentSessionId(rebuiltSessionId);
				try {
					await openSession?.(rebuiltSessionId);
				} catch (error) {
					if (!isLatestSelection()) return result;
					await refreshSessions();
					if (!isLatestSelection()) return result;
					await openSession?.(rebuiltSessionId);
				}
			}
			return result;
		}
		function readPersistedDshCurrentSessionId(storage = browserStorage()) {
			try {
				const raw = storage?.getItem?.(DSH_CURRENT_SESSION_STORAGE_KEY);
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				return typeof parsed?.sessionId === "string" && parsed.sessionId.trim() ? parsed.sessionId : null;
			} catch {
				return null;
			}
		}
		function writePersistedDshCurrentSessionId(sessionId, storage = browserStorage()) {
			const candidate = typeof sessionId === "string" ? sessionId.trim() : "";
			if (!candidate) return;
			try {
				storage?.setItem?.(DSH_CURRENT_SESSION_STORAGE_KEY, JSON.stringify({ sessionId: candidate }));
			} catch {}
		}
		function browserStorage() {
			try {
				return typeof window === "undefined" ? null : window.localStorage;
			} catch {
				return null;
			}
		}
		//#endregion
		//#region src/client/index.ts
		const inject = [
			"slots",
			"theme",
			"locale",
			"sessions",
			"workspaces",
			"connection"
		];
		function apply(ctx) {
			applyAdvancedDebug(ctx);
			applyWorkspaceImport(ctx);
			applySessionOpenSync(ctx);
			applyConnectionStatus(ctx);
			return installModelSelection(ctx, "relay-codex", "relay-codex", "relay-claude");
		}
		function applyConnectionStatus(ctx) {
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "relay-codex-connection-status",
				order: -19,
				locale: "relay.codex"
			}, CodexStatusBadge));
		}
		function applySessionOpenSync(ctx) {
			ctx.effect(() => observeSessionOpen(ctx.sessions.currentProvideInfo, (sessionId, isLatestSelection) => syncOpenedCodexSessionAndRefresh(sessionId, () => Promise.all([ctx.sessions.refresh(), ctx.workspaces.refresh()]), fetch, (rebuiltSessionId) => ctx.sessions.open(rebuiltSessionId), void 0, isLatestSelection), (error) => console.warn("Codex open-time history sync failed:", error)), "relay-codex: open-time history sync");
		}
		function applyWorkspaceImport(ctx) {
			const injected = () => ({
				hooks: {
					workspaceImportWorkspaces: ctx.workspaces.list,
					workspaceImportSessions: ctx.sessions.list
				},
				scanWorkspace: (cwd) => scanCodexWorkspace(cwd),
				importWorkspace: (cwd, threadIds, onProgress) => importCodexWorkspace(cwd, {
					threadIds,
					onProgress
				}),
				refreshWorkspaceState: () => refreshImportedWorkspace(ctx.sessions, ctx.workspaces)
			});
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "relay-codex-workspace-import",
				order: -10,
				inject: injected,
				locale: "relay.codex"
			}, WorkspaceImportAction));
		}
		function applyAdvancedDebug(ctx) {
			ctx.effect(() => ctx.locale.register("relay.codex", {
				zh,
				en
			}), "relay-codex: dictionaries");
			const t = ctx.locale.bind("relay.codex");
			const advancedDebug = new AdvancedDebugPreference();
			const hooks = { hooks: { advancedDebug } };
			ctx.effect(() => () => {
				advancedDebug.dispose();
			}, "relay-codex: advanced debug preference");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "relay-codex-advanced-debug",
				order: 90,
				label: () => t("advancedNav"),
				locale: "relay.codex",
				inject: () => ({
					...hooks,
					setAdvancedDebug: (enabled) => {
						advancedDebug.set(enabled);
					}
				})
			}, AdvancedDebugSection));
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "relay-codex-advanced-debug-guard",
				order: -20,
				inject: () => hooks
			}, AdvancedDebugGuard));
			ctx.slots.inject("conversation.session.header.utilities", () => {
				let removeShadow;
				const reconcile = () => {
					if (advancedDebug.getSnapshot()) {
						removeShadow?.();
						removeShadow = void 0;
					} else if (removeShadow === void 0) removeShadow = ctx.slots.register({
						name: "conversation.session.header.utilities",
						id: "session-log-download",
						priority: -100
					}, HiddenSessionLogAction);
				};
				const unsubscribe = advancedDebug.subscribe(reconcile);
				reconcile();
				return () => {
					unsubscribe();
					removeShadow?.();
				};
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map