import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_TOOLS } from '../mcp/tools/index';
import { MOVIE_TOOL_NAMES as DECLARED_NAMES, movieTools } from '../mcp/tools/movie';
import { MOVIE_TOOL_NAMES, movieToolHandler } from '../src/main/movieTools';
import { applyProductionEdits, emptyProduction, type Production, type ProductionEdit } from '../src/api/movie';

/**
 * The Movie tools, as a seam rather than as a unit.
 *
 * A tool declared in the server and never intercepted in main reaches the `run` body that throws
 * "route your turn through the app", which looks like a bug in the app rather than a missing
 * registration. A tool intercepted in main and never declared is simply invisible to the model.
 * Neither shows up in a test of the handler alone, so the first tests here are about the wiring.
 */

/** An in-memory production, so the handler is tested without the store underneath it. */
function harness(options: { open?: boolean; productionId?: string | null } = {}) {
  let production: Production = emptyProduction('prod-1', 'Test film');
  const handler = movieToolHandler({
    assertOpen: () => {
      if (options.open === false) throw new Error('No licence is installed for this expansion.');
    },
    openProductionId: () => (options.productionId === undefined ? 'prod-1' : options.productionId),
    read: () => production,
    edit: (_id, edits) => {
      production = applyProductionEdits(production, edits as ProductionEdit[]);
      return production;
    },
  });
  return {
    call: (name: string, args: Record<string, unknown> = {}) => handler(name, args, { model: 'test-model' } as never),
    current: () => production,
  };
}

// ------------------------------------------------------------------ the wiring

test('every Movie tool main answers is also declared to the model', () => {
  for (const name of MOVIE_TOOL_NAMES) {
    assert.ok(
      movieTools.some((tool) => tool.name === name),
      `${name} is intercepted in main but never declared, so no model can call it`
    );
  }
});

test('every Movie tool declared to the model is answered in main', () => {
  for (const tool of movieTools) {
    assert.ok(
      (MOVIE_TOOL_NAMES as readonly string[]).includes(tool.name),
      `${tool.name} is declared but not intercepted, so calling it reaches the unreachable stub`
    );
  }
  assert.deepEqual([...DECLARED_NAMES].sort(), [...MOVIE_TOOL_NAMES].sort());
});

test('the Movie tools are in the list the server actually serves', () => {
  // The registration this guards is one line in mcp/tools/index.ts, and forgetting it means a
  // complete, tested, documented feature that no model is ever told about.
  for (const name of MOVIE_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((tool) => tool.name === name), `${name} is missing from ALL_TOOLS`);
  }
});

test('no tool declares the production as an argument', () => {
  // A model that could name a production could name one belonging to work it was never shown.
  for (const tool of movieTools) {
    const properties = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
    for (const key of properties) {
      assert.equal(/^production/.test(key), false, `${tool.name} takes ${key}, which must come from the workbench`);
    }
  }
});

test('every declared tool has a description a model can act on', () => {
  for (const tool of movieTools) {
    assert.ok(tool.description.length > 80, `${tool.name} is described too thinly to be used correctly`);
    assert.ok(tool.inputSchema, `${tool.name} has no input schema`);
  }
});

// ------------------------------------------------------------------ refusals

test('the tools refuse when the universe is not open, and say why', async () => {
  const movie = harness({ open: false });
  await assert.rejects(movie.call('movie_read'), /No licence/);
});

test('with no production open the refusal says what the person has to do', async () => {
  const movie = harness({ productionId: null });
  await assert.rejects(movie.call('movie_read'), /Ask the person to open or create one/);
});

test('an unknown tool name is refused rather than silently doing nothing', async () => {
  const movie = harness();
  await assert.rejects(movie.call('movie_explode'), /is not a Movie tool/);
});

test('a refusal names what to do next, because the model cannot see the screen', async () => {
  const movie = harness();
  await assert.rejects(movie.call('movie_update_shot', { id: 'ghost', slug: 'x' }), /call movie_read again/);
  await assert.rejects(movie.call('movie_remove_shot', { id: 'ghost' }), /call movie_read again/);
  await assert.rejects(movie.call('movie_select_take', { shot: 'ghost' }), /call movie_read again/);
  await assert.rejects(movie.call('movie_add_shot', { slug: 'x', beat: 'ghost' }), /call movie_read again/);
  await assert.rejects(movie.call('movie_add_shot', { slug: 'x', before: 'ghost' }), /call movie_read again/);
  await assert.rejects(movie.call('movie_order_cut', { shots: ['ghost'] }), /not shots in this production/);
});

test('a tool with nothing to change refuses rather than reporting a no-op as success', async () => {
  const movie = harness();
  await assert.rejects(movie.call('movie_set_brief'), /needs a brief/);
  await assert.rejects(movie.call('movie_add_beat'), /needs a title/);
  await assert.rejects(movie.call('movie_add_shot'), /needs a slug/);
  await assert.rejects(movie.call('movie_order_cut', { shots: [] }), /needs the shot ids/);
  const added = await movie.call('movie_add_shot', { slug: 'the coast' });
  const id = /shot-[0-9a-f]+/.exec(added)![0];
  await assert.rejects(movie.call('movie_update_shot', { id }), /at least one of/);
});

// ------------------------------------------------------------------ what the tools actually do

test('a shot added by a tool lands in the cut and says it has no footage', async () => {
  const movie = harness();
  const result = await movie.call('movie_add_shot', { slug: 'the coast', intent: 'establish', seconds: 6 });
  assert.match(result, /cut position 1/);
  assert.match(result, /plays as a slug/);
  const shot = movie.current().shots[0];
  assert.equal(shot.slug, 'the coast');
  assert.equal(shot.seconds, 6);
  assert.deepEqual(movie.current().cut.map((entry) => entry.shotId), [shot.id]);
});

test('a shot can be added outside the cut when that is what was asked', async () => {
  const movie = harness();
  const result = await movie.call('movie_add_shot', { slug: 'an alt', in_cut: false });
  assert.match(result, /not in the cut/);
  assert.equal(movie.current().cut.length, 0);
});

test('a tool records the model as the author, never the person', async () => {
  const movie = harness();
  await movie.call('movie_add_shot', { slug: 'a shot' });
  await movie.call('movie_add_beat', { title: 'a beat' });
  assert.deepEqual(movie.current().shots[0].author, { kind: 'model', name: 'test-model' });
  assert.deepEqual(movie.current().boards[0].author, { kind: 'model', name: 'test-model' });
});

test('a shot size is accepted case-insensitively and nonsense is simply left unset', async () => {
  const movie = harness();
  await movie.call('movie_add_shot', { slug: 'a', size: 'CLOSE' });
  await movie.call('movie_add_shot', { slug: 'b', size: 'dutch angle from a crane' });
  assert.equal(movie.current().shots[0].size, 'close');
  assert.equal(movie.current().shots[1].size, undefined);
});

test('reordering the cut keeps every shot and every take', async () => {
  const movie = harness();
  const ids: string[] = [];
  for (const slug of ['one', 'two', 'three']) {
    ids.push(/shot-[0-9a-f]+/.exec(await movie.call('movie_add_shot', { slug }))![0]);
  }
  const result = await movie.call('movie_order_cut', { shots: [ids[2], ids[0]] });
  assert.match(result, /now 2 shots/);
  assert.match(result, /taken out of the cut but kept/);
  assert.deepEqual(movie.current().cut.map((entry) => entry.shotId), [ids[2], ids[0]]);
  assert.equal(movie.current().shots.length, 3, 'a shot out of the cut is not a deleted shot');
});

test('a duplicated id in an ordering is taken once, not twice', async () => {
  const movie = harness();
  const id = /shot-[0-9a-f]+/.exec(await movie.call('movie_add_shot', { slug: 'one' }))![0];
  await movie.call('movie_order_cut', { shots: [id, id] });
  assert.deepEqual(movie.current().cut.map((entry) => entry.shotId), [id]);
});

test('changing a prompt tells the model that existing takes keep theirs', async () => {
  const movie = harness();
  const id = /shot-[0-9a-f]+/.exec(await movie.call('movie_add_shot', { slug: 'one' }))![0];
  const result = await movie.call('movie_update_shot', { id, prompt: 'a new idea' });
  assert.match(result, /keep the prompt they were made from/);
});

test('removing a shot with no footage says so plainly', async () => {
  const movie = harness();
  const id = /shot-[0-9a-f]+/.exec(await movie.call('movie_add_shot', { slug: 'one' }))![0];
  assert.match(await movie.call('movie_remove_shot', { id }), /^Removed shot-[0-9a-f]+\.$/);
  assert.equal(movie.current().shots.length, 0);
  assert.equal(movie.current().cut.length, 0, 'the cut must not keep naming a shot that is gone');
});

test('a take can be deselected back to a slug without losing it', async () => {
  const movie = harness();
  const id = /shot-[0-9a-f]+/.exec(await movie.call('movie_add_shot', { slug: 'one' }))![0];
  const result = await movie.call('movie_select_take', { shot: id, take: '' });
  assert.match(result, /plays as a slug/);
  assert.match(result, /still there/);
});

test('selecting a take that does not exist is refused by name', async () => {
  const movie = harness();
  const id = /shot-[0-9a-f]+/.exec(await movie.call('movie_add_shot', { slug: 'one' }))![0];
  await assert.rejects(movie.call('movie_select_take', { shot: id, take: 'no-such-take' }), /has no take no-such-take/);
});

test('the brief and the look are set separately, because one is sent to a model', async () => {
  const movie = harness();
  const result = await movie.call('movie_set_brief', { brief: 'A short about rain.', look: '16mm, grainy' });
  assert.match(result, /brief, lookbook/);
  assert.equal(movie.current().brief, 'A short about rain.');
  assert.equal(movie.current().lookbook, '16mm, grainy');
});

test('movie_read reads as a document, and reports a slug as a normal state', async () => {
  const movie = harness();
  await movie.call('movie_add_shot', { slug: 'the coast', intent: 'establish' });
  const text = await movie.call('movie_read');
  assert.match(text, /Production "Test film"/);
  assert.match(text, /no footage yet/);
  assert.match(text, /intent: establish/);
});
