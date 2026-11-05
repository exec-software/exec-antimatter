import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';

/** Native spelling actions never send a draft to a provider or expose editing through IPC. */
export function installSpellingMenu(
  window: BrowserWindow,
  isTrustedPage: () => boolean,
  menus: Pick<typeof Menu, 'buildFromTemplate'> = Menu,
): () => void {
  const contents = window.webContents;
  let currentMenu: Menu | null = null;
  let generation = 0;
  let disposed = false;

  const closeMenu = () => {
    generation += 1;
    const previous = currentMenu;
    currentMenu = null;
    if (previous && !window.isDestroyed()) {
      previous.closePopup(window);
    }
  };

  const showMenu = (_event: Electron.Event, params: ContextMenuParams) => {
    closeMenu();
    const menuGeneration = generation;
    const isCurrent = () => !disposed && !window.isDestroyed() && !contents.isDestroyed()
      && generation === menuGeneration && params.frame !== null && params.frame === contents.mainFrame
      && !params.frame.isDestroyed() && !params.frame.detached && contents.focusedFrame === params.frame
      && isTrustedPage();
    // Linux Electron can report a false enabled flag alongside a genuine native misspelling.
    // Leave code editors, terminals, passwords, previews, and non-editable content alone.
    const hasSpelling = params.spellcheckEnabled || Boolean(params.misspelledWord);
    if (!isCurrent() || !params.isEditable || !hasSpelling || params.formControlType !== 'text-area') {
      return;
    }

    const template: MenuItemConstructorOptions[] = [];
    if (params.misspelledWord) {
      for (const suggestion of [...new Set(params.dictionarySuggestions)].slice(0, 8)) {
        template.push({
          label: suggestion.replace(/&/g, '&&'),
          click: () => { if (isCurrent()) { contents.replaceMisspelling(suggestion); } },
        });
      }
      if (!template.length) {
        template.push({ label: 'No spelling suggestions', enabled: false });
      }
      template.push({
        label: 'Add to dictionary',
        click: () => {
          if (isCurrent()) {
            contents.session.addWordToSpellCheckerDictionary(params.misspelledWord);
          }
        },
      }, { type: 'separator' });
    }
    template.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    );
    currentMenu = menus.buildFromTemplate(template);
    currentMenu.popup({ window, frame: params.frame!, x: params.x, y: params.y, sourceType: params.menuSourceType });
  };

  const dispose = () => {
    if (disposed) { return; }
    disposed = true;
    closeMenu();
    contents.removeListener('context-menu', showMenu);
    contents.removeListener('did-start-navigation', closeMenu);
    contents.removeListener('render-process-gone', closeMenu);
    window.removeListener('hide', closeMenu);
    window.removeListener('minimize', closeMenu);
    window.removeListener('closed', dispose);
  };
  contents.on('context-menu', showMenu);
  contents.on('did-start-navigation', closeMenu);
  contents.on('render-process-gone', closeMenu);
  window.on('hide', closeMenu);
  window.on('minimize', closeMenu);
  window.on('closed', dispose);
  return dispose;
}
