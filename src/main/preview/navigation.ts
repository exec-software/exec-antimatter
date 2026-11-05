export interface NavigationFailure {
  activeGeneration: number;
  failureGeneration: number | undefined;
  currentUrl: string;
  failedUrl: string;
  isMainFrame: boolean;
  errorCode: number;
}

/** A late failure from a page that has already been replaced must not cover the current page. */
export const isCurrentNavigationFailure = (failure: NavigationFailure): boolean =>
  failure.isMainFrame &&
  failure.errorCode !== -3 &&
  failure.failureGeneration === failure.activeGeneration &&
  failure.failedUrl === failure.currentUrl;

export interface PreviewNavigationHistory {
  getActiveIndex(): number;
  getEntryAtIndex(index: number): { url: string } | null;
  goBack(): void;
  goForward(): void;
}

/**
 * History traversal does not emit Electron's `will-navigate` event. Record its destination before
 * asking Chromium to move so a real failure on that destination belongs to the new generation.
 */
export function navigateHistory(
  history: PreviewNavigationHistory,
  direction: 'back' | 'forward',
  begin: (url: string) => void
): boolean {
  const offset = direction === 'back' ? -1 : 1;
  const target = history.getEntryAtIndex(history.getActiveIndex() + offset);
  if (!target?.url) return false;
  begin(target.url);
  if (direction === 'back') history.goBack();
  else history.goForward();
  return true;
}
