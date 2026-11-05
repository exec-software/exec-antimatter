import assert from 'node:assert/strict';
import test from 'node:test';
import { explicitlyRequiredTool } from '../src/main/toolIntent';

test('recognizes an explicit Bash instruction from the failing carbon', () => {
  assert.equal(explicitlyRequiredTool('Now use bash to open it in the system editor.'), 'run_command');
  assert.equal(explicitlyRequiredTool('Please run_command with pwd.'), 'run_command');
  assert.equal(
    explicitlyRequiredTool(
      'Can you at least use your CLI tools to open a document on the desktop in an editor so I can see that specific tool works?'
    ),
    'open_path'
  );
});

test('does not force a tool for explanatory Bash questions', () => {
  assert.equal(explicitlyRequiredTool("Why won't the model use bash commands?"), undefined);
  assert.equal(explicitlyRequiredTool('What command would I type in Bash?'), undefined);
  assert.equal(explicitlyRequiredTool('Can you explain when to use Bash?'), undefined);
  assert.equal(explicitlyRequiredTool('Do not use bash; just explain the command.'), undefined);
  assert.equal(explicitlyRequiredTool('Never use the shell for this.'), undefined);
  assert.equal(explicitlyRequiredTool('Avoid calling run_command.'), undefined);
  assert.equal(explicitlyRequiredTool("I don't want you to use Bash."), undefined);
  assert.equal(explicitlyRequiredTool('Can you not use Bash for this?'), undefined);
  assert.equal(explicitlyRequiredTool('Please refrain from using Bash.'), undefined);
  assert.equal(explicitlyRequiredTool('This works with Bash but fails in zsh.'), undefined);
  assert.equal(explicitlyRequiredTool('I wrote it with Bash.'), undefined);
});
