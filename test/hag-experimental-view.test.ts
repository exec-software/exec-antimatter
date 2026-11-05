import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HAG_SOURCE_ID, type HagExperimentalState } from '../src/api/hag';
import type { HagExperimentalController } from '../renderer/src/lib/useHagExperimental';
import { HagExperimentalControls } from '../renderer/src/components/settings/HagExperimentalPanel';
import { HagWelcomeDialog } from '../renderer/src/components/setup/HagWelcomeDialog';
import { HagPreviewNotice } from '../renderer/src/components/chat/HagPreviewNotice';

const state: HagExperimentalState = {
  showWelcome: true, enabled: false, available: true, unavailableReason: null, status: 'disabled', error: null,
  sourceId: 'bundled-hag-experimental', model: { id: 'qwen3-0.6b-hag-16k', name: 'Qwen3-0.6B', maxEvaluatedTokens: 1024 },
  modelDownloadBytes: 639447744, downloadProgress: null,
};
const controller = (patch: Partial<HagExperimentalState> = {}, overrides: Partial<HagExperimentalController> = {}): HagExperimentalController => ({
  state: { ...state, ...patch }, error: '', loading: false, action: null, available: true,
  reload: async () => undefined,
  perform: async () => { throw new Error('Rendering must never change the experiment.'); },
  ...overrides,
});
const render = (value: HagExperimentalController, welcome = false) => renderToStaticMarkup(createElement(HagExperimentalControls, { controller: value, welcome }));
const button = (html: string, label: string) => {
  const match = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find((entry) => entry[2].includes(label));
  assert.ok(match, `Expected button ${label}`);
  return match[1];
};

test('first-update offer requires explicit download consent and preserves existing model selection', () => {
  const html = renderToStaticMarkup(createElement(HagWelcomeDialog, { controller: controller() }));
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /off until you enable it/);
  assert.match(html, /Download &amp; enable HAG/);
  assert.match(html, /639 MB/);
  assert.match(html, /Keep current setup/);
  assert.match(html, /Your current model and existing conversations keep their selections/);
  assert.match(html, /Qwen3-0.6B only/);
  assert.match(html, /OpenMythos and your other models continue using their existing engines/);
  assert.match(html, /Settings → Experimental/);
  assert.doesNotMatch(html, /type="checkbox"|checked=|Use HAG by default/);
});

test('reported serving cap is distinct from context capacity and workload qualification', () => {
  const html = render(controller({ model: { ...state.model, maxEvaluatedTokens: 64 } }));
  assert.match(html, /Prompt, history and reply together are limited to 64 evaluated tokens/);
  assert.match(html, /Full editor conversations and tool use are still being qualified/);
  assert.doesNotMatch(html, /16,384|1024|Unlimited|production-ready/);
});

test('a verified local checkpoint needs no download consent and cannot enable on unsupported hardware', () => {
  const local = render(controller({ modelDownloadBytes: null }));
  assert.match(local, /Enable experimental HAG/);
  assert.doesNotMatch(local, /Enabling downloads|Download &amp;/);
  const unavailable = render(controller({ available: false, unavailableReason: 'No supported AMD render device is available.' }), true);
  assert.match(button(unavailable, 'Download &amp; enable HAG'), / disabled=""/);
  assert.doesNotMatch(button(unavailable, 'Keep current setup'), / disabled=""/);
  assert.match(unavailable, /No supported AMD render device/);
});

test('enabled and failed installations retain an explicit off switch even if device support is unavailable', () => {
  const html = render(controller({ enabled: true, available: false, status: 'error', error: 'Device disappeared.', unavailableReason: 'GPU unavailable.', modelDownloadBytes: null }));
  assert.match(html, /Device disappeared/);
  assert.doesNotMatch(button(html, 'Turn off HAG'), / disabled=""/);
  assert.doesNotMatch(html, /Download &amp; enable HAG/);
  assert.match(html, /Turning HAG off stops its server and restores your previous default model when it is still available/);
});

test('enabling or selecting HAG does not promise a model load before the first message', () => {
  const html = render(controller({ enabled: true, status: 'stopped', modelDownloadBytes: 0 }));
  assert.match(html, /Enabled · starts with your first message/);
  assert.match(html, /Its model loads when you send your first message/);
  assert.doesNotMatch(html, /starts when selected/);
});

test('pending provisioning cannot double-submit or misrepresent Keep current setup as cancellation', () => {
  const html = render(controller({ status: 'downloading', downloadProgress: { receivedBytes: 123000000, totalBytes: 639447744 } }, { action: 'enable' }), true);
  assert.match(html, /Downloading Qwen3-0.6B/);
  assert.match(html, /aria-label="Qwen3-0.6B download"/);
  assert.match(html, /123 of 640 MB/);
  assert.match(button(html, 'Enabling HAG'), / disabled=""/);
  assert.match(button(html, 'Keep current setup'), / disabled=""/);
});

test('missing preload or failed state read never presents an actionable opt-in', () => {
  const unavailable = render(controller({}, { available: false, state: null }));
  assert.match(unavailable, /controls are unavailable/);
  assert.doesNotMatch(unavailable, /<button/);
  const failed = render(controller({}, { state: null, error: 'Could not read HAG settings.' }));
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Retry/);
  assert.doesNotMatch(failed, /Enable experimental|Download &amp;/);
});

test('normal composer clearly discloses the small text-only budget only for the owned HAG source identity', () => {
  const html = renderToStaticMarkup(createElement(HagPreviewNotice, { sourceId: HAG_SOURCE_ID }));
  assert.match(html, /HAG text preview/);
  assert.match(html, /Tools and file attachments are off/);
  assert.match(html, /1,024-token preview budget/);
  assert.match(html, /replies are limited to 64 tokens/);
  assert.match(html, /without workspace or memory context/);
  assert.match(html, /History that is too long or contains tool calls is refused/);
  for (const sourceId of ['local-openmythos-27b', 'local-qwen3-omni-30b', 'other-hag-server', undefined]) {
    assert.equal(renderToStaticMarkup(createElement(HagPreviewNotice, { sourceId })), '');
  }
});

test('the user-facing preview limit never claims the allocated native context is qualified for editor chat', () => {
  const html = render(controller({ model: { ...state.model, maxEvaluatedTokens: 16384 } }));
  assert.match(html, /limited to 1,024 evaluated tokens in this text preview/);
  assert.match(html, /replies are limited to 64 tokens/);
  assert.doesNotMatch(html, /16,384/);
});
