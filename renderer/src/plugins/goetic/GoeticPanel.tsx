import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Ban,
  Bot,
  Check,
  ChevronLeft,
  KeyRound,
  Plus,
  RefreshCw,
  Settings2,
  User,
} from 'lucide-react';
import type { GoeticCard, GoeticPhase } from '../../types';
import {
  connect,
  createCard,
  dismissNotice,
  loadBoard,
  loadConnection,
  moveCard,
  openTab,
  refresh,
  select,
  setArchiveFilter,
  setArchived,
  useGoetic,
} from './store';

/**
 * Goetic in Antimatter.
 *
 * The panel exists because of who is on the other side of it. Antimatter's agent works this
 * board through the same API, so the person watching needs to see what the agent sees — the
 * phase a card is in, what that phase expects, and who last touched it — without switching to a
 * browser and losing the conversation.
 *
 * Two decisions worth stating. First, the phase column headings and the gate text are Goetic's
 * own words, read from the board's lifecycle, never a local table: a board here may be
 * Continuum, Agile or Kanban, and inventing labels would make the panel disagree with the
 * product at exactly the moment someone is relying on it. Second, a move asks for a handoff note
 * and will not submit without one, which is not an interface flourish — Goetic refuses the move
 * anyway, and a form that let you discover that by being rejected would be worse than a form
 * that says so.
 */

const PANEL = 'flex h-full min-h-0 flex-col bg-surface-2 text-ink-1';
const HEADER = 'flex items-center gap-2 border-b border-line px-3 py-2';
const BUTTON =
  'inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-40';
const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-md border border-primary/60 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40';
const FIELD =
  'w-full rounded-md border border-line bg-surface-3/60 px-2 py-1.5 text-[12px] text-ink-1 outline-none placeholder:text-ink-3 focus:border-primary/60';
const CAPTION = 'text-[10px] font-medium uppercase tracking-wide text-ink-3';

/** Who made a revision, as far as the panel can honestly tell. */
function Actor({ card, agentId }: { card: GoeticCard; agentId: string | null }) {
  const mine = agentId !== null && card.actorId === agentId;
  const Icon = mine ? Bot : User;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-ink-3" title={`Last changed by entity ${card.actorId}`}>
      <Icon size={11} />
      {mine ? 'this agent' : `${card.actorId.slice(0, 8)}…`}
    </span>
  );
}

function Banner({ tone, children, onDismiss }: { tone: 'error' | 'notice'; children: React.ReactNode; onDismiss(): void }) {
  const look =
    tone === 'error'
      ? 'border-danger/50 bg-danger/10 text-danger'
      : 'border-accent/50 bg-accent/10 text-accent-strong';
  return (
    <div className={`mx-3 mt-2 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px] leading-relaxed ${look}`}>
      <span className="min-w-0 flex-1 break-words">{children}</span>
      <button type="button" className="shrink-0 text-ink-3 hover:text-ink-1" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

function CardRow({ card, agentId, onOpen }: { card: GoeticCard; agentId: string | null; onOpen(): void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-md border border-line bg-surface-3/40 px-2.5 py-2 text-left transition hover:border-primary/50"
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-1">{card.title}</span>
        {card.blocked && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded border border-danger/50 bg-danger/10 px-1 text-[10px] text-danger">
            <Ban size={9} /> blocked
          </span>
        )}
        {card.archived && <span className={`${CAPTION} shrink-0`}>archived</span>}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <Actor card={card} agentId={agentId} />
        {card.assignee && <span className="truncate text-[10px] text-ink-3">· {card.assignee}</span>}
        <span className="ml-auto shrink-0 text-[10px] text-ink-3">r{card.revision}</span>
      </div>
    </button>
  );
}

function BoardView() {
  const { view, identity, archived, universes, universeId, boardId, busy } = useGoetic();
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const byPhase = useMemo(() => {
    const columns: GoeticCard[][] = (view?.phases ?? []).map(() => []);
    for (const card of view?.cards ?? []) {
      if (card.stage >= 0 && card.stage < columns.length) columns[card.stage].push(card);
    }
    return columns;
  }, [view]);

  if (!view) {
    return (
      <div className="px-3 py-6 text-[12px] text-ink-3">
        {busy ? 'Reading Goetic…' : 'No board this credential can read. Its scopes are listed under Settings.'}
      </div>
    );
  }

  const submit = async () => {
    if (!title.trim()) return;
    const made = await createCard({
      title: title.trim(),
      description: description.trim(),
      // The panel's writes carry Antimatter's agent credential, so the honest
      // default is agent-led rather than claiming a person did it.
      collaboration: 'agent',
      handoff: 'Filed from the Goetic panel in Antimatter.',
    });
    if (made) {
      setComposing(false);
      setTitle('');
      setDescription('');
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      <div className="sticky top-0 z-10 -mx-3 mb-2 bg-surface-2/95 px-3 pb-2 pt-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            className={`${FIELD} max-w-[200px] flex-1`}
            value={universeId && boardId ? `${universeId}:${boardId}` : ''}
            onChange={(event) => {
              const [nextUniverse, nextBoard] = event.target.value.split(':');
              if (nextUniverse && nextBoard) void loadBoard(nextUniverse, nextBoard);
            }}
          >
            {universes.map((universe) =>
              universe.boards.map((board) => (
                <option key={board.id} value={`${universe.id}:${board.id}`}>
                  {universe.name} › {board.name}
                </option>
              ))
            )}
          </select>
          <select
            className={`${FIELD} w-[112px]`}
            value={archived}
            onChange={(event) => void setArchiveFilter(event.target.value as typeof archived)}
          >
            <option value="exclude">Active</option>
            <option value="include">All</option>
            <option value="only">Archived</option>
          </select>
          <button type="button" className={BUTTON} onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={11} className={busy ? 'animate-spin' : undefined} /> Refresh
          </button>
          <button type="button" className={PRIMARY} onClick={() => setComposing((open) => !open)}>
            <Plus size={11} /> Card
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-ink-3">
          {view.lifecycleName || view.board.kind} · {view.total} card{view.total === 1 ? '' : 's'} · work-in-progress limit{' '}
          {view.board.wipLimit}
        </p>
      </div>

      {composing && (
        <div className="mb-3 space-y-1.5 rounded-md border border-primary/40 bg-surface-3/40 p-2.5">
          <input
            className={FIELD}
            placeholder="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
          <textarea
            className={`${FIELD} min-h-[56px] resize-y`}
            placeholder="What is the work?"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <div className="flex items-center gap-1.5">
            <button type="button" className={PRIMARY} onClick={() => void submit()} disabled={!title.trim() || busy}>
              <Check size={11} /> Create in {view.phases[0]?.name ?? 'the first phase'}
            </button>
            <button type="button" className={BUTTON} onClick={() => setComposing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {view.phases.map((phase, index) => (
          <section key={phase.name}>
            <h3 className="mb-1 flex items-baseline gap-1.5">
              <span className={CAPTION}>{phase.name}</span>
              <span className="text-[10px] text-ink-3">{byPhase[index]?.length ?? 0}</span>
            </h3>
            {byPhase[index]?.length ? (
              <div className="space-y-1.5">
                {byPhase[index].map((card) => (
                  <CardRow key={card.id} card={card} agentId={identity?.entityId ?? null} onOpen={() => void select(card.id)} />
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-line px-2.5 py-1.5 text-[10px] text-ink-3">
                {phase.entry}
              </p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function PhaseExpectation({ phase }: { phase: GoeticPhase | undefined }) {
  if (!phase) return null;
  return (
    <dl className="space-y-1.5 rounded-md border border-line bg-surface-3/40 p-2.5 text-[11px] leading-relaxed">
      {(
        [
          ['Leaves when', phase.exit],
          ['Evidence', phase.evidence],
          ['Handoff', phase.handoff],
        ] as const
      ).map(([label, text]) => (
        <div key={label}>
          <dt className={CAPTION}>{label}</dt>
          <dd className="text-ink-2">{text}</dd>
        </div>
      ))}
    </dl>
  );
}

function CardView() {
  const { view, identity, history, busy } = useGoetic();
  const card = view?.cards.find((entry) => entry.id === useGoetic().selectedId) ?? null;
  const [stage, setStage] = useState<number | null>(null);
  const [handoff, setHandoff] = useState('');
  const [evidence, setEvidence] = useState('');

  useEffect(() => {
    if (!card) return;
    setStage(Math.min(card.stage + 1, (view?.phases.length ?? 1) - 1));
    setHandoff('');
    setEvidence(card.evidence);
  }, [card?.id, card?.revision, view?.phases.length]);

  if (!card || !view) {
    return <div className="px-3 py-6 text-[12px] text-ink-3">Nothing selected.</div>;
  }

  const target = stage === null ? null : view.phases[stage];
  const advancing = stage !== null && stage > card.stage;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      <button type="button" className={`${BUTTON} my-2`} onClick={() => void select(null)}>
        <ChevronLeft size={11} /> Board
      </button>

      <h2 className="text-[13px] font-medium text-ink-1">{card.title}</h2>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="rounded border border-line px-1 text-[10px] text-ink-2">{card.stageName}</span>
        <span className="text-[10px] text-ink-3">revision {card.revision}</span>
        <Actor card={card} agentId={identity?.entityId ?? null} />
        {card.collaboration && <span className="text-[10px] text-ink-3">· {card.collaboration}</span>}
      </div>

      {card.blocked && (
        <p className="mt-2 rounded-md border border-danger/50 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          Blocked: {card.blocker || 'no reason recorded'}. It cannot advance until that is resolved.
        </p>
      )}

      <div className="mt-3 space-y-2 text-[11px] leading-relaxed">
        {(
          [
            ['Description', card.description],
            ['Acceptance', card.acceptance],
            ['Assignee', card.assignee],
            ['Evidence on record', card.evidence],
            ['Last handoff', card.handoff],
          ] as const
        ).map(([label, text]) => (
          <div key={label}>
            <p className={CAPTION}>{label}</p>
            <p className="whitespace-pre-wrap break-words text-ink-2">{text || <span className="text-ink-3">—</span>}</p>
          </div>
        ))}
      </div>

      {!card.archived && (
        <section className="mt-4 space-y-1.5">
          <p className={CAPTION}>Move</p>
          <select
            className={FIELD}
            value={stage ?? card.stage}
            onChange={(event) => setStage(Number(event.target.value))}
          >
            {view.phases.map((phase, index) => (
              <option key={phase.name} value={index} disabled={index === card.stage || index > card.stage + 1}>
                {index}. {phase.name}
                {index === card.stage ? ' (current)' : ''}
                {index > card.stage + 1 ? ' — forward one phase at a time' : ''}
              </option>
            ))}
          </select>
          {advancing && <PhaseExpectation phase={view.phases[card.stage]} />}
          <textarea
            className={`${FIELD} min-h-[60px] resize-y`}
            placeholder="Handoff — required. Who picks this up, and what do they need to know?"
            value={handoff}
            onChange={(event) => setHandoff(event.target.value)}
          />
          <textarea
            className={`${FIELD} min-h-[60px] resize-y`}
            placeholder="Evidence for leaving this phase. Leaving it unchanged keeps what is on record."
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className={PRIMARY}
              disabled={busy || !handoff.trim() || stage === null || stage === card.stage || card.blocked}
              onClick={() => void moveCard(card, stage!, handoff.trim(), evidence)}
            >
              <ArrowRight size={11} /> Move to {target?.name ?? '…'}
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void setArchived(card, true)}>
              <Archive size={11} /> Archive
            </button>
          </div>
          <p className="text-[10px] text-ink-3">
            Recorded against this agent identity. Goetic treats it as a stated claim, not independent verification, and
            it authorizes no release.
          </p>
        </section>
      )}

      {card.archived && (
        <button type="button" className={`${PRIMARY} mt-4`} disabled={busy} onClick={() => void setArchived(card, false)}>
          <ArchiveRestore size={11} /> Restore to {card.stageName}
        </button>
      )}

      {history.length > 0 && (
        <section className="mt-4">
          <p className={CAPTION}>History</p>
          <ol className="mt-1 space-y-1">
            {[...history].reverse().map((entry) => (
              <li key={entry.number} className="flex items-baseline gap-2 text-[10px] text-ink-3">
                <span className="w-7 shrink-0 text-ink-2">r{entry.number}</span>
                <span className="w-14 shrink-0">{entry.action}</span>
                <span className="min-w-0 flex-1 truncate">
                  {view.phases[entry.stage]?.name ?? `phase ${entry.stage}`} · {entry.actorId.slice(0, 8)}…
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function SettingsView() {
  const { connection, identity, busy } = useGoetic();
  const [url, setUrl] = useState(connection?.url ?? 'http://127.0.0.1:3000');
  const [token, setToken] = useState('');

  useEffect(() => {
    if (connection?.url) setUrl(connection.url);
  }, [connection?.url]);

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-[11px] leading-relaxed">
      <div className="space-y-1.5">
        <p className={CAPTION}>Goetic URL</p>
        <input className={FIELD} value={url} onChange={(event) => setUrl(event.target.value)} spellCheck={false} />
        <p className="text-[10px] text-ink-3">
          Goetic binds loopback only. A plain-HTTP address that is not loopback is refused, because a bearer token must
          not go out in clear.
        </p>
      </div>

      <div className="space-y-1.5">
        <p className={CAPTION}>Agent token</p>
        <input
          className={FIELD}
          type="password"
          placeholder={connection?.configured ? 'Stored — paste a new token to replace it' : 'gta_…'}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={PRIMARY}
            disabled={busy}
            onClick={() => void connect(url.trim(), token.trim() ? token.trim() : undefined)}
          >
            <KeyRound size={11} /> Save
          </button>
          {connection?.configured && (
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void connect(url.trim(), '')}>
              Forget token
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1 rounded-md border border-line bg-surface-3/40 p-2.5">
        <p className={CAPTION}>Connection</p>
        {connection?.configured ? (
          <>
            <p className="text-ink-2">
              Authenticating as <span className="text-ink-1">{identity?.agentName || 'an agent identity'}</span>
              {connection.agentId && <span className="text-ink-3"> ({connection.agentId.slice(0, 8)}…)</span>}
              {identity?.workspaceName && <span className="text-ink-3"> in {identity.workspaceName}</span>}.
            </p>
            <p className="text-[10px] text-ink-3">
              Credential from {connection.source === 'environment' ? 'GOETIC_TOKEN' : 'this machine’s Antimatter config'}.
            </p>
            {identity?.scopes.length ? (
              <div className="mt-1.5">
                <p className={CAPTION}>Live actions</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {identity.scopes.map((scope) => (
                    <span key={scope} className="rounded border border-line px-1 text-[10px] text-ink-2">
                      {scope}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-ink-2">Not connected.</p>
        )}
      </div>

      <p className="text-[10px] text-ink-3">
        Antimatter cannot create or widen a Goetic credential. Admitting an agent identity, rotating its token and
        changing its scopes are browser-only operations in Goetic, so that an agent cannot promote itself. Ask whoever
        administers the workspace to admit an identity and hand you the token it prints once.
      </p>
    </div>
  );
}

export function GoeticPanel({ visible = true }: { visible?: boolean }) {
  const { tab, error, notice, connection } = useGoetic();

  useEffect(() => {
    if (visible && !connection) void loadConnection();
  }, [visible, connection]);

  return (
    <div className={PANEL}>
      <div className={HEADER}>
        {(['board', 'card', 'settings'] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => openTab(name)}
            className={`rounded px-1.5 py-0.5 text-[11px] capitalize transition ${
              tab === name ? 'bg-surface-3 text-ink-1' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {name === 'settings' ? <Settings2 size={12} /> : name}
          </button>
        ))}
      </div>

      {error && (
        <Banner tone="error" onDismiss={dismissNotice}>
          {error}
        </Banner>
      )}
      {notice && !error && (
        <Banner tone="notice" onDismiss={dismissNotice}>
          {notice}
        </Banner>
      )}

      {tab === 'settings' ? <SettingsView /> : tab === 'card' ? <CardView /> : <BoardView />}
    </div>
  );
}
