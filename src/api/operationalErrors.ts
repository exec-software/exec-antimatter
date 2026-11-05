/** App/service failures are diagnostics, never words attributed to the model. */
export interface OperationalError {
  kind: 'operational-error';
  message: string;
  at: number;
}

export interface OperationalMessage {
  role: string;
  content: string;
  meta?: {
    failed?: boolean;
    chunks?: number;
    firstTokenAt?: number;
    finishedAt?: number;
    createdAt?: number;
    operationalError?: OperationalError;
    voiceGuidance?: readonly import('./voice').VoiceGuidance[];
  };
}

/** Bound provider text before retaining it in the private diagnostic metadata. */
export function operationalError(message: string, at: number): OperationalError {
  const detail = message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .replace(/^Error:\s*/, '').replace(/\u0000/g, '').trim();
  return { kind: 'operational-error', message: (detail || 'Failed to get response').slice(0, 4_000),
    at: Number.isFinite(at) ? Math.min(8_640_000_000_000_000, Math.max(0, at)) : 0 };
}

export function normalizeOperationalError(value: unknown): OperationalError | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<OperationalError>;
  if (item.kind !== 'operational-error' || typeof item.message !== 'string' ||
      typeof item.at !== 'number' || !Number.isFinite(item.at) || item.at < 0) return undefined;
  return operationalError(item.message, item.at);
}

const LEGACY_FAILURES = [
  'Failed to get response',
  'The source became unavailable.',
  'The host could not finish this turn. You can retry after reconnecting.',
  'The host restarted before this turn finished. Retry from the current conversation.',
] as const;

/**
 * Older builds appended a failure to assistant prose. Migrate only provenance-backed shapes:
 * a failed placeholder that received zero tokens, or an exact app-authored failure footer.
 * Unknown error prose, tool results and user messages are deliberately left intact.
 */
export function separateOperationalError<T extends OperationalMessage>(message: T): T {
  if (message.role !== 'assistant' || message.meta?.operationalError || !message.meta?.failed) return message;
  let content: string | undefined;
  let detail: string | undefined;
  if (message.meta.chunks === 0 && message.meta.firstTokenAt === undefined && message.content.startsWith('Error: ')) {
    content = '';
    detail = message.content.slice(7);
  } else {
    for (const known of LEGACY_FAILURES) {
      const marker = `Error: ${known}`;
      if (message.content === marker) { content = ''; detail = known; break; }
      if (message.content.endsWith(`\n\n${marker}`)) {
        content = message.content.slice(0, -marker.length - 2); detail = known; break;
      }
    }
  }
  if (content === undefined || detail === undefined) return message;
  return { ...message, content, meta: { ...message.meta,
    operationalError: operationalError(detail, message.meta.finishedAt ?? message.meta.createdAt ?? 0) } };
}

/** Empty diagnostic placeholders remain in the audit but do not consume model context. */
export function isOperationalPlaceholder(message: OperationalMessage): boolean {
  return message.role === 'assistant' && !message.content &&
    (message.meta?.operationalError !== undefined || message.meta?.failed === true);
}

/** Delivered speech is real user content, even if the model failed before writing a word. */
export function hasDeliveredVoiceGuidance(message: OperationalMessage): boolean {
  return message.meta?.voiceGuidance?.some((entry) => entry.status === 'delivered' &&
    typeof entry.text === 'string' && !!entry.text.trim()) === true;
}
