import { useEffect, useState } from 'react';
import { AlertTriangle, Globe, Image as ImageIcon, LoaderCircle } from 'lucide-react';
import { previewIdentity, type ConversationPreview } from '../../lib/conversation';
import type { PreviewImage } from '../../types';
import { useConversationUi } from './conversationUi';

interface Props {
  previews: readonly ConversationPreview[];
  limit: number;
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
  onOpenPreview(preview: ConversationPreview): void;
  openPreviewIdentity: string | null;
}

type ImageState =
  | { status: 'loading' }
  | { status: 'loaded'; image: PreviewImage }
  | { status: 'error'; message: string };

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(Error:\s*)?/,
    ''
  );

/** A thumbnail owns one request, so success or failure cannot retrigger the effect. */
function ImageThumbnail({ path, title, workspace }: { path: string; title: string; workspace?: string }) {
  const { activeWorkspace } = useConversationUi();
  const [state, setState] = useState<ImageState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    window.electronAPI.preview
      .image(path, workspace, true)
      .then((image) => {
        if (!cancelled) setState({ status: 'loaded', image });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: messageOf(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, workspace, activeWorkspace]);

  if (state.status === 'loaded') {
    return (
      <img
        src={state.image.dataUrl}
        alt=""
        draggable={false}
        className="h-full w-full object-cover"
        onError={() => setState({ status: 'error', message: `Could not display ${title}.` })}
      />
    );
  }

  if (state.status === 'error') {
    return (
      <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-danger" title={state.message}>
        <AlertTriangle size={16} aria-hidden="true" />
        <span className="max-w-full truncate text-[10px]">Unavailable</span>
      </span>
    );
  }

  return (
    <span className="flex h-full w-full items-center justify-center text-ink-3" aria-label={`Loading ${title}`}>
      <LoaderCircle size={17} className="animate-spin" aria-hidden="true" />
    </span>
  );
}

function PreviewTile({
  preview,
  open,
  onOpen,
}: {
  preview: ConversationPreview;
  open: boolean;
  onOpen(): void;
}) {
  const Icon = preview.kind === 'page' ? Globe : ImageIcon;

  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-current={open ? 'true' : undefined}
        aria-label={`Open preview: ${preview.title}`}
        title={preview.target}
        className={`group flex w-full min-w-0 flex-col overflow-hidden rounded-md border text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${
          open
            ? 'border-accent/60 bg-surface-3/80'
            : 'border-line-soft bg-surface-1/40 hover:border-line hover:bg-surface-3/50'
        }`}
      >
        <span className="relative block aspect-[4/3] w-full overflow-hidden bg-surface-0">
          {preview.kind === 'image' ? (
            <ImageThumbnail path={preview.target} title={preview.title} workspace={preview.workspace} />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-ink-3">
              <Globe size={22} aria-hidden="true" />
            </span>
          )}
          <span
            className={`absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded bg-surface-2/90 ${
              open ? 'text-accent' : 'text-ink-3'
            }`}
          >
            <Icon size={12} aria-hidden="true" />
          </span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 border-t border-line-soft px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">{preview.title}</span>
          {open && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Open" />}
        </span>
      </button>
    </li>
  );
}

/** Compact gallery for the narrow conversation rail; the full preview opens over the transcript. */
export function PreviewGrid({
  previews,
  limit,
  expanded,
  onExpandedChange,
  onOpenPreview,
  openPreviewIdentity,
}: Props) {
  const visible = expanded ? previews : previews.slice(0, limit);
  const hidden = previews.length - limit;

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenPreview({ id: crypto.randomUUID(), at: Date.now(), kind: 'page', target: '', title: 'Web preview' })}
        className="mb-2 flex w-full items-center justify-center gap-2 rounded-md border border-line px-2 py-1.5 text-xs text-ink-2 transition hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
      >
        <Globe size={13} aria-hidden="true" />
        Open website
      </button>
      {previews.length === 0 && <p className="text-xs leading-5 text-ink-3">Open a website or local development server above. Images and pages from this conversation also appear here.</p>}
      <ul className="grid grid-cols-2 gap-1.5">
        {visible.map((preview) => (
          <PreviewTile
            // The list is deduplicated on this exact identity, so it is also a guaranteed-unique
            // React key even for legacy rows whose provider call ids were reused.
            key={previewIdentity(preview)}
            preview={preview}
            open={previewIdentity(preview) === openPreviewIdentity}
            onOpen={() => onOpenPreview(preview)}
          />
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => onExpandedChange(!expanded)}
          aria-expanded={expanded}
          className="mt-1 rounded px-1 py-0.5 text-[12px] text-ink-3 transition hover:bg-surface-3/70 hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
        >
          {expanded ? 'Show fewer' : `${hidden} more`}
        </button>
      )}
    </>
  );
}
