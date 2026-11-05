import { createContext, useContext } from 'react';
import type { ShellContextValue } from './types';

/**
 * The host API, as a context. A tool window is rendered by the shell, so it reads this rather
 * than taking props — which is what lets the same component render docked, floating, or nested
 * inside another panel without the shell threading state through every level.
 */
const ShellContext = createContext<ShellContextValue>({
  workspace: null,
  conversation: null,
  sources: { providers: [], activeProviderId: '', activeModelId: '' },
  selectProvider: () => {},
  openPage: () => {},
  openModelLibrary: () => {},
});

export const ShellProvider = ShellContext.Provider;

export const useShell = (): ShellContextValue => useContext(ShellContext);
