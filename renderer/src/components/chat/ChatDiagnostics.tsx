import { useMemo } from 'react';
import type { Message } from '../../types';
import { chatDiagnostics } from '../../lib/chatDiagnostics';

/** A durable, user-readable audit beside the chat, never an assistant message. */
export function ChatDiagnostics({ messages }: { messages: readonly Message[] }) {
  const audit = useMemo(() => chatDiagnostics(messages), [messages]);
  if (!audit.total) return null;
  return <details className="mx-4 my-2 rounded-md border border-line bg-surface-2 text-xs text-ink-2">
    <summary className="cursor-pointer px-3 py-2 font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      Diagnostics · {audit.total}
    </summary>
    <div className="border-t border-line px-3 py-2">
      <p className="mb-2 text-ink-3">Service and model failures are saved here for troubleshooting. These notices are excluded from model context.</p>
      {audit.total > audit.entries.length && <p className="mb-2 text-ink-3">Showing the latest {audit.entries.length} of {audit.total} notices.</p>}
      <ol className="max-h-64 space-y-3 overflow-y-auto" aria-label="Conversation diagnostics">
        {audit.entries.map((entry) => <li key={entry.id} className="select-text">
          <time dateTime={new Date(entry.at).toISOString()} className="block text-[11px] text-ink-3">{new Date(entry.at).toLocaleString()}</time>
          <p className="mt-1 whitespace-pre-wrap break-words text-ink">{entry.message}</p>
        </li>)}
      </ol>
    </div>
  </details>;
}
