import type { LibraryEntry } from '../api/pensieveLibrary';

/** Original public templates; no private training material or project examples are bundled. */
export const PENSIEVE_CATALOG: readonly LibraryEntry[] = [
  {
    id: 'shipped:workspace-note', title: 'Workspace note', kind: 'schema', language: 'shared',
    origin: 'shipped', scope: 'global', enabled: true, updatedAt: null,
    content: JSON.stringify({ type: 'object', required: ['title', 'context', 'guidance'], properties: {
      title: { type: 'string' }, context: { type: 'string', description: 'When this note applies.' },
      guidance: { type: 'string', description: 'Advice from the author; not a verified tool result.' },
      sources: { type: 'array', items: { type: 'string' } },
    }, additionalProperties: false }, null, 2),
  },
  {
    id: 'shipped:verification-record', title: 'Verification record', kind: 'schema', language: 'shared',
    origin: 'shipped', scope: 'global', enabled: true, updatedAt: null,
    content: JSON.stringify({ type: 'object', required: ['command', 'outcome', 'revision'], properties: {
      command: { type: 'string' }, outcome: { enum: ['passed', 'failed', 'not-run'] },
      revision: { type: 'string', description: 'Source revision or hash that was actually checked.' },
      environment: { type: 'string' }, details: { type: 'string' },
    }, additionalProperties: false }, null, 2),
  },
];
