import { createInterface } from 'node:readline';

// Deliberately tiny real stdio MCP peer: the tests exercise launch and invocation boundaries.
const lines = createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
lines.on('line', async (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    if (process.env.TEST_MCP_DELAY) await new Promise((resolve) => setTimeout(resolve, Number(process.env.TEST_MCP_DELAY)));
    send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'managed-test-server', version: '1.0' } });
  } else if (request.method === 'tools/list') {
    send(request.id, { tools: [{ name: 'echo', description: 'Echo the configured marker.', inputSchema: { type: 'object', properties: {} } }] });
  } else if (request.method === 'tools/call') {
    send(request.id, { content: [{ type: 'text', text: process.env.MANAGED_MARKER || 'original' }] });
  } else if (request.method === 'ping') send(request.id, {});
});
