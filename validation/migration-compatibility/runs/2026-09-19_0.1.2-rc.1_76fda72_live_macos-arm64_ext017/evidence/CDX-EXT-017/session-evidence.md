# CDX-EXT-017 Session Evidence

## Identity

- DSH Session: `session-20b2156c-4cc3-40ea-b0d1-ab70bd544981`
- Codex Thread: `01a0b993-14f7-70e2-bc5b-6c296f2f568d`
- Codex Turn: `01a0b993-16fb-7c30-8aa9-4e3356b61375`
- Original DSH name: `mcp__scholar-search__batch_get_papers`
- Codex wire alias: `relay_mcp__scholar-search__batch_get_papers`
- Arguments: `{}`
- Result: `MCP_ALIAS_OK_001`
- Dynamic activity count: `1`

## DSH request header

The persisted `request/header` tool catalog retained the original DSH identity:

```json
{
  "name": "mcp__scholar-search__batch_get_papers",
  "description": "Return the deterministic reserved-name compatibility marker.",
  "parameters": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

## Completed dynamic activity

The persisted completed activity proved the Codex-safe alias, exact input, and
exact result:

```json
{
  "type": "dynamicToolCall",
  "status": "completed",
  "title": "dsh / relay_mcp__scholar-search__batch_get_papers",
  "summary": "{}",
  "input": "{}",
  "output": "MCP_ALIAS_OK_001"
}
```

The corresponding `tool/result` had `isError: false`. The owning Session then
rendered the exact final answer `MCP_ALIAS_OK_001`; see
`08-reserved-mcp-alias.png`.

## Independent fixture preflight

Direct stdio JSON-RPC preflight returned:

```text
tools/list -> batch_get_papers
tools/call({}) -> MCP_ALIAS_OK_001
```

This separates fixture availability from the Codex alias mapping under test.
