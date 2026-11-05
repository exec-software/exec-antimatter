import { useEffect, useState } from 'react';
import { AlertTriangle, Maximize2 } from 'lucide-react';
import type { PreviewImage } from '../../types';
import { useConversationUi } from './conversationUi';

interface Props {
  /** Workspace-relative path of the image the call showed. */
  path: string;
  title: string;
  workspace?: string;
}

/**
 * A picture, in the conversation, where the call that made it happened.
 *
 * This is the whole point of the preview tools: a model that says "I have written chart.png" has
 * told you nothing you can check, and one that shows you the chart has. So the image is drawn in
 * the transcript rather than only listed in the section beside it, small enough to read past and
 * large enough to see, and a click opens it full size.
 *
 * The pixels are fetched by path rather than carried in the transcript. A screenshot is a
 * megabyte; the conversation it illustrates is a few kilobytes, and putting the one inside the
 * other would mean carrying it into the carbon and the model's next prompt as well.
 */
const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(Error:\s*)?/,
    ''
  );

export function InlineImage({ path, title, workspace }: Props) {
  const { activeWorkspace, openPreview } = useConversationUi();
  const [image, setImage] = useState<PreviewImage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setImage(null);
    setError('');
    window.electronAPI.preview
      .image(path, workspace, true)
      .then((loaded) => {
        if (!cancelled) setImage(loaded);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(messageOf(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [path, workspace, activeWorkspace]);

  if (error) {
    return (
      <p className="ml-6 mt-1.5 flex max-w-md items-center gap-1.5 text-[11px] text-ink-3" title={error}>
        <AlertTriangle size={13} className="shrink-0 text-danger" aria-hidden="true" />
        Preview unavailable
      </p>
    );
  }

  return (
    <div className="ml-6 mt-1.5">
      <button
        type="button"
        onClick={() => openPreview({ kind: 'image', target: path, title, workspace })}
        aria-label={`Open ${title} full size`}
        title={`${path}${image ? ` · ${image.width}×${image.height}` : ''}`}
        className="group relative block max-w-md overflow-hidden rounded-lg border border-line bg-surface-0 transition hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
      >
        {image ? (
          <img src={image.dataUrl} alt={title} className="block max-h-72 w-auto max-w-full object-contain" />
        ) : (
          // Holds the row's height steady while the pixels arrive, so the transcript does not
          // jump under someone who is reading it.
          <span className="flex h-32 w-64 items-center justify-center text-[12px] text-ink-3">Loading…</span>
        )}
        <span
          aria-hidden="true"
          className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md bg-surface-0/80 text-ink-3 opacity-0 backdrop-blur transition group-hover:opacity-100"
        >
          <Maximize2 size={13} />
        </span>
      </button>
    </div>
  );
}
