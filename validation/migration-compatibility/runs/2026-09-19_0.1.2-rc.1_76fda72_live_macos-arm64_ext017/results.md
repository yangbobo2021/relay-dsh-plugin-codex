# Codex Run Results

| Requirement | Case | Result | Evidence | Notes |
| --- | --- | --- | --- | --- |
| CDX-EXT-017 | Reserved DSH MCP tool name compatibility | pass | `evidence/CDX-EXT-017/session-evidence.md`, `08-reserved-mcp-alias.png` | Real DSH MCP tool called once through `relay_mcp__scholar-search__batch_get_papers`; original name retained in DSH request header; exact `{}` input and `MCP_ALIAS_OK_001` output |
| Delivery regression | Packed candidate and cold restart | pass | `result.json`, `01-baseline.png` | Isolated installed tarball and client digest matched; previous history rendered after restart |
| Delivery regression | Tool presentation and persistence | pass | `02-live.png` through `06-mobile-390.png` | Real edit, image view, exit 7, keyboard disclosure, reload, and 390 x 844 viewport passed |
| Delivery regression | Stop and recovery | pass | `07-cancelled.png`, `result.json` | UI stop settled the command, retained `CANCEL_PARTIAL_OK`, and loaded after cold restart |

## Summary

- Passed: 9 scripted assertions groups
- Failed: 0
- Blocked: 0
- MCP attempts: 1
- MCP dynamic activity count: 1

The reserved-name error did not occur. The fixture tool was available to the
model, executed exactly once, and returned its deterministic marker to the same
DSH Session.
