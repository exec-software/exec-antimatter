import { useEffect, useState } from 'react';
import { Globe, Image as ImageIcon, LoaderCircle, Plus, X } from 'lucide-react';
import { PreviewPane } from '../../components/chat/PreviewPane';
import { previewIdentity, type ConversationPreview } from '../../lib/conversation';
import type { PreviewImage } from '../../types';
import type { ToolWindowProps } from '../types';
import { usePreviewPanel } from './context';

type PreviewKind = ConversationPreview['kind'];

// This is deliberately the list of working viewers, not a row of disabled future-format tabs.
export const PREVIEW_BROWSERS = [
  { kind: 'page' as const, label: 'Web', icon: Globe },
  { kind: 'image' as const, label: 'Images', icon: ImageIcon },
];

export function previewBrowserItems(
  previews: readonly ConversationPreview[], selected: ConversationPreview | null, kind: PreviewKind
): ConversationPreview[] {
  const seen = new Set<string>();
  return [...(selected ? [selected] : []), ...previews].filter((preview) => {
    const key = previewIdentity(preview);
    if (preview.kind !== kind || !preview.target || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const newWebPreview = (): ConversationPreview => ({
  id: crypto.randomUUID(), at: Date.now(), kind: 'page', target: '', title: 'Web preview',
});

function Thumbnail({ preview, workspace }: { preview: ConversationPreview; workspace: string | null }) {
  const [image, setImage] = useState<PreviewImage | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setImage(null);
    setFailed(false);
    window.electronAPI.preview.image(preview.target, preview.workspace, true).then(
      (loaded) => { if (!cancelled) setImage(loaded); },
      () => { if (!cancelled) setFailed(true); }
    );
    return () => { cancelled = true; };
  }, [preview.id, preview.target, preview.workspace, workspace]);
  return image && !failed
    ? <img src={image.dataUrl} alt="" draggable={false} className="h-full w-full object-cover" onError={() => setFailed(true)} />
    : failed
      ? <ImageIcon size={18} className="text-ink-3" aria-label="Thumbnail unavailable" />
      : <LoaderCircle size={16} className="animate-spin text-ink-3" aria-label="Loading thumbnail" />;
}

/** The tool-window frame supplies the heading and close/dock controls; this is only its content. */
export function PreviewPanel({ visible = true }: Partial<ToolWindowProps>) {
  const { conversationId, workspace } = usePreviewPanel();
  return <PreviewBrowser key={`${conversationId ?? 'new-conversation'}\u0000${workspace ?? ''}`} visible={visible} />;
}

function PreviewBrowser({ visible }: { visible: boolean }) {
  const { selected, previews, workspace, onSelect, onClear, suspended } = usePreviewPanel();
  const selectedKey = selected ? previewIdentity(selected) : null;
  const [browser, setBrowser] = useState({ selectedKey, kind: selected?.kind ?? 'page' as PreviewKind });
  // Switch formats in the same render as an external selection. An effect-only tab update would
  // briefly mount an empty web viewer between two selected formats and close the browser twice.
  const kind = selected && selectedKey !== browser.selectedKey ? selected.kind : browser.kind;
  useEffect(() => { setBrowser({ selectedKey, kind }); }, [selectedKey, kind]);
  const items = previewBrowserItems(previews, selected, kind);
  const current = selected?.kind === kind ? selected : null;

  // A hidden tool window must unmount the real viewer. PagePreview immediately clears native
  // bounds and destroys its isolated browser; an offscreen WebContentsView cannot cover chat.
  if (!visible) return null;

  const selectKind = (next: PreviewKind) => {
    setBrowser({ selectedKey, kind: next });
    if (selected?.kind === next) return;
    const previous = previewBrowserItems(previews, selected, next)[0];
    if (previous) onSelect(previous);
    else if (next === 'page') onSelect(newWebPreview());
  };

  return <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface-1" aria-label="Preview browser">
    <div className="flex shrink-0 items-center gap-1 border-b border-line-soft px-2 py-1.5">
      <div role="tablist" aria-label="Preview types" className="flex min-w-0 flex-1 items-center gap-1">
        {PREVIEW_BROWSERS.map(({ kind: candidate, label, icon: Icon }) => <button
          key={candidate} type="button" role="tab" aria-selected={kind === candidate}
          aria-controls="preview-browser-content" id={`preview-browser-${candidate}`}
          tabIndex={kind === candidate ? 0 : -1}
          onClick={() => selectKind(candidate)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'page' : event.key === 'End' ? 'image' : kind === 'page' ? 'image' : 'page';
            selectKind(next);
            document.getElementById(`preview-browser-${next}`)?.focus();
          }}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${kind === candidate ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:bg-surface-3/60 hover:text-ink-2'}`}
        ><Icon size={13} aria-hidden="true" />{label}</button>)}
      </div>
      {kind === 'page' && <button type="button" onClick={() => onSelect(newWebPreview())}
        aria-label="Open another website" title="Open another website"
        className="flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
      ><Plus size={14} /></button>}
      {current && <button type="button" onClick={onClear} aria-label="Clear selected preview" title="Clear selected preview"
        className="flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
      ><X size={13} /></button>}
    </div>
    {items.length > 0 && <div className="shrink-0 border-b border-line-soft px-2 py-2">
      <select aria-label={kind === 'page' ? 'Recent web previews' : 'Conversation images'}
        value={current?.target ? previewIdentity(current) : ''}
        onChange={(event) => { const next = items.find((preview) => previewIdentity(preview) === event.target.value); if (next) onSelect(next); }}
        className="w-full min-w-0 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink-2 outline-none focus:border-primary/60"
      >
        <option value="" disabled>{kind === 'page' ? 'Recent web previews' : 'Choose an image'}</option>
        {items.map((preview) => <option key={previewIdentity(preview)} value={previewIdentity(preview)}>{preview.title} · {preview.target}</option>)}
      </select>
      {kind === 'image' && <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1" aria-label="Image thumbnails">
        {items.slice(0, 24).map((preview) => <button key={previewIdentity(preview)} type="button"
          onClick={() => onSelect(preview)} aria-label={`View image: ${preview.title}`} title={preview.target}
          aria-pressed={previewIdentity(preview) === selectedKey}
          className={`flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded border bg-surface-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${previewIdentity(preview) === selectedKey ? 'border-primary/70' : 'border-line-soft hover:border-line'}`}
        ><Thumbnail preview={preview} workspace={workspace} /></button>)}
      </div>}
    </div>}
    <div id="preview-browser-content" role="tabpanel" aria-labelledby={`preview-browser-${kind}`} className="min-h-0 min-w-0 flex-1">
      {current ? <PreviewPane key={`${current.id}:${previewIdentity(current)}`} preview={current} embedded suspended={suspended} /> : kind === 'page'
        ? <PreviewPane key="empty-web" preview={{ id: 'empty-web', at: 0, kind: 'page', target: '', title: 'Web preview' }} embedded suspended={suspended} />
        : <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <ImageIcon size={28} className="text-ink-3" aria-hidden="true" />
          <h2 className="text-sm font-medium text-ink">{items.length ? 'Choose an image' : 'No images yet'}</h2>
          <p className="max-w-sm text-xs leading-5 text-ink-3">{items.length ? 'Select a thumbnail above to inspect it at full size.' : 'Images and screenshots shown in this conversation appear here. Ask the agent to preview an image from your workspace.'}</p>
        </div>}
    </div>
  </div>;
}
