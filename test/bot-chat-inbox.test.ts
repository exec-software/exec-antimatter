import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BotChatInbox } from '../src/main/botChatInbox';

interface Posted { channelId: string; body: string; name: string; occurrence: string; replyTo?: string }

const harness = () => {
  const directory = mkdtempSync(join(tmpdir(), 'bot-inbox-'));
  const posts: Posted[] = [];
  const warnings: string[] = [];
  const inbox = new BotChatInbox(directory, {
    channelId: (name) => (name === 'general' ? 'channel-1' : null),
    post: (channelId, body, name, occurrence, replyTo) => { posts.push({ channelId, body, name, occurrence, replyTo }); },
    now: () => 1_700_000_000_000,
    warn: (message) => { warnings.push(message); },
  });
  inbox.prepare();
  const drop = (name: string, contents: string) => writeFileSync(join(directory, name), contents);
  return { directory, posts, warnings, inbox, drop };
};

test('a dropped message reaches the channel and the file is consumed', () => {
  const { directory, posts, inbox, drop } = harness();
  drop('hello.json', JSON.stringify({ channel: 'general', author: 'Claude', body: 'Reading you.' }));
  assert.equal(inbox.sweep(), 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channelId, 'channel-1');
  assert.equal(posts[0].body, 'Reading you.');
  assert.equal(posts[0].name, 'Claude');
  // Consumed, so the next sweep does not post it again.
  assert.equal(readdirSync(directory).filter((n) => n.endsWith('.json')).length, 0);
  assert.equal(inbox.sweep(), 0);
});

test('a symlink is refused rather than followed', () => {
  const { directory, posts, inbox, warnings } = harness();
  const secret = join(directory, '..', 'secret.json');
  writeFileSync(secret, JSON.stringify({ channel: 'general', author: 'Not me', body: 'exfiltrated' }));
  symlinkSync(secret, join(directory, 'link.json'));
  assert.equal(inbox.sweep(), 0);
  assert.equal(posts.length, 0);
  assert.match(warnings.join('\n'), /not a regular file/);
});

test('a file that is too large is refused without being read', () => {
  const { posts, inbox, warnings, drop } = harness();
  drop('huge.json', JSON.stringify({ channel: 'general', author: 'A', body: 'x'.repeat(100_000) }));
  assert.equal(inbox.sweep(), 0);
  assert.equal(posts.length, 0);
  assert.match(warnings.join('\n'), /larger than/);
});

test('a prototype-polluting key cannot reach the object the post is built from', () => {
  const { posts, inbox, drop } = harness();
  drop('nasty.json', '{"channel":"general","author":"A","body":"hi","__proto__":{"polluted":true}}');
  assert.equal(inbox.sweep(), 1);
  assert.equal(posts.length, 1);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('a name that is not a plain file name is never opened', () => {
  const { directory, posts, inbox } = harness();
  mkdirSync(join(directory, 'sub'), { recursive: true });
  writeFileSync(join(directory, 'sub', 'inner.json'),
    JSON.stringify({ channel: 'general', author: 'A', body: 'nested' }));
  // A traversing name cannot be created as a file, so the guard that matters is
  // that only plain names in this directory are considered at all.
  assert.equal(inbox.sweep(), 0);
  assert.equal(posts.length, 0);
});

test('a malformed file is moved aside rather than silently discarded', () => {
  const { directory, inbox, warnings, drop } = harness();
  drop('broken.json', 'not json at all');
  assert.equal(inbox.sweep(), 0);
  assert.equal(readdirSync(join(directory, 'rejected')).length, 1);
  assert.match(warnings.join('\n'), /refused broken\.json/);
});

test('an unknown channel is refused by name', () => {
  const { inbox, warnings, drop } = harness();
  drop('elsewhere.json', JSON.stringify({ channel: 'nowhere', author: 'A', body: 'hi' }));
  assert.equal(inbox.sweep(), 0);
  assert.match(warnings.join('\n'), /no channel named 'nowhere'/);
});

test('a missing field is named in the refusal', () => {
  const { inbox, warnings, drop } = harness();
  drop('partial.json', JSON.stringify({ channel: 'general', author: 'A' }));
  assert.equal(inbox.sweep(), 0);
  assert.match(warnings.join('\n'), /'body' is required/);
});

test('one sweep takes a bounded number of files', () => {
  const { posts, inbox, drop } = harness();
  for (let index = 0; index < 50; index += 1)
    drop(`m${String(index).padStart(3, '0')}.json`, JSON.stringify({ channel: 'general', author: 'A', body: `m${index}` }));
  assert.equal(inbox.sweep(), 32);
  assert.equal(posts.length, 32);
  // The rest are still waiting, not lost.
  assert.equal(inbox.sweep(), 18);
});

test('a redelivered file posts under the same occurrence, so the store can refuse the duplicate', () => {
  const { posts, inbox, drop } = harness();
  const body = JSON.stringify({ channel: 'general', author: 'A', body: 'once', clientMessageId: 'fixed-id' });
  drop('a.json', body);
  inbox.sweep();
  drop('b.json', body);
  inbox.sweep();
  assert.equal(posts.length, 2);
  assert.equal(posts[0].occurrence, 'fixed-id');
  assert.equal(posts[1].occurrence, 'fixed-id');
});
