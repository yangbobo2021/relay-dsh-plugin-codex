import { createInterface } from "node:readline";

const tool = {
  name: "batch_get_papers",
  description: "Return the deterministic reserved-name compatibility marker.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "relay-reserved-name-fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [tool] } });
    return;
  }
  if (message.method === "tools/call") {
    const valid = message.params?.name === "batch_get_papers"
      && JSON.stringify(message.params?.arguments ?? {}) === "{}";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: valid
        ? { content: [{ type: "text", text: "MCP_ALIAS_OK_001" }] }
        : { isError: true, content: [{ type: "text", text: "MCP_ALIAS_INVALID_INPUT" }] },
    });
    return;
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
  }
});
