/**
 * Puts the main window in the tray without leaving a remote preview page behind it.
 *
 * Kept independent of Electron so the ordering is testable: the native page is destroyed first,
 * then the renderer is told to clear its matching React pane, and only then does the window
 * disappear. Reopening can therefore never reveal a stale empty preview shell.
 */
export function hideWindowWithPreviewCleanup(actions: {
  closePage(): void;
  clearRenderer(): void;
  hideWindow(): void;
}): void {
  actions.closePage();
  actions.clearRenderer();
  actions.hideWindow();
}
