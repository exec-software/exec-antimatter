import assert from 'node:assert/strict';
import { once } from 'node:events';

/** Phone-originated turns through the real App/preload and durable host store; no inference. */
export async function exerciseRemoteTurns({ store, window, run, waitFor, fillComposer, threadId,
  provider, model, remoteControls, snapshot, requests, rendererCheckpoints, holdHydration }) {
  const send = (channel, payload) => window.webContents.send(channel, payload);
  const thread = () => store.load().threads.find((item) => item.id === threadId);
  const unsubscribe = store.subscribe((change) => {
    if (change.kind !== 'replace') send('conversations:changed', { change, stored: store.load() });
  });
  const publish = (turns, finished) => {
    Object.assign(snapshot, { revision: snapshot.revision + 1, turns, finished });
    send('chat:remote-turns-changed', snapshot);
  };
  const begin = (suffix, matchingIds = false) => {
    const startedAt = Date.now();
    const remote = { threadId, runId: `phone-request-${suffix}`, responseMessageId: matchingIds ? `phone-request-${suffix}` : `phone-response-${suffix}`,
      providerId: provider.id, modelId: model, sourceName: provider.name, startedAt };
    store.beginTurn(threadId, { providerId: provider.id, modelId: model,
      user: { id: `phone-user-${suffix}`, content: `Phone follow-up ${suffix}`, createdAt: startedAt },
      assistant: { id: remote.responseMessageId, modelId: model, sourceName: provider.name, createdAt: startedAt },
    }, thread().revision);
    publish([remote]);
    return remote;
  };
  const append = (remote, content) => {
    send('chat:stream-data', { id: remote.runId, content });
    store.appendAssistantDelta(threadId, remote.responseMessageId, content, Date.now(), thread().revision);
  };
  const finish = (remote) => {
    const finishedAt = Date.now();
    store.finishAssistantMessage(threadId, remote.responseMessageId, finishedAt, thread().revision);
    publish([], { runId: remote.runId, finishedAt, failed: false });
  };
  const button = (label) => run(`Boolean(document.querySelector('[aria-label=${JSON.stringify(label)}]'))`);
  const visible = (text) => run(`document.body.textContent.includes(${JSON.stringify(text)})`);
  try {
    const localRequestCount = requests.length;
    const first = begin('one');
    await waitFor('phone turn exposes desktop Stop', () => button('Stop generating'));
    append(first, 'Phone response exactly once.');
    await waitFor('phone response reaches desktop', () => visible('Phone response exactly once.'));
    assert.equal(await run(`[...document.querySelectorAll('article[aria-label$=" response"]')].at(-1).textContent.split('Phone response exactly once.').length - 1`), 1);
    const beforeCheckpoints = rendererCheckpoints.length;
    await fillComposer('Please keep this brief.');
    await waitFor('desktop steer for phone turn', () => button('Queue steer'));
    await run(`document.querySelector('[aria-label="Queue steer"]').click()`);
    await waitFor('steer IPC reaches actual phone run', () => remoteControls.length === 1);
    assert.deepEqual(remoteControls[0], { kind: 'steer', runId: first.runId, text: 'Please keep this brief.', now: false });
    await waitFor('remote renderer checkpoint', () => rendererCheckpoints.length > beforeCheckpoints);
    for (const checkpoint of rendererCheckpoints.slice(beforeCheckpoints)) {
      const reply = checkpoint.threads.find((item) => item.id === threadId)?.messages.find((item) => item.id === first.responseMessageId);
      if (reply) assert.equal(reply.content, 'Phone response exactly once.', 'raw deltas must not duplicate persisted remote text');
    }
    await run(`document.querySelector('[aria-label="Stop generating"]').click()`);
    await waitFor('stop IPC reaches actual phone run', () => remoteControls.length === 2);
    assert.deepEqual(remoteControls[1], { kind: 'cancel', runId: first.runId });
    finish(first);
    await waitFor('phone stop releases desktop composer', () => button('Send message'));
    // A delayed raw delta cannot revive a completed phone response.
    send('chat:stream-data', { id: first.runId, content: 'LATE RAW DELTA' });

    const second = begin('two');
    append(second, 'Another phone turn survives desktop reload.');
    await waitFor('second phone run visible', () => visible('Another phone turn survives desktop reload.'));
    const activity = { callId: 'running-phone-tool', activityId: 'phone-tool-occurrence', requestId: second.responseMessageId,
      serverId: 'fixture', serverName: 'Fixture', toolName: 'read_file', tier: 'read', args: '{}', status: 'running' };
    store.upsertToolActivity(threadId, second.responseMessageId, activity, Date.now(), thread().revision);
    const held = holdHydration();
    const reloadCheckpointIndex = rendererCheckpoints.length;
    const loaded = once(window.webContents, 'did-finish-load');
    window.webContents.reload();
    await loaded;
    await waitFor('history arrives before delayed phone ownership', () => held.reads.ownership > 0 && held.reads.conversations > 0);
    // Host history advances while the older initial load waits for its ownership read.
    append(second, ' Arrived during hydration.');
    await waitFor('new host history received during hydration', () => visible('Arrived during hydration.'));
    held.release();
    await waitFor('active phone run restored after desktop reload', async () =>
      await button('Stop generating') && await visible('Another phone turn survives desktop reload.'));
    append(second, ' Still streaming.');
    await waitFor('phone stream continues after desktop reload', () => visible('Still streaming.'));
    assert.equal(thread().messages.at(-1).content, 'Another phone turn survives desktop reload. Arrived during hydration. Still streaming.');
    await waitFor('hydrated phone checkpoint retains newest history', () => rendererCheckpoints.slice(reloadCheckpointIndex).some((checkpoint) =>
      checkpoint.threads.find((item) => item.id === threadId)?.messages.at(-1)?.content.includes('Still streaming.')));
    for (const checkpoint of rendererCheckpoints.slice(reloadCheckpointIndex)) {
      const reply = checkpoint.threads.find((item) => item.id === threadId)?.messages.find((item) => item.id === second.responseMessageId);
      if (reply?.meta.tools?.length) assert.equal(reply.meta.tools[0].status, 'running', 'hydration must not settle a live phone tool');
    }
    assert.equal(thread().messages.at(-1).meta.tools[0].status, 'running');
    store.upsertToolActivity(threadId, second.responseMessageId, { ...activity, status: 'done', result: 'Read complete.' }, Date.now(), thread().revision);
    const stale = structuredClone(snapshot);
    finish(second);
    await waitFor('second phone turn completes', () => button('Send message'));
    send('chat:remote-turns-changed', stale);
    // Wait for a later IPC in the renderer, ensuring the stale event has been delivered.
    await run('window.electronAPI.chat.remoteTurns()');
    assert.equal(await button('Stop generating'), false);
    assert.equal(await visible('LATE RAW DELTA'), false);
    const third = begin('matching-identities', true);
    await waitFor('phone turn with matching identities', () => button('Stop generating'));
    append(third, 'One authoritative copy.');
    await waitFor('matching-identity response visible', () => visible('One authoritative copy.'));
    await fillComposer('Checkpoint matching identities');
    await waitFor('matching-identity renderer checkpoint', () => rendererCheckpoints.some((checkpoint) =>
      checkpoint.drafts[threadId]?.text === 'Checkpoint matching identities'));
    assert.equal(thread().messages.at(-1).content, 'One authoritative copy.');
    assert.equal(await run(`[...document.querySelectorAll('article[aria-label$=" response"]')].at(-1).textContent.split('One authoritative copy.').length - 1`), 1);
    finish(third);
    await waitFor('matching-identity turn completes', () => button('Send message'));
    assert.equal(requests.length, localRequestCount, 'mirroring phone turns must never dispatch inference');
    return { passed: true, distinctRunAndResponseIds: true, controls: remoteControls,
      duplicateTextPrevented: true, reloadDuringTurn: true, staleLifecycleIgnored: true,
      desktopInferenceNotDuplicated: true };
  } finally { unsubscribe(); }
}
