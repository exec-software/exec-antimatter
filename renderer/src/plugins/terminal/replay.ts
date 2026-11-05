import type { TerminalSessionInfo } from '../../types';

export interface TerminalChunk { data: string; offset?: number }

/** Offsets count UTF-16 code units, just like string.length in the host's scrollback. */
export function terminalTail(chunk: TerminalChunk, consumed: number): { data: string; offset: number } {
  if (chunk.offset === undefined) return { data: chunk.data, offset: consumed + chunk.data.length };
  if (chunk.offset <= consumed) return { data: '', offset: consumed };
  const skip = Math.max(0, consumed - (chunk.offset - chunk.data.length));
  return { data: chunk.data.slice(skip), offset: chunk.offset };
}

/** An agent command is never adopted as a manual shell, even in the same directory. */
export function matchingShell(entries: readonly TerminalSessionInfo[], cwd: string | null): TerminalSessionInfo | undefined {
  if (!cwd) return undefined;
  return entries.filter((entry) => entry.kind !== 'command' && !entry.exit && entry.cwd === cwd)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

export function terminalLabel(entry: TerminalSessionInfo): string {
  const name = entry.kind === 'command' ? entry.command?.replace(/\s+/g, ' ').trim() || 'Agent command' : entry.cwd || entry.shell;
  return `${entry.kind === 'command' ? 'Command' : 'Shell'} · ${name}${entry.exit ? ` · exited ${entry.exit.code}` : ''}`;
}
