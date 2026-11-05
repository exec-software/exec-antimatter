import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from './privateState';
import {
  DEFAULT_AUTO_CONTINUE,
  normalizeAutoContinue,
  type AutoContinueSettings,
} from './autoContinue';

/**
 * Developer settings: the switches that change how a turn is run.
 *
 * Kept apart from Settings, and from a model profile, because that is what they are. A profile
 * describes a model — its window, its output ceiling, its brief. These describe Antimatter's own
 * behaviour around whatever model is answering, they are the sort of thing you turn on to get
 * through an evening's work with a smaller model, and they are the sort of thing that should be
 * easy to find and turn off again when it turns out to have been a bad idea.
 *
 * In the main process rather than the renderer, for the same reason the model choice is: this is
 * one setting per install, and it has to be readable before any window exists, because an agent
 * or a scheduled run is a turn too.
 */

/**
 * Whether a screen capture is put to the person every time.
 *
 * Every capture asks, because a display holds whatever is on it — the mail client, the password
 * manager — and that is worth an interruption. The one exception is automatic, and on some sessions
 * it cannot be reached at all: recognising one of Antimatter's own windows needs the capturer to
 * name windows, and a Wayland/PipeWire session publishes no titles — it offers one nameless window
 * and one screen. There the only capture that works is the whole display, which always asks, so a
 * model checking what it just drew asks on every look, and a GUI built over twenty iterations is
 * twenty dialogs.
 *
 * This is the person answering that question once, in advance. It applies to `screenshot` under
 * Full access and to nothing else: Ask first still asks, Read only still refuses, and a command
 * that installs packages stays a separate question — one nobody can answer before seeing it.
 */
export interface ScreenCaptureSettings {
  withoutAsking: boolean;
}

/**
 * Whether a command that reaches past the project is put to the person every time.
 *
 * Full access is permission over the project; a command line is the one tool argument that can
 * step outside it — `sudo`, the system package managers, a `pip --user` or
 * `--break-system-packages` install that lands in front of every Python program on the machine.
 * Those are put to the person by default, and the default is not paranoia: a model asked for a
 * GIMP clone once installed Pillow 12.3 machine-wide to get around a missing ImageTk.
 *
 * This is the person answering that question once, in advance, for a machine that is theirs to
 * change — a development box where `sudo` is wired to a Vault credential and every install is
 * expected. It applies to the command tools under Full access and to nothing else: Ask first
 * still asks, Read only still refuses, a screen capture is still the camera's own question, and
 * sending an image to a non-loopback vision source still asks per call, because that one is not
 * a change to this machine but a copy leaving it.
 */
export interface MachineWideSettings {
  withoutAsking: boolean;
}

export interface DeveloperSettings {
  autoContinue: AutoContinueSettings;
  screenCapture: ScreenCaptureSettings;
  machineWide: MachineWideSettings;
}

/**
 * On, unlike the other switches here.
 *
 * This one does not grant a capability, it removes a prompt in front of one the model already
 * has. Asked every time, a model checking the page it just wrote has to interrupt the person to
 * do it — so it stops checking, and reports work as finished that it never looked at. A wrong
 * answer delivered confidently costs more than an unprompted capture of a screen the person is
 * sitting in front of. Turn it off in Settings when that trade does not hold.
 */
export const DEFAULT_SCREEN_CAPTURE: ScreenCaptureSettings = { withoutAsking: true };

export function normalizeScreenCapture(value: unknown): ScreenCaptureSettings {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<ScreenCaptureSettings>;
  return { withoutAsking: source.withoutAsking === true };
}

/**
 * Off, unlike screen capture.
 *
 * The capture switch removes a prompt in front of something that reads; this one removes a prompt
 * in front of something that writes, outside the project, where no later edit undoes it. A fresh
 * install should ask. Someone who wants it on knows why.
 */
export const DEFAULT_MACHINE_WIDE: MachineWideSettings = { withoutAsking: false };

export function normalizeMachineWide(value: unknown): MachineWideSettings {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<MachineWideSettings>;
  return { withoutAsking: source.withoutAsking === true };
}

interface StoreFile extends DeveloperSettings {
  version: 1;
}

export const DEFAULT_DEVELOPER_SETTINGS: DeveloperSettings = {
  autoContinue: DEFAULT_AUTO_CONTINUE,
  screenCapture: DEFAULT_SCREEN_CAPTURE,
  machineWide: DEFAULT_MACHINE_WIDE,
};

/** Electron owns the real userData path; main sets it once at startup. */
let configPath = join(homedir(), '.antimatter', 'developer.json');
let cache: DeveloperSettings | null = null;

export const useConfigPath = (path: string): void => {
  configPath = path;
  cache = null;
};

export function normalize(value: unknown): DeveloperSettings {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<DeveloperSettings>;
  return {
    autoContinue: normalizeAutoContinue(source.autoContinue),
    screenCapture: normalizeScreenCapture(source.screenCapture),
    machineWide: normalizeMachineWide(source.machineWide),
  };
}

export function read(): DeveloperSettings {
  if (cache) return cache;
  const ownsDirectory = migratePrivateDirectory(dirname(configPath));
  if (!existsSync(configPath)) return (cache = DEFAULT_DEVELOPER_SETTINGS);
  if (ownsDirectory) migratePrivateFile(configPath);
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<StoreFile> | null;
    cache = parsed?.version === 1 ? normalize(parsed) : DEFAULT_DEVELOPER_SETTINGS;
  } catch (error) {
    // A setting nobody can read is a setting that is off, which is the safe reading of every one
    // of these: the default behaviour is what Antimatter does without being asked.
    console.error('[developer] unreadable settings, using defaults:', error);
    cache = DEFAULT_DEVELOPER_SETTINGS;
  }
  return cache;
}

export function save(next: unknown): DeveloperSettings {
  const settings = normalize(next);
  const file: StoreFile = { version: 1, ...settings };
  writePrivateFileAtomic(configPath, `${JSON.stringify(file, null, 2)}\n`);
  cache = settings;
  return settings;
}
