/**
 * Goetic, for the tool window.
 *
 * The panel exists so that a person can watch and steer the same board the agent is working,
 * in the same window, without alt-tabbing to a browser. It is not a second implementation of
 * Goetic's rules: every call here is the same `/api/v1` request `mcp/tools/goetic.ts` makes, so
 * the panel and the agent see one state and obey one set of gates.
 *
 * The credential stays in this process. The renderer is told whether a token is configured and
 * which agent identity it names — never the token — so a compromised renderer surface cannot
 * read it back out, and the panel's own writes are attributed to that agent exactly like the
 * agent's are. That attribution is honest rather than flattering: a card the person moves from
 * this panel is recorded as moved by Antimatter's agent identity, because that is whose
 * credential carried it.
 */
import { goeticCall, goeticConfigView, idempotencyKey, saveGoeticConfig, type GoeticConfigView } from '../../mcp/goetic';

export interface GoeticBoardRef {
  id: string;
  universeId: string;
  name: string;
  kind: string;
  wipLimit: number;
  stageCount: number;
}

export interface GoeticUniverse {
  id: string;
  name: string;
  description: string;
  boards: GoeticBoardRef[];
}

export interface GoeticPhase {
  name: string;
  entry: string;
  exit: string;
  evidence: string;
  handoff: string;
}

export interface GoeticCard {
  id: string;
  revision: number;
  stage: number;
  stageName: string;
  title: string;
  description: string;
  acceptance: string;
  assignee: string;
  collaboration: string;
  blocked: boolean;
  blocker: string;
  evidence: string;
  handoff: string;
  actorId: string;
  archived: boolean;
  at: number;
}

export interface GoeticBoardView {
  board: GoeticBoardRef;
  universeName: string;
  phases: GoeticPhase[];
  lifecycleName: string;
  cadence: string;
  cards: GoeticCard[];
  total: number;
}

export interface GoeticRevision extends GoeticCard {
  number: number;
  action: string;
}

const card = (entry: any): GoeticCard => ({
  id: String(entry.id ?? ''),
  revision: Number(entry.revision ?? 0),
  stage: Number(entry.current?.stage ?? 0),
  stageName: String(entry.stage_name ?? ''),
  title: String(entry.current?.title ?? ''),
  description: String(entry.current?.description ?? ''),
  acceptance: String(entry.current?.acceptance ?? ''),
  assignee: String(entry.current?.assignee ?? ''),
  collaboration: String(entry.current?.collaboration ?? ''),
  blocked: Boolean(entry.current?.blocked),
  blocker: String(entry.current?.blocker ?? ''),
  evidence: String(entry.current?.evidence ?? ''),
  handoff: String(entry.current?.handoff ?? ''),
  actorId: String(entry.current?.actor_id ?? ''),
  archived: Boolean(entry.current?.archived),
  at: Number(entry.current?.at ?? 0),
});

export const config = (): GoeticConfigView => goeticConfigView();

export const connect = (update: { url?: string; token?: string | null }): GoeticConfigView => saveGoeticConfig(update);

/** The caller's own identity and live scopes, so the panel can say what it may do. */
export async function identity(): Promise<{ workspaceName: string; agentName: string; entityId: string; scopes: string[] }> {
  const { body } = await goeticCall('GET', '/api/v1/meta');
  return {
    workspaceName: String(body.workspace_name ?? ''),
    agentName: String(body.caller?.name ?? ''),
    entityId: String(body.caller?.entity_id ?? ''),
    scopes: Array.from(new Set<string>((body.caller?.scopes ?? []).map((scope: any) => String(scope.action)))).sort(),
  };
}

export async function universes(): Promise<GoeticUniverse[]> {
  const { body } = await goeticCall('GET', '/api/v1/universes');
  return (body.universes ?? []).map((entry: any) => ({
    id: String(entry.id ?? ''),
    name: String(entry.name ?? ''),
    description: String(entry.description ?? ''),
    boards: (entry.boards ?? []).map((board: any) => ({
      id: String(board.id ?? ''),
      universeId: String(board.universe_id ?? ''),
      name: String(board.name ?? ''),
      kind: String(board.kind ?? ''),
      wipLimit: Number(board.wip_limit ?? 0),
      stageCount: Number(board.stage_count ?? 0),
    })),
  }));
}

export async function board(universeId: string, boardId: string, archived: 'exclude' | 'include' | 'only'): Promise<GoeticBoardView> {
  const detail = await goeticCall('GET', `/api/v1/universes/${universeId}/boards/${boardId}`);
  // 100 is the API's page limit; a board caps at 128 cards, so a second page is
  // fetched rather than quietly showing a partial board.
  const first = await goeticCall('GET', `/api/v1/universes/${universeId}/boards/${boardId}/work?take=100&archived=${archived}`);
  const cards = [...(first.body.items ?? [])];
  if (Number(first.body.total ?? 0) > cards.length) {
    const next = await goeticCall(
      'GET',
      `/api/v1/universes/${universeId}/boards/${boardId}/work?skip=${cards.length}&take=100&archived=${archived}`
    );
    cards.push(...(next.body.items ?? []));
  }
  const info = detail.body.board ?? {};
  return {
    board: {
      id: String(info.id ?? boardId),
      universeId: String(info.universe_id ?? universeId),
      name: String(info.name ?? ''),
      kind: String(info.kind ?? ''),
      wipLimit: Number(info.wip_limit ?? 0),
      stageCount: Number(info.stage_count ?? 0),
    },
    universeName: String(detail.body.universe?.name ?? ''),
    lifecycleName: String(info.lifecycle?.name ?? ''),
    cadence: String(info.lifecycle?.cadence ?? ''),
    phases: (info.lifecycle?.stages ?? []).map((stage: any) => ({
      name: String(stage.name ?? ''),
      entry: String(stage.entry ?? ''),
      exit: String(stage.exit ?? ''),
      evidence: String(stage.evidence ?? ''),
      handoff: String(stage.handoff ?? ''),
    })),
    cards: cards.map(card),
    total: Number(first.body.total ?? cards.length),
  };
}

export async function history(universeId: string, boardId: string, cardId: string): Promise<GoeticRevision[]> {
  const { body } = await goeticCall('GET', `/api/v1/universes/${universeId}/boards/${boardId}/work/${cardId}/history`);
  return (body.revisions ?? []).map((entry: any) => ({
    ...card({ id: cardId, revision: entry.number, current: entry, stage_name: '' }),
    number: Number(entry.number ?? 0),
    action: String(entry.action ?? ''),
  }));
}

export interface GoeticCardDraft {
  title: string;
  description?: string;
  acceptance?: string;
  assignee?: string;
  collaboration?: string;
  blocked?: boolean;
  blocker?: string;
  evidence?: string;
  handoff?: string;
}

export async function createCard(universeId: string, boardId: string, draft: GoeticCardDraft): Promise<GoeticCard> {
  const key = idempotencyKey('panel-create', { universeId, boardId, draft });
  const { body } = await goeticCall('POST', `/api/v1/universes/${universeId}/boards/${boardId}/work`, draft, {
    idempotencyKey: key,
  });
  return card(body);
}

export async function updateCard(
  universeId: string,
  boardId: string,
  cardId: string,
  revision: number,
  patch: Partial<GoeticCardDraft>
): Promise<GoeticCard> {
  const { body } = await goeticCall('PATCH', `/api/v1/universes/${universeId}/boards/${boardId}/work/${cardId}`, {
    ...patch,
    revision,
  });
  return card(body);
}

export async function moveCard(
  universeId: string,
  boardId: string,
  cardId: string,
  revision: number,
  stage: number,
  handoff: string,
  evidence?: string
): Promise<GoeticCard> {
  const body: Record<string, unknown> = { stage, handoff, revision };
  if (evidence !== undefined) body.evidence = evidence;
  const reply = await goeticCall('POST', `/api/v1/universes/${universeId}/boards/${boardId}/work/${cardId}/move`, body);
  return card(reply.body);
}

export async function setArchived(
  universeId: string,
  boardId: string,
  cardId: string,
  revision: number,
  archived: boolean
): Promise<GoeticCard> {
  const action = archived ? 'archive' : 'restore';
  const { body } = await goeticCall('POST', `/api/v1/universes/${universeId}/boards/${boardId}/work/${cardId}/${action}`, {
    revision,
  });
  return card(body);
}
