import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeInstructions, systemPrompt, withSituation } from '../src/main/prompt';

const at = (mode: 'full' | 'ask' | 'read', tools: string[]) =>
  systemPrompt({ workspace: '/work', workspaceConfirmed: true, mode, tools });

test('model instructions and a caller brief compose in a stable order', () => {
  assert.equal(mergeInstructions('  Model brief.  ', null, 'Caller brief.'), 'Model brief.\n\nCaller brief.');
  assert.equal(mergeInstructions('', undefined, '   '), null);
});

test('durable model instructions precede current workspace and safety grounding', () => {
  const prompt = withSituation('Model brief: prefer terse replies.', {
    workspace: '/work',
    workspaceConfirmed: true,
    mode: 'read',
    tools: ['read_file'],
  });
  const brief = prompt.indexOf('Model brief: prefer terse replies.');
  const situation = prompt.indexOf('You are the assistant inside Antimatter');
  const permission = prompt.indexOf('Permissions are set to read-only.');
  const accuracy = prompt.indexOf('Be accurate about what you did.');
  assert.ok(brief >= 0 && brief < situation, 'model brief is composed before live situation grounding');
  assert.ok(situation < permission && permission < accuracy, 'permission and accuracy policy remain later');
});

test('an agent whose every tool is named is not told it has "0 more"', () => {
  // The Shell runner's prompt read "run_command, read_file, list_directory and 0 more".
  const prompt = at('full', ['run_command', 'read_file', 'list_directory']);
  assert.match(prompt, /right now — run_command, read_file and list_directory\./);
  assert.doesNotMatch(prompt, /and 0 more/);

  assert.match(at('full', ['read_file']), /right now — read_file\./);
  assert.match(at('full', ['read_file', 'git_log', 'git_diff']), /right now — read_file and 2 more\./);
  assert.match(at('full', ['git_log', 'git_diff']), /right now — 2 of them\./);
});

test('a turn that can change things is told to install inside the project', () => {
  for (const mode of ['full', 'ask'] as const) {
    const prompt = at(mode, ['run_command']);
    assert.match(prompt, /inside the project — a virtual environment/, mode);
    assert.match(prompt, /--break-system-packages/, mode);
  }
  // Read-only turns install nothing, so the advice would only be noise there.
  assert.doesNotMatch(at('read', ['read_file']), /virtual environment/);
});

test('launch_program is explained only where it is offered', () => {
  const offered = at('full', ['run_command', 'launch_program', 'write_file']);
  assert.match(offered, /run_command, launch_program and write_file\./);
  assert.match(offered, /goes through launch_program, which starts it, checks that it stays up/);
  assert.doesNotMatch(at('full', ['run_command']), /launch_program/);
});

test('start_agent is explained only where it is offered, as work that runs alongside the turn', () => {
  const offered = at('ask', ['read_file', 'start_agent', 'wait_for_agents']);
  assert.match(offered, /right now — start_agent, read_file and 1 more\./);
  assert.match(offered, /returns at once: the agent works alongside you while you carry on with your own part/);
  assert.match(offered, /Your turn does not end while an agent you started is still working/);
  assert.doesNotMatch(at('ask', ['read_file']), /start_agent|wait_for_agents/);
});

test('the reply limit is spelled out where files can be written', () => {
  const prompt = (tools: string[], maxOutputTokens?: number) =>
    systemPrompt({ workspace: '/work', workspaceConfirmed: true, mode: 'full', tools, maxOutputTokens });
  assert.match(
    prompt(['write_file'], 8192),
    /Each reply you write holds at most 8192 tokens, and the arguments of a tool call count toward it — roughly 500 lines of code\. Write a file longer than that in parts/
  );
  assert.match(prompt(['write_file'], 4096), /roughly 250 lines of code/);
  assert.match(prompt(['write_file'], 512), /roughly 50 lines of code/);
  assert.doesNotMatch(prompt(['write_file']), /holds at most/);
  assert.doesNotMatch(prompt(['read_file'], 8192), /holds at most/);
});

test('breadth is handed to agents and the next step is kept', () => {
  const offered = at('ask', ['read_file', 'start_agent', 'wait_for_agents']);
  // The rails that remain: keep the step you are about to build on, and never duplicate an agent.
  assert.match(offered, /Keep the one step whose answer you are about to build on/);
  assert.match(offered, /never do the same work as an agent you started/);
  // And the encouragement that replaced "an agent costs a whole run". A model that reads its
  // instructions literally was told not to delegate anything it needed next, which during serial
  // exploration is everything: carbon 2d0d2b60 ran 33 hours and started no agent at all.
  assert.match(offered, /Reach for an agent whenever a piece of this job stands on its own/);
  assert.match(offered, /each gets its own budget rather than spending this turn's/);
});

test('the shared scratch directory is named only when it exists, and only to a model that writes', () => {
  const base = { workspace: '/work', workspaceConfirmed: true, mode: 'full' as const };
  const scratchPath = '/work/.antimatter/scratch';

  const writing = systemPrompt({ ...base, tools: ['write_file', 'read_file'], scratchPath });
  assert.match(writing, /\/work\/\.antimatter\/scratch/);
  // Both halves of why it exists: the project stays clean, and the next agent finds the work.
  assert.match(writing, /ignored by git/);
  assert.match(writing, /another agent working here reads the same directory/);

  // Silence when the directory is not there. Naming a path the model cannot find is worse than
  // saying nothing — it writes there anyway and creates it somewhere nobody expects.
  assert.doesNotMatch(systemPrompt({ ...base, tools: ['write_file', 'read_file'] }), /scratch/);

  // A read-only toolset has nothing to put there, and this rides on every turn.
  assert.doesNotMatch(systemPrompt({ ...base, tools: ['read_file'], scratchPath }), /scratch/);

  // A conversation with no tools at all keeps its short, separate grounding.
  assert.doesNotMatch(systemPrompt({ ...base, tools: [], scratchPath }), /scratch/);
});
