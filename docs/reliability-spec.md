# Codex Reliability Specification

Status: Accepted for implementation

This specification defines the user-visible and safety-critical behavior of
`relay-dsh-plugin-codex`. The official DSH checkout remains unmodified.

## App Server ownership and connection state

The plugin Host process owns one Codex App Server child process. It starts the
child while the DSH Host activates the plugin, before Codex models are used,
and stops it when the plugin is disposed or DSH exits. The default launcher is
the pinned `@openai/codex` package and its platform optional dependency. A
global `codex` command is not required. `codexCommand` overrides
`RELAY_CODEX_COMMAND`, which overrides the bundled launcher.

The observable state machine is:

| State | Meaning | Required user behavior |
| --- | --- | --- |
| `not-started` | Plugin is loaded but start has not begun. | Wait for DSH startup. |
| `starting` | Child spawn and App Server initialization are in progress. | Wait; do not create a Thread. |
| `connected` | Initialize and model discovery succeeded. | Codex conversations may run. |
| `connection-failed` | A child existed or was attempted, but protocol initialization, connection, or process lifetime failed. | Preserve bindings; show restart/authentication diagnostics. |
| `unavailable` | The executable, bundled platform runtime, or supported platform is unavailable. | Show reinstall or absolute-path configuration guidance. |
| `rebind-required` | A DSH fork could not establish its App Server child binding safely. | Preserve provenance and retry Fork from the original Session after fixing the condition. |

User-facing status must never expose raw `spawn codex ENOENT`. Stable error
codes include `CODEX_EXECUTABLE_NOT_FOUND`, `CODEX_RUNTIME_MISSING`,
`CODEX_PLATFORM_UNSUPPORTED`, `CODEX_APP_SERVER_NOT_RUNNING`,
`CODEX_APP_SERVER_CONNECTION_FAILED`, and `CODEX_REBIND_REQUIRED`.

## Backend model selection

For a blank DSH Session, the selected Agent preset determines the model
provider group:

- `relay-codex` selects `relay-codex` and its default model/default reasoning
  effort;
- `relay-claude` is never rewritten by the Codex coordinator;
- leaving Codex for a native preset selects a provider group that is neither
  Codex nor Claude.

Only the newest preset generation may select a model. Model discovery may be
retried with bounded delays while the App Server becomes ready. A non-blank
Session is never rewritten by this synchronization.

## Thread binding and forks

One DSH Session binds at most one Codex Thread, and one Codex Thread binds at
most one DSH Session. A persisted binding is never deleted merely
because `thread/resume` fails. Active-writer and transient failures retain the
binding for retry. A missing Thread enters `rebind-required`.

DSH forks inherit assistant messages and their Codex `replayState`. When an
unbound child contains an original `threadId` and completed `turnId`, and that
Thread is still owned by another DSH Session, the plugin calls App Server
`thread/fork` with `threadId` and `lastTurnId`. It persists the returned new
Thread as the child's one-to-one binding before starting the child Turn. It
never writes the child continuation to the parent Thread.

Missing Turn provenance, an unowned or rebind-required source, an in-progress
Turn, an App Server rejection, or an invalid fork response enters
`CODEX_REBIND_REQUIRED`. Diagnostics retain the original Thread and, when
available, Turn and Item ids. These paths perform neither `thread/start` nor
`turn/start`, and the plugin must not silently create a replacement Thread.
Retrying the same provenance may retry `thread/fork`; it still cannot fall back
to fresh Thread creation.

## Approval provenance and reconnect

Every App Server approval is owned by this tuple:

`(DSH Session id, Codex Thread id, Turn id, Item id, App Server request id, binding epoch)`.

The tuple is captured before asking DSH for approval and validated again after
the user decision but before responding to Codex. Detach, rebind state, binding
replacement, request identity change, or provenance mismatch makes the
approval stale. A stale approval is rejected with `CODEX_STALE_APPROVAL`; it is
never accepted or routed to another Thread. The diagnostic names the original
Thread, Turn, and Item.

DSH may replay the same still-pending approval rpc id after a browser
disconnect. That replay is safe only while the ownership tuple remains valid.

## Platform contract

The bundled launcher supports darwin, linux, and win32 on arm64 and x64 using
the matching `@openai/codex-<platform>-<arch>` package. Commands are spawned
directly with an argument array and never through a shell, so spaces and
Windows backslashes remain literal. CI runs launcher, App Server client, and
status/error tests on macOS, Windows, and Linux.
