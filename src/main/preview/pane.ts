import {
  WebContentsView,
  type BrowserWindow,
  type Rectangle,
  type Session,
} from 'electron';
import { isCurrentNavigationFailure, navigateHistory } from './navigation';
import {
  bindPreviewClientCertificateDenial,
  nextPreviewPartition,
  preventPageWindowMutation,
  retirePreviewSession,
} from './session';
import { boundedPreviewRectangle } from './targets';

/**
 * The live web page in the Preview pane.
 *
 * A page has to be rendered by a real browser engine, and the renderer cannot host one: an
 * iframe would be blocked by every site that sets frame-ancestors, and a `<webview>` tag costs
 * turning `webviewTag` on for the whole window. So the page is its own `WebContentsView`, owned
 * by the main process, laid over the area the renderer says the pane occupies.
 *
 * It is one view, reused. Previewing a second page navigates the first rather than accumulating
 * browser processes behind a panel nobody has open.
 *
 * Nothing of Antimatter is reachable from inside it. No preload, no node integration, an isolated
 * context, its own session partition, and navigation is confined to http and https. Page-created
 * windows and dialogs are denied; the app-owned toolbar is the explicit way out to the browser.
 */

let view: WebContentsView | null = null;
let attachedTo: BrowserWindow | null = null;
let current = '';
let requestedBounds: Rectangle | null = null;
let loading = false;
let pageError: string | null = null;
let navigationGeneration = 0;
let navigationUrls = new Map<string, number>();

/**
 * What the page said, so the model can read its own bug instead of guessing.
 *
 * Bounded, and dropped when a new page starts: these are the current page's diagnostics, not a
 * log. A model that opened a preview and reported the page fine had no way to see the error the
 * page was already printing. This is that way.
 */
export interface ConsoleLine {
  level: 'debug' | 'info' | 'warning' | 'error';
  text: string;
  source?: string;
  line?: number;
  at: number;
}
const CONSOLE_LIMIT = 200;
let consoleLines: ConsoleLine[] = [];
const LEVELS: ConsoleLine['level'][] = ['debug', 'info', 'warning', 'error'];

export interface PaneState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Set when the page itself failed, rather than when there is no page. */
  error: string | null;
}

type Listener = (state: PaneState) => void;
let listener: Listener | null = null;

export const onChange = (next: Listener | null): void => {
  listener = next;
};

const state = (): PaneState => {
  const contents = view && !view.webContents.isDestroyed() ? view.webContents : null;
  return {
    url: current,
    title: contents?.getTitle() ?? '',
    loading,
    canGoBack: contents?.navigationHistory.canGoBack() ?? false,
    canGoForward: contents?.navigationHistory.canGoForward() ?? false,
    error: pageError,
  };
};

const announce = (): void => listener?.(state());

const beginNavigation = (url: string): number => {
  current = url;
  loading = true;
  pageError = null;
  const generation = ++navigationGeneration;
  navigationUrls = new Map([[url, generation]]);
  place();
  announce();
  return generation;
};

const protectedSessions = new WeakSet<Session>();

/** A previewed site never gets ambient OS capabilities or a route for downloading files. */
function protect(pageSession: Session): void {
  if (protectedSessions.has(pageSession)) return;
  protectedSessions.add(pageSession);
  pageSession.setPermissionCheckHandler(() => false);
  pageSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  pageSession.on('will-download', (event) => event.preventDefault());
}

/** Native child views ignore DOM clipping, so visibility and clipping stay main-process owned. */
function place(): void {
  if (!view || view.webContents.isDestroyed()) return;
  const window = attachedTo;
  if (!window || window.isDestroyed() || !requestedBounds || pageError) {
    view.setVisible(false);
    return;
  }
  const [width, height] = window.getContentSize();
  // BrowserWindow child-view bounds are in display-independent pixels. DOM measurements match
  // them at the default zoom; when the app renderer is zoomed, one CSS pixel occupies `zoom`
  // DIPs, so scale the measured hole to keep the native page attached to it.
  const zoom = window.webContents.getZoomFactor();
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const bounded = boundedPreviewRectangle(
    {
      x: requestedBounds.x * scale,
      y: requestedBounds.y * scale,
      width: requestedBounds.width * scale,
      height: requestedBounds.height * scale,
    },
    { width, height }
  );
  if (!bounded) {
    view.setVisible(false);
    return;
  }
  view.setBounds(bounded);
  view.setVisible(true);
}

function failed(message: string, url = current): void {
  loading = false;
  if (url) current = url;
  pageError = message;
  place();
  announce();
}

function build(window: BrowserWindow): WebContentsView {
  const created = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      disableDialogs: true,
      // Its own in-memory jar. A preview never sees a cookie or login from the application or
      // the person's normal browser, and nothing in it survives an application restart.
      partition: nextPreviewPartition(),
    },
  });

  created.setBackgroundColor('#141414');
  const contents = created.webContents;
  protect(contents.session);
  const active = () => view === created;
  // window.moveTo/resizeTo defaults to mutating the owner BrowserWindow, even for a child view.
  contents.on('content-bounds-updated', preventPageWindowMutation);
  bindPreviewClientCertificateDenial(contents);
  // A remote page cannot make the operating system open windows. The trusted main renderer's
  // toolbar remains the one deliberate route to a real browser.
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Electron has moved this signature between majors; accept either shape rather than
  // silently recording nothing after an upgrade.
  contents.on('console-message', (...args: unknown[]) => {
    if (!active()) return;
    const detail = args[1] && typeof args[1] === 'object' ? (args[1] as Record<string, unknown>) : null;
    const rawLevel = detail ? detail.level : args[1];
    const level =
      typeof rawLevel === 'number'
        ? LEVELS[rawLevel] ?? 'info'
        : LEVELS.includes(rawLevel as ConsoleLine['level'])
          ? (rawLevel as ConsoleLine['level'])
          : 'info';
    const message = detail ? detail.message : args[2];
    const sourceId = detail ? detail.sourceId : args[4];
    const lineNumber = detail ? detail.lineNumber : args[3];
    consoleLines.push({
      level,
      text: String(message ?? '').slice(0, 2000),
      ...(typeof sourceId === 'string' && sourceId ? { source: sourceId } : {}),
      ...(typeof lineNumber === 'number' ? { line: lineNumber } : {}),
      at: Date.now(),
    });
    if (consoleLines.length > CONSOLE_LIMIT) consoleLines = consoleLines.slice(-CONSOLE_LIMIT);
  });
  // A load that failed outright never reaches console-message, and is the thing most worth
  // reporting when a page looks blank.
  contents.on('did-fail-load', (_event, code, description, failedUrl) => {
    if (!active() || code === -3) return; // -3 is an aborted navigation, not a failure
    consoleLines.push({ level: 'error', text: `load failed (${code}) ${description} ${failedUrl}`, at: Date.now() });
  });

  created.webContents.on('will-navigate', (event) => {
    const url = event.url;
    if (!active()) {
      event.preventDefault();
      return;
    }
    if (!/^https?:$/.test(safeProtocol(url))) {
      event.preventDefault();
      return;
    }
    // `will-navigate` is for page/user initiated navigation, not loadURL(). Mark it as a new
    // generation so the promise from the page's original load cannot report over this one.
    beginNavigation(url);
  });
  created.webContents.on('will-redirect', (event) => {
    const url = event.url;
    if (!active()) {
      event.preventDefault();
      return;
    }
    if (!/^https?:$/.test(safeProtocol(url))) {
      event.preventDefault();
      return;
    }
    current = url;
    navigationUrls.set(url, navigationGeneration);
  });
  created.webContents.on('did-start-loading', () => {
    // The buffer describes the page on screen; a new load starts a new page.
    consoleLines = [];
    if (!active()) return;
    loading = true;
    pageError = null;
    place();
    announce();
  });
  created.webContents.on('did-navigate', (_event, url) => {
    if (!active()) return;
    current = url || current;
    if (url) navigationUrls.set(url, navigationGeneration);
    announce();
  });
  created.webContents.on('did-navigate-in-page', (_event, url) => {
    if (!active()) return;
    current = url || current;
    if (url) navigationUrls.set(url, navigationGeneration);
    announce();
  });
  created.webContents.on('page-title-updated', () => {
    if (active()) announce();
  });
  created.webContents.on('did-stop-loading', () => {
    if (!active()) return;
    current = created.webContents.getURL() || current;
    loading = false;
    // Keep a main-frame failure through did-stop-loading. Chromium emits both events for a
    // failed navigation, and clearing it here used to replace the useful error with a blank box.
    place();
    announce();
  });
  created.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!active()) return;
    if (
      !isCurrentNavigationFailure({
        activeGeneration: navigationGeneration,
        failureGeneration: navigationUrls.get(url),
        currentUrl: current,
        failedUrl: url,
        isMainFrame,
        errorCode: code,
      })
    ) {
      return;
    }
    failed(`${description || 'The page could not be loaded'} (${url})`, url);
  });
  created.webContents.on('render-process-gone', (_event, details) => {
    if (active()) failed(`The page process stopped: ${details.reason}. Reload to try again.`);
  });

  window.contentView.addChildView(created);
  attachedTo = window;
  return created;
}

const safeProtocol = (url: string): string => {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
};

/** Opens a page, building the view on first use. The caller has already vetted the URL. */
export function open(window: BrowserWindow, url: string): void {
  if (!view || view.webContents.isDestroyed() || attachedTo !== window) {
    close();
    view = build(window);
  }
  current = url;
  const generation = beginNavigation(url);
  const opened = view;
  void opened.webContents.loadURL(url).catch((error) => {
    // did-fail-load normally supplied the useful URL and Chromium description already. This is
    // the fallback for failures that happen before navigation starts; never let an old request
    // overwrite the state of a replacement view.
    if (view === opened && navigationGeneration === generation && current === url && !pageError) {
      failed((error as Error).message, url);
    }
  });
}

/**
 * Where the pane is, in window coordinates.
 *
 * The renderer measures it, because the renderer is what lays it out — a main process that tried
 * to work out where a flex child ended up would be guessing at a number the DOM already knows.
 * A zero-sized rectangle means the pane is closed, and the view is taken off screen rather than
 * destroyed so that going back to it does not reload the page.
 */
export function setBounds(bounds: Rectangle | null): void {
  requestedBounds = bounds;
  place();
}

export function goBack(): void {
  if (view && !view.webContents.isDestroyed() && view.webContents.navigationHistory.canGoBack()) {
    const history = view.webContents.navigationHistory;
    navigateHistory(history, 'back', beginNavigation);
  }
}

export function goForward(): void {
  if (view && !view.webContents.isDestroyed() && view.webContents.navigationHistory.canGoForward()) {
    const history = view.webContents.navigationHistory;
    navigateHistory(history, 'forward', beginNavigation);
  }
}

export function reload(): void {
  if (!view || view.webContents.isDestroyed()) return;
  pageError = null;
  loading = true;
  place();
  announce();
  // After a failed provisional load, reload() can reload Chromium's error document instead of
  // the address the user asked for. loadURL is unambiguous and gives the pane a real retry.
  const url = current;
  if (url) {
    const generation = beginNavigation(url);
    const reloading = view;
    void reloading.webContents.loadURL(url).catch((error) => {
      if (view === reloading && navigationGeneration === generation && current === url && !pageError) {
        failed((error as Error).message, url);
      }
    });
  } else {
    view.webContents.reload();
  }
}

/** Tears the page down. Called when the pane is closed for good, and when the window goes. */
export function close(): void {
  const going = view;
  const owner = attachedTo;
  view = null;
  attachedTo = null;
  current = '';
  navigationGeneration += 1;
  navigationUrls.clear();
  requestedBounds = null;
  loading = false;
  pageError = null;
  if (!going) return;
  const retiredSession = going.webContents.session;
  if (owner && !owner.isDestroyed()) {
    try {
      owner.contentView.removeChildView(going);
    } catch {
      // The window may be in the middle of its own teardown; closing the webContents below is
      // still sufficient to stop the page process.
    }
  }
  if (!going.webContents.isDestroyed()) going.webContents.close({ waitForBeforeUnload: false });
  void retirePreviewSession(retiredSession).catch((error) => {
    console.warn('Could not completely clean up web preview session:', error);
  });
}

export const openUrl = (): string => current;

/** The live page's contents, or null when nothing is open. */
const live = () => (view && !view.webContents.isDestroyed() ? view.webContents : null);

/** Diagnostics the current page has printed, oldest first. */
export const consoleLog = (): ConsoleLine[] => [...consoleLines];

/**
 * A picture of the pane, as PNG bytes.
 *
 * `capturePage` runs in process against a view the application owns, so unlike the desktop
 * `screenshot` tool this photographs nothing the person did not already put on their own
 * screen inside this window: no other application, no other display. That is why it needs no
 * capture permission and asks nothing.
 */
export async function capture(): Promise<Buffer | null> {
  const contents = live();
  if (!contents || !current) return null;
  const image = await contents.capturePage();
  return image.isEmpty() ? null : image.toPNG();
}

export interface PageText {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/**
 * The page as text, for a model that needs to know what it actually rendered.
 *
 * `innerText` rather than the DOM: it is what a person reading the page would see, it collapses
 * the markup a model does not need, and it leaves out script and style content. Bounded, because
 * a page can be arbitrarily large and this goes into a prompt.
 */
export async function readText(limit = 20_000): Promise<PageText | null> {
  const contents = live();
  if (!contents || !current) return null;
  const raw: unknown = await contents.executeJavaScript(
    '(() => ({ title: document.title, text: document.body ? document.body.innerText : "" }))()',
    true
  );
  const value = (raw && typeof raw === 'object' ? raw : {}) as { title?: unknown; text?: unknown };
  const text = typeof value.text === 'string' ? value.text : '';
  return {
    url: current,
    title: typeof value.title === 'string' ? value.title : '',
    text: text.slice(0, limit),
    truncated: text.length > limit,
  };
}
