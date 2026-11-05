import { normalizeOperationalError, separateOperationalError, type OperationalMessage } from '../../../src/api/operationalErrors';

/** Diagnostic text stays out of transcript prose and the messages sent to providers. */
export function chatDiagnostics(messages: readonly (OperationalMessage & { id: string })[], limit = 50) {
  const entries = messages.flatMap((message) => {
    if (message.role !== 'assistant') return [];
    const failure = normalizeOperationalError(separateOperationalError(message).meta?.operationalError);
    return failure ? [{ id: message.id, message: failure.message, at: failure.at }] : [];
  });
  return { total: entries.length, entries: entries.slice(-Math.max(1, Math.floor(limit))).reverse() };
}
