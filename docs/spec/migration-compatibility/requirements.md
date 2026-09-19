# Codex Atomic Requirements

This is the Codex-only capability catalog. Each row must be implemented as one or
more independent cases under `validation/migration-compatibility/cases/`.

`State` describes specification readiness, not current product support.

## Conversation and presentation

| ID | Priority | Atomic capability | Minimum observable | State |
| --- | --- | --- | --- | --- |
| CDX-TXT-001 | P0 | Plain text turn | One non-duplicated terminal answer | verified |
| CDX-TXT-002 | P0 | Chinese and Unicode | Exact marker survives round trip | verified |
| CDX-TXT-003 | P0 | Markdown and code blocks | Structure and whitespace remain readable | verified |
| CDX-TXT-004 | P0 | Incremental streaming | Output appears before turn completion | verified |
| CDX-TXT-005 | P1 | Reasoning presentation | Reasoning and final answer are distinct and non-duplicated | failed |
| CDX-TXT-006 | P0 | Multi-turn context | Second turn recalls a random first-turn marker | verified |
| CDX-TXT-007 | P0 | Stop generation | Turn stops and emits no requested terminal marker | verified |
| CDX-TXT-008 | P0 | Model selection | App Server uses the model selected in DSH | verified |
| CDX-TXT-009 | P0 | Reasoning effort | App Server receives the selected effort | verified |
| CDX-TXT-010 | P1 | Auxiliary title isolation | Title generation does not enter the business Thread | verified |

## Multimodal input and artifacts

| ID | Priority | Atomic capability | Minimum observable | State |
| --- | --- | --- | --- | --- |
| CDX-IMG-001 | P0 | Single-image understanding | Correct fixed visual marker | failed |
| CDX-IMG-002 | P0 | Image OCR | Correct fixed text marker | failed |
| CDX-IMG-003 | P1 | Ordered multi-image input | Images remain distinguishable and ordered | failed |
| CDX-IMG-004 | P0 | Invalid image rejection | Failure occurs before a model turn starts | verified |
| CDX-IMG-005 | P0 | Image generation | A new valid image artifact is produced | verified |
| CDX-IMG-006 | P0 | Generated-image rendering | Standard DSH image block is visible | verified |
| CDX-IMG-007 | P0 | Generated-image persistence | Image remains visible after reload | verified |
| CDX-IMG-008 | P1 | Image editing | A deterministic property of the source image changes | failed |
| CDX-FILE-001 | P1 | Text or source attachment | Requested marker is read correctly | failed |
| CDX-FILE-002 | P1 | Document or table attachment | Supported content is read or rejection is explicit | verified |

## Built-in Codex tools

| ID | Priority | Atomic capability | Minimum observable | State |
| --- | --- | --- | --- | --- |
| CDX-TOOL-001 | P0 | Workspace cwd | Tool cwd equals the selected DSH Workspace | verified |
| CDX-TOOL-002 | P0 | List, glob, and search | Unique fixture file and marker are found | verified |
| CDX-TOOL-003 | P0 | File read | Exact fixture content is returned | verified |
| CDX-TOOL-004 | P0 | File create | Expected bytes are written inside Workspace | verified |
| CDX-TOOL-005 | P0 | Targeted edit or patch | Only intended lines change | verified |
| CDX-TOOL-006 | P0 | Multi-file edit | All intended files change with no unrelated diff | verified |
| CDX-TOOL-007 | P0 | Shell success | stdout and zero exit are presented | verified |
| CDX-TOOL-008 | P0 | Shell failure | stderr and non-zero exit are presented | verified |
| CDX-TOOL-009 | P1 | Long-running shell streaming | Intermediate output is visible | failed |
| CDX-TOOL-010 | P0 | Shell interruption | Process stops and creates no late marker | failed |
| CDX-TOOL-011 | P0 | Test execution | Fixture test result is correctly interpreted | verified |
| CDX-TOOL-012 | P0 | Git inspection | Status and diff are read without mutation | verified |
| CDX-TOOL-013 | P1 | Web access | Fixed source is read or policy denial is explicit | verified |
| CDX-TOOL-014 | P0 | User question | Turn pauses and receives the selected answer | verified |
| CDX-TOOL-015 | P0 | Tool approval | Allow executes and deny prevents execution | failed |
| CDX-TOOL-016 | P1 | Subagent dispatch | Child result returns to the owning turn | failed |

## User extensions

| ID | Priority | Atomic capability | Minimum observable | State |
| --- | --- | --- | --- | --- |
| CDX-EXT-001 | P0 | Global Skill discovery | Test Skill is listed or invoked | verified |
| CDX-EXT-002 | P0 | Project Skill discovery | Skill is available only in the fixture project | verified |
| CDX-EXT-003 | P0 | Manual Skill invocation | Skill produces its unique marker | verified |
| CDX-EXT-004 | P1 | Automatic Skill invocation | Matching prompt loads the Skill | verified |
| CDX-EXT-005 | P0 | Skill resource and script | Bundled reference and script are usable | verified |
| CDX-EXT-006 | P0 | Global STDIO MCP | Test server starts and handles a call | verified |
| CDX-EXT-007 | P0 | Project MCP | Server is scoped to the trusted fixture project | verified |
| CDX-EXT-008 | P1 | HTTP MCP | Test server connects and handles a call | verified |
| CDX-EXT-009 | P1 | MCP text, JSON, and image results | Each result type reaches Codex intact | failed |
| CDX-EXT-010 | P1 | MCP failure and timeout | Failure is explicit and the turn remains usable | verified |
| CDX-EXT-011 | P0 | Installed Codex plugin discovery | Installed fixture plugin is present | verified |
| CDX-EXT-012 | P0 | Plugin Skill | Namespaced fixture Skill runs | verified |
| CDX-EXT-013 | P0 | Plugin MCP tool | Bundled fixture MCP tool runs | verified |
| CDX-EXT-014 | P1 | Plugin Hook | Fixture hook observes or blocks its target event | failed |
| CDX-EXT-015 | P1 | DSH-contributed tool | Advertised tool executes through the Codex `dsh` namespace | verified |
| CDX-EXT-016 | P1 | Dynamic DSH tool refresh | A later turn sees the updated tool set | failed |
| CDX-EXT-017 | P0 | Reserved DSH MCP tool name compatibility | An `mcp__`-prefixed DSH tool is aliased for Codex and executes through the original DSH name | ready |

## Configuration and instructions

| ID | Priority | Atomic capability | Minimum observable | State |
| --- | --- | --- | --- | --- |
| CDX-CFG-001 | P0 | User `config.toml` | A non-UI setting has observable effect | verified |
| CDX-CFG-002 | P0 | Project `.codex/config.toml` | Setting applies only in the fixture project | verified |
| CDX-CFG-003 | P0 | Config precedence | Project and user conflict resolves as specified | verified |
| CDX-CFG-004 | P0 | Project trust boundary | Untrusted project layer is skipped | verified |
| CDX-CFG-005 | P0 | DSH-owned setting collision | Model, effort, sandbox, and approval precedence is documented and observed | verified |
| CDX-CFG-006 | P1 | Config environment references | Fixture environment value reaches its consumer | verified |
| CDX-INS-001 | P0 | Global `AGENTS.md` | Global unique instruction marker is followed | verified |
| CDX-INS-002 | P0 | Project `AGENTS.md` | Project marker is followed only in that project | verified |
| CDX-INS-003 | P0 | Nested `AGENTS.md` | Nested rule applies in its directory | verified |
| CDX-INS-004 | P0 | `AGENTS.override.md` | Override wins at the same scope | verified |

## Permissions, environment, and continuity

| ID | Priority | Atomic capability | Minimum observable | State |
| --- | --- | --- | --- | --- |
| CDX-PERM-001 | P0 | Workspace read and write | Effective DSH/Codex policy is enforced | verified |
| CDX-PERM-002 | P0 | Outside-Workspace access | Access is denied or explicitly approved | verified |
| CDX-PERM-003 | P0 | Read-only mode | No fixture mutation occurs | verified |
| CDX-PERM-004 | P1 | Network policy | Effective policy is enforced | verified |
| CDX-ENV-001 | P0 | PATH and executable discovery | Fixture executable can be found | verified |
| CDX-ENV-002 | P0 | Non-ASCII or spaced cwd | Tools operate in the exact path | verified |
| CDX-ENV-003 | P0 | Secret redaction | Fixture secret is absent from transcript and logs | failed |
| CDX-SES-001 | P0 | New Thread binding | Exactly one Thread is bound | verified |
| CDX-SES-002 | P0 | Browser reload continuation | Same Thread continues | verified |
| CDX-SES-003 | P0 | Host restart continuation | Same Thread continues | verified |
| CDX-SES-004 | P0 | Workspace Thread discovery | Existing eligible Threads are listed correctly | failed |
| CDX-SES-005 | P0 | Thread import and history | Imported presentation matches source order | verified |
| CDX-SES-006 | P0 | Imported Thread continuation | New turn enters the original Thread | verified |
| CDX-SES-007 | P1 | Long-context continuation | Marker survives the supported compaction path | verified |
