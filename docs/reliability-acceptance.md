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
| R1 Public reasoning summary | Fresh High-effort business Turn whose App Server emits `summaryPartAdded` and `summaryTextDelta`. | Inspect `turn/start`, adapter chunks, persisted DSH blocks, and final answer. | `summary: auto`; one non-empty reasoning block is distinct from one non-duplicated final text block; no raw/encrypted reasoning is projected. | `session-runtime.test.mjs`, `dsh-adapter.test.mjs`; signed-in CDX-TXT-005 regression. | Empty `Think` disclosure caused by disabling App Server summaries. |
| R2 Empty and auxiliary reasoning | One business Turn completes with an empty reasoning item; title and compaction run as auxiliary Turns. | Consume all streams and inspect each `turn/start`. | Empty business item creates no reasoning block; auxiliary Turns use `summary: none`; business history receives no auxiliary reasoning. | `dsh-adapter.test.mjs`, `session-runtime.test.mjs`. | Blank UI controls, hidden-work leakage, and unnecessary auxiliary summary cost. |
| I1 Historical JPEG with `.png` name | Replay the `imageView` shape from DSH Session `session-6f78fa6a-bc1d-4be9-b15b-264d5f743c05`; the source file is named `completed-clean.png` and begins with JPEG/JFIF bytes. | Import the item, then project the following final assistant item and completed Turn. | Attachment media type is `image/jpeg`; image and final text are emitted; DSH finishes with `stop`, not `Declared image type does not match its bytes.` | `dsh-adapter.test.mjs` historical Session regression; manual replay against the retained local Session and source image. | Exact Issue #5 regression and apparent DSH interruption while Codex continues. |
| I2 Declared/extension type differs from bytes | Use file and generated-image inputs whose `.png` name or `data:image/png` declaration contains JPEG bytes. | Import both through the normal attachment boundary. | Both are submitted as `image/jpeg`; generated attachment name uses `.jpg`; DSH admission succeeds. | `dsh-adapter.test.mjs`. | Trusting unverified metadata over encoded content. |
| I3 Supported signatures | Supply PNG, JPEG, GIF, WebP, and invalid signatures. | Detect media type before DSH admission. | Four supported signatures map exactly; invalid bytes return no media type. | `dsh-adapter.test.mjs`. | Partial fix that handles only the reported JPEG case. |
| I4 Image failure isolation | Emit an invalid `imageView` or force DSH attachment storage to reject a valid signature, followed by final assistant text and a completed source Turn. | Consume the adapter stream. | One preview-unavailable block and warning with a stable reason code are emitted; no raw path or storage error leaks; final text remains; DSH finishes with `stop`; attachment storage is not called for unrecognized bytes. | `dsh-adapter.test.mjs`. | One malformed or rejected image aborting the whole DSH Turn. |
| I5 Image path boundary | Place valid or invalid image bytes outside the Workspace and access them directly or through a symlink. | Import through `imageView`. | Import is rejected before byte admission; no external file is published. | `dsh-adapter.test.mjs`. | MIME repair weakening filesystem containment. |
| IN1 DSH attachment input | Use the historical `user/message` shape with one `attachmentId`, no local path, and the IMG-001/002 PNG bytes. | Send through the adapter and inspect `turn/start` plus the native rollout. | Attachment is read once; exact bytes are materialized under the private Codex input root; one ordered `localImage` reaches Codex; the exact visual/OCR answer completes. | `dsh-adapter.test.mjs`, `codex-image-input.test.mjs`; signed-in IMG-001/002 regression. | UI-visible image silently dropped before Codex. |
| IN2 Ordered multi-image input | Use the two distinct IMG-003 DSH attachment refs in first/second order. | Send one Turn and inspect cache paths, `turn/start`, rollout, and answer. | Two distinct images are read and forwarded once in original order; exact answer is `FIRST_17>SECOND_29`. | `dsh-adapter.test.mjs`; signed-in IMG-003 regression. | Missing, duplicate, or reordered images. |
| IN3 Editing source continuity | Use the IMG-008 source attachment and request the established image edit. | Inspect source Turn and editing call/result. | Source appears as one conversation image and the edit produces a distinct valid artifact while preserving required foreground content. | Signed-in IMG-008 regression. | Editing tool runs without its source image. |
| IN4 Input admission and isolation | Exercise pure-image input, repeated bytes, metadata/signature mismatch, unavailable service, missing/corrupt/invalid/oversized data, and cancellation. | Prepare the user input. | Pure image starts; digest path is reused; signature determines extension; invalid/cancelled cases create zero Codex Threads and Turns; Workspace manifest is unchanged. | `codex-image-input.test.mjs`, `dsh-adapter.test.mjs`. | Unsafe cache writes, text-only degradation, orphan Threads, and Workspace mutation. |
| T1 Targeted shell interruption | A Turn owns a yielded `commandExecution` that writes a unique marker after 15 seconds; another background terminal belongs to a different Turn. | Wait for the target process id, stop the Turn, then wait at least 17 seconds. | Target process is terminated through `thread/backgroundTerminals/terminate`; marker stays absent; unrelated terminal remains; Turn is aborted and the Session remains usable. | `session-runtime.test.mjs`, `dsh-adapter.test.mjs`; signed-in App Server delayed-marker regression. | UI-only cancellation that leaves descendants running, and over-broad cleanup that kills unrelated work. |
| T2 Interruption cleanup failure | Make targeted terminal listing or termination fail while stopping a live Turn. | Abort the adapter stream. | The Turn reports `CODEX_TURN_INTERRUPT_CLEANUP_FAILED`, not a successful abort; diagnostic contains stable code and Thread/Turn ids without command output. | `session-runtime.test.mjs`, `dsh-adapter.test.mjs`. | False assurance after an unconfirmed process stop. |
| T3 Long shell output streaming | In a fresh post-upgrade Session, code mode yields `STREAM_FIRST_4102` through a raw call result, the same process later emits native `STREAM_LAST_8604`, and then completes. | Consume adapter chunks while recording source completion; inspect raw filtering, assemble/persist/reload the response, and repeat completion-only, empty, overlapping, malformed, unrelated, private, and late cases. | First marker arrives while active; both markers share one block in order and occur once; legitimate repeated output survives; completion-only output is present; empty/private/unrelated raw data creates no block; final answer and `stop` occur once; no DSH tool call is generated. A pre-upgrade Thread is documented as native-delta-only because App Server cannot retrofit raw events. | `app-server-client.test.mjs`, `session-runtime.test.mjs`, `dsh-adapter.test.mjs`; signed-in CDX-TOOL-009 delayed-marker regression plus Session reload inspection. | Backend streams but DSH hides output until completion, leaks raw context, duplicates or drops output, reruns an already-executed command, silently replaces an old Thread, or loses output after reload. |
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

## Issue #5 regression sequence

1. Retain the original Session export and the original
   `completed-clean.png` source file without rewriting either artifact.
2. Confirm the source file has a `.png` suffix while `file` and its `ff d8 ff`
   prefix identify JPEG bytes.
3. Confirm plugin `0.1.2` derives `image/png` from that suffix and the retained
   DSH Session ends with `Declared image type does not match its bytes.`
4. Replay the same `imageView` path and following terminal assistant item through
   the modified adapter.
5. Confirm DSH receives `image/jpeg`, renders the image and terminal text, and
   finishes normally without changing or replacing the source Codex Thread.
6. Repeat with malformed bytes. Confirm only the preview becomes unavailable;
   the surrounding DSH Turn still completes.
