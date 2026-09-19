import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_RESERVED_DYNAMIC_TOOL_PREFIX,
  codexDshToolBindings,
  codexDshToolSurface,
} from "../codex-tools.js";

test("reserved DSH MCP names receive stable non-reserved aliases", () => {
  const tools = [
    { name: "read", description: "read", parameters: {} },
    { name: "mcp__scholar-search__batch_get_papers", description: "papers", parameters: {} },
  ];
  const first = codexDshToolSurface(tools);
  const second = codexDshToolSurface(tools);
  const registered = first.dynamicTools.find(tool => tool.name === "dsh").tools.map(tool => tool.name);

  assert.equal(CODEX_RESERVED_DYNAMIC_TOOL_PREFIX, "mcp__");
  assert.deepEqual(registered, ["read", "relay_mcp__scholar-search__batch_get_papers"]);
  assert.deepEqual(registered, second.dynamicTools.find(tool => tool.name === "dsh").tools.map(tool => tool.name));
  assert.equal(first.aliasToOriginal.get("read"), "read");
  assert.equal(first.aliasToOriginal.get(registered[1]), "mcp__scholar-search__batch_get_papers");
  assert.equal(registered.some(name => name.startsWith("mcp__")), false);
});

test("reserved DSH MCP aliases remain unique when an ordinary tool occupies the base alias", () => {
  const tools = [
    { name: "relay_mcp__scholar-search__batch_get_papers", description: "ordinary", parameters: {} },
    { name: "mcp__scholar-search__batch_get_papers", description: "MCP", parameters: {} },
  ];
  const first = codexDshToolBindings(tools);
  const second = codexDshToolBindings(tools);
  const alias = first.originalToAlias.get("mcp__scholar-search__batch_get_papers");

  assert.equal(first.originalToAlias.get("relay_mcp__scholar-search__batch_get_papers"), "relay_mcp__scholar-search__batch_get_papers");
  assert.notEqual(alias, "relay_mcp__scholar-search__batch_get_papers");
  assert.equal(alias, second.originalToAlias.get("mcp__scholar-search__batch_get_papers"));
  assert.equal(first.aliasToOriginal.get(alias), "mcp__scholar-search__batch_get_papers");
  assert.equal(new Set(first.aliasToOriginal.keys()).size, 2);
});
