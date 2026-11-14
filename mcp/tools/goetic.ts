/**
 * Goetic work tracking, as tools.
 *
 * These are what let an agent working in Antimatter read and run a project's work without a
 * browser: find a board, read its lifecycle, pick up a card, record evidence and hand it on.
 * They are a thin shell over Goetic's `/api/v1`, which is the point — Goetic owns the rules.
 * Every phase gate, work-in-progress limit, revision conflict and permission check happens
 * there, so a tool here cannot soften one by accident, and a refusal is reported as Goetic
 * worded it rather than being retried or reinterpreted.
 *
 * Two things an agent reading this should take seriously:
 *
 * - **A mutation needs the revision you last read.** Goetic refuses a stale write instead of
 *   overwriting someone else's change, so read before you write and expect a conflict to mean
 *   somebody moved first.
 * - **What you record is your own assertion.** Writing "tests pass" into a card's evidence is a
 *   claim attributed to this agent identity. It is not independent verification, and no
 *   combination of these tools authorizes a release or a deployment.
 */
import { GoeticError, goeticCall, goeticConfigView, idempotencyKey } from '../goetic';
import { bool, clip, num, str, type ToolDef } from '../types';

const ID = /^[0-9a-f]{32}$/;

function checkedId(raw: unknown, field: string): string {
  const value = String(raw ?? '').trim();
  if (!ID.test(value)) {
    throw new Error(`${field} must be a Goetic identity: 32 lowercase hexadecimal characters. Got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Hands Goetic's own wording to the model, with the status so a retry decision is possible. */
async function call<T = any>(method: string, path: string, body?: unknown, key?: string): Promise<T> {
  try {
    const reply = await goeticCall<T>(method, path, body, { idempotencyKey: key });
    return reply.body;
  } catch (cause) {
    if (cause instanceof GoeticError) {
      const hint =
        cause.status === 409
          ? ' Read the card again and retry against its current revision.'
          : cause.status === 403
            ? " This agent identity has no live grant for that action. Its scopes are listed by goetic_status."
            : '';
      throw new Error(`Goetic ${cause.status || 'unreachable'} (${cause.code}): ${cause.message}${hint}`);
    }
    throw cause;
  }
}

const show = (value: unknown): string => clip(JSON.stringify(value, null, 2));

const universe = str('Universe identity, 32 hexadecimal characters, from goetic_universes.');
const board = str('Board identity, 32 hexadecimal characters, from goetic_universes or goetic_board.');
const card = str('Work card identity, 32 hexadecimal characters, from goetic_cards.');
const revision = num(
  'The card revision you last read. Goetic refuses a stale write rather than overwriting a newer change.'
);

const planning = {
  title: str('Card title, 1 to 160 characters.'),
  description: str('What the work is, up to 8192 characters.'),
  acceptance: str('Acceptance criteria. Continuum boards require these from the Ready phase onward.'),
  assignee: str('Who is doing it. Continuum requires an assignee from the Build phase onward. Planning metadata only: it grants nothing.'),
  collaboration: str('One of human, agent or pair. Describes the plan, not an authorization.'),
  blocked: bool('Whether the card is blocked. A blocked card cannot advance.'),
  blocker: str('What is blocking it. Required and non-blank when blocked is true.'),
  evidence: str('Evidence for the current phase. Continuum requires this from the Verify phase onward.'),
  handoff: str('Who is handing this to whom, and what they need to know.'),
};

/** Only the planning fields the caller actually sent, so an omission keeps its stored value. */
function planningPatch(args: Record<string, any>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of Object.keys(planning)) {
    if (args[field] !== undefined) patch[field] = field === 'blocked' ? Boolean(args[field]) : String(args[field]);
  }
  return patch;
}

export const goeticTools: ToolDef[] = [
  {
    name: 'goetic_status',
    description:
      'Report how Antimatter is connected to Goetic and what this agent identity may do: the server URL, ' +
      'the agent it authenticates as, and its live per-board scopes. Call this first; a 403 from any other ' +
      'Goetic tool is usually a missing scope rather than a mistake in the call.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const view = goeticConfigView();
      if (!view.configured) {
        return clip(
          `Goetic is not connected.\n\n  url:    ${view.url}\n  token:  not configured\n\n` +
            'Someone with a Goetic browser session has to admit an agent identity and paste its token into the ' +
            'Goetic panel, or set GOETIC_TOKEN. Antimatter cannot mint one: minting, rotating and re-scoping a ' +
            'credential are browser-only operations in Goetic, so that an agent cannot widen its own access.'
        );
      }
      const meta = await call('GET', '/api/v1/meta');
      return show({ connection: view, workspace: { id: meta.workspace_id, name: meta.workspace_name }, caller: meta.caller });
    },
  },

  {
    name: 'goetic_universes',
    description:
      'List the Goetic Universes this agent identity may read, each with its readable boards. A Universe is ' +
      'the project container; a board inside it holds the work cards.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      return show(await call('GET', '/api/v1/universes'));
    },
  },

  {
    name: 'goetic_board',
    description:
      "Read one board and its whole lifecycle: every phase in order, and for each phase what it expects on " +
      'entry, what it expects before leaving, what evidence it wants, and who hands the work to whom. Read ' +
      'this before moving a card, because the phase indices and the gates come from here, not from a ' +
      'convention — a Continuum board is not a Kanban board with more columns.',
    inputSchema: { type: 'object', properties: { universe_id: universe, board_id: board }, required: ['universe_id', 'board_id'] },
    async run(args) {
      const uid = checkedId(args.universe_id, 'universe_id');
      const bid = checkedId(args.board_id, 'board_id');
      return show(await call('GET', `/api/v1/universes/${uid}/boards/${bid}`));
    },
  },

  {
    name: 'goetic_cards',
    description:
      'List work cards on a board. Filters apply before the total, so `total` describes the whole filtered ' +
      'set while `items` is one page of it. Archived cards are excluded unless asked for.',
    inputSchema: {
      type: 'object',
      properties: {
        universe_id: universe,
        board_id: board,
        stage: num('Restrict to one phase index, counting from zero.'),
        archived: str('One of exclude (default), include or only.'),
        assignee: str('Case-insensitive substring of the assignee.'),
        collaboration: str('One of human, agent or pair.'),
        blocked: bool('Restrict to blocked or unblocked cards.'),
        query: str('Case-insensitive substring of the title, description or acceptance notes.'),
        skip: num('Cards to skip, 0 to 4096. Default 0.'),
        take: num('Cards to return, 1 to 100. Default 25.'),
      },
      required: ['universe_id', 'board_id'],
    },
    async run(args) {
      const uid = checkedId(args.universe_id, 'universe_id');
      const bid = checkedId(args.board_id, 'board_id');
      const query = new URLSearchParams();
      if (args.stage !== undefined) query.set('stage', String(Number(args.stage)));
      if (args.archived !== undefined) query.set('archived', String(args.archived));
      if (args.assignee) query.set('assignee', String(args.assignee));
      if (args.collaboration) query.set('collaboration', String(args.collaboration));
      if (args.blocked !== undefined) query.set('blocked', args.blocked ? 'true' : 'false');
      if (args.query) query.set('q', String(args.query));
      if (args.skip !== undefined) query.set('skip', String(Number(args.skip)));
      if (args.take !== undefined) query.set('take', String(Number(args.take)));
      const suffix = query.size ? `?${query}` : '';
      return show(await call('GET', `/api/v1/universes/${uid}/boards/${bid}/work${suffix}`));
    },
  },

  {
    name: 'goetic_card',
    description: 'Read one work card: its current revision, phase, planning fields, evidence and handoff notes.',
    inputSchema: {
      type: 'object',
      properties: { universe_id: universe, board_id: board, card_id: card },
      required: ['universe_id', 'board_id', 'card_id'],
    },
    async run(args) {
      const uid = checkedId(args.universe_id, 'universe_id');
      const bid = checkedId(args.board_id, 'board_id');
      const cid = checkedId(args.card_id, 'card_id');
      return show(await call('GET', `/api/v1/universes/${uid}/boards/${bid}/work/${cid}`));
    },
  },

  {
    name: 'goetic_card_history',
    description:
      'Read every revision of a work card, with the actor and timestamp of each change. This is how to see ' +
      'what a previous phase actually recorded, and who recorded it, rather than inferring it.',
    inputSchema: {
      type: 'object',
      properties: { universe_id: universe, board_id: board, card_id: card },
      required: ['universe_id', 'board_id', 'card_id'],
    },
    async run(args) {
      const uid = checkedId(args.universe_id, 'universe_id');
      const bid = checkedId(args.board_id, 'board_id');
      const cid = checkedId(args.card_id, 'card_id');
      return show(await call('GET', `/api/v1/universes/${uid}/boards/${bid}/work/${cid}/history`));
    },
  },

  {
    name: 'goetic_create_card',
    description:
      "Create a work card in the board's first phase. The card is attributed to this agent identity and " +
      'appears in the human board immediately. Retrying with the same arguments replays the first result ' +
      'instead of creating a second card.',
    inputSchema: {
      type: 'object',
      properties: { universe_id: universe, board_id: board, ...planning },
      required: ['universe_id', 'board_id', 'title'],
    },
    async run(args) {
      const uid = checkedId(args.universe_id, 'universe_id');
      const bid = checkedId(args.board_id, 'board_id');
      const patch = planningPatch(args);
      const key = idempotencyKey('create', { uid, bid, patch });
      return show(await call('POST', `/api/v1/universes/${uid}/boards/${bid}/work`, patch, key));
    },
  },

  {
    name: 'goetic_update_card',
    description:
      "Change a work card's planning fields without moving it between phases. Fields you leave out keep " +
      'their current value. Requires the revision you last read.',
    inputSchema: {
      type: 'object',
      properties: { universe_id: universe, board_id: board, card_id: card, revision, ...planning },
      required: ['universe_id', 'board_id', 'card_id', 'revision'],
    },
    async run(args) {
      const uid = checkedId(args.universe_id, 'universe_id');
      const bid = checkedId(args.board_id, 'board_id');
      const cid = checkedId(args.card_id, 'card_id');
      const patch = { ...planningPatch(args), revision: Number(args.revision) };
      return show(await call('PATCH', `/api/v1/universes/${uid}/boards/${bid}/work/${cid}`, patch));
    },
  },

  {
    name: 'goetic_move_card',
    description:
      'Move a work card one phase forward, or back to any earlier phase. A handoff note is required, because ' +
      "a move is a handoff: say who is picking this up and what they need. The phase's own gates still apply " +
      '— a Continuum board wants acceptance criteria before Ready, an assignee before Build and evidence ' +
      'before Verify — and a refusal names the gate. Read goetic_board for the phase indices. This records ' +
      'progress; it does not authorize a release or a deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        universe_id: universe,
        board_id: board,
        card_id: card,
        stage: num('Target phase index, counting from zero. Forward by exactly one, or back to any earlier phase.'),
        handoff: str('Required: who hands this to whom, and what they need to know.'),
        evidence: str('Evidence for leaving the current phase. Omit to keep what is already recorded.'),
        revision,
      },
      required: ['universe_id', 'board_id', 'card_id', 'stage', 'handoff', 'revision'],
    },
    async run(args) {
      const uid = checkedId(args.universe_id, 'universe_id');
      const bid = checkedId(args.board_id, 'board_id');
      const cid = checkedId(args.card_id, 'card_id');
      const body: Record<string, unknown> = {
        stage: Number(args.stage),
        handoff: String(args.handoff ?? ''),
        revision: Number(args.revision),
      };
      if (args.evidence !== undefined) body.evidence = String(args.evidence);
      return show(await call('POST', `/api/v1/universes/${uid}/boards/${bid}/work/${cid}/move`, body));
    },
  },

  {
    name: 'goetic_archive_card',
    description:
      'Archive a work card. This is what deleting a card means in Goetic: the card leaves the default board ' +
      'view, its history is preserved in full, and it can be restored. Requires the revision you last read.',
    inputSchema: {
      type: 'object',
      properties: { universe_id: universe, board_id: board, card_id: card, revision },
      required: ['universe_id', 'board_id', 'card_id', 'revision'],
    },
    async run(args) {
      const uid = checkedId(args.universe_id, 'universe_id');
      const bid = checkedId(args.board_id, 'board_id');
      const cid = checkedId(args.card_id, 'card_id');
      return show(
        await call('POST', `/api/v1/universes/${uid}/boards/${bid}/work/${cid}/archive`, { revision: Number(args.revision) })
      );
    },
  },

  {
    name: 'goetic_restore_card',
    description:
      'Restore an archived work card to the phase it was archived in. Refused if that phase is a ' +
      'work-in-progress phase and the board is already at its limit.',
    inputSchema: {
      type: 'object',
      properties: { universe_id: universe, board_id: board, card_id: card, revision },
      required: ['universe_id', 'board_id', 'card_id', 'revision'],
    },
    async run(args) {
      const uid = checkedId(args.universe_id, 'universe_id');
      const bid = checkedId(args.board_id, 'board_id');
      const cid = checkedId(args.card_id, 'card_id');
      return show(
        await call('POST', `/api/v1/universes/${uid}/boards/${bid}/work/${cid}/restore`, { revision: Number(args.revision) })
      );
    },
  },
];
