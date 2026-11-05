/** Catalog-only MCP boundary: real SDK client/protocol, production definitions, no child or tool calls. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ALL_TOOLS } from '../../mcp/tools/index';

// Preserve the production environment calculation; only the transport is replaced.
export { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

export class StdioClientTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private readonly client: InMemoryTransport;
  private readonly peer: InMemoryTransport;
  private readonly server: Server;
  private readonly record: { opened: boolean; closed: boolean; methods: string[]; tools: unknown[] };
  private started = false;
  private closed = false;

  constructor(parameters: { command: string; args?: string[]; env?: Record<string, string> }) {
    const state = (globalThis as any).__hagProductionSmoke;
    assert.equal(state.fullCatalogMode, true);
    assert.equal(parameters.command, process.execPath);
    assert.deepEqual(parameters.args, [join(state.output, 'dist-electron/mcp/server.js')]);
    assert.equal(parameters.env?.ANTIMATTER_WORKSPACE, join(state.output, 'workspace'));
    assert.equal(parameters.env?.CODING_WORKSPACE_PATH, join(state.output, 'workspace'));
    assert.equal(ALL_TOOLS.length, 21, 'pinned bundled catalog changed');
    [this.client, this.peer] = InMemoryTransport.createLinkedPair();
    this.record = { opened: false, closed: false, methods: [], tools: [] };
    state.mcpTransports.push(this.record);
    this.server = new Server({ name: 'antimatter-tools', version: '1.0.0' }, { capabilities: { tools: {} } });
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Same definition projection as mcp/server.ts; no ToolDef.run is exposed here.
      const tools = ALL_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      this.record.tools = structuredClone(tools);
      return { tools };
    });
  }

  async start(): Promise<void> {
    assert.equal(this.started, false, 'MCP transport started twice');
    assert.equal(this.closed, false);
    this.started = true;
    this.client.onmessage = (message, extra) => this.onmessage?.(message, extra);
    this.client.onerror = error => this.onerror?.(error);
    this.client.onclose = () => {
      this.closed = true;
      this.record.closed = true;
      this.onclose?.();
    };
    await this.server.connect(this.peer);
    await this.client.start();
    this.record.opened = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if ('method' in message) {
      this.record.methods.push(message.method);
      assert.ok(['initialize', 'notifications/initialized', 'tools/list', 'ping'].includes(message.method),
        `Catalog smoke forbids MCP method ${message.method}`);
    }
    assert.equal(this.closed, false);
    await this.client.send(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.record.closed = true;
    await this.client.close();
  }

  get stderr(): null { return null; }
  get pid(): null { return null; }
}
