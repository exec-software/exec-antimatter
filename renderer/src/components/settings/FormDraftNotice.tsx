import { useState, useSyncExternalStore } from 'react';
import { downloadFormDraft, formDraftStatus, formDraftVersion, resetFormDraft, retryFormDraft, subscribeFormDrafts } from '../../lib/formDrafts';
import { ConfirmDialog } from '../ConfirmDialog';

/** Storage errors remain visible even when the corresponding form is closed. */
export function FormDraftNotice({ draftKey }: { draftKey: string }) {
  useSyncExternalStore(subscribeFormDrafts, formDraftVersion, formDraftVersion);
  const status = formDraftStatus(draftKey);
  const [error, setError] = useState(''), [reset, setReset] = useState(false);
  if (!status.error) return null;
  const button = 'rounded border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-3';
  const download = () => {
    try {
      const data = downloadFormDraft(draftKey, status.recovery);
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'antimatter-settings-draft-recovery.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not download this draft.'); }
  };
  return <div role="alert" className="space-y-2 rounded border border-warning/40 p-3 text-xs text-warning">
    <p>{status.error}</p>{error && <p>{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} onClick={download}>{status.recovery ? 'Download saved draft' : 'Download draft'}</button>
      {status.recovery ? <button type="button" className={button} onClick={() => setReset(true)}>Reset saved draft</button>
        : <button type="button" className={button} onClick={() => { retryFormDraft(draftKey); setError(''); }}>Retry draft storage</button>}
    </div>
    {reset && <ConfirmDialog title="Reset saved draft storage?" message="This removes the unreadable saved copy. Download it first if you need to recover it. Your current edits stay in this window."
      confirmLabel="Reset saved draft" tone="danger" onCancel={() => setReset(false)} onConfirm={() => { resetFormDraft(draftKey); setReset(false); setError(''); }} />}
  </div>;
}
