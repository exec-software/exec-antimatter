import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceSettingsPanel, voiceSettingsProblem } from '../renderer/src/components/chat/VoiceSettingsPanel';
import type { VoiceConfiguration } from '../src/api/voice';

const config: VoiceConfiguration = {
  sources: [
    { id: 'local', name: 'Local audio', local: true, models: ['audio-model'] },
    { id: 'remote', name: 'Remote speech', local: false, models: ['tts-model'] },
  ],
  settings: { inputSourceId: 'local', inputModel: 'custom-audio-model', inputMode: 'chat-audio', speechSourceId: '', speechModel: '', speechVoice: '', speechEnabled: false, allowRemote: false },
  state: { active: false, sessionId: null, threadId: null, phase: 'idle', muted: false, speaking: false, error: null },
};

test('voice setup permits custom local models and requires explicit remote-transfer consent', () => {
  assert.equal(voiceSettingsProblem(config.settings, config.sources), null);
  assert.match(voiceSettingsProblem({ ...config.settings, inputSourceId: 'remote' }, config.sources)!, /Explicitly allow remote/);
  assert.equal(voiceSettingsProblem({ ...config.settings, inputSourceId: 'remote', allowRemote: true }, config.sources), null);
  assert.match(voiceSettingsProblem({ ...config.settings, speechEnabled: true }, config.sources)!, /speech output source/);
  assert.match(voiceSettingsProblem({ ...config.settings, inputModel: ' ' }, config.sources)!, /input model/);
});

test('voice settings present explicit save/probe actions and honest local/remote behavior', () => {
  const markup = renderToStaticMarkup(createElement(VoiceSettingsPanel, { config, onSaved: () => undefined }));
  assert.match(markup, /Save settings/);
  assert.match(markup, /Check saved input/);
  assert.match(markup, /Replies play progressively/);
  assert.match(markup, /Live streaming/);
  assert.match(markup, /privacy policies and usage charges apply/);
  assert.match(markup, /custom-audio-model/);
  assert.doesNotMatch(markup, /type="password"/, 'credentials stay with configured sources, not this view');
  const active = renderToStaticMarkup(createElement(VoiceSettingsPanel, { config: { ...config, state: { ...config.state, active: true } }, disabled: true, onSaved: () => undefined }));
  assert.match(active, /Stop the active voice session/);
  assert.match(active, /<fieldset disabled=""/);
  const stopped = renderToStaticMarkup(createElement(VoiceSettingsPanel, { config: { ...config, state: { ...config.state, active: true } }, disabled: false, onSaved: () => undefined }));
  assert.doesNotMatch(stopped, /<fieldset disabled=""/, 'a stale configuration snapshot cannot lock settings after Stop');
});

test('corrupt saved configuration remains repairable even when proposed defaults were not edited', () => {
  const markup = renderToStaticMarkup(createElement(VoiceSettingsPanel, { config: { ...config, configurationError: 'Saved voice settings could not be read.' }, onSaved: () => undefined }));
  assert.match(markup, /save them to repair the configuration/);
  const buttons = [...markup.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
  const save = buttons.find((match) => match[2].includes('Save settings'))!;
  const probe = buttons.find((match) => match[2].includes('Check saved input'))!;
  assert.doesNotMatch(save[1], / disabled=""/);
  assert.match(probe[1], / disabled=""/);
});
