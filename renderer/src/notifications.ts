import {
  builtInSound,
  previewSoundPlan,
  type FinishedTurn,
  type NotificationSettings,
  type SoundPlan,
} from '../../src/api/notifications';

/**
 * Making the noise.
 *
 * The window's half of notifications. Main decides whether anything should happen and raises the
 * desktop notification; this plays what comes back, because a process with no document has no
 * way to put sound out.
 *
 * Deliberately not a component and not a hook. The turn that finishes may be in a conversation
 * nobody has on screen, and the settings panel previews a sound while the chat page is unmounted
 * — neither has a component to hang this off.
 */

let context: AudioContext | null = null;
/** The chosen sound, decoded once. Cleared by `forgetCustomSound` when the file changes. */
let custom: AudioBuffer | null = null;
let customLoad: Promise<AudioBuffer | null> | null = null;

function audio(): AudioContext | null {
  if (context) return context;
  const Constructor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return null;
  try { context = new Constructor(); } catch (cause) { console.warn('[notifications] no audio output:', cause); }
  return context;
}

/**
 * A chosen sound file has changed, so the decoded copy is stale.
 *
 * Called from the settings panel rather than inferred, because the data URL is only fetched when
 * something is about to be played: without this, replacing the sound would keep playing the old
 * one until the window was reloaded.
 */
export function forgetCustomSound(): void {
  custom = null;
  customLoad = null;
}

async function customBuffer(): Promise<AudioBuffer | null> {
  if (custom) return custom;
  if (customLoad) return customLoad;
  const target = audio();
  if (!target) return null;
  customLoad = (async () => {
    const stored = await window.electronAPI.notifications.soundData();
    if (!stored) return null;
    const bytes = await fetch(stored.dataUrl).then((response) => response.arrayBuffer());
    custom = await target.decodeAudioData(bytes);
    return custom;
  })();
  try {
    return await customLoad;
  } catch (cause) {
    console.error('[notifications] could not decode the chosen sound:', cause);
    return null;
  } finally {
    // Keep the resolved promise only while it is the cache; a failure must be retried, not stuck.
    if (!custom) customLoad = null;
  }
}

/**
 * Play one of the built-ins.
 *
 * Synthesized rather than played from a file, so there is no audio to ship, nothing to decode,
 * and the four sounds are identical on every platform. Each tone gets its own short attack and
 * release: a bare gain step on a sine is a click at both ends, which is the one thing a
 * notification sound must not be.
 */
function playTones(target: AudioContext, plan: Extract<SoundPlan, { kind: 'builtin' }>): void {
  const sound = builtInSound(plan.id);
  const start = target.currentTime + 0.01;
  for (const tone of sound.tones) {
    const at = start + tone.at / 1000;
    const until = at + tone.ms / 1000;
    const oscillator = target.createOscillator();
    oscillator.type = tone.wave;
    oscillator.frequency.value = tone.hz;
    const gain = target.createGain();
    const peak = Math.max(0.0001, tone.gain * plan.volume);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, until);
    oscillator.connect(gain).connect(target.destination);
    oscillator.start(at);
    oscillator.stop(until + 0.02);
    // Nodes are single-use; dropping them on the floor leaks one oscillator per finished turn.
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
}

/** Play what main asked for. Never throws: a notice that fails to sound is not a failed turn. */
export async function playNotificationSound(plan: SoundPlan): Promise<void> {
  try {
    const target = audio();
    if (!target) return;
    // An AudioContext built before the first interaction starts suspended. By the time a turn
    // has finished there has been one, so this resumes rather than waits for a gesture.
    if (target.state === 'suspended') await target.resume();
    if (plan.kind === 'builtin') { playTones(target, plan); return; }
    const buffer = await customBuffer();
    // A chosen sound that cannot be read or decoded is silent on purpose: falling back to a
    // built-in would make a broken file sound exactly like a working one.
    if (!buffer) return;
    const source = target.createBufferSource();
    source.buffer = buffer;
    const gain = target.createGain();
    gain.gain.value = plan.volume;
    source.connect(gain).connect(target.destination);
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.start();
  } catch (cause) {
    console.error('[notifications] could not play the sound:', cause);
  }
}

/**
 * Report a settled turn and play whatever comes back.
 *
 * Swallows everything. This runs in the `finally` of a turn's dispatch, where a throw would
 * leave the conversation looking as though it never finished.
 */
export async function announceFinishedTurn(turn: FinishedTurn): Promise<void> {
  try {
    const plan = await window.electronAPI.notifications.turnFinished(turn);
    if (plan.sound) await playNotificationSound(plan.sound);
  } catch (cause) {
    console.error('[notifications] could not announce the finished turn:', cause);
  }
}

/** The panel's preview, which plays whatever is selected regardless of the on/off switches. */
export const previewNotificationSound = (settings: NotificationSettings): Promise<void> =>
  playNotificationSound(previewSoundPlan(settings));
