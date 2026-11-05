import { nodeKey, type InferenceNode } from '../api/nodes';
import type { NodeAgentReport } from '../api/nodeAgent';
import type { Recipe } from './recipes';

/**
 * The declared boxes, collapsed from the recipes that mention them and probed once each.
 *
 * Two recipes naming the same peer are one node with two reasons to exist, so entries merge on
 * `host:port` and keep both recipe names. Probing is one connection attempt per node, run in
 * parallel: an unreachable peer costs its timeout, and doing them in sequence would make a roster
 * of four down boxes take four timeouts to render.
 *
 * Capacity is layered on top of that, from whatever can actually measure it. The local box is
 * read from its own driver. A remote box is read from a paired node agent (ADR 0001 stage 5),
 * which reports per accelerator and is matched to the roster **by host**: an agent listens on its
 * own port while `--rpc` listens on another, and memory is a property of the machine rather than
 * of either port. A box with no agent keeps `null`, which the UI shows as unknown.
 *
 * Nothing here starts anything. `recipes.ensurePeers` does that before a turn that needs a peer,
 * which is a decision about dispatch; this is a status list.
 */
export interface NodeDeps {
  recipes(): Recipe[];
  probe(host: string, port: number): Promise<boolean>;
  now?(): number;
  /**
   * Accelerator memory on *this* machine, from the driver. Omitted in tests and anywhere the
   * reading is unavailable; a missing reading is reported as unknown, never as zero.
   */
  localMemory?(): Promise<{ free: number | null; total: number | null }>;
  /** What to call this machine in the roster. */
  localName?(): string;
  /** Boxes a node agent has been paired with, keyed `host:port` on the agent's own port. */
  paired?(): Array<{ key: string; name: string; endpoint: string }>;
  /** Asks one paired box for its report. Rejecting is an answer: the box is there but not talking. */
  report?(key: string): Promise<NodeAgentReport>;
}

const blank = (node: Omit<InferenceNode, 'capacityFrom' | 'paired' | 'checkpoints' | 'agentError'>): InferenceNode => ({
  ...node,
  capacityFrom: null,
  paired: false,
  checkpoints: [],
  agentError: null,
});

const hostOf = (key: string): string => key.slice(0, key.lastIndexOf(':'));

export async function listNodes(deps: NodeDeps): Promise<InferenceNode[]> {
  const now = deps.now ?? Date.now;
  const merged = new Map<string, InferenceNode>();

  for (const recipe of deps.recipes()) {
    for (const peer of recipe.peers) {
      const key = nodeKey(peer.host, peer.port);
      const existing = merged.get(key);
      if (existing) {
        if (!existing.recipes.includes(recipe.name)) existing.recipes.push(recipe.name);
        for (const model of recipe.models) if (!existing.models.includes(model)) existing.models.push(model);
        // Any recipe that knows how to start it makes the node startable.
        existing.startable = existing.startable || peer.start !== null;
        continue;
      }
      merged.set(key, blank({
        key,
        name: peer.name,
        host: peer.host,
        port: peer.port,
        reachable: false,
        probedAt: null,
        startable: peer.start !== null,
        recipes: [recipe.name],
        models: [...recipe.models],
        local: false,
        memoryFree: null,
        memoryTotal: null,
      }));
    }
  }

  // Paired agents come next, so a box someone deliberately paired is in the roster even when no
  // recipe mentions it. One that shares a host with a declared peer does not get its own row:
  // it is the same machine, and its report enriches the row that carries the RPC address.
  const paired = deps.paired?.() ?? [];
  const hostsFromRecipes = new Set([...merged.values()].map((node) => node.host));
  for (const box of paired) {
    const host = hostOf(box.key);
    if (hostsFromRecipes.has(host)) continue;
    if (merged.has(box.key)) continue;
    const port = Number(box.key.slice(box.key.lastIndexOf(':') + 1));
    merged.set(box.key, blank({
      key: box.key,
      name: box.name,
      host,
      port,
      reachable: false,
      probedAt: null,
      startable: false,
      recipes: [],
      models: [],
      local: false,
      memoryFree: null,
      memoryTotal: null,
    }));
  }

  const nodes = [...merged.values()];

  // This machine is always in the roster, with no recipe needed: a workload that runs here and
  // nowhere else is still a distribution choice, and it is the only box whose capacity can be
  // read without asking anything.
  const reading = deps.localMemory ? await deps.localMemory().catch(() => ({ free: null, total: null })) : null;
  const local = blank({
    key: 'local',
    name: deps.localName?.() ?? 'this machine',
    host: '127.0.0.1',
    port: 0,
    reachable: true,
    probedAt: now(),
    startable: false,
    recipes: [],
    models: [],
    local: true,
    memoryFree: reading?.free ?? null,
    memoryTotal: reading?.total ?? null,
  });
  if (local.memoryTotal !== null || local.memoryFree !== null) local.capacityFrom = 'driver';
  nodes.unshift(local);

  const byHost = new Map<string, InferenceNode[]>();
  for (const node of nodes) {
    if (node.local) continue;
    const list = byHost.get(node.host) ?? [];
    list.push(node);
    byHost.set(node.host, list);
  }

  await Promise.all([
    ...nodes.filter((node) => !node.local).map(async (node) => {
      // A probe that throws is a node that is not answering, which is the same answer.
      node.reachable = await deps.probe(node.host, node.port).catch(() => false);
      node.probedAt = now();
    }),
    ...(deps.report
      ? paired.map(async (box) => {
          const host = hostOf(box.key);
          const rows = byHost.get(host) ?? [];
          for (const row of rows) row.paired = true;
          try {
            const report = await deps.report!(box.key);
            for (const row of rows) {
              row.memoryFree = report.memoryFree;
              row.memoryTotal = report.memoryTotal;
              row.capacityFrom = report.memoryTotal === null && report.memoryFree === null ? null : 'agent';
              row.checkpoints = report.checkpoints;
              row.agentError = null;
              // The agent's own name for the machine beats a recipe's label for it, since it is
              // the machine talking about itself.
              if (report.name) row.name = report.name;
            }
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            for (const row of rows) row.agentError = message.replace(/\s+/g, ' ').trim().slice(0, 300);
          }
        })
      : []),
  ]);

  // This machine first, then reachable boxes, then by name: a roster reads as "what can I use
  // right now", and the box you are sitting at is never the uncertain one.
  return nodes.sort((left, right) => {
    if (left.local !== right.local) return left.local ? -1 : 1;
    if (left.reachable !== right.reachable) return left.reachable ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}
