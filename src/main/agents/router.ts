import type { StreamingProvider } from '../toolLoop';
import * as registry from './registry';
import type { AgentDefinition } from './types';

/**
 * The router: deciding which agent a piece of work belongs to, for the Agents panel's route
 * button. Whoever pressed it wants an agent, so there is always one.
 *
 * The main model does the deciding, because the question is about meaning — "regenerate the
 * title art" belongs to an asset agent and "why is this test flaky" does not, and no keyword
 * table gets that right for long. But routing must never be the thing that fails: if the model
 * is unreachable, slow, or answers with prose instead of JSON, we score the catalogue by hand
 * and carry on. A mediocre choice is recoverable; a dispatch that never happens is not.
 *
 * A chat turn is not routed. The conversation's own model hands work to agents itself, with
 * start_agent (see delegation.ts), and keeps the conversation while they work.
 */

export interface Routed {
  agentId: string;
  agentName: string;
  title: string;
  /** Why this agent, in one line. Shown in the task list so a wrong route is obvious. */
  why: string;
  /** True when the fallback scorer decided rather than the model. */
  guessed: boolean;
}

export interface RouteDeps {
  provider: StreamingProvider;
  providerId: string;
  model: string;
}

/**
 * The roster as a model reads it: short enough to send on every request, specific enough to
 * choose between near neighbours.
 *
 * Each agent's tools and round budget ride along with its description, because they are facts a
 * choice has to respect. "Implement a GIMP clone and run it" once went to the Shell runner, whose
 * description says "builds" and whose three tools cannot write a file.
 */
export function catalogue(agents: AgentDefinition[]): string {
  return agents
    .map((agent) => {
      const tags = agent.tags.length ? ` [${agent.tags.join(', ')}]` : '';
      const tools = agent.tools.length ? agent.tools.join(', ') : 'every tool';
      // Unattended, "ask" is as read-only as "read": nobody is there to approve a change.
      const readOnly = agent.access === 'full' ? '' : '; read-only';
      return `- ${agent.id}: ${agent.description}${tags} (tools: ${tools}; ${agent.maxRounds} rounds${readOnly})`;
    })
    .join('\n');
}

const INSTRUCTIONS = `You route work to specialised agents. Reply with JSON only, no prose:
{"agent": "<id from the list>", "title": "<six words or fewer>", "why": "<one short sentence>"}
Choose the single best fit. If nothing fits well, choose the closest and say so in "why".`;

/** Words worth matching on, minus the ones every request contains. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'is', 'it', 'this', 'that',
  'with', 'my', 'me', 'please', 'can', 'you', 'i', 'we', 'should', 'need', 'want', 'some',
]);

/**
 * Overlap between the request and each agent's own words. Crude on purpose: it exists to be
 * better than "always the first agent", not to be clever.
 */
function score(text: string, agent: AgentDefinition): number {
  const words = new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word))
  );
  if (!words.size) return 0;

  const haystack = `${agent.name} ${agent.description} ${agent.tags.join(' ')}`.toLowerCase();
  let hits = 0;
  for (const word of words) if (haystack.includes(word)) hits += 1;
  // Tags are deliberate labels, so a tag match is worth more than a word buried in prose.
  const tagHits = agent.tags.filter((tag) => words.has(tag.toLowerCase())).length;
  return hits + tagHits * 2;
}

export function guess(text: string): Routed | null {
  const agents = registry.list();
  if (!agents.length) return null;

  const ranked = agents
    .map((agent) => ({ agent, points: score(text, agent) }))
    .sort((a, b) => b.points - a.points);
  const best = ranked[0];

  return {
    agentId: best.agent.id,
    agentName: best.agent.name,
    title: title(text),
    why: best.points > 0 ? `closest match on wording` : `no clear match; picked ${best.agent.name}`,
    guessed: true,
  };
}

/** A task needs a label before it has a result. The first clause of the request is usually it. */
function title(text: string): string {
  const first = text.trim().split(/[.\n!?]/)[0]?.trim() ?? '';
  const short = first.length > 58 ? `${first.slice(0, 55).trimEnd()}…` : first;
  return short || 'Untitled task';
}

interface Answer {
  agent?: unknown;
  title?: unknown;
  why?: unknown;
}

/** Pulls the object out of a reply that may be fenced, prefixed, or trailed with commentary. */
function parse(reply: string): Answer | null {
  const start = reply.indexOf('{');
  if (start < 0) return null;
  const end = reply.lastIndexOf('}');
  // The whole object, or — when the model stopped one brace short — everything after the opening.
  const candidates = [end > start ? reply.slice(start, end + 1) : null, `${reply.slice(start).trimEnd()}}`];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value as Answer;
    } catch {
      // Try the next reading.
    }
  }
  return null;
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export async function route(text: string, deps: RouteDeps, signal?: AbortSignal): Promise<Routed | null> {
  const agents = registry.list();
  if (!agents.length) return null;
  if (agents.length === 1) {
    const only = agents[0];
    return { agentId: only.id, agentName: only.name, title: title(text), why: `${only.name} is the only agent installed`, guessed: false };
  }

  let reply = '';
  try {
    const result = await deps.provider.stream(
      {
        messages: [
          { id: 'route-system', role: 'system', content: `${INSTRUCTIONS}\n\nAgents:\n${catalogue(agents)}` },
          { id: 'route-user', role: 'user', content: text },
        ],
        model: deps.model,
        providerId: deps.providerId,
        requestId: 'route',
        // A routing decision is a few tokens; a long answer means it misunderstood the job.
        maxTokens: 256,
        useTools: false,
      },
      () => {},
      undefined,
      signal
    );
    reply = result.content;
  } catch (error) {
    console.error('[router] the model could not be reached, scoring by hand:', error);
    return guess(text);
  }

  const parsed = parse(reply);
  const chosen = trimmed(parsed?.agent) ? registry.find(trimmed(parsed?.agent)) : null;
  if (!chosen) return guess(text);

  return {
    agentId: chosen.id,
    agentName: chosen.name,
    title: trimmed(parsed?.title) || title(text),
    why: trimmed(parsed?.why) || `routed to ${chosen.name}`,
    guessed: false,
  };
}
