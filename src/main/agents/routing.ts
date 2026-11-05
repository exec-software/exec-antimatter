import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../privateState';

/**
 * Whether the conversation's model may hand work to agents (start_agent) without being asked.
 *
 * On by default, because an agent nobody dispatches is a roster nobody uses — the panel was
 * complete, the events were wired, and the count never moved because the only callers were two
 * buttons. The thing that was missing was not display.
 *
 * It is a setting rather than a constant because automatic delegation is the kind of behaviour
 * that has to be switchable by whoever it surprises, and a rebuild is not a way to switch it off.
 */

let root = join(homedir(), '.antimatter', 'agents');

export const useRoot = (path: string): void => {
  root = path;
};

const marker = () => join(root, '.routing');

export function enabled(): boolean {
  const path = marker();
  // Absent means on: the default lives here rather than in a file nobody has written yet.
  if (!existsSync(path)) return true;
  return readFileSync(path, 'utf8').trim() !== 'off';
}

export function setEnabled(value: boolean): boolean {
  ensurePrivateDirectory(root);
  writePrivateFileAtomic(marker(), `${value ? 'on' : 'off'}\n`);
  return value;
}
