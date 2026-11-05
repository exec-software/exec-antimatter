import { formatElapsedMilliseconds } from '../../renderer/src/lib/duration';

/**
 * Being told a turn has finished when you are not watching it.
 *
 * A long turn on a local model is minutes of nothing, and the usual answer is to keep the window
 * on screen and keep glancing at it. This is the other answer: go and do something else, and let
 * the desktop say when the reply landed. The in-app toast is not that — it only exists while the
 * window is in front of you, which is the one case where a notice is least needed.
 *
 * Two independent channels, because they fail in opposite directions. A desktop notification is
 * quiet and persistent and lost if the desktop suppresses it; a sound is immediate and gone, and
 * carries to the next room. People want one, the other, or both, so neither implies the other.
 *
 * Decisions this module owns, so neither the main process nor the renderer has to repeat them:
 *
 *  - **Whether to say anything at all.** `planTurnNotification` is the only answer. It is pure,
 *    so the rules are a test rather than a thing to try by waiting ten minutes for a turn.
 *  - **What the sound is.** The built-ins are tone sequences and not audio files: nothing to
 *    ship, nothing to decode, and the same four sounds on every platform. A chosen file replaces
 *    them wholesale.
 *  - **What a custom sound may be.** The renderer never names a path. `customSound` is written
 *    only by the main process, from a file it opened itself through a dialog, so no patch from
 *    the window can aim the reader at something else.
 */

export type NotificationSoundWave = 'sine' | 'triangle' | 'square' | 'sawtooth';

/** One partial of a built-in sound. Offsets and lengths are milliseconds. */
export interface NotificationTone {
  /** Offset from the start of the sound. */
  at: number;
  hz: number;
  ms: number;
  wave: NotificationSoundWave;
  /** Peak gain before the chosen volume is applied, 0..1. */
  gain: number;
}

export type BuiltInSoundId = 'chime' | 'ping' | 'knock' | 'rise';

export interface BuiltInSound {
  id: BuiltInSoundId;
  label: string;
  description: string;
  tones: readonly NotificationTone[];
}

/**
 * The four built-ins.
 *
 * Kept deliberately short and quiet. This plays at the end of every turn, so anything with a
 * tail or a flourish becomes the sound you turn off rather than the sound you rely on.
 */
const SOUNDS: readonly BuiltInSound[] = [
  {
    id: 'chime',
    label: 'Chime',
    description: 'Two soft bell notes.',
    tones: [
      { at: 0, hz: 1046.5, ms: 260, wave: 'sine', gain: 0.5 },
      { at: 90, hz: 1318.5, ms: 320, wave: 'sine', gain: 0.4 },
    ],
  },
  {
    id: 'ping',
    label: 'Ping',
    description: 'One short blip.',
    tones: [{ at: 0, hz: 880, ms: 130, wave: 'triangle', gain: 0.45 }],
  },
  {
    id: 'knock',
    label: 'Knock',
    description: 'Two low taps, for a quiet room.',
    tones: [
      { at: 0, hz: 180, ms: 80, wave: 'sine', gain: 0.6 },
      { at: 135, hz: 140, ms: 90, wave: 'sine', gain: 0.5 },
    ],
  },
  {
    id: 'rise',
    label: 'Rise',
    description: 'Three notes going up.',
    tones: [
      { at: 0, hz: 659.3, ms: 120, wave: 'triangle', gain: 0.35 },
      { at: 70, hz: 880, ms: 120, wave: 'triangle', gain: 0.35 },
      { at: 140, hz: 1174.7, ms: 200, wave: 'triangle', gain: 0.35 },
    ],
  },
];

export const BUILT_IN_SOUNDS: readonly BuiltInSound[] = Object.freeze(
  SOUNDS.map((sound) => Object.freeze({ ...sound, tones: Object.freeze([...sound.tones]) })),
);

export const DEFAULT_SOUND_ID: BuiltInSoundId = 'chime';

export type NotificationSoundId = BuiltInSoundId | 'custom';

export const builtInSound = (id: BuiltInSoundId): BuiltInSound =>
  BUILT_IN_SOUNDS.find((sound) => sound.id === id) ?? BUILT_IN_SOUNDS[0];

const isBuiltInSoundId = (value: unknown): value is BuiltInSoundId =>
  BUILT_IN_SOUNDS.some((sound) => sound.id === value);

/**
 * A chosen sound file, after the main process has vetted and copied it.
 *
 * `path` is the copy Antimatter owns, not where it was picked from: a sound chosen out of
 * Downloads would otherwise go silent the first time that folder is tidied. `name` is the
 * original file name, kept only so the panel can say which sound this is.
 */
export interface CustomSound {
  path: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface NotificationSettings {
  /** A desktop notification when a turn finishes. */
  desktop: boolean;
  /** A sound when a turn finishes. */
  sound: boolean;
  soundId: NotificationSoundId;
  /** 0..1. Applied to the built-ins and to a chosen file alike. */
  volume: number;
  /**
   * Stay quiet while the finished conversation is the one you are looking at.
   *
   * On by default, because a notice about something happening in front of you is noise. "In
   * front of you" means both halves: the window has focus *and* that conversation is the one on
   * screen. A turn finishing in another chat is exactly as invisible as one finishing while the
   * window is behind a browser.
   */
  onlyWhenUnfocused: boolean;
  /** Written by the main process alone; never accepted from a renderer patch. */
  customSound: CustomSound | null;
}

export const DEFAULT_NOTIFICATIONS: Readonly<NotificationSettings> = Object.freeze({
  desktop: true,
  sound: true,
  soundId: DEFAULT_SOUND_ID,
  volume: 0.6,
  onlyWhenUnfocused: true,
  customSound: null,
});

/** The keys a renderer may patch. `customSound` is deliberately absent. */
const NOTIFICATION_KEYS = ['desktop', 'sound', 'soundId', 'volume', 'onlyWhenUnfocused'] as const;

export const MAX_CUSTOM_SOUND_BYTES = 2 * 1024 * 1024;
export const MAX_CUSTOM_SOUND_NAME = 120;

/** What a sound file may be, by what is actually in it rather than what it is called. */
export interface SoundFileType {
  mime: string;
  extension: string;
  label: string;
}

export const SOUND_FILE_EXTENSIONS: readonly string[] = Object.freeze(['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a']);

/**
 * Identify a sound file from its first bytes.
 *
 * By content, because the extension is the user's and the decoder's opinion of the bytes is what
 * actually matters: a .wav that is really a video plays as nothing, with no way to tell that
 * from a broken speaker. Null means "not a sound this app will try to play", which is a refusal
 * the picker can explain rather than a silence nobody can diagnose.
 */
export function detectSoundType(head: Uint8Array): SoundFileType | null {
  const ascii = (at: number, text: string): boolean =>
    head.length >= at + text.length && [...text].every((character, index) => head[at + index] === character.charCodeAt(0));

  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return { mime: 'audio/wav', extension: 'wav', label: 'WAV' };
  if (ascii(0, 'fLaC')) return { mime: 'audio/flac', extension: 'flac', label: 'FLAC' };
  if (ascii(0, 'OggS')) return { mime: 'audio/ogg', extension: 'ogg', label: 'Ogg' };
  if (ascii(0, 'ID3')) return { mime: 'audio/mpeg', extension: 'mp3', label: 'MP3' };
  // A bare MPEG frame: the eleven-bit sync word, then a version and layer that are not the
  // reserved encodings. Without those two checks any 0xffe. byte pair passes as audio.
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0 &&
      (head[1] & 0x18) !== 0x08 && (head[1] & 0x06) !== 0x00) {
    return { mime: 'audio/mpeg', extension: 'mp3', label: 'MP3' };
  }
  if (ascii(4, 'ftyp') && (ascii(8, 'M4A') || ascii(8, 'mp42') || ascii(8, 'isom'))) {
    return { mime: 'audio/mp4', extension: 'm4a', label: 'M4A' };
  }
  return null;
}

/** Collapse a relayed string to one bounded line. Chat titles and file names are both user text. */
const line = (value: unknown, limit: number): string => {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
};

function normalizeCustomSound(value: unknown): CustomSound | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const name = line(input.name, MAX_CUSTOM_SOUND_NAME);
  if (typeof input.path !== 'string' || !input.path || !name) return null;
  if (typeof input.mime !== 'string' || !/^audio\/[a-z0-9.+-]+$/.test(input.mime)) return null;
  const bytes = typeof input.bytes === 'number' && Number.isFinite(input.bytes) ? Math.max(0, Math.trunc(input.bytes)) : 0;
  if (bytes === 0 || bytes > MAX_CUSTOM_SOUND_BYTES) return null;
  return { path: input.path, name, mime: input.mime, bytes };
}

/** Disk and fallback only. Patches go through the strict validator below. */
export function normalizeNotifications(value: unknown): NotificationSettings {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const customSound = normalizeCustomSound(input.customSound);
  // A chosen sound that is no longer on record cannot be selected. Falling back rather than
  // going silent keeps "sound on" honest when the file has been removed behind the settings.
  const requested = input.soundId;
  const soundId: NotificationSoundId = requested === 'custom'
    ? (customSound ? 'custom' : DEFAULT_SOUND_ID)
    : isBuiltInSoundId(requested) ? requested : DEFAULT_SOUND_ID;
  const volume = typeof input.volume === 'number' && Number.isFinite(input.volume)
    ? Math.min(1, Math.max(0, Math.round(input.volume * 100) / 100))
    : DEFAULT_NOTIFICATIONS.volume;
  return {
    desktop: input.desktop === undefined ? DEFAULT_NOTIFICATIONS.desktop : input.desktop !== false,
    sound: input.sound === undefined ? DEFAULT_NOTIFICATIONS.sound : input.sound !== false,
    soundId,
    volume,
    onlyWhenUnfocused: input.onlyWhenUnfocused === undefined
      ? DEFAULT_NOTIFICATIONS.onlyWhenUnfocused
      : input.onlyWhenUnfocused !== false,
    customSound,
  };
}

/** Reject unknown keys and wrong types rather than silently applying half an edit. */
export function validateNotificationsPatch(value: unknown): Partial<NotificationSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Notification settings must be an object.');
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('Notification settings must be a plain object.');
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key === 'customSound') throw new Error('A notification sound is chosen through the file picker.');
    if (!(NOTIFICATION_KEYS as readonly string[]).includes(key)) throw new Error('Unknown notification setting.');
  }
  const patch: Partial<NotificationSettings> = {};
  for (const key of ['desktop', 'sound', 'onlyWhenUnfocused'] as const) {
    if (!Object.hasOwn(input, key)) continue;
    if (typeof input[key] !== 'boolean') throw new Error('That notification setting is on or off.');
    patch[key] = input[key] as boolean;
  }
  if (Object.hasOwn(input, 'soundId')) {
    if (input.soundId !== 'custom' && !isBuiltInSoundId(input.soundId)) throw new Error('Choose one of the sounds offered.');
    patch.soundId = input.soundId as NotificationSoundId;
  }
  if (Object.hasOwn(input, 'volume')) {
    if (typeof input.volume !== 'number' || !Number.isFinite(input.volume) || input.volume < 0 || input.volume > 1) {
      throw new Error('The volume is between 0 and 1.');
    }
    patch.volume = Math.round(input.volume * 100) / 100;
  }
  return patch;
}

export function notificationsEqual(a: NotificationSettings, b: NotificationSettings): boolean {
  const sameSound = a.customSound === b.customSound ||
    (a.customSound !== null && b.customSound !== null &&
      a.customSound.path === b.customSound.path && a.customSound.name === b.customSound.name &&
      a.customSound.mime === b.customSound.mime && a.customSound.bytes === b.customSound.bytes);
  return sameSound && (NOTIFICATION_KEYS as readonly (keyof NotificationSettings)[]).every((key) => a[key] === b[key]);
}

/** What the renderer reports about a turn that has just settled. */
export interface FinishedTurn {
  threadId: string;
  /** The conversation's title, for the notification. Sanitized here: it is the user's own text. */
  title: string;
  failed: boolean;
  /** The person pressed Stop. They were there; they do not need telling. */
  stopped: boolean;
  elapsedMs: number;
  /** Whether that conversation is the one the window is showing. */
  onScreen: boolean;
}

export type SoundPlan =
  | { kind: 'builtin'; id: BuiltInSoundId; volume: number }
  | { kind: 'custom'; volume: number };

export interface NotificationPlan {
  desktop: { title: string; body: string } | null;
  sound: SoundPlan | null;
}

export const NO_NOTIFICATION: Readonly<NotificationPlan> = Object.freeze({ desktop: null, sound: null });

const MAX_NOTIFICATION_TITLE = 80;

export function parseFinishedTurn(value: unknown): FinishedTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A finished turn must be an object.');
  const input = value as Record<string, unknown>;
  if (typeof input.threadId !== 'string' || !input.threadId || input.threadId.length > 128) {
    throw new Error('A finished turn names its conversation.');
  }
  return {
    threadId: input.threadId,
    title: line(input.title, MAX_NOTIFICATION_TITLE),
    failed: input.failed === true,
    stopped: input.stopped === true,
    elapsedMs: typeof input.elapsedMs === 'number' && Number.isFinite(input.elapsedMs) ? Math.max(0, input.elapsedMs) : 0,
    onScreen: input.onScreen === true,
  };
}

/**
 * Whether a settled turn is worth a notification, and what it should be.
 *
 * A failure is reported on the same terms as a success. It is the more useful of the two to hear
 * about from the next room, and suppressing it would mean a turn that died in its first second
 * looks, from outside the window, exactly like one still running.
 */
export function planTurnNotification(
  settings: NotificationSettings,
  turn: FinishedTurn,
  context: { focused: boolean },
): NotificationPlan {
  if (turn.stopped) return NO_NOTIFICATION;
  if (!settings.desktop && !settings.sound) return NO_NOTIFICATION;
  if (settings.onlyWhenUnfocused && context.focused && turn.onScreen) return NO_NOTIFICATION;

  const elapsed = formatElapsedMilliseconds(turn.elapsedMs);
  const desktop = settings.desktop
    ? {
      title: turn.title || 'Antimatter',
      body: turn.failed ? `The turn failed after ${elapsed}.` : `Reply ready after ${elapsed}.`,
    }
    : null;
  // Volume zero is a mute someone set on purpose; honour it instead of playing an inaudible tone.
  const audible = settings.sound && settings.volume > 0;
  const sound: SoundPlan | null = !audible ? null
    : settings.soundId === 'custom' && settings.customSound
      ? { kind: 'custom', volume: settings.volume }
      : { kind: 'builtin', id: settings.soundId === 'custom' ? DEFAULT_SOUND_ID : settings.soundId, volume: settings.volume };
  return { desktop, sound };
}

/** The sound the panel's preview button plays, whatever the on/off switches currently say. */
export function previewSoundPlan(settings: NotificationSettings): SoundPlan {
  const volume = settings.volume > 0 ? settings.volume : DEFAULT_NOTIFICATIONS.volume;
  return settings.soundId === 'custom' && settings.customSound
    ? { kind: 'custom', volume }
    : { kind: 'builtin', id: settings.soundId === 'custom' ? DEFAULT_SOUND_ID : settings.soundId, volume };
}

export interface NotificationsAPI {
  get(): Promise<NotificationSettings>;
  update(patch: Partial<NotificationSettings>): Promise<NotificationSettings>;
  /** Opens a file picker, vets what was chosen, and keeps a copy. Null when it was cancelled. */
  chooseSound(): Promise<NotificationSettings | null>;
  clearSound(): Promise<NotificationSettings>;
  /** The stored custom sound as a data URL, for the renderer to decode. Null when there is none. */
  soundData(): Promise<{ dataUrl: string; mime: string } | null>;
  /** Reports a settled turn and gets back what, if anything, the window should play. */
  turnFinished(turn: FinishedTurn): Promise<NotificationPlan>;
  onChanged(callback: (settings: NotificationSettings) => void): () => void;
  /** A notification was clicked: show this conversation. */
  onActivate(callback: (event: { threadId: string }) => void): () => void;
}
