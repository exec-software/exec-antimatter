import { useEffect, useSyncExternalStore } from 'react';
import type { Message, ToolActivity } from '../../types';
import { cursor, insertAtCursor } from '../editorBridge';
import { actions as env, active } from '../store';
import { GREETING, SYSTEM_PROMPT, type CoreState } from './persona';

/**
 * The core's own conversation.
 *
 * Separate from the main chat on purpose. This is the thing you ask mid-edit — "what does this
 * return", "write me the retry loop" — and those exchanges have no business landing in the
 * transcript you are keeping about something else. It gets its own thread id, so it gets its own
 * carbon, and it can be read back later like any other session.
 */

export interface CoreTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Set while the answer is still arriving. */
  streaming?: boolean;
}

export interface AvatarState {
  open: boolean;
  position: { x: number; y: number };
  turns: CoreTurn[];
  runId: string | null;
  state: CoreState;
  /** The tool the core is running, or the one waiting on a yes. */
  tool: ToolActivity | null;
  approval: ToolActivity | null;
  error: string;
  /** Bumped per turn so the status line varies instead of reading like a stuck gauge. */
  seed: number;
}

const POSITION_KEY = 'antimatter.core.position';

function storedPosition(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // Falls through to the default corner.
  }
  return { x: -1, y: -1 };
}

let state: AvatarState = {
  open: false,
  position: storedPosition(),
  turns: [],
  runId: null,
  state: 'idle',
  tool: null,
  approval: null,
  error: '',
  seed: 0,
};

let wired = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const set = (patch: Partial<AvatarState>) => {
  state = { ...state, ...patch };
  emit();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The thread id, so every exchange with the core lands in one carbon rather than one per turn. */
const threadId = crypto.randomUUID();

/**
 * What the core is looking at. Without this it is a chat window that happens to float: the whole
 * point is that "what does this do" and "write it here" mean the file on screen.
 */
function situation(): string {
  const file = active();
  if (!file) return 'No file is open in the editor right now.';

  const lines = file.text.split('\n');
  const head = lines.slice(0, 400).join('\n');
  const truncated = lines.length > 400 ? `\n… (${lines.length - 400} more lines)` : '';
  const caret = cursor();

  const where = caret
    ? caret.selection
      ? `The caret is on line ${caret.line}, with lines ${caret.from}–${caret.to} selected:\n\n\`\`\`\n${caret.selection.slice(0, 4000)}\n\`\`\``
      : `The caret is on line ${caret.line}, column ${caret.column}, with nothing selected.`
    : '';

  return [
    `The editor has ${file.path} open (${lines.length} lines).`,
    where,
    '',
    'Its current contents, which may differ from disk if there are unsaved edits:',
    '',
    '```',
    head + truncated,
    '```',
  ]
    .filter(Boolean)
    .join('\n');
}

export const actions = {
  toggle(): void {
    set({ open: !state.open });
  },

  close(): void {
    set({ open: false });
  },

  move(position: { x: number; y: number }): void {
    set({ position });
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    } catch {
      // A refused write is not worth a message; the orb just starts in the corner next time.
    }
  },

  clear(): void {
    set({ turns: [], error: '' });
  },

  clearError(): void {
    set({ error: '' });
  },

  async approve(approved: boolean): Promise<void> {
    const pending = state.approval;
    if (!pending) return;
    set({ approval: null, state: approved ? 'tool' : 'thinking' });
    await window.electronAPI.tools.approve(pending.approvalId ?? pending.callId, approved);
  },

  /** SCRAM: drop the rods. Whatever it had already written stays. */
  async scram(): Promise<void> {
    if (!state.runId) return;
    await window.electronAPI.chat.cancel(state.runId);
  },

  async ask(text: string, source: { providerId: string; model: string; accessMode: string }): Promise<void> {
    const prompt = text.trim();
    if (!prompt || state.runId) return;
    if (!source.providerId || !source.model) {
      set({ error: 'No inference source is connected.', state: 'error' });
      return;
    }

    const runId = crypto.randomUUID();
    const answerId = `${runId}-answer`;

    const history: Message[] = state.turns.map((turn) => ({
      id: turn.id,
      role: turn.role,
      content: turn.content,
    }));

    set({
      turns: [
        ...state.turns,
        { id: runId, role: 'user', content: prompt },
        { id: answerId, role: 'assistant', content: '', streaming: true },
      ],
      runId,
      state: 'thinking',
      error: '',
      tool: null,
      seed: state.seed + 1,
    });

    try {
      await window.electronAPI.chat.startAvatarStream({
        messages: [
          { id: 'core-system', role: 'system', content: `${SYSTEM_PROMPT}\n\n${situation()}` },
          ...history,
          { id: runId, role: 'user', content: prompt },
        ],
        model: source.model,
        providerId: source.providerId,
        requestId: runId,
        responseMessageId: answerId,
        threadId,
        accessMode: source.accessMode as 'read' | 'ask' | 'full',
        useTools: true,
      });
      set({ state: 'idle' });
    } catch (error) {
      const message = (error as Error).message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
      set({ error: message, state: 'error' });
    } finally {
      set({
        runId: null,
        tool: null,
        approval: null,
        turns: state.turns.map((turn) => (turn.id === answerId ? { ...turn, streaming: false } : turn)),
      });
    }
  },

  /** Puts a block from an answer into the file on screen, at the caret. */
  insert(code: string): void {
    if (insertAtCursor(code)) return;

    // No live view — the pane is showing something else. Append rather than lose the code.
    const file = active();
    if (file) env.edit(file.path, file.text ? `${file.text.replace(/\n?$/, '\n')}\n${code}\n` : `${code}\n`);
  },
};

function wire(): void {
  if (wired) return;
  wired = true;

  window.electronAPI.onStreamData((data) => {
    if (!state.runId || data.id !== state.runId) return;
    const answerId = `${state.runId}-answer`;
    set({
      state: 'thinking',
      turns: state.turns.map((turn) =>
        turn.id === answerId ? { ...turn, content: turn.content + data.content } : turn
      ),
    });
  });

  window.electronAPI.onToolActivity((activity) => {
    if (!state.runId || activity.requestId !== state.runId) return;
    set({
      tool: activity,
      state: activity.awaitingApproval ? 'waiting' : activity.status === 'running' ? 'tool' : state.state,
    });
  });

  window.electronAPI.onToolApproval((request) => {
    if (!state.runId || request.requestId !== state.runId) return;
    set({ approval: request, state: 'waiting' });
  });
}

export function useAvatar(): AvatarState {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    wire();
  }, []);
  return snapshot;
}

export const greeting = GREETING;
