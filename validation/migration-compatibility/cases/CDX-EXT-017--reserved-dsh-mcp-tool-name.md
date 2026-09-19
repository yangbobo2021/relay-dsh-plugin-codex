# CDX-EXT-017 — Reserved DSH MCP tool name compatibility

## Traceability

- Primary requirement: `CDX-EXT-017`
- Secondary requirements: `CDX-EXT-015`, `CDX-EXT-016`
- Verification levels: `L`, `W`
- Priority: `P0`

## Objective

Prove that a DSH MCP-contributed tool whose original name begins with `mcp__` can
be registered and called through a Codex-backed DSH Session without triggering
Codex's reserved dynamic-tool namespace rejection.

## Preconditions

- Enhanced execution mode is active.
- The sanitized DSH fixture contributes exactly one tool named
  `mcp__scholar-search__batch_get_papers`.
- The fixture returns the deterministic marker `MCP_ALIAS_OK_001` for an empty
  object argument.
- A fresh Codex-backed DSH Session and an independent plain DSH tool control are
  available.

## Method

1. Record the fixture digest and original tool name.
2. Start a fresh Codex-backed Session with the fixture tool.
3. Inspect the native `thread/start` request and require that no registered
   function name begins with `mcp__`.
4. Require one registered alias beginning with `relay_mcp__` and retain the
   alias-to-original mapping.
5. Invoke the alias exactly once with `{}` through both supported dynamic-tool
   request shapes where available.
6. Inspect DSH Session history and require the original
   `mcp__scholar-search__batch_get_papers` name in the request header, exactly one
   dynamic activity using the `relay_mcp__` wire alias, exact `{}` arguments, and
   the exact result marker.
7. Repeat with one ordinary DSH tool, two MCP tools, a readable alias collision,
   a later refreshed tool list, and a second independent Session.
8. Resume or fork the original Session and verify that its current mapping remains
   correct; run the native-mode control and require no DSH dynamic tools.

## Expected results

- Enhanced `thread/start` succeeds; Codex reports no reserved-name error.
- Reserved DSH MCP names receive deterministic, unique, non-`mcp__` aliases.
- The DSH history retains the original tool name while the Codex activity records
  the `relay_mcp__` wire alias; the alias executes the original DSH tool exactly
  once and returns `MCP_ALIAS_OK_001` to the owning Session.
- Ordinary names remain unchanged, mappings do not cross Sessions, and refresh,
  resume, and fork preserve the correct current mapping.
- Native mode remains a no-DSH-tools comparison path.

## Result interpretation

- Pass only when native catalog, alias mapping, DSH request header, dynamic
  activity, exact result, and Session presentation agree.
- Fail when App Server rejects registration, a reserved name is sent, the alias is
  not callable, the original name is not executed, results are lost, or mappings
  cross a Session boundary.
- Blocked only when the fixture or real App Server cannot start independently of
  the alias implementation.

## Review focus

- Do not treat a successful `thread/start` as sufficient; require one real alias
  call and an independent original-name execution record.
- Do not accept filtering the MCP tool as a pass because the DSH capability must
  remain available.
