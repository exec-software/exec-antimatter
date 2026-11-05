import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPrompt } from '../src/main/orchestrator/workflow';

test('renders nested arrays with common Liquid filters', () => {
  const rendered = renderPrompt(
    '{% for blocker in issue.blockedBy %}{{ blocker.identifier | downcase }}={{ blocker.state }};{% endfor %} labels={{ issue.labels | join: ", " }} attempt={{ attempt | default: "first" }}',
    {
      blockedBy: [
        { identifier: 'AM-1', state: 'Done' },
        { identifier: 'AM-2', state: 'Todo' },
      ],
      labels: ['backend', 'urgent'],
    },
    null
  );
  assert.equal(rendered, 'am-1=Done;am-2=Todo; labels=backend, urgent attempt=first');
});

test('fails unknown variables, filters, and unclosed tags', () => {
  assert.throws(() => renderPrompt('{{ issue.missing }}', {}, null), /Unknown template variable/);
  assert.throws(() => renderPrompt('{{ issue.title | imaginary }}', { title: 'x' }, null), /Unknown template filter/);
  assert.throws(() => renderPrompt('{% for label in issue.labels %}{{ label }}', { labels: [] }, null), /Unclosed/);
});

test('does not interpret Liquid-looking issue text as template syntax', () => {
  assert.equal(
    renderPrompt('Task: {{ issue.description }}', { description: 'Preserve {{raw}} and {% literal %} exactly.' }, null),
    'Task: Preserve {{raw}} and {% literal %} exactly.'
  );
});

test('renders loops whose inner collection comes from the outer loop scope', () => {
  assert.equal(
    renderPrompt(
      '{% for group in issue.groups %}[{{ group.name }}:{% for item in group.items %}{{ item }}{% endfor %}]{% endfor %}',
      { groups: [{ name: 'a', items: ['1', '2'] }, { name: 'b', items: ['3'] }] },
      null
    ),
    '[a:12][b:3]'
  );
});

test('keeps pipes inside quoted literals and supports conditional blocks', () => {
  assert.equal(
    renderPrompt(
      '{{ "a|b" }} {{ issue.labels | join: " | " }} {% if issue.labels contains "urgent" %}now{% else %}later{% endif %}',
      { labels: ['backend', 'urgent'] },
      null
    ),
    'a|b backend | urgent now'
  );
});
