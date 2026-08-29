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

## Reasoning summary presentation

Business Turns request App Server reasoning summaries with `summary: auto`.
When Codex supplies a summary, the adapter projects its public summary deltas as
one DSH reasoning block that remains distinct from the final answer. It never
projects encrypted or raw hidden reasoning content.

An App Server reasoning item with no public summary produces no DSH reasoning
block rather than an empty `Think` disclosure. Ephemeral title and compaction
Turns explicitly use `summary: none`; their internal work is not added to the
business conversation and does not incur a presentation-only summary.

## Image projection and failure isolation

Codex `imageView` and `imageGeneration` items are admitted according to their
encoded byte signature, not a local filename extension or unverified data-URI
declaration. PNG, JPEG, GIF, and WebP signatures map to the corresponding DSH
media type. The DSH attachment store remains the authority for full decode,
normalization, size, and pixel-limit validation.

A filename such as `completed-clean.png` may therefore produce an
`image/jpeg` attachment when its bytes are JPEG. Workspace and generated-image
root checks still run before any local file is read; byte detection does not
expand the allowed filesystem boundary.

Image preview admission and storage are projection concerns. Failure of one
image emits one terminal text placeholder and a Host warning containing only a
stable reason code and the owning Thread, Turn, and Item identifiers. Raw
storage errors and absolute paths are not projected or logged. Projection then
continues through later Codex items and the source Turn's terminal status. It
must not throw out of the adapter stream, mark an otherwise successful DSH Turn
as failed, or interrupt the backing Codex Thread.

## DSH image input transport

DSH user image blocks normally contain a content-addressed attachment reference,
not a local path. Before creating or resuming a Codex Thread, the adapter reads
each image through DSH's attachment service, preserves message order, and verifies
the encoded PNG, JPEG, GIF, or WebP signature. Encoded bytes are authoritative
when stored metadata or the display name disagrees.

Verified bytes are materialized outside the Workspace under
`$CODEX_HOME/dsh-input-images` (or the default `~/.codex` equivalent). Files use
their SHA-256 digest plus a signature-derived extension, directories are private,
and writes are atomic without replacing an existing digest. Repeated immutable
attachments reuse the same verified path. The Workspace is not modified.

The resulting path is sent through App Server `turn/start` as native
`localImage` input and attachment metadata. Multiple images retain DSH order and
pure-image messages are valid. Existing trusted path-backed image blocks remain
supported.

Missing/corrupt attachments, unavailable attachment service, invalid bytes,
oversized data, and cancellation fail before a Codex Thread or Turn starts. They
use stable `CODEX_IMAGE_*` codes and never silently degrade an image-bearing user
message to text-only input.

## Turn interruption and process cleanup

Stopping a DSH Codex Turn must stop both model generation and every active App
Server background terminal owned by that Turn. Before sending `turn/interrupt`,
the runtime identifies the Turn's in-progress `commandExecution` item ids and
terminates only matching `thread/backgroundTerminals` process ids. It repeats
discovery after interruption to close races and confirms that no matching
terminal remains.

Background terminals owned by another Turn are not terminated. The plugin must
not use the thread-wide background-terminal cleanup operation for an ordinary
Turn stop.

The Turn is reported as aborted only after targeted cleanup and
`turn/interrupt` succeed. If cleanup cannot be confirmed, the DSH Turn ends with
`CODEX_TURN_INTERRUPT_CLEANUP_FAILED`, tells the user to check for late Workspace
side effects, and logs only the stable code plus Thread and Turn identifiers.

## Command output streaming

App Server shell output belongs to the user-visible Codex response even though the
command is executed inside Codex rather than by the DSH tool dispatcher. Code mode
returns the first yielded bytes in a raw `custom_tool_call_output`, while later PTY
bytes also arrive as native `item/commandExecution/outputDelta` notifications. New
durable plugin-owned Threads opt into raw response items; ephemeral auxiliary Threads
do not. The runtime never forwards a raw item: it correlates only `exec` call/output pairs, parses structured text results, and
projects only a non-empty result containing `session_id`, `wall_time_seconds`, and
`output`. Raw messages, prompts, reasoning, encrypted content, unrelated tools,
malformed results, and completed results without a live `session_id` remain private.

The adapter correlates the sanitized first yield and native command notifications by
`session_id`/`processId`, then emits one ordered DSH text block. Cross-source overlap
is removed by cumulative byte position so a byte reported by both sources appears
once while legitimately repeated native output remains repeated. It must not emit a
DSH `tool-call` chunk, because doing so would ask the DSH Agent to execute the
already-running command a second time.

All deltas for one process share one block and retain App Server order. For native-only
commands, the completed item's `aggregatedOutput` is the authoritative settled value:
a missing suffix is appended without duplicating the streamed prefix, while a
non-prefix final snapshot replaces the block value at close. For a code-mode process,
the aggregate covers only the native PTY side and cannot erase an earlier sanitized
yield. A completed item with no preceding delta still emits its non-empty aggregate.
Empty output emits no block. Late deltas after completion are ignored.

The command output blocks are persisted in the assembled assistant message alongside
Codex commentary and the final answer. This uses DSH's core stream and persistence
vocabulary, survives Session reload, and remains readable if the Session later changes
backend. It does not reintroduce plugin-private Session events, which the current DSH
persistence catalog cannot safely adopt across reloads.

`experimentalRawEvents` is immutable App Server Thread creation state in the pinned
runtime: resume, settings update, and fork cannot enable it for a Thread created by an
older plugin version. Such Sessions continue to receive native command deltas, but
complete first-yield streaming requires a new DSH Session created after this feature
is installed. The plugin must not silently replace or summarize an existing Codex
Thread because that would weaken its model-context continuity.

## Platform contract

The bundled launcher supports darwin, linux, and win32 on arm64 and x64 using
the matching `@openai/codex-<platform>-<arch>` package. Commands are spawned
directly with an argument array and never through a shell, so spaces and
Windows backslashes remain literal. CI runs launcher, App Server client, and
status/error tests on macOS, Windows, and Linux.
