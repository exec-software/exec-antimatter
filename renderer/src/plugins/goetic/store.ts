import { useSyncExternalStore } from 'react';
import type {
  GoeticArchiveFilter,
  GoeticBoardView,
  GoeticCard,
  GoeticCardDraft,
  GoeticConnection,
  GoeticIdentity,
  GoeticRevision,
  GoeticUniverse,
} from '../../types';

/**
 * Goetic's state for the panel.
 *
 * A store outside React, like Snitch's, because the panel can be docked or torn off and there is
 * no common ancestor to hang a provider on. Everything here is a cache of what Goetic said:
 * nothing is computed locally that Goetic owns, and every write refetches rather than patching
 * the cache, because the card the agent is also working may have moved since the last read.
 */

export type GoeticTab = 'board' | 'card' | 'settings';

export interface GoeticState {
  connection: GoeticConnection | null;
  identity: GoeticIdentity | null;
  universes: GoeticUniverse[];
  universeId: string | null;
  boardId: string | null;
  view: GoeticBoardView | null;
  selectedId: string | null;
  history: GoeticRevision[];
  archived: GoeticArchiveFilter;
  tab: GoeticTab;
  busy: boolean;
  /** What Goetic refused, in its own words. Never replaced with a friendlier guess. */
  error: string;
  notice: string;
}

const EMPTY: GoeticState = {
  connection: null,
  identity: null,
  universes: [],
  universeId: null,
  boardId: null,
  view: null,
  selectedId: null,
  history: [],
  archived: 'exclude',
  tab: 'board',
  busy: false,
  error: '',
  notice: '',
};

let state = EMPTY;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const set = (patch: Partial<GoeticState>) => {
  state = { ...state, ...patch };
  emit();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useGoetic = (): GoeticState => useSyncExternalStore(subscribe, () => state);

/** The number on the stripe button: active cards, which is what someone wants at a glance. */
export const useGoeticBadge = (): number | null => {
  const { view } = useGoetic();
  if (!view) return null;
  const active = view.cards.filter((card) => !card.archived).length;
  return active > 0 ? active : null;
};

const api = () => window.electronAPI.goetic;

/** Goetic's message is the message. A wrapper that rephrased it would be lying by paraphrase. */
const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+':\s*/, '') : String(cause);

async function guard<T>(work: () => Promise<T>): Promise<T | null> {
  set({ busy: true, error: '' });
  try {
    const result = await work();
    set({ busy: false });
    return result;
  } catch (cause) {
    set({ busy: false, error: describe(cause) });
    return null;
  }
}

export async function loadConnection(): Promise<void> {
  const connection = await guard(() => api().config());
  if (!connection) return;
  set({ connection });
  if (!connection.configured) {
    set({ tab: 'settings', identity: null, universes: [], view: null });
    return;
  }
  await loadIdentity();
  await loadUniverses();
}

async function loadIdentity(): Promise<void> {
  const identity = await guard(() => api().identity());
  if (identity) set({ identity });
}

export async function loadUniverses(): Promise<void> {
  const universes = await guard(() => api().universes());
  if (!universes) return;
  set({ universes });
  if (state.boardId && universes.some((entry) => entry.boards.some((board) => board.id === state.boardId))) {
    await loadBoard(state.universeId!, state.boardId);
    return;
  }
  // Open on the first board the credential can actually see, so the panel is
  // useful without a choice having to be made first.
  const first = universes.find((entry) => entry.boards.length > 0);
  if (first) await loadBoard(first.id, first.boards[0].id);
  else set({ view: null, universeId: null, boardId: null });
}

export async function loadBoard(universeId: string, boardId: string): Promise<void> {
  set({ universeId, boardId, selectedId: null, history: [], tab: 'board' });
  const view = await guard(() => api().board(universeId, boardId, state.archived));
  if (view) set({ view });
}

export async function refresh(): Promise<void> {
  if (!state.universeId || !state.boardId) {
    await loadConnection();
    return;
  }
  const view = await guard(() => api().board(state.universeId!, state.boardId!, state.archived));
  if (!view) return;
  const selected = state.selectedId && view.cards.some((card) => card.id === state.selectedId) ? state.selectedId : null;
  set({ view, selectedId: selected, tab: selected ? state.tab : 'board' });
}

export async function setArchiveFilter(archived: GoeticArchiveFilter): Promise<void> {
  set({ archived });
  await refresh();
}

export async function select(cardId: string | null): Promise<void> {
  set({ selectedId: cardId, tab: cardId ? 'card' : 'board', history: [], notice: '' });
  if (!cardId || !state.universeId || !state.boardId) return;
  const history = await guard(() => api().history(state.universeId!, state.boardId!, cardId));
  if (history) set({ history });
}

export const openTab = (tab: GoeticTab) => set({ tab, notice: '', error: '' });
export const dismissNotice = () => set({ notice: '', error: '' });

/**
 * Saves the connection. An omitted token keeps whatever is stored, so changing the URL does not
 * silently drop the credential; an empty string clears it deliberately.
 */
export async function connect(url: string, token?: string | null): Promise<boolean> {
  const connection = await guard(() => api().connect({ url, token }));
  if (!connection) return false;
  set({ connection, notice: connection.configured ? 'Credential saved.' : 'Credential cleared.' });
  if (connection.configured) {
    await loadIdentity();
    await loadUniverses();
  } else {
    set({ identity: null, universes: [], view: null, universeId: null, boardId: null });
  }
  return true;
}

export async function createCard(draft: GoeticCardDraft): Promise<GoeticCard | null> {
  if (!state.universeId || !state.boardId) return null;
  const card = await guard(() => api().createCard(state.universeId!, state.boardId!, draft));
  if (!card) return null;
  set({ notice: `Created "${card.title}" in ${card.stageName}.` });
  await refresh();
  await select(card.id);
  return card;
}

export async function moveCard(card: GoeticCard, stage: number, handoff: string, evidence?: string): Promise<boolean> {
  if (!state.universeId || !state.boardId) return false;
  const moved = await guard(() =>
    api().moveCard(state.universeId!, state.boardId!, card.id, card.revision, stage, handoff, evidence)
  );
  if (!moved) return false;
  set({ notice: `Moved to ${moved.stageName}.` });
  await refresh();
  await select(moved.id);
  return true;
}

export async function updateCard(card: GoeticCard, patch: Partial<GoeticCardDraft>): Promise<boolean> {
  if (!state.universeId || !state.boardId) return false;
  const saved = await guard(() => api().updateCard(state.universeId!, state.boardId!, card.id, card.revision, patch));
  if (!saved) return false;
  set({ notice: 'Saved.' });
  await refresh();
  await select(saved.id);
  return true;
}

export async function setArchived(card: GoeticCard, archived: boolean): Promise<boolean> {
  if (!state.universeId || !state.boardId) return false;
  const saved = await guard(() => api().setArchived(state.universeId!, state.boardId!, card.id, card.revision, archived));
  if (!saved) return false;
  set({ notice: archived ? 'Archived. Its history is kept and it can be restored.' : 'Restored.' });
  await refresh();
  if (archived) await select(null);
  else await select(saved.id);
  return true;
}

export const selectedCard = (): GoeticCard | null =>
  state.view?.cards.find((card) => card.id === state.selectedId) ?? null;
