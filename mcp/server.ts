/**
 * Antimatter's own MCP server.
 *
 * Speaks MCP over stdio and is spawned by the app (see src/main/mcpStore.ts). It uses the
 * low-level Server API with hand-written JSON Schema rather than the zod-based helper, so the
 * tool definitions the model sees are exactly what is written in mcp/tools/*.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ALL_TOOLS, toolsByName } from './tools/index';
import { activeWriteCount } from './tools/files';
import { workspaceRoot } from './workspace';

const server = new Server({ name: 'antimatter-tools', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const tool = toolsByName.get(request.params.name);
  if (!tool) {
    return { content: [{ type: 'text', text: `No tool named ${request.params.name}.` }], isError: true };
  }

  try {
    // The workspace is read per call, so picking a new directory takes effect without a restart
    // for everything except the environment the process was spawned with.
    const text = await tool.run((request.params.arguments ?? {}) as Record<string, any>, {
      workspace: workspaceRoot(),
      signal: extra.signal,
    });
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
  }
});

/**
 * A dev reload kills this server's whole process group while the agent is mid-edit: the tool
 * write lands just as the app restarts over it, and Node's default SIGTERM would drop the reply
 * before the main process read it — the file is written, the model is told it failed, and the
 * next attempt races the same restart. When a write is still in flight, hold the exit until it
 * has answered (bounded, in case a write genuinely never finishes) so the result is delivered
 * and the edit is never reported as a failure it was not.
 */
const HOLD_EXIT_MS = 4_000;
const DEFER_POLL_MS = 25;
let exiting = false;

function requestExit(signal: NodeJS.Signals): void {
  if (exiting) return;
  const defer = (waited: number): void => {
    if (activeWriteCount() > 0 && waited < HOLD_EXIT_MS) {
      setTimeout(defer, DEFER_POLL_MS, waited + DEFER_POLL_MS);
      return;
    }
    exiting = true;
    process.exit(0);
  };
  defer(0);
}

process.on('SIGTERM', requestExit);
process.on('SIGINT', requestExit);

async function main() {
  await server.connect(new StdioServerTransport());
  // stdout belongs to the protocol; anything we want to say goes to stderr.
  process.stderr.write(`antimatter-tools ready: ${ALL_TOOLS.length} tools, workspace ${workspaceRoot()}\n`);
}

main().catch((error) => {
  process.stderr.write(`antimatter-tools failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});
