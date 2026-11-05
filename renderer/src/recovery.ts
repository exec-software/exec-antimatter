/**
 * The recovery shell's page.
 *
 * Deliberately standalone: no React or chat bundle, so the page can render even when the main
 * bundle crashed. The small appearance controller supplies the saved palette; recovery state
 * and actions stay on the preload's recovery namespace.
 */
import type { RecoveryApproval, RecoveryState } from './types';
import { initializeAppearance } from './appearance';

const disposeAppearance = initializeAppearance(window.electronAPI.appearance);
window.addEventListener('unload', disposeAppearance, { once: true });

const transcript = document.getElementById('transcript') as HTMLElement;
const approvalEl = document.getElementById('approval') as HTMLElement;
const approvalWhat = approvalEl.querySelector('.what') as HTMLElement;
const versionEl = document.getElementById('version') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const busyEl = document.getElementById('busy') as HTMLElement;
const hintEl = document.getElementById('hint') as HTMLElement;
const form = document.getElementById('line') as HTMLFormElement;
const promptInput = document.getElementById('prompt') as HTMLInputElement;
const cancelButton = document.getElementById('cancel') as HTMLButtonElement;
const clearButton = document.getElementById('clear') as HTMLButtonElement;
const allowButton = document.getElementById('allow') as HTMLButtonElement;
const denyButton = document.getElementById('deny') as HTMLButtonElement;

const HINT =
  'Anything you type goes to the model with the same real tools as the chat window. ' +
  '/workspace, /run, /verify, /reload and /exit are the controls that put the app back in front of you.';
const emptyHint = 'Type /help in the line below for the full list of controls.';

const translates: Record<string, string> = {
  system: 'system ·',
  prompt: '',
  assistant: '',
  tool: 'tool ·',
  note: 'note ·',
  error: 'error ·',
};

const roleMark = (role: RecoveryState['messages'][number]['role']): string => translates[role] ?? '';

let approval: RecoveryApproval | null = null;

function messageRow(message: RecoveryState['messages'][number]): HTMLElement {
  const row = document.createElement('div');
  row.className = `msg ${message.role}`;
  const marker = roleMark(message.role);
  row.textContent = marker ? `${marker} ${message.content}` : message.content;
  return row;
}

function scrollToEnd(): void {
  transcript.scrollTop = transcript.scrollHeight;
}

function render(state: RecoveryState): void {
  versionEl.textContent = state.version ?? '';
  busyEl.classList.toggle('hidden', !state.busy);
  hintEl.textContent = state.messages.length ? HINT : emptyHint;

  const parts: string[] = [];
  if (state.model) parts.push(`model: ${state.model.model}`);
  else parts.push('no model configured — add a source in Settings, then /model <name>');
  parts.push(`workspace: ${state.workspace}`);
  if (state.trigger) parts.push(`fallback: ${state.trigger.kind} — ${state.trigger.detail}`);
  statusEl.textContent = parts.join('  ·  ');

  // Repaint the whole transcript, which is what makes a page that loaded late catch up.
  transcript.replaceChildren(...state.messages.map(messageRow));
  scrollToEnd();

  approval = state.approval;
  const showing = !!approval;
  approvalEl.classList.toggle('show', showing);
  if (approval) approvalWhat.textContent = approval.what;
}

const refresh = (): void => {
  void window.electronAPI.recovery.state().then(render);
};

// The page can load before or after the shell produced its state; both are answered.
window.electronAPI.onRecoveryState(render);
refresh();

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const line = promptInput.value.trim();
  if (!line) return;
  promptInput.value = '';
  void window.electronAPI.recovery.send(line);
});

cancelButton.addEventListener('click', () => {
  void window.electronAPI.recovery.cancel();
});

clearButton.addEventListener('click', () => {
  // /clear is a plain shell command; the actions row just sends it.
  void window.electronAPI.recovery.send('/clear');
});

setTimeout(() => promptInput.focus(), 0);

let approving = false;
const settle = (allowed: boolean): void => {
  if (!approval || approving) return;
  approving = true;
  void window.electronAPI.recovery
    .approve(approval.approvalId, allowed)
    .catch(() => undefined)
    .finally(() => {
      approving = false;
      refresh();
    });
};
allowButton.addEventListener('click', () => settle(true));
denyButton.addEventListener('click', () => settle(false));

// A crashed window deserves a way out of the shell too: this one never loses the app.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && form === document.activeElement?.closest('form')) {
    promptInput.blur();
  }
});
