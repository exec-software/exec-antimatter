import { accessSync, constants, statSync } from 'node:fs';
import type { SourceReadiness } from './sourceReadiness';

export interface BeholddStartupInput {
  binaryPath: string;
  defaultConfigPath: string;
  /** Read-only: whether the registrar could render a generated startup configuration. */
  canPrepareConfig(): boolean;
}

const usableFile = (path: string, mode: number): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
};

/**
 * Inspects a stopped bundled engine after its endpoint was found unreachable. Like start(),
 * a registrar failure falls back to the default configuration. Unlike start(), this never
 * writes an overlay, adopts a listener, or launches a process; the request still owns preflight.
 */
export function beholddStartupReadiness(input: BeholddStartupInput): SourceReadiness {
  if (!usableFile(input.binaryPath, constants.X_OK)) {
    return { state: 'unreachable', detail: 'The bundled Beholdd executable is unavailable. Repair the Antimatter installation.' };
  }

  let generated = false;
  try { generated = input.canPrepareConfig(); } catch { /* start() also falls back to the default. */ }
  if (generated || usableFile(input.defaultConfigPath, constants.R_OK)) {
    return { state: 'startable', detail: 'Beholdd is stopped and will start when you send a message.' };
  }
  return { state: 'unreachable', detail: 'Beholdd has no available startup configuration. Set up a supported model in Models.' };
}
