'use strict';

const PROTOCOL_VERSION = '2024-11-05';

const asContent = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];

// JSON-RPC over one connection. `host` supplies { version, tools, context,
// onInitialized }; a tool is { name, description, inputSchema, run(context, args) }.
function handleMcpMessage(host, conn, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  const { id, method, params } = msg;
  if (method === undefined) return; // response to something we never sent
  const reply = (result) => { if (id !== undefined) conn.send({ jsonrpc: '2.0', id, result }); };

  switch (method) {
    case 'initialize':
      reply({
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true }, logging: {} },
        serverInfo: { name: 'claude-ide-bridge-obsidian', version: host.version },
      });
      return;
    case 'notifications/initialized':
      host.onInitialized();
      return;
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: host.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    case 'tools/call': {
      const name = params && params.name;
      const tool = host.tools.find((t) => t.name === name);
      Promise.resolve()
        .then(() => {
          if (!tool) throw new Error(`Unknown tool: ${name}`);
          return tool.run(host.context, (params && params.arguments) || {});
        })
        .then((value) => reply({ content: asContent(value) }))
        .catch((e) => reply({ content: asContent(String((e && e.message) || e)), isError: true }));
      return;
    }
    case 'prompts/list':
      reply({ prompts: [] });
      return;
    case 'resources/list':
      reply({ resources: [] });
      return;
    default:
      if (method.startsWith('notifications/')) return;
      if (id !== undefined) conn.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

module.exports = { handleMcpMessage };
