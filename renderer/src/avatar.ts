import './avatar.css';
import type { VoiceCommand, VoiceState } from '../../src/api/voice';
import { initializeAppearance } from './appearance';

type State = { kind: 'atom' | 'robot' | 'cat'; running: number; approvals: number;
  voice?: Pick<VoiceState, 'active' | 'phase' | 'muted' | 'speaking'> };
const api = (window as unknown as { desktopAvatar: {
  get(): Promise<State>; openApp(): Promise<void>; menu(): Promise<void>; voiceControl(command: VoiceCommand): Promise<State>;
  onState(callback: (state: State) => void): () => void;
  appearance?: Parameters<typeof initializeAppearance>[0];
} }).desktopAvatar;
const disposeAppearance = initializeAppearance(api.appearance);
window.addEventListener('unload', disposeAppearance, { once: true });
const voiceStatus = document.getElementById('voice-status')!;
const voiceControls = document.getElementById('voice-controls')!;
// Small, local vector controls match the app's outline icons without loading React here.
const icons = {
  voice: '<path d="M2 10v4m4-7v10m4-14v18m4-14v10m4-12v14m4-9v4"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  micOff: '<path d="m2 2 20 20M9 9v3a3 3 0 0 0 5.1 2.1M9 5a3 3 0 0 1 6 0v5M5 10v2a7 7 0 0 0 12 4.9M19 10v2a7 7 0 0 1-.2 1.8M12 19v3m-4 0h8"/>',
  quiet: '<path d="m11 5-6 4H2v6h3l6 4V5Zm6 4 5 6m0-6-5 6"/>',
  end: '<path d="m2 2 20 20M9.5 9.5a16 16 0 0 0 5 5M7 7l-1.2.8a16 16 0 0 0 2.4 3.5M10.7 14a16 16 0 0 0 5.5 4.2l1-1.5a1 1 0 0 1 1.2-.4l3.2 1.1a1 1 0 0 1 .7 1v2a2 2 0 0 1-2.2 2A20 20 0 0 1 2 4a2 2 0 0 1 2-2h2a1 1 0 0 1 1 .7l1.1 3.2"/>',
};
let current: State | null = null;
let controllingVoice = false;
let voiceError = '';
let renderedVoiceControls = '';

function control(icon: keyof typeof icons, command: VoiceCommand, title: string, disabled = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.dataset.command = command;
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[icon]}</svg>`;
  button.title = title;
  button.setAttribute('aria-label', title);
  if (command === 'toggleMute') {
    button.setAttribute('aria-label', 'Mute microphone');
    button.setAttribute('aria-pressed', String(current?.voice?.muted ?? false));
  }
  button.disabled = controllingVoice || disabled;
  button.addEventListener('click', () => {
    const restoreFocus = document.activeElement === button;
    controllingVoice = true;
    voiceError = '';
    renderVoice();
    void api.voiceControl(command).then((state) => { current = state; }).catch(() => {
      voiceError = 'Open app for voice';
    }).finally(() => {
      controllingVoice = false;
      renderVoice();
      // Restore focus after pending IPC only if the user has not moved elsewhere.
      if (restoreFocus && document.activeElement === document.body) {
        const target = voiceControls.querySelector<HTMLButtonElement>(`[data-command="${command}"]:not(:disabled)`)
          ?? voiceControls.querySelector<HTMLButtonElement>('button:not(:disabled)');
        target?.focus();
      }
    });
  });
  return button;
}

function renderVoice(): void {
  const voice = current?.voice;
  voiceStatus.textContent = '';
  if (!voice) { voiceControls.hidden = true; voiceStatus.hidden = true; document.body.dataset.voice = 'off'; renderedVoiceControls = ''; return; }
  voiceControls.hidden = false;
  voiceStatus.hidden = false;
  document.body.dataset.voice = voice.active ? voice.speaking ? 'speaking' : voice.muted ? 'muted' : voice.phase : 'off';
  const phaseLabels: Record<VoiceState['phase'], string> = {
    idle: 'Voice ready', starting: 'Starting voice', listening: 'Listening', recording: 'Listening · speaking detected',
    transcribing: 'Transcribing', speaking: 'Speaking', muted: 'Microphone muted', error: 'Voice needs attention',
  };
  voiceStatus.textContent = voiceError || (voice.active ? voice.muted ? 'Microphone muted' : voice.speaking ? 'Speaking' : phaseLabels[voice.phase] : 'Voice off');
  const controlsKey = `${voice.active}:${voice.muted}:${voice.speaking}:${controllingVoice}`;
  if (controlsKey === renderedVoiceControls) return; // Polling must not steal keyboard focus.
  renderedVoiceControls = controlsKey;
  const focusedCommand = document.activeElement instanceof HTMLElement && voiceControls.contains(document.activeElement)
    ? document.activeElement.dataset.command : undefined;
  voiceControls.replaceChildren();
  if (!voice.active) {
    voiceControls.append(control('voice', 'open', 'Open voice setup in Antimatter'));
  } else {
    voiceControls.append(
      control(voice.muted ? 'micOff' : 'mic', 'toggleMute', voice.muted ? 'Unmute microphone' : 'Mute microphone'),
      control('quiet', 'interrupt', 'Interrupt spoken reply (keep task running)', !voice.speaking),
      control('end', 'stop', 'End voice session (keep task running)'),
    );
  }
  if (focusedCommand) {
    const target = voiceControls.querySelector<HTMLButtonElement>(`[data-command="${focusedCommand}"]:not(:disabled)`)
      ?? voiceControls.querySelector<HTMLButtonElement>('button:not(:disabled)');
    target?.focus();
  }
}
// Original vector companions; no remote images, downloads, or plugins run in this window.
const faces: Record<State['kind'], string> = {
  atom: '<g fill="none" stroke="currentColor" stroke-width="4"><ellipse cx="60" cy="60" rx="48" ry="19"/><ellipse cx="60" cy="60" rx="48" ry="19" transform="rotate(60 60 60)"/><ellipse cx="60" cy="60" rx="48" ry="19" transform="rotate(120 60 60)"/></g><circle cx="60" cy="60" r="12" fill="currentColor"/>',
  robot: '<path d="M60 27V13" stroke="currentColor" stroke-width="5"/><circle cx="60" cy="11" r="6" fill="currentColor"/><rect class="face-surface" x="19" y="28" width="82" height="70" rx="22" stroke="currentColor" stroke-width="5"/><rect x="34" y="47" width="13" height="18" rx="6" fill="currentColor"/><rect x="73" y="47" width="13" height="18" rx="6" fill="currentColor"/><path d="M43 78Q60 88 77 78" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  cat: '<path class="face-surface" d="M23 57L17 18L47 34Q60 30 73 34L103 18L97 57Q107 105 60 107Q13 105 23 57Z" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/><path d="M32 64L45 61M75 61L88 64" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M54 76L60 81L66 76M60 81Q51 90 47 84M60 81Q69 90 73 84" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
};
function render(state: State) {
  current = state;
  const face = document.getElementById('face')!;
  const kind = Object.prototype.hasOwnProperty.call(faces, state.kind) ? state.kind : 'atom';
  if (face.dataset.kind !== kind) { face.innerHTML = faces[kind]; face.dataset.kind = kind; }
  document.body.dataset.phase = state.approvals ? 'approval' : state.running ? 'working' : 'idle';
  document.getElementById('status')!.textContent = state.approvals ? 'Needs your approval' : state.running ? `${state.running} running` : 'Ready';
  renderVoice();
}
document.getElementById('open')!.addEventListener('click', () => void api.openApp());
document.getElementById('menu')!.addEventListener('click', () => void api.menu());
// The drag surface belongs to the window manager. Keep custom menus in the no-drag toolbar.
document.getElementById('avatar-actions')!.addEventListener('contextmenu', (event) => { event.preventDefault(); void api.menu(); });
api.onState(render);
void api.get().then(render).catch(() => { document.getElementById('status')!.textContent = 'Open Antimatter'; });
