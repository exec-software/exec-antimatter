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

test('work the model needs next is not handed to an agent', () => {
  const offered = at('ask', ['read_file', 'start_agent', 'wait_for_agents']);
  assert.match(offered, /Hand off only work you do not need for your own next step\. If what you do next depends on the answer, find it out yourself/);
  assert.match(offered, /never do the same work as an agent you started/);
});
