import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from 'lucide-react';
import type { ConversationPreview } from '../../lib/conversation';
import { previewAddress, previewFailureAdvice } from '../../lib/previewNavigation';
import type { PreviewImage, PreviewPageState } from '../../types';
import { useConversationUi } from './conversationUi';

interface Props {
  preview: ConversationPreview;
  onClose?(): void;
  /** The tool-window shell owns the border, title bar, and close button. */
  embedded?: boolean;
  /** Temporarily hide the native browser while another surface needs to cover it. */
  suspended?: boolean;
}

/**
 * A web or image viewer, embedded in the Preview tool window or in a standalone frame.
 *
 * Images and pages are drawn by two different things and only one of them is React. An image is
 * fetched by path and drawn here; a page is a `WebContentsView` the main process owns, because a
 * renderer cannot host a browser engine, and all this does for one is measure the hole it should
 * be laid over and say where that is. That is why the page branch renders an empty box: the
 * pixels in it belong to another process.
 */
// Explicit adapters are the extension seam. Adding audio, code, or a 3D viewer means adding its
// actual renderer here and a matching preview kind; unsupported content never falls into Image.
const viewers = {
  page: ({ preview, ...props }: Props) => <PagePreview url={preview.target} title={preview.title} {...props} />,
  image: ({ preview, ...props }: Props) => <ImagePreview path={preview.target} title={preview.title} workspace={preview.workspace} {...props} />,
};

export function PreviewPane(props: Props) {
  const Viewer = viewers[props.preview.kind];
  return Viewer ? <Viewer {...props} /> : <p role="alert" className="p-4 text-xs text-ink-3">This preview format is not supported yet.</p>;
}

function Frame({
  title,
  subtitle,
  controls,
  children,
  onClose,
  embedded = false,
  hideHeader = false,
}: {
  title: string;
  subtitle: string;
  controls?: React.ReactNode;
  children: React.ReactNode;
  onClose?(): void;
  embedded?: boolean;
  hideHeader?: boolean;
}) {
  return (
    <section
      aria-label={`Preview: ${title}`}
      data-preview-surface="true"
      className={`pointer-events-auto flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden ${embedded ? 'bg-surface-1' : 'rounded-2xl border border-line bg-surface-2/95 shadow-xl shadow-black/40 backdrop-blur'}`}
    >
      {!hideHeader && <header className="flex min-w-0 shrink-0 items-center gap-2 border-b border-line-soft px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{title}</span>
          <span className="block truncate text-[11px] text-ink-3">{subtitle}</span>
        </span>
        {controls}
        {!embedded && onClose && <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          title="Close preview"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
        >
          <X size={15} />
        </button>}
      </header>}
      {children}
    </section>
  );
}

const IconButton = ({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={label}
    className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-3 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
  >
    {children}
  </button>
);

const kilobytes = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(Error:\s*)?/,
    ''
  );

function ImagePreview({
  path,
  title,
  workspace,
  onClose,
  embedded,
}: {
  path: string;
  title: string;
  workspace?: string;
  onClose?(): void;
  embedded?: boolean;
}) {
  const { activeWorkspace } = useConversationUi();
  const [image, setImage] = useState<PreviewImage | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setImage(null);
    setError('');
    window.electronAPI.preview
      .image(path, workspace)
      .then((loaded) => {
        if (!cancelled) setImage(loaded);
      })
      .catch((failure: Error) => {
        if (!cancelled) setError(messageOf(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [path, workspace, activeWorkspace, revision]);

  const subtitle = image ? `${path} · ${image.width}×${image.height} · ${kilobytes(image.bytes)}` : path;

  return (
    <Frame
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      embedded={embedded}
      controls={
        <IconButton label="Reload image" onClick={() => setRevision((value) => value + 1)}>
          <RotateCw size={14} />
        </IconButton>
      }
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-0 p-3">
        {error ? (
          <div className="flex max-w-md flex-col items-center gap-3 text-center">
            <p role="alert" className="text-[13px] leading-6 text-danger">{error}</p>
            <button
              type="button"
              onClick={() => setRevision((value) => value + 1)}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              Try again
            </button>
          </div>
        ) : image ? (
          <img
            src={image.dataUrl}
            alt={title}
            className="max-h-full max-w-full object-contain"
            style={{ imageRendering: 'auto' }}
            onError={() => {
              setImage(null);
              setError(`Could not display ${title}.`);
            }}
          />
        ) : (
          <p className="text-[13px] text-ink-3">Loading…</p>
        )}
      </div>
    </Frame>
  );
}

function PagePreview({ url, title, onClose, embedded, suspended = false }: {
  url: string; title: string; onClose?(): void; embedded?: boolean; suspended?: boolean;
}) {
  const hole = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<PreviewPageState | null>(null);
  const [error, setError] = useState('');
  const [address, setAddress] = useState(url);
  const [addressError, setAddressError] = useState('');
  const [target, setTarget] = useState(url);
  const [revision, setRevision] = useState(0);
  const failure = error || state?.error || '';
  const canShow = useRef(false);
  canShow.current = !suspended && !failure;
  const reportBounds = (element: HTMLElement) => {
    if (canShow.current) reportPageBounds(element);
    else window.electronAPI.preview.bounds(null);
  };

  useEffect(() => window.electronAPI.onPreviewPage(setState), []);

  useEffect(() => {
    // Navigation should update the address, but never overwrite an address the person is typing.
    if (state?.url && document.activeElement !== addressInput.current) setAddress(state.url);
  }, [state?.url]);

  useEffect(() => {
    let cancelled = false;
    setError('');
    setState(null);
    if (!target) return;
    window.electronAPI.preview
      .openPage(target)
      .then(() => {
        // A keyed page switch unmounts the old pane before mounting this one. Its close request
        // can clear the rectangle the new layout effect just sent, so confirm it after open.
        const element = hole.current;
        if (!cancelled && element) reportBounds(element);
      })
      .catch((failure: Error) => {
        if (!cancelled) {
          setError(messageOf(failure));
          // A rejected IPC navigation never emits page state. Hide any previous native page so
          // it cannot sit over the useful error/retry UI.
          window.electronAPI.preview.bounds(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [target, revision]);

  /**
   * Where the page should be drawn, in window coordinates.
   *
   * Sent on every layout change and on unmount, because the view is a sibling of the whole
   * window rather than a child of this element: nothing moves it when the pane moves, and a
   * page left at the last rectangle it was told about would hang over the transcript after the
   * pane had closed. `null` is what puts it away.
   */
  useLayoutEffect(() => {
    const element = hole.current;
    if (!element || !target) return;

    const report = () => {
      reportBounds(element);
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener('resize', report);
    document.addEventListener('visibilitychange', report);
    // The pane can move without changing size — the panel opening beside it does exactly that —
    // and nothing fires for that, so the position is re-read each frame the layout might settle.
    const settle = window.setInterval(report, 250);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      document.removeEventListener('visibilitychange', report);
      window.clearInterval(settle);
      window.electronAPI.preview.bounds(null);
    };
  }, [target, failure, suspended]);

  // The bounds cleanup hides the native surface immediately; this then tears its isolated page
  // process down rather than leaving it running behind the transcript.
  useEffect(() => () => {
    // The window/IPC connection may already be closing during application teardown.
    void window.electronAPI.preview.closePage().catch(() => undefined);
  }, []);

  const reloadPage = async () => {
    setError('');
    try {
      if (state) await window.electronAPI.preview.reload();
      else await window.electronAPI.preview.openPage(target);
      const element = hole.current;
      if (element) reportBounds(element);
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const navigate = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const next = previewAddress(address);
      setAddressError('');
      setAddress(next);
      setTarget(next);
      // Submitting the same address is a deliberate retry too.
      setRevision((value) => value + 1);
      addressInput.current?.blur();
    } catch (failure) {
      setAddressError(messageOf(failure));
    }
  };

  const travel = async (direction: 'back' | 'forward') => {
    setError('');
    try {
      await window.electronAPI.preview[direction]();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const controls = <>
          <IconButton label="Back" onClick={() => void travel('back')} disabled={!state?.canGoBack}>
            <ArrowLeft size={14} />
          </IconButton>
          <IconButton
            label="Forward"
            onClick={() => void travel('forward')}
            disabled={!state?.canGoForward}
          >
            <ArrowRight size={14} />
          </IconButton>
          <IconButton label="Reload" onClick={() => void reloadPage()} disabled={!target}>
            <RotateCw size={14} className={state?.loading ? 'animate-spin' : undefined} />
          </IconButton>
          {/*
            An anchor rather than a button: the window's open handler is what sends a link to the
            real browser, and it only sees links. There is no openExternal on the preload API and
            adding one would be a second, wider way to do what this already does safely.
          */}
          {(state?.url || target) && (
            <a
              href={state?.url || target}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Open in the browser"
              title="Open in the browser"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              <ExternalLink size={14} />
            </a>
          )}
        </>;

  return (
    <Frame
      title={state?.title || title}
      subtitle={state?.url || target || 'Websites and local development servers'}
      onClose={onClose}
      embedded={embedded}
      hideHeader={embedded}
      controls={controls}
    >
      <form onSubmit={navigate} className="shrink-0 border-b border-line-soft p-2">
        <div className="flex min-w-0 items-center gap-1">
        {embedded && controls}
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface-0 px-2">
          <Globe size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
          <input
            ref={addressInput}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setAddressError('');
            }}
            aria-label="Preview address"
            aria-invalid={!!addressError}
            placeholder="http://localhost:5173 or https://example.com"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            autoFocus={!url}
            className="min-w-0 flex-1 bg-transparent py-2 text-xs text-ink outline-none placeholder:text-ink-3"
          />
          <button type="submit" className="shrink-0 rounded px-2 py-1 text-xs text-ink-2 transition hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70">Go</button>
        </div>
        </div>
        {addressError && <p role="alert" className="mt-1 px-1 text-xs text-danger">{addressError}</p>}
      </form>
      <div className="relative min-h-0 flex-1 bg-surface-0" aria-busy={state?.loading || undefined}>
        {target && <div ref={hole} className="absolute inset-0" />}
        {!target ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <Globe size={28} className="text-ink-3" aria-hidden="true" />
            <h2 className="text-sm font-medium text-ink">Open a web preview</h2>
            <p className="max-w-md text-xs leading-5 text-ink-3">Enter a website or the address of a running development server. For Electron apps, use the renderer’s development-server URL. This sandboxed preview cannot access Antimatter’s desktop APIs.</p>
          </div>
        ) : failure && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6">
            <p role="alert" className="max-w-md text-center text-[13px] leading-6 text-danger">
              {failure}
            </p>
            <p className="max-w-md text-center text-xs leading-5 text-ink-3">{previewFailureAdvice(state?.url || target)}</p>
            <button
              type="button"
              onClick={() => void reloadPage()}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              Try again
            </button>
          </div>
        )}
      </div>
      <div role="status" className="shrink-0 border-t border-line-soft px-3 py-1 text-[10px] text-ink-3">
        {!target ? 'Ready' : failure ? 'Page unavailable' : !state || state.loading ? 'Loading page…' : 'Sandboxed web preview · separate browser session'}
      </div>
    </Frame>
  );
}

/** Native views sit above renderer DOM; hide them wherever an app window/dialog would cover it. */
export function previewRectanglesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 &&
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function isPageOccluded(element: HTMLElement, box: DOMRect): boolean {
  const ownFloat = element.closest('[data-floating-tool]');
  return [...document.querySelectorAll<HTMLElement>('[data-floating-tool], [data-preview-occluder="true"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], dialog[open]')].some((surface) => {
    if (surface === ownFloat || surface.contains(element)) return false;
    const style = window.getComputedStyle(surface);
    if (surface.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    // A modal's backdrop covers the whole app even when the dialog card is beside this pane.
    if (surface.getAttribute('aria-modal') === 'true') return true;
    if (ownFloat && surface.hasAttribute('data-floating-tool') &&
      Number(style.zIndex) < Number(window.getComputedStyle(ownFloat).zIndex)) return false;
    return previewRectanglesOverlap(box, surface.getBoundingClientRect());
  });
}

function reportPageBounds(element: HTMLElement): void {
  const box = element.getBoundingClientRect();
  window.electronAPI.preview.bounds(
    document.visibilityState === 'hidden' || box.width < 1 || box.height < 1 || isPageOccluded(element, box)
      ? null
      : { x: box.x, y: box.y, width: box.width, height: box.height }
  );
}
