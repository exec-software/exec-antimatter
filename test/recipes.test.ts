import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensurePeers,
  forModel,
  list,
  peerInUse,
  summarize,
  useRoot,
  type Recipe,
  type RecipePeer,
} from '../src/main/recipes';

const withRecipes = <T>(files: Record<string, string>, body: () => T): T => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-recipes-'));
  try {
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
    useRoot(root);
    return body();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const peer = (overrides: Partial<RecipePeer> = {}): RecipePeer => ({
  name: 'second box',
  host: '192.0.2.10',
  port: 50052,
  start: 'start-it {host}',
  startTimeoutMs: 5_000,
  ...overrides,
});

const recipe = (peers: RecipePeer[]): Recipe => ({
  id: 'two-box',
  name: 'Two boxes',
  models: ['big-model'],
  peers,
  path: '/nowhere',
});

test('no recipes directory means nothing changes', () => {
  useRoot(join(tmpdir(), 'antimatter-recipes-does-not-exist'));
  assert.deepEqual(list(), []);
  assert.equal(forModel('big-model'), null);
});

test('a recipe is read and matched to its models case-insensitively', () => {
  withRecipes(
    {
      'two-box.yaml': [
        'id: two-box',
        'name: Two boxes',
        'models: [Big-Model, other-model]',
        'peers:',
        '  - name: second box',
        '    host: 192.0.2.10',
        '    port: 50052',
        '    start: start-it {host}',
      ].join('\n'),
    },
    () => {
      const recipes = list();
      assert.equal(recipes.length, 1);
      assert.equal(recipes[0].peers[0].host, '192.0.2.10');
      assert.equal(recipes[0].peers[0].start, 'start-it {host}');
      assert.equal(forModel('big-model')?.id, 'two-box');
      assert.equal(forModel('BIG-MODEL')?.id, 'two-box');
      assert.equal(forModel('a-model-that-fits'), null);
    }
  );
});

test('a recipe with no models or no peers asks for nothing and is dropped', () => {
  withRecipes(
    {
      'no-peers.yaml': 'id: no-peers\nmodels: [x]\n',
      'no-models.yaml': 'id: no-models\npeers:\n  - host: 192.0.2.10\n    port: 1\n',
    },
    () => assert.deepEqual(list(), [])
  );
});

test('a peer whose host could become a second command is refused', () => {
  withRecipes(
    {
      'bad.yaml': [
        'id: bad',
        'models: [m]',
        'peers:',
        '  - host: "192.0.2.10; rm -rf /"',
        '    port: 50052',
      ].join('\n'),
    },
    // The peer is dropped, which leaves the recipe with none, which drops the recipe.
    () => assert.deepEqual(list(), [])
  );
});

test('a peer already listening is neither started nor waited for', async () => {
  let started = 0;
  const outcomes = await ensurePeers(recipe([peer()]), {
    probe: async () => true,
    run: async () => {
      started += 1;
    },
  });
  assert.equal(started, 0);
  assert.equal(outcomes[0].ready, true);
  assert.equal(outcomes[0].started, false);
  assert.equal(summarize(recipe([peer()]), outcomes), null);
});

test('a peer that is down is started, then waited for until it answers', async () => {
  const commands: string[] = [];
  let answers = false;
  const outcomes = await ensurePeers(recipe([peer()]), {
    probe: async () => answers,
    run: async (command, target) => {
      commands.push(command.replaceAll('{host}', target.host));
      answers = true;
    },
    sleep: async () => undefined,
  });
  assert.deepEqual(commands, ['start-it 192.0.2.10']);
  assert.equal(outcomes[0].ready, true);
  assert.equal(outcomes[0].started, true);
  assert.match(summarize(recipe([peer()]), outcomes) ?? '', /was started and is listening/);
});

test('a peer that never comes up is reported rather than thrown', async () => {
  let clock = 0;
  const outcomes = await ensurePeers(recipe([peer()]), {
    probe: async () => false,
    run: async () => undefined,
    now: () => (clock += 1_000),
    sleep: async () => undefined,
  });
  assert.equal(outcomes[0].ready, false);
  assert.match(outcomes[0].detail, /did not answer within/);
  assert.match(summarize(recipe([peer()]), outcomes) ?? '', /will fail to load without it/);
});

test('a peer with no start command is reported, not guessed at', async () => {
  const outcomes = await ensurePeers(recipe([peer({ start: null })]), { probe: async () => false });
  assert.equal(outcomes[0].ready, false);
  assert.match(outcomes[0].detail, /does not say how to start it/);
});

test('a start command that fails is reported with the reason', async () => {
  const outcomes = await ensurePeers(recipe([peer()]), {
    probe: async () => false,
    run: async () => {
      throw new Error('Permission denied (publickey).');
    },
  });
  assert.equal(outcomes[0].ready, false);
  assert.match(outcomes[0].detail, /could not be started: Permission denied/);
});

test('a shard already serving this machine is ready, and is never probed or started', async () => {
  // The bug this fixes: `ggml-rpc-server` serves one client, so once llama-server has attached,
  // a probe to its port gets no answer and times out. Measured on the real pair — the peer had an
  // established socket from this box and inference was running — the probe said false. Antimatter
  // then tried to SSH-start a machine that was already working, failed, and told the person on
  // every turn that the model would not load, while the model was loaded and answering.
  let probed = 0;
  let started = 0;
  const outcomes = await ensurePeers(recipe([peer()]), {
    inUse: async () => true,
    probe: async () => {
      probed += 1;
      return false;
    },
    run: async () => {
      started += 1;
    },
  });

  assert.equal(probed, 0, 'a peer we are already talking to has nothing left to ask');
  assert.equal(started, 0);
  assert.equal(outcomes[0].ready, true);
  assert.equal(outcomes[0].started, false);
  assert.match(outcomes[0].detail, /already serving this machine/);
  assert.equal(summarize(recipe([peer()]), outcomes), null, 'nothing to report when everything is up');
});

test('a peer nothing is talking to still falls through to the probe', async () => {
  const outcomes = await ensurePeers(recipe([peer()]), { inUse: async () => false, probe: async () => true });
  assert.equal(outcomes[0].ready, true);
  assert.match(outcomes[0].detail, /already listening/);
});

test('peerInUse reads the socket table and never throws on what it cannot answer', async () => {
  // 192.0.2.0/24 is TEST-NET-1: routable nowhere, so nothing can be established to it.
  assert.equal(await peerInUse('192.0.2.10', 50052), false);
  // A name that cannot resolve is not an error here, just an unanswered question.
  assert.equal(await peerInUse('no-such-host.invalid', 50052), false);
});
