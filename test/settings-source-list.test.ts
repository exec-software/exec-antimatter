import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  boundedSourceOperation,
  isLocalBeholddSource,
  sourceActionError,
  SourceList,
} from '../renderer/src/components/settings/SourceList';
import type { ProviderConfig } from '../renderer/src/types';

const source: ProviderConfig = {
  id: 'local',
  name: 'Local inference',
  kind: 'beholdd',
  baseUrl: 'http://127.0.0.1:6768/v1',
  models: [{ id: 'model-one', name: 'Model One', contextLength: 8192 }],
  supportsStreaming: true,
  credentialConfigured: true,
};

test('source rows keep everyday checks visible and management behind closed details', () => {
  const markup = renderToStaticMarkup(createElement(SourceList, {
    sources: [source], onChanged: () => undefined, onManageEngine: () => undefined,
  }));
  const [summary, disclosure] = markup.split('<details');
  assert.match(summary, /Local inference/);
  assert.match(summary, /1 model/);
  assert.match(summary, /Chat Completions/);
  assert.match(summary, /Test/);
  assert.match(summary, /Refresh models/);
  assert.doesNotMatch(summary, /model-one|Rotate key|Remove source/);
  assert.doesNotMatch(disclosure.split('>')[0], /\bopen(?:=|\s|$)/);
  assert.match(disclosure, /model-one/);
  assert.match(disclosure, /Rotate key/);
  assert.match(disclosure, /Remove source/);
  assert.match(disclosure, /Local engine settings/);
  assert.doesNotMatch(markup, />Connect<|>Reconnect<|>Stop<|managed outside Antimatter|pid /);
  assert.doesNotMatch(markup, /type="password"/, 'stored credentials are never prefilled or requested during render');
});

test('local engine link never claims ownership and does not show for remote or other sources', () => {
  assert.equal(isLocalBeholddSource(source), true);
  assert.equal(isLocalBeholddSource({ ...source, baseUrl: 'http://localhost:9876/v1' }), true);
  assert.equal(isLocalBeholddSource({ ...source, baseUrl: 'http://[::1]:6768/v1' }), true);
  assert.equal(isLocalBeholddSource({ ...source, baseUrl: 'https://inference.example/v1' }), false);
  assert.equal(isLocalBeholddSource({ ...source, kind: 'openai-compatible' }), false);
  assert.equal(isLocalBeholddSource({ ...source, baseUrl: 'not a URL' }), false);
  const markup = renderToStaticMarkup(createElement(SourceList, {
    sources: [{ ...source, kind: 'openai', baseUrl: 'https://api.openai.com/v1' }],
    onChanged: () => undefined, onManageEngine: () => undefined,
  }));
  assert.doesNotMatch(markup, /Local engine settings/);
});

test('source actions surface failure and have a bounded wait without claiming cancellation', async () => {
  assert.equal(await boundedSourceOperation(Promise.resolve('done'), 50), 'done');
  await assert.rejects(boundedSourceOperation(Promise.reject(new Error('Unavailable')), 50), /Unavailable/);
  let finish: ((value: string) => void) | undefined;
  const hanging = new Promise<string>((resolve) => { finish = resolve; });
  await assert.rejects(boundedSourceOperation(hanging, 5), /may still complete/);
  finish!('late');
  assert.equal(await hanging, 'late');
});

test('source error messages strip the IPC wrapper and redact a replacement key', () => {
  const error = new Error("Error invoking remote method 'providers:credential-replace': Error: Rejected example-secret");
  assert.equal(sourceActionError(error, 'example-secret'), 'Rejected [redacted]');
  assert.equal(sourceActionError(null), 'The source operation failed.');
  assert.equal(sourceActionError(new Error('x'.repeat(900))).length, 500);
});

test('empty sources remain an actionable explanation without expanded scaffolding', () => {
  const markup = renderToStaticMarkup(createElement(SourceList, { sources: [], onChanged: () => undefined }));
  assert.match(markup, /No sources yet/);
  assert.doesNotMatch(markup, /details|rounded-xl/);
});
