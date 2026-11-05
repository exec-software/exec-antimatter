import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AskActivityCard, isAskActivity } from '../renderer/src/components/chat/AskActivityCard';
import type { ToolActivity } from '../renderer/src/types';

/**
 * The question card.
 *
 * What is checked here is the thing a worse version of this card would get wrong: you must be
 * able to tell, without expanding anything, whether a question is still waiting on you. A card
 * that looks answerable when nothing is listening is how a person comes back in ten minutes to
 * find the turn died waiting — and a card that looks settled when it is not is how a model sits
 * idle while someone reads around it.
 */

const QUESTION = {
  questions: [{
    header: 'Store',
    question: 'Which store should the cache use?',
    options: [
      { label: 'sqlite', description: 'Survives a restart; one more file in the project.' },
      { label: 'in-memory', description: 'Nothing on disk; cold after every launch.' },
    ],
  }],
};

const activity = (over: Partial<ToolActivity> = {}): ToolActivity => ({
  callId: 'call-1',
  activityId: 'occurrence-1',
  requestId: 'run-1',
  serverId: 'antimatter.ask',
  serverName: 'Ask',
  toolName: 'ask_user',
  tier: 'read',
  args: JSON.stringify(QUESTION),
  status: 'running',
  ...over,
});

const render = (over: Partial<ToolActivity> = {}, isActive = true) =>
  renderToStaticMarkup(createElement(AskActivityCard, { activity: activity(over), isActive }));

test('only the app’s own server gets the question card', () => {
  assert.equal(isAskActivity(activity()), true);
  // A configured server advertising the same tool name must not borrow the app's framing to put
  // its own prompt in front of the person.
  assert.equal(isAskActivity(activity({ serverId: 'plugin.lookalike' })), false);
  assert.equal(isAskActivity(activity({ serverId: 'antimatter', toolName: 'run_command' })), false);
});

test('a waiting question shows the question, the options, and that the turn is held', () => {
  const markup = render();
  assert.match(markup, /Which store should the cache use\?/);
  assert.match(markup, /Store/);
  assert.match(markup, /sqlite/);
  assert.match(markup, /Survives a restart/, 'the trade-off is shown, not just the label');
  assert.match(markup, /in-memory/);
  assert.match(markup, /Waiting on you/);
  assert.match(markup, /turn is paused here/i);
  assert.match(markup, />Send answer</);
});

test('free text and discussing are always offered, never withheld by the model', () => {
  const markup = render();
  // The options are the model's guess at the answers. The box is for when the guess is wrong,
  // which is exactly when a multiple-choice question does the most damage.
  assert.match(markup, /Or say it in your own words/);
  assert.match(markup, />Discuss this</);
  assert.match(markup, />Not now</);
  // A question with no options at all is still answerable.
  const open = render({ args: JSON.stringify({ questions: [{ header: 'Name', question: 'What should it be called?', options: [] }] }) });
  assert.match(open, /Your answer…/);
  assert.match(open, />Send answer</);
});

test('the send button is disabled until something has been answered', () => {
  // Server-rendered first paint: nothing is chosen and nothing is typed, so there is nothing to
  // send. An enabled button here would post an empty decision as though it were a real one.
  const markup = render();
  const at = markup.indexOf('Send answer');
  assert.ok(at > 0, 'the send button is rendered');
  const button = markup.slice(markup.lastIndexOf('<button', at), at);
  assert.match(button, /disabled=""/);
  // Discussing and declining stay available: they need no answer to be meaningful.
  const discuss = markup.slice(markup.lastIndexOf('<button', markup.indexOf('Discuss this')), markup.indexOf('Discuss this'));
  assert.doesNotMatch(discuss, /disabled=""/);
});

test('a question whose turn has died says so instead of offering buttons', () => {
  const markup = render({}, false);
  assert.match(markup, /Interrupted/);
  assert.match(markup, /never given an answer/);
  // The decisive part: no way to answer something nothing is waiting for.
  assert.doesNotMatch(markup, />Send answer</);
  assert.doesNotMatch(markup, />Discuss this</);
});

test('a settled question reports what the model was told', () => {
  const markup = render({ status: 'done', result: 'The user answered:\nStore: Which store should the cache use?\n  → sqlite' });
  assert.match(markup, /Answered/);
  assert.match(markup, /What the model was told/);
  assert.doesNotMatch(markup, />Send answer</, 'a decided question is reported, not re-offered');
});

test('several questions are asked together and counted', () => {
  const markup = render({
    args: JSON.stringify({
      questions: [
        { header: 'Store', question: 'Which store?', options: ['sqlite'] },
        { header: 'Migration', question: 'May it drop the old column?', options: ['Yes', 'No'] },
      ],
    }),
  });
  assert.match(markup, /2 decisions needed from you/);
  assert.match(markup, /May it drop the old column\?/);
});

test('an unreadable question is reported as a fault, not drawn as an empty form', () => {
  const markup = render({ args: '{"questions":[]}' });
  assert.match(markup, /could not be read/);
  assert.doesNotMatch(markup, />Send answer</);
  assert.doesNotMatch(markup, />Discuss this</);
  // Same for arguments that are not JSON at all.
  assert.match(render({ args: 'not json' }), /could not be read/);
});

test('a failed call shows why it was not asked', () => {
  const markup = render({ status: 'failed', result: 'There is nobody watching this run to answer a question.' }, true);
  assert.match(markup, /Not asked/);
  assert.match(markup, /nobody watching/);
});
