import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatRequest, StreamResult } from '../src/api/types';
import { installHint } from '../mcp/tools/shell';
import { DEFAULT_MACHINE_WIDE, normalizeMachineWide } from '../src/main/developerSettings';
import { runToolLoop, type StreamingProvider, type ToolActivity, type ToolRuntime } from '../src/main/toolLoop';
import {
  allowedUnattended,
  decide,
  denialReason,
  isTrustedTool,
  machineWide,
  machineWideAdvice,
  needsLocalInput,
  tierOf,
} from '../src/main/toolPolicy';

const command = (line: string) => ({ command: line });

test('commands that reach past the project are recognised, with why', () => {
  // What qwen3-coder-next-80b ran in carbon 48f42447, with full access.
  assert.match(machineWide('run_command', command('pip3 install --break-system-packages pillow tk 2>&1 | tail -20')) ?? '', /break-system-packages/);
  assert.match(
    machineWide('run_command', command('apt-get update -qq && apt-get install -y -qq python3-pil.imagetk 2>&1 | tail -10')) ?? '',
    /operating system's packages/
  );

  for (const line of [
    'sudo apt install python3-pil.imagetk',
    'cd /x && sudo make install',
    'echo y | sudo tee /etc/hosts',
    'x=$(sudo cat /etc/shadow)',
    'apt-get -y install foo',
    'dpkg -i thing.deb',
    'pacman -Syu',
    'snap install code --classic',
    'npm install -g typescript',
    'npm i --global pnpm',
    'yarn global add serve',
    'pip install --user requests',
    'python3 -m pip install -q --user numpy',
  ]) {
    assert.ok(machineWide('run_command', command(line)), line);
  }
  assert.ok(machineWide('launch_program', command('sudo ./server')));
});

test('commands that stay in the project, or only mention those words, are left alone', () => {
  for (const line of [
    'python3 -m venv .venv && .venv/bin/pip install pillow',
    'pip3 install pillow',
    'npm install',
    'npm install --save-dev typescript',
    'grep -rn "sudo " docs',
    "grep -r 'apt-get install' README.md",
    'apt list --installed | grep pil',
    'apt-cache policy python3-pil',
    'dpkg -l | grep pil',
    'echo pseudo apt install',
    'cat notes/sudoers.md',
    'python3 gimp_clone/gimp_clone.py',
  ]) {
    assert.equal(machineWide('run_command', command(line)), null, line);
  }
  // Only command lines are read.
  assert.equal(machineWide('write_file', { path: 'install.sh', content: 'sudo apt install x', command: 'sudo x' }), null);
});

test('full access still asks about them; the other modes are unchanged', () => {
  const risky = command('pip3 install --break-system-packages pillow');
  const local = command('python3 -m venv .venv');
  assert.equal(decide('run_command', 'full', risky), 'ask');
  assert.equal(decide('run_command', 'full', local), 'allow');
  assert.equal(decide('run_command', 'full'), 'allow');
  assert.equal(decide('run_command', 'ask', risky), 'ask');
  assert.equal(decide('run_command', 'read', risky), 'deny');
  assert.equal(decide('run_command', { mode: 'full', workspaceConfirmed: false }, risky), 'deny');
});

test('a familiar tool name confers no read or unattended authority on another MCP server', () => {
  assert.equal(isTrustedTool('read_file', 'antimatter'), true);
  assert.equal(isTrustedTool('read_file', 'untrusted.plugin'), false);
  assert.equal(tierOf('read_file', 'antimatter'), 'read');
  assert.equal(tierOf('read_file', 'untrusted.plugin'), 'danger');
  assert.equal(allowedUnattended('read_file', 'antimatter'), true);
  assert.equal(allowedUnattended('read_file', 'untrusted.plugin'), false);
  assert.equal(decide('read_file', { mode: 'read', serverId: 'untrusted.plugin' }), 'deny');
  assert.equal(decide('read_file', { mode: 'ask', serverId: 'untrusted.plugin' }), 'ask');
  assert.equal(decide('read_file', { mode: 'full', serverId: 'untrusted.plugin' }), 'ask');
  assert.equal(decide('read_file', { mode: 'full', serverId: 'antimatter' }), 'allow');
});

const visionArgs = (baseUrl: string) => ({
  path: 'screenshots/editor.png',
  question: 'What is broken?',
  vision_destination: { provider: 'fixture-host-c', model: 'qwen-vision', baseUrl },
});

test('remote image egress is explicit policy while loopback image analysis stays a read', () => {
  const local = visionArgs('http://127.0.0.1:18080/v1');
  const remote = visionArgs('http://192.0.2.220:18080/v1');
  assert.equal(machineWide('look_at_image', local), null);
  assert.equal(decide('look_at_image', 'read', local), 'allow');

  const caution = machineWide('look_at_image', remote) ?? '';
  assert.match(caution, /screenshots\/editor\.png/);
  assert.match(caution, /fixture-host-c/);
  assert.match(caution, /qwen-vision/);
  assert.match(caution, /http:\/\/192\.0\.2\.220:18080\/v1/);
  assert.equal(decide('look_at_image', 'ask', remote), 'ask');
  assert.equal(decide('look_at_image', 'full', remote), 'ask');
  assert.equal(decide('look_at_image', 'read', remote), 'deny');
  assert.match(machineWideAdvice(caution, 'look_at_image'), /No image was sent.*loopback.*future look_at_image/s);
  assert.doesNotMatch(machineWideAdvice(caution, 'look_at_image'), /virtual environment|venv/);
  assert.match(denialReason('look_at_image', true, '/workspace', remote), /Read only.*No image was sent/s);
});

const request: ChatRequest = {
  messages: [{ id: 'user', role: 'user', content: 'Make ImageTk available.' }],
  model: 'test',
  providerId: 'test',
  useTools: true,
};

function turn(line: string) {
  const ran: string[] = [];
  const results: StreamResult[] = [
    {
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'antimatter__run_command', arguments: JSON.stringify({ command: line }) } }],
    },
    { content: 'Understood.', toolCalls: [] },
  ];
  const provider: StreamingProvider = { stream: async () => results.shift()! };
  const runtime: ToolRuntime = {
    enabledTools: () => [
      {
        serverId: 'antimatter',
        serverName: 'Antimatter tools',
        tool: { name: 'run_command', description: 'Run Bash.', inputSchema: { type: 'object', properties: {} }, enabled: true },
      },
    ],
    async callTool(_server, _name, args) {
      ran.push(String(args.command));
      return { ok: true, text: 'exit 0' };
    },
  };
  return { provider, runtime, ran };
}

function visionTurn(baseUrl: string) {
  const calls: Array<{ args: Record<string, unknown>; prepared: unknown }> = [];
  const prepared = { apiKey: 'provider-api-secret', exactBaseUrl: `${baseUrl}?token=query-secret` };
  const results: StreamResult[] = [
    {
      content: '',
      toolCalls: [
        {
          id: 'vision-1',
          type: 'function',
          function: {
            name: 'antimatter_preview__look_at_image',
            arguments: JSON.stringify({ path: 'screenshots/editor.png', question: 'What is broken?' }),
          },
        },
      ],
    },
    { content: 'Understood.', toolCalls: [] },
  ];
  const provider: StreamingProvider = { stream: async () => results.shift()! };
  const runtime: ToolRuntime = {
    enabledTools: () => [
      {
        serverId: 'antimatter.preview',
        serverName: 'Preview',
        tool: {
          name: 'look_at_image',
          description: 'Analyze an image.',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          enabled: true,
        },
      },
    ],
    async prepareTool(_server, _name, args) {
      return { args: { ...args, vision_destination: { provider: 'fixture-host-c', model: 'qwen-vision', baseUrl } }, prepared };
    },
    async callTool(_server, _name, args, options) {
      calls.push({ args, prepared: options?.prepared });
      return { ok: true, text: 'A local answer.' };
    },
  };
  return { provider, runtime, calls, prepared };
}

test('with full access, a machine-wide command is put to the person, who can say no', async () => {
  const model = turn('pip3 install --break-system-packages pillow');
  const asked: ToolActivity[] = [];
  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: model.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async (activity) => {
      asked.push(activity);
      return false;
    },
  });

  assert.equal(asked.length, 1);
  assert.match(asked[0].caution ?? '', /break-system-packages installs outside any virtual environment/);
  assert.deepEqual(model.ran, []);
  const told = result.transcript.find((message) => message.role === 'tool')?.content ?? '';
  assert.match(told, /^run_command was declined, so nothing ran\. It was put to the user because it reaches past the project/);
  assert.match(told, /python3 -m venv \.venv, then \.venv\/bin\/pip install <package>/);
});

test('with full access, what stays in the project still runs without asking', async () => {
  const model = turn('python3 -m venv .venv && .venv/bin/pip install pillow');
  let asked = 0;
  await runToolLoop({
    provider: model.provider,
    toolRuntime: model.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => {
      asked += 1;
      return true;
    },
  });
  assert.equal(asked, 0);
  assert.deepEqual(model.ran, ['python3 -m venv .venv && .venv/bin/pip install pillow']);
});

test('loopback vision preparation runs without approval and carries opaque state only to execution', async () => {
  const model = visionTurn('http://127.0.0.1:18080/v1');
  let asked = 0;
  await runToolLoop({
    provider: model.provider,
    toolRuntime: model.runtime,
    request,
    runId: 'vision-local',
    mode: 'read',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => {
      asked += 1;
      return false;
    },
  });
  assert.equal(asked, 0);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].prepared, model.prepared);
  assert.doesNotMatch(JSON.stringify(model.calls[0].args), /provider-api-secret|query-secret/);
});

test('remote vision approval names the prepared destination and decline sends no pixels', async () => {
  const model = visionTurn('http://192.0.2.220:18080/v1');
  const asked: ToolActivity[] = [];
  await runToolLoop({
    provider: model.provider,
    toolRuntime: model.runtime,
    request,
    runId: 'vision-remote',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async (activity) => {
      asked.push(activity);
      return false;
    },
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0].caution ?? '', /fixture-host-c.*qwen-vision.*192\.0\.2\.220/s);
  assert.match(asked[0].caution ?? '', /screenshots\/editor\.png/);
  assert.doesNotMatch(`${asked[0].args}\n${asked[0].caution}`, /provider-api-secret|query-secret/);
  assert.deepEqual(model.calls, [], 'declining before callTool means no runtime can send pixels');
});

test('an unattended approval adapter refuses a prepared remote vision caution', async () => {
  const model = visionTurn('http://192.0.2.220:18080/v1');
  await runToolLoop({
    provider: model.provider,
    toolRuntime: model.runtime,
    request,
    runId: 'vision-unattended',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async (activity) => !activity.caution,
  });
  assert.deepEqual(model.calls, []);
});

test('read-only remote vision is denied without prompting and explains that no image left', async () => {
  const model = visionTurn('http://192.0.2.220:18080/v1');
  let asked = 0;
  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: model.runtime,
    request,
    runId: 'vision-read',
    mode: 'read',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => {
      asked += 1;
      return true;
    },
  });
  assert.equal(asked, 0);
  assert.deepEqual(model.calls, []);
  const told = result.transcript.find((message) => message.role === 'tool')?.content ?? '';
  assert.match(told, /Read only.*No image was sent/s);
});

test('install failures come with the way out', () => {
  // pip on Ubuntu 24.04, refusing.
  const pep668 = 'error: externally-managed-environment\n\n× This environment is externally managed\n╰─> To install Python packages system-wide, try apt install';
  assert.match(installHint(pep668) ?? '', /^\[note\] pip will not install into this Python.*python3 -m venv \.venv/);
  assert.match(installHint('Defaulting to user installation because normal site-packages is not writeable') ?? '', /virtual/);

  // The launch that started it.
  const traceback =
    "Traceback (most recent call last):\n  File \"/work/gimp_clone.py\", line 9, in <module>\n" +
    "ImportError: cannot import name 'ImageTk' from 'PIL' (/usr/lib/python3/dist-packages/PIL/__init__.py). Did you mean: 'Image'?";
  assert.match(installHint(traceback) ?? '', /operating system's own Python packages.*ImageTk.*python3 -m venv \.venv/);

  const apt = 'E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)';
  assert.match(installHint(apt) ?? '', /needs root, and installing system packages is the user's decision/);
  assert.match(installHint('sudo: a password is required') ?? '', /needs root/);

  assert.equal(installHint("ModuleNotFoundError: No module named 'numpy'"), null);
  assert.equal(installHint('[exit] 0\nall good'), null);
});

test('the console is revealed for a command that will ask for a password, and not for ordinary work', () => {
  // A miss here is worse than a false positive: the person never sees the prompt and the turn
  // looks hung, so every shape sudo actually arrives in has to match.
  for (const command of [
    'sudo apt install python3-pil.imagetk',
    'cd /x && sudo make install',
    'echo y | sudo tee /etc/hosts',
    'x=$(sudo cat /etc/shadow)',
    'time sudo systemctl restart nginx',
    'sudo',
    '(sudo -v)',
  ]) {
    assert.equal(needsLocalInput(command), true, `${command} must reveal the console`);
  }

  // The reason this exists: an agent turn is mostly these, and popping the console for each one
  // buries whatever the person was reading.
  for (const command of [
    'ls -la',
    'git status',
    'npm run typecheck',
    'grep -rn sudoku ./src',
    'echo "pseudonym"',
    'node scripts/test.mjs',
    '',
  ]) {
    assert.equal(needsLocalInput(command), false, `${command} must not steal focus`);
  }
  assert.equal(needsLocalInput(undefined), false);
  assert.equal(needsLocalInput(null), false);
})

test('reading and photographing the preview pane never asks, unlike the desktop screenshot', () => {
  // The pane is a view this application owns: no other window, no other display, and nothing
  // the person did not already put on their own screen inside this one. The desktop capture is
  // a different question and keeps its own gate.
  for (const mode of ['read', 'ask', 'full'] as const) {
    assert.equal(decide('preview_read', mode), 'allow', `preview_read must not prompt in ${mode}`);
    assert.equal(decide('preview_capture', mode), 'allow', `preview_capture must not prompt in ${mode}`);
  }
  // Still nothing machine-wide about either.
  assert.equal(machineWide('preview_read'), null);
  assert.equal(machineWide('preview_capture'), null);
})

test('a standing answer from the person runs machine-wide commands under full access', () => {
  // The switch exists for a box the person expects to be set up: `sudo` wired to a Vault
  // credential, an afternoon of apt-get, one answer rather than a dozen dialogs.
  const on = { mode: 'full' as const, machineWideWithoutAsking: true };
  for (const line of [
    'sudo apt-get install -y -qq libasound2-dev',
    'printf \'%s\' "$ANTIMATTER_VAULT_SUDO" | sudo -S -p \'\' mount /dev/sr0 /mnt/dvd',
    'apt-get install -y ffmpeg',
    'pip3 install --break-system-packages pillow',
    'pip install --user pillow',
    'npm install -g typescript',
  ]) {
    assert.equal(decide('run_command', on, command(line)), 'allow', `${line} must run unprompted`);
  }
  assert.equal(decide('launch_program', on, command('sudo gparted')), 'allow');
  assert.equal(decide('coding_run_command', on, command('sudo dnf install git'), ), 'allow');

  // It is a decision, not a claim about the call: the activity still carries why this reaches
  // past the project, so what was changed is on the record either way.
  assert.match(machineWide('run_command', command('sudo apt install gh')) ?? '', /sudo runs it as root/);
});

test('the standing answer for commands is for this machine, and only under full access', () => {
  const on = { machineWideWithoutAsking: true };
  // The lower modes are unchanged.
  assert.equal(decide('run_command', { ...on, mode: 'ask' }, command('sudo apt install gh')), 'ask');
  assert.equal(decide('run_command', { ...on, mode: 'read' }, command('sudo apt install gh')), 'deny');

  // A change still needs a directory somebody chose, whatever was answered in advance.
  assert.equal(
    decide('run_command', { ...on, mode: 'full', workspaceConfirmed: false }, command('sudo apt install gh')),
    'deny'
  );

  // The screen is a different question with its own answer, and the command-line capture tools
  // keep their prompt: it protects the turn from a picker nobody will click, not the machine.
  assert.equal(decide('screenshot', { ...on, mode: 'full' }, {}), 'ask');
  assert.equal(decide('run_command', { ...on, mode: 'full' }, command('scrot /tmp/shot.png')), 'ask');
  assert.equal(decide('run_command', { ...on, mode: 'full' }, command('import -window tiny /tmp/shot.png')), 'ask');
  assert.equal(decide('run_command', { ...on, mode: 'full' }, command('gnome-screenshot -w -f /tmp/a.png')), 'ask');

  // So is an image leaving the machine: that is a copy going elsewhere, not a change here.
  assert.equal(
    decide(
      'look_at_image',
      { ...on, mode: 'full' },
      { path: 'shot.png', vision_destination: { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' } }
    ),
    'ask'
  );

  // Posting and spending a credential ask every time, as before.
  assert.equal(decide('vault_use', { ...on, mode: 'full' }, {}), 'ask');
  assert.equal(decide('discord_post', { ...on, mode: 'full' }, {}), 'ask');

  // And with nothing said, or the switch off, every one of these is still put to the person.
  assert.equal(decide('run_command', 'full', command('sudo apt install gh')), 'ask');
  assert.equal(
    decide('run_command', { mode: 'full', machineWideWithoutAsking: false }, command('sudo apt install gh')),
    'ask'
  );
  // An ordinary command never needed the switch.
  assert.equal(decide('run_command', 'full', command('npm test')), 'allow');
});

test('the machine-wide switch is off unless it was stored as exactly true', () => {
  assert.equal(normalizeMachineWide(undefined).withoutAsking, false);
  assert.equal(normalizeMachineWide({}).withoutAsking, false);
  assert.equal(normalizeMachineWide({ withoutAsking: 'yes' }).withoutAsking, false);
  assert.equal(normalizeMachineWide({ withoutAsking: 1 }).withoutAsking, false);
  assert.equal(normalizeMachineWide({ withoutAsking: true }).withoutAsking, true);
  assert.equal(DEFAULT_MACHINE_WIDE.withoutAsking, false);
});
