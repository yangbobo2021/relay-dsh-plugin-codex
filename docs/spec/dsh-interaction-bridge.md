# DSH Interaction Bridge Specification

## Scope

Codex App Server can pause a Turn to request approval for a command, file
change, or permission profile, or to ask the user a structured question. The
plugin routes those requests through the owning DSH Session so DSH remains the
authority for human interaction and conversation continuity.

## Composition contract

`approval` and `userQuestions` are required Host injections. They are provided
by sibling plugins in the official DSH composition, so listing them in the Host
plugin's exported `inject` array binds them into the Codex consumer fiber and
makes activation wait for both services.

The bridge must not read either service as an undeclared context property. It
must not make either dependency optional, and it must not bypass DSH approval or
question handling when a service is missing, cancelled, or fails. Failure is
closed: no App Server request is accepted and no protected operation executes.

## Request ownership

Every modern request carries a Codex `threadId`; legacy command and patch
requests carry the same identity as `conversationId`. The adapter normalizes
both forms and must resolve that id to one live DSH Session and Agent before
invoking a DSH interaction service. Modern `itemId` and legacy `callId` are
normalized into the same ownership slot.
Approval ownership includes the DSH Session, Codex Thread, Turn, Item, App
Server request id, and binding epoch. Unknown, stale, re-bound, or unowned
requests are rejected without asking the user or executing the operation.

## Approval mapping

For command, file-change, and permission approval requests:

| DSH outcome | App Server response |
| --- | --- |
| `allowed-once` | `accept` for the current request |
| `rejected` | `decline` |
| `cancelled` | `decline` |
| `unavailable` | `decline` |

The requested command or App Server reason is shown through DSH's approval
service. The protected operation must not begin before `allowed-once` returns.
Thrown service errors reject the pending App Server request and never become an
implicit allow.

## Question mapping

For `item/tool/requestUserInput`, the bridge maps at most three Codex questions
to DSH questions, waits for `userQuestions.ask()`, and maps selected and custom
answers back to App Server. Cancellation or provider failure rejects the
pending request. Unsupported interaction methods are rejected.

## Verification contract

1. A unit contract test fails when either required Host injection is absent.
2. A Cordis composition test mounts interaction services as sibling providers,
   mounts the Codex consumer with its exported `inject`, and completes one
   approval plus one question request.
3. Handler and runtime tests cover allow, deny, permission, answer, stale
   ownership, unknown Session, and unsupported request mappings.
4. An official DSH Web acceptance test uses two independent Codex Sessions.
   Both request the same class of outside-Workspace write. Before either answer,
   both target files are absent and the sentinel is unchanged. One-time allow
   creates only the allow target with exact bytes. Reject leaves the deny target
   absent. Both Sessions finish normally and remain usable.
5. The historical pre-fix plugin commit must reproduce the missing approval UI
   and automatic fail-closed response for the same request shape.
