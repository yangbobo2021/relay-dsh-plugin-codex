# Codex Reliability Acceptance

The implementation is accepted only when the specification, source, tests,
generated `lib/` artifacts, package contents, and this matrix agree.

| ID / scenario | Preconditions | Executable steps | Expected result | Automation / manual check | Risk covered |
| --- | --- | --- | --- | --- | --- |
| C1 Connected startup | Plugin package and current platform runtime installed. | Activate Host; wait for initialize, model/list, and account/read; dispose. | `not-started` → `starting` → `connected`; one Host-owned child; clean stop. | `plugin.test.mjs`, `session-runtime.test.mjs`; Settings shows **Connected** and a live reply completes. | Undefined process ownership, startup hang, process leak. |
| C2 Missing configured executable | Set `codexCommand` or `RELAY_CODEX_COMMAND` to a nonexistent absolute path. | Activate plugin; read status; request readiness. | `unavailable` + `CODEX_EXECUTABLE_NOT_FOUND`; actionable override guidance; no raw ENOENT and no Thread start. | `app-server-client.test.mjs`, `plugin.test.mjs`, `connection-status.test.mjs`; manual invalid-override check. | The reported `spawn codex ENOENT` incident. |
| C3 Missing runtime / unsupported target | Inject missing optional package or unsupported platform/arch. | Resolve launcher. | `CODEX_RUNTIME_MISSING` or `CODEX_PLATFORM_UNSUPPORTED`; reinstall/absolute-path action. | `codex-command.test.mjs`, `connection-status.test.mjs`. | Package-manager optional dependency and target gaps. |
| C4 Protocol/process failure | Executable exists; fake initialize timeout, protocol error, or early exit. | Start and wait for readiness. | `connection-failed`, not an installation diagnosis; bindings remain. | `app-server-client.test.mjs`, `connection-status.test.mjs`; manual forced-exit check. | Misdiagnosis and invisible App Server failure. |
| C5 Visible status | DSH Web loads plugin client. | Open Settings → Advanced; open affected Codex Session. | Localized global state; header shows non-connected/rebind state and server action/code. | Client status/route tests; manual browser screenshot. | Host-only logs that ordinary users cannot act on. |
| M1 Backend switch | Blank Session with Standard, Codex, and Claude groups. | Standard → Codex → Claude → Codex → Standard. | Provider, default model, and effort follow each backend. | `model-selection.test.mjs`; manual model-picker check. | Model picker remains on native DSH or wrong backend. |
| M2 Discovery race | Delay/reorder models responses or omit Codex group initially. | Change preset while a query is pending; later expose Codex group. | Old generation cannot select; bounded retry selects current target; stop cancels timers. | `model-selection.test.mjs`. | Async overwrite and intermittent startup race. |
| M3 Non-blank Session | Existing Session has already sent a Turn. | Trigger preset/list updates. | No provider rewrite. | `model-selection.test.mjs`. | Existing conversation route corruption. |
| F1 App Server fork | Parent DSH Session owns Thread T; completed assistant replay state names T, Turn A, optional Item I; child has no binding. | Send first child continuation. | Exactly one `thread/fork(T, lastTurnId=A)`; returned child Thread C is persisted and receives the continuation; no child `thread/start`; parent T receives no child Turn. | `session-runtime.test.mjs`, `dsh-adapter.test.mjs`; real DSH fork screenshot and binding inspection. | Silent fresh Thread, child writing into parent, or lost Codex context. |
| F1b Fork rejection | Replay lacks A, T has no owning DSH Session, A is in progress, or App Server rejects/returns an invalid child. | Send first child continuation, then optionally retry the same stable provenance after recovery. | `CODEX_REBIND_REQUIRED` with T/A/I; zero fallback `thread/start` and zero child `turn/start`; no link before successful retry. | `dsh-adapter.test.mjs`; manual forced rejection check. | Unsafe provenance, partial-history forks, or masking protocol failure with a fresh Thread. |
| F2 Persisted resume failure | Link store maps DSH Session to T; resume reports missing or transient failure. | Restart adapter and ensure Thread. | T remains persisted; missing enters rebind; transient failure is retryable; zero replacement starts. | `dsh-adapter.test.mjs`. | Destructive recovery that masks broken bindings. |
| F3 Disconnect / pending approval / reconnect / stale replay | Approval request carries DSH Session, T/A/I, request id, and binding epoch. | Hold approval; disconnect browser; invalidate owner/binding; reconnect and answer replay. | `rejectRequest` with `CODEX_STALE_APPROVAL`; never `resolveRequest(accept)`; T/A/I named. | `dsh-adapter.test.mjs` ownership replay test; official DSH browser replay check. | Approval sent to the wrong Thread, Turn, or Item. |
| X1 Cross-platform launch | CI on macOS, Windows, Linux; empty PATH and paths with spaces. | Resolve and execute bundled launcher tests. | Six desktop target mappings; direct argument-array spawn; no shell splitting. | CI `codex-runtime` matrix; optional signed-in smoke per OS. | PATH, quoting, backslash, shell, architecture differences. |
| D1 Spec/package boundary | All behavior changes complete. | Run verify, build, pack, root boundary tests, and clean-reference check. | SPEC/README/code/tests/lib/package agree; official DSH reference unchanged. | Commands below plus `git diff --check`. | Documentation drift, missing artifact, upstream modification. |

## Commands

```bash
npm ci --ignore-scripts
DSH_ROOT=/path/to/deepseek-harness npm run verify
npm pack --dry-run
```

The official DSH reference must be commit
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` unless the README and CI are
updated together for a newer validated release.

## Reddit regression sequence

1. Create a Codex DSH Session and complete a Turn so its assistant message has
   replay state for Thread T and Turn A.
2. Fork the DSH Session at the stable completed boundary and open child C.
3. Continue in C. The plugin must call `thread/fork` with T/A, persist the
   returned child Thread, and send the continuation only to that child. It must
   not call `thread/start` for C or add the continuation to T.
4. Repeat with missing A or an in-progress A. The plugin must return
   `CODEX_REBIND_REQUIRED`; App Server receives no fallback `thread/start` or
   child `turn/start`.
5. For an explicitly bound child test fixture, pause on an App Server approval
   carrying Thread T, Turn A, and Item I; disconnect the Web client.
6. Change or detach the binding before the replayed approval is answered.
7. Reconnect and answer the replay. The plugin must call `rejectRequest`, not
   `resolveRequest`, and the failure must name T/A/I.
