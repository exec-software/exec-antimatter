#!/usr/bin/env node
/** Bounded replay using production inference, tool-loop, memory, file, and shell implementations. */
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { createMicroFixture, verifyMicroCandidate, continuationPrompt } from './pensieve-model-eval-support.mjs';

const repo = resolve(import.meta.dirname, '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const json = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const help = `Usage: node scripts/test-pensieve-model-eval.mjs --output DIR [options]

Default: prepare an isolated Matrix project and validate the harness; no model requests.
Use --run explicitly to contact an EXISTING OpenAI-compatible server. No model lifecycle calls.

  --prepare-only                    Prepare/inspect only (default)
  --run                             Execute the selected phase once
  --endpoint URL                    API base URL, default http://127.0.0.1:8080/v1
  --model ID                        Required for --run
  --provider-kind llama-cpp|openai-compatible  Default llama-cpp
  --thinking default|off|low|medium|high        Default default; production controls
  --memory on|off                    Retrieval ablation only; compiler feedback stays on
  --task quote|stock|warehouse        Default quote; independent API tests for micro tasks
  --max-rounds N                    Default 12, hard maximum 256; auto-continue disabled
  --time-budget-seconds N            Model/tool-loop wall time, default 240
  --temperature N                   Default 0.2
  --max-tokens N                    Per-response output budget, default 4096
  --context-tokens N                Context estimate including output/tools, default 65536
  --tool-timeout-seconds N           Per-shell-call ceiling, default 60, maximum 300
  --check-timeout-seconds N          Each final check/run ceiling, default 60, maximum 300
  --phase reservation|continuation|fulfillment  Default reservation; fresh conversation each phase
                                    continuation: micro tasks, unchanged prior candidate and same memory
  --accepted-initial FILE            Required for fulfillment: manually authored acceptance JSON
  --sdk DIR                         Default matching stable SDK named by the curriculum
  --runtime-root DIR                Default vendor/pensieve
  --curriculum FILE                 Default <runtime-root>/curriculum.json
  --python EXECUTABLE               Optional memory bridge interpreter
  --api-key-env NAME                Default PENSIEVE_WORKLOAD_API_KEY (never saved)

The harness offers production file tools and run_command, plus Pensieve tools when enabled.
It omits GUI, network, agents and persistent processes. Shell commands run in Linux bubblewrap:
minimal system root, candidate workspace writable, copied SDK read-only, network disabled.
Final check/run observations never establish application acceptance. Review the source and tests.
Memory on/off masks retrieved content only. Both arms retain identical tools, capture and compiler feedback.
The sealed SDK includes seven Matrix library sources but not the full Matrix guide supplied by Pensieve.
Thus this is added-reference/retrieval access, not equal-knowledge or learned-memory-only comparison.
Continuation retains both candidate files and project memory; it does not isolate memory from code.
Fulfillment acceptance file: {"accepted":true,"reviewer":"name","sourceFingerprint":"..."}
Use the reservation result.json fingerprint AFTER manually reviewing that candidate.
`;

const flags = new Map();
const switches = new Set(['help', 'run', 'prepare-only']);
const known = new Set(['output', 'endpoint', 'model', 'provider-kind', 'thinking', 'memory', 'max-rounds', 'time-budget-seconds',
  'temperature', 'max-tokens', 'context-tokens', 'tool-timeout-seconds', 'check-timeout-seconds',
  'task', 'phase', 'accepted-initial', 'sdk', 'runtime-root', 'curriculum', 'python', 'api-key-env', ...switches]);
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index].replace(/^--/, '');
  if (!process.argv[index].startsWith('--') || !known.has(name) || flags.has(name)) throw new Error(`Unknown or repeated argument: ${process.argv[index]}`);
  if (switches.has(name)) flags.set(name, true);
  else {
    const value = process.argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    flags.set(name, value);
  }
}
if (flags.has('help')) { console.log(help); process.exit(0); }
if (!flags.has('output')) throw new Error('--output DIR is required. Use --help for options.');
if (flags.has('run') && flags.has('prepare-only')) throw new Error('Choose --run or --prepare-only.');
if (process.platform !== 'linux') throw new Error('This workload harness requires Linux bubblewrap for shell isolation.');

const requestedOutput = resolve(flags.get('output'));
if (fs.existsSync(requestedOutput) && !fs.statSync(requestedOutput).isDirectory()) throw new Error('--output must be a directory.');
fs.mkdirSync(requestedOutput, { recursive: true, mode: 0o700 });
const output = fs.realpathSync(requestedOutput);
const configPath = join(output, 'config.json');
const saved = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;
if (!saved && fs.readdirSync(output).length) throw new Error('A new --output directory must be empty; existing project folders are never imported.');
if (saved && (saved.schema !== 1 || saved.output !== output || saved.workspace !== join(output, 'workspace'))) throw new Error('Existing output configuration is invalid or moved. Use a fresh output directory.');
const value = (name, key, fallback) => flags.get(name) ?? saved?.[key] ?? fallback;
const number = (name, key, fallback, min, max, integer = true) => {
  const result = Number(value(name, key, fallback));
  if (!Number.isFinite(result) || result < min || result > max || integer && !Number.isInteger(result)) throw new Error(`Invalid --${name}; expected ${min}–${max}${integer ? ' whole number' : ''}.`);
  return result;
};
const runtimeSource = resolve(value('runtime-root', 'runtimeSource', join(repo, 'vendor/pensieve')));
const curriculumSource = resolve(value('curriculum', 'curriculumSource', join(runtimeSource, 'curriculum.json')));
const curriculum = JSON.parse(fs.readFileSync(curriculumSource, 'utf8'));
const sdkSource = fs.realpathSync(resolve(value('sdk', 'sdkSource', curriculum.sdk.path)));
const task = value('task', 'task', 'quote');
if (!['quote', 'stock', 'warehouse'].includes(task)) throw new Error('Invalid --task.');
const phase = flags.get('phase') ?? 'reservation';
if (!['reservation', 'continuation', 'fulfillment'].includes(phase)) throw new Error('Invalid --phase.');
if (phase === 'continuation' && (task === 'warehouse' || !saved)) throw new Error('Continuation requires an existing micro-task output directory.');
if (task !== 'warehouse' && phase === 'fulfillment') throw new Error('Fulfillment is only a warehouse phase.');
const config = {
  schema: 1, output, workspace: join(output, 'workspace'), sdkPath: join(output, 'workspace/sdk'),
  sdkSource, runtimeSource, curriculumSource,
  endpoint: value('endpoint', 'endpoint', 'http://127.0.0.1:8080/v1'), model: value('model', 'model', null),
  providerKind: value('provider-kind', 'providerKind', 'llama-cpp'), thinkingLevel: value('thinking', 'thinkingLevel', 'default'),
  memory: value('memory', 'memory', 'on'), task, compilerFeedback: 'on', comparison: 'retrieval-ablation',
  maxRounds: number('max-rounds', 'maxRounds', 12, 1, 256),
  timeBudgetSeconds: number('time-budget-seconds', 'timeBudgetSeconds', 240, 1, 14400),
  temperature: number('temperature', 'temperature', 0.2, 0, 2, false),
  maxTokens: number('max-tokens', 'maxTokens', 4096, 128, 131072),
  contextTokens: number('context-tokens', 'contextTokens', 65536, 4096, 1048576),
  toolTimeoutSeconds: number('tool-timeout-seconds', 'toolTimeoutSeconds', 60, 1, 300),
  checkTimeoutSeconds: number('check-timeout-seconds', 'checkTimeoutSeconds', 60, 1, 300),
  python: value('python', 'python', null), apiKeyEnv: value('api-key-env', 'apiKeyEnv', 'PENSIEVE_WORKLOAD_API_KEY'),
};
if (!['llama-cpp', 'openai-compatible'].includes(config.providerKind)) throw new Error('Invalid --provider-kind.');
if (!['default', 'off', 'low', 'medium', 'high'].includes(config.thinkingLevel)) throw new Error('Invalid --thinking.');
if (!['on', 'off'].includes(config.memory)) throw new Error('--memory must be on or off.');
if (saved && task !== saved.task) throw new Error('Task is fixed per output directory.');
if (saved && config.memory !== saved.memory) throw new Error('Memory mode is fixed per output directory. Use a separate directory for the comparison arm.');
if (config.contextTokens < config.maxTokens + 4096) throw new Error('Context budget must leave at least 4096 tokens beyond the output budget.');
const endpoint = new URL(config.endpoint);
if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Use an http(s) API base URL without credentials, query or fragment.');
if (flags.has('run') && !config.model) throw new Error('--model is required for --run.');
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) throw new Error('Invalid API key environment variable name.');
const assertSdk = path => {
  if (digest(fs.readFileSync(join(path, 'manifest.json'))) !== curriculum.sdk.manifest_sha256 ||
      digest(fs.readFileSync(join(path, 'nilcompiler'))) !== curriculum.sdk.compiler_sha256) throw new Error('SDK does not match the curriculum manifest/compiler fingerprint.');
  const manifest = JSON.parse(fs.readFileSync(join(path, 'manifest.json'), 'utf8'));
  const files = manifest.payload?.files;
  if (!Array.isArray(files) || !files.length) throw new Error('SDK payload manifest is empty.');
  for (const entry of files) {
    const file = resolve(path, entry.path); const within = relative(path, file);
    if (isAbsolute(within) || within === '..' || within.startsWith('..' + sep) || !fs.lstatSync(file).isFile() ||
        fs.statSync(file).size !== entry.bytes || digest(fs.readFileSync(file)) !== entry.sha256) {
      throw new Error(`SDK ${entry.path} differs from its sealed manifest.`);
    }
  }
  return { manifestSha256: curriculum.sdk.manifest_sha256, payloadFilesVerified: files.length, payloadFingerprint: digest(JSON.stringify(files)) };
};
assertSdk(sdkSource);
if (!saved) {
  fs.mkdirSync(join(config.workspace, 'src'), { recursive: true });
  fs.cpSync(sdkSource, config.sdkPath, { recursive: true, dereference: true, errorOnExist: true, force: false });
  fs.writeFileSync(join(config.workspace, 'src/main.matrix'), 'book warehouse\n\nmain returns number begin paragraph\n    say "Warehouse candidate not implemented yet"\n    give 1\nend paragraph\n');
  json(join(config.workspace, 'nil.project.json'), { schema: 'nil.project.v1', name: 'warehouse-workload', entry: 'src/main.matrix', includePaths: ['src'], outputDirectory: 'build', analysis: { disabledRules: [], warningsAsErrors: false } });
}
config.sdkAttestation = assertSdk(config.sdkPath);
if (fs.realpathSync(config.workspace) !== config.workspace || fs.lstatSync(config.sdkPath).isSymbolicLink()) throw new Error('Workspace and SDK must be owned local directories, not links.');
json(configPath, config);
const fixturePath = join(repo, 'scripts/pensieve-warehouse-workload.json');
const fixture = task === 'warehouse' ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : createMicroFixture(task);
if (phase === 'continuation') {
  const text = continuationPrompt(fixture.prompts.reservation.text);
  fixture.prompts.continuation = { text, sha256: digest(text) };
}
for (const prompt of Object.values(fixture.prompts)) if (digest(prompt.text) !== prompt.sha256) throw new Error('Workload prompt fingerprint mismatch.');
json(join(output, 'workload.json'), fixture);

// Freeze exactly the production source loaded for this invocation; later runs build a new worker.
const harness = join(output, 'harness');
fs.mkdirSync(harness, { recursive: true, mode: 0o700 });
const worker = join(harness, 'worker.cjs');
const imports = [
  `import * as fs from 'node:fs';`, `import { createHash, randomUUID } from 'node:crypto';`,
  `import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';`,
  `import { spawn, spawnSync } from 'node:child_process';`,
  `import { runToolLoop } from './src/main/toolLoop';`,
  `import { OpenAICompatibleProvider } from './src/api/providers/openai';`,
  `import { withPensieve, PENSIEVE_INSTRUCTIONS } from './src/main/pensieveRuntime';`,
  `import { PensieveExperimental } from './src/main/pensieveExperimental';`,
  `import { fitToBudget, toolDefinitionTokens } from './src/main/context';`,
  `import { fileTools } from './mcp/tools/files';`, `import { shellTools } from './mcp/tools/shell';`,
  `import { insideWorkspace } from './mcp/workspace';`,
  `import { thinkingParameters, thinkingSupport } from './src/api/thinking';`,
  `import { memoryAblationAdapter, isolatedSandbox, assertMicroContinuation } from './scripts/pensieve-model-eval-support.mjs';`,
].join('\n');
const bundled = await build({ stdin: { contents: imports + '\n(' + workloadWorker.toString() + ')().catch(error => { console.error(error); process.exitCode = 1; });', resolveDir: repo, sourcefile: 'pensieve-workload-worker.js' }, outfile: worker, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], metafile: true, logLevel: 'warning' });
json(join(harness, 'source-hashes.json'), Object.fromEntries(Object.keys(bundled.metafile.inputs).filter(path => fs.existsSync(resolve(repo, path))).sort().map(path => [path, digest(fs.readFileSync(resolve(repo, path)))])));
const child = spawnSync(process.execPath, [worker, configPath, flags.has('run') ? 'run' : 'prepare', phase, flags.has('accepted-initial') ? resolve(flags.get('accepted-initial')) : ''], { stdio: 'inherit', env: { ...process.env, NODE_PATH: join(repo, 'node_modules') }, timeout: (config.timeBudgetSeconds + 2 * config.checkTimeoutSeconds + 180) * 1000 });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
if (flags.has('run') && task !== 'warehouse' && fs.existsSync(join(output, phase, 'result.json'))) {
  const acceptance = verifyMicroCandidate({ task, workspace: join(output, phase, 'candidate'), sdkPath: config.sdkPath, directory: join(output, phase, 'independent-acceptance'), timeoutMs: config.checkTimeoutSeconds * 1000 });
  console.log(JSON.stringify({ independentApiAcceptance: acceptance.apiAcceptance, taskAcceptance: acceptance.taskAcceptance, comparisons: acceptance.expectedComparisons, mismatches: acceptance.mismatchCount, report: join(output, phase, 'independent-acceptance/result.json') }, null, 2));
}

// Bundled above with real application imports. This never runs in the outer preparer.
async function workloadWorker() {
  const [configPath, operation, phase, acceptancePath] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const digest = value => createHash('sha256').update(value).digest('hex');
  const json = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const { output, workspace, sdkPath } = config;
  const fixture = JSON.parse(fs.readFileSync(join(output, 'workload.json'), 'utf8'));
  const shellQuote = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const sandbox = cwd => isolatedSandbox(workspace, sdkPath, cwd);
  const probe = spawnSync('bwrap', [...sandbox(workspace), '/bin/true'], { encoding: 'utf8', timeout: 5000 });
  if (probe.status !== 0) throw new Error(`Bubblewrap isolation unavailable: ${probe.error?.message ?? probe.stderr}`);
  const ownedTools = [...fileTools, ...shellTools.filter(tool => tool.name === 'run_command')];
  const memory = new PensieveExperimental({ directory: join(output, 'memory'), runtimeRoot: config.runtimeSource,
    curriculumPath: config.curriculumSource, ...(config.python ? { python: config.python } : {}) });
  const preflight = { schema: 1, phase, preparedAt: new Date().toISOString(), modelRequests: 0,
    providerKind: config.providerKind, thinkingLevel: config.thinkingLevel,
    thinkingSupport: thinkingSupport({ kind: config.providerKind, protocol: 'openai-chat' }, config.model ?? ''),
    thinkingParameters: thinkingParameters({ kind: config.providerKind, protocol: 'openai-chat' }, { model: config.model ?? '', thinkingLevel: config.thinkingLevel, maxTokens: config.maxTokens }),
    memoryAvailable: memory.state().available, corpus: memory.state().corpus, sandbox: 'bubblewrap: minimal system root; host projects, evaluation files and memory absent; workspace writable; SDK read-only; network isolated',
    tools: ownedTools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    differencesFromGUI: ['Only production file tools and run_command; no GUI, agents, network or persistent launch tools.',
      'Shell/VM runs inside a minimal bubblewrap root; prior projects/evaluation files are absent; SDK file edits are rejected. Production app-owned compile-only checks use sealed SDK binaries on the host with validated source paths.', 'Fresh minimal system prompt; production context fitter with explicit estimated budget.',
      'Developer auto-continue is disabled. Production output-limit retries remain bounded by rounds/time.',
      'Retrieval ablation: both arms retain production automatic compiler feedback, observation capture and identical tool schemas; off masks every recall result.',
      'Production shell tool output clipping applies; independent final checks retain bounded raw stdout/stderr.',
      'SDK has seven Matrix library source files and shared/Ny HTML docs, but no full Matrix guide. Pensieve adds guide/fixture access; this is not equal-knowledge or learned-memory-only isolation.',
      'Continuation uses a fresh conversation with the unchanged prior candidate and same memory; both code and memory carry over.'] };
  json(join(output, 'prepared.json'), preflight);
  if (!memory.state().available) throw new Error(memory.state().unavailableReason);

  const inventory = () => {
    const files = {};
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || ['sdk', 'build', 'dist', 'node_modules'].includes(entry.name)) continue;
        const path = join(directory, entry.name); const name = relative(workspace, path).split(sep).join('/');
        if (entry.isSymbolicLink()) { files[name] = { symlink: fs.readlinkSync(path) }; continue; }
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) {
          const bytes = fs.statSync(path).size;
          files[name] = bytes > 8 * 1024 * 1024 ? { bytes, error: 'File exceeds evidence capture limit.' } : { bytes, sha256: digest(fs.readFileSync(path)) };
        }
      }
    };
    walk(workspace); return files;
  };
  const before = inventory();
  let continuationOf = null;
  if (phase === 'continuation') {
    const initialPath = join(output, 'reservation/result.json');
    if (!fs.existsSync(initialPath)) throw new Error('Continuation requires an existing reservation result.');
    continuationOf = assertMicroContinuation(config.task, JSON.parse(fs.readFileSync(initialPath, 'utf8')), digest(JSON.stringify(before)));
    if (fs.existsSync(join(output, phase))) throw new Error('Continuation already exists; prior evidence is never overwritten.');
    preflight.continuationOf = continuationOf;
    json(join(output, 'prepared.json'), preflight);
  }
  if (phase === 'fulfillment') {
    if (!acceptancePath) throw new Error('Fulfillment requires --accepted-initial FILE after manual review.');
    const accepted = JSON.parse(fs.readFileSync(acceptancePath, 'utf8'));
    const initial = JSON.parse(fs.readFileSync(join(output, 'reservation/result.json'), 'utf8'));
    if (accepted.accepted !== true || typeof accepted.reviewer !== 'string' || !accepted.reviewer.trim() ||
        accepted.sourceFingerprint !== initial.sourceFingerprint || digest(JSON.stringify(before)) !== initial.sourceFingerprint) {
      throw new Error('Acceptance must explicitly identify the reviewer and the unchanged reservation candidate fingerprint.');
    }
  }
  if (operation === 'prepare') { console.log(`Prepared ${workspace}; no model requests. See ${join(output, 'prepared.json')}`); return; }
  const phaseDir = join(output, phase);
  fs.mkdirSync(phaseDir, { recursive: false, mode: 0o700 }); // One execution per phase; no silent overwrite.
  const record = (name, value) => fs.appendFileSync(join(phaseDir, name + '.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 });
  json(join(phaseDir, 'config.json'), config);
  json(join(phaseDir, 'prepared.json'), preflight);
  json(join(phaseDir, 'sources-before.json'), before);
  json(join(phaseDir, 'harness-source-hashes.json'), JSON.parse(fs.readFileSync(join(output, 'harness/source-hashes.json'), 'utf8')));
  fs.copyFileSync(join(output, 'harness/worker.cjs'), join(phaseDir, 'worker.cjs'));
  if (acceptancePath) fs.copyFileSync(acceptancePath, join(phaseDir, 'initial-acceptance.json'));
  // Keep this invocation's memory code and corpus beside its evidence, outside the model workspace.
  const memoryRuntime = join(phaseDir, 'pensieve-runtime');
  fs.cpSync(config.runtimeSource, memoryRuntime, { recursive: true, dereference: true });
  const curriculumPath = join(memoryRuntime, 'curriculum.json');
  fs.copyFileSync(config.curriculumSource, curriculumPath);
  const activeMemory = new PensieveExperimental({ directory: join(output, 'memory'), runtimeRoot: memoryRuntime,
    curriculumPath, ...(config.python ? { python: config.python } : {}) });
  await activeMemory.enable();
  const ablatedMemory = memoryAblationAdapter(activeMemory, config.memory, request => record('masked-recall', { request }));
  const session = randomUUID(); const runId = randomUUID();
  const controller = new AbortController(); let stopSignal = null;
  const cancel = signal => { stopSignal = signal; controller.abort(); };
  const onInt = () => cancel('SIGINT'); const onTerm = () => cancel('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const timer = setTimeout(() => cancel('time-budget'), config.timeBudgetSeconds * 1000);
  const started = Date.now(); let latestTranscript = []; let result = null; let error = null;
  const rounds = []; const activityLatest = new Map();
  let requests = 0;
  const runtime = {
    enabledTools: () => ownedTools.map(tool => ({ serverId: 'antimatter', serverName: 'Antimatter workload tools', tool: { ...tool, enabled: true } })),
    async callTool(server, name, args, options = {}) {
      const tool = server === 'antimatter' && ownedTools.find(tool => tool.name === name);
      if (!tool) return { ok: false, attempted: false, text: 'Tool is unavailable in the workload harness.' };
      try {
        let actual = args;
        if (['write_file', 'edit_file'].includes(name)) {
          const path = insideWorkspace(workspace, args.path);
          // File tools run outside the shell sandbox. An in-workspace symlink to sdk is
          // allowed by insideWorkspace, so enforce the immutable SDK boundary canonically.
          let ancestor = path; const missing = [];
          while (!fs.existsSync(ancestor)) { missing.unshift(relative(dirname(ancestor), ancestor)); ancestor = dirname(ancestor); }
          const canonical = join(fs.realpathSync(ancestor), ...missing);
          if (canonical === sdkPath || canonical.startsWith(sdkPath + sep)) throw new Error('The pinned SDK is read-only. Edit the application instead.');
        }
        if (name === 'run_command') {
          const cwd = insideWorkspace(workspace, args.cwd ?? '.');
          const command = ['bwrap', ...sandbox(cwd), '/bin/bash', '-c', String(args.command ?? '')].map(shellQuote).join(' ');
          actual = { ...args, command, timeout_ms: Math.max(1, Math.min(Number(args.timeout_ms) || 60000, config.toolTimeoutSeconds * 1000)) };
        }
        let text = await tool.run(actual, { workspace, signal: options.signal });
        record('tool-execution', { server, name, args, sandboxed: name === 'run_command', result: text });
        if (name === 'run_command') text = '$ ' + String(args.command ?? '') + '\n' + text.slice(text.indexOf('\n') + 1);
        return { ok: true, text };
      } catch (error) {
        record('tool-execution', { server, name, args, error: String(error) });
        return { ok: false, text: String(error) };
      }
    },
  };
  const provider = new OpenAICompatibleProvider({ id: 'pensieve-workload', name: 'Workload endpoint', apiKey: process.env[config.apiKeyEnv] ?? '',
    baseUrl: config.endpoint, models: [], supportsStreaming: true, protocol: 'openai-chat', kind: config.providerKind });
  const tracedProvider = { prepareMessages: provider.prepareMessages.bind(provider), async stream(request, callback, onAlive, signal) {
    const number = ++requests; record('inference', { event: 'request', number, request });
    try {
      const response = await provider.stream(request, chunk => { record('stream', { number, ...chunk }); callback(chunk); }, onAlive, signal);
      record('inference', { event: 'result', number, response }); return response;
    } catch (error) { record('inference', { event: 'error', number, error: String(error) }); throw error; }
  } };
  const wrapped = withPensieve(runtime, tracedProvider, { memory: ablatedMemory, workspace, session, runId,
    signal: controller.signal, sdkOptions: () => ({ sdkPath, environment: { PATH: '/usr/bin:/bin', NIL_SDK_PATH: sdkPath } }), curriculumPath });
  const system = 'You are a coding agent working in ' + workspace + '. Tools execute real operations. The project has a pinned SDK at ./sdk. ' +
    'Shell commands run in an isolated system root with a writable project, read-only SDK and no network. Use supplied file and shell tools to implement and verify the request. ' +
    'There are no subagents or persistent process tools in this replay. Do not treat printed claims or exit zero as proof of the requested behavior. ' +
    PENSIEVE_INSTRUCTIONS;
  latestTranscript = [{ id: randomUUID(), role: 'system', content: system }, { id: randomUUID(), role: 'user', content: fixture.prompts[phase].text }];
  json(join(phaseDir, 'transcript.json'), latestTranscript);
  try {
    result = await runToolLoop({ provider: wrapped.provider, toolRuntime: wrapped.runtime, prepareMessages: wrapped.prepareMessages,
      runId, workspace, mode: 'full', workspaceConfirmed: true, maxRounds: config.maxRounds, signal: controller.signal,
      autoContinue: { enabled: false, maxContinues: 0, onRoundLimit: false }, reportWhenStopped: false,
      request: { messages: latestTranscript, model: config.model, providerId: 'pensieve-workload', threadId: session,
        useTools: true, accessMode: 'full', temperature: config.temperature, maxTokens: config.maxTokens, thinkingLevel: config.thinkingLevel },
      fit: (messages, tools) => fitToBudget(messages, config.contextTokens - config.maxTokens - toolDefinitionTokens(tools)),
      toolTimeoutMs: config.toolTimeoutSeconds * 1000,
      onContent: text => fs.appendFileSync(join(phaseDir, 'assistant.txt'), text),
      onReasoning: text => fs.appendFileSync(join(phaseDir, 'reasoning.txt'), text),
      onTranscript: messages => { latestTranscript = messages; json(join(phaseDir, 'transcript.json'), messages); },
      onMetrics: event => { rounds.push(event); record('metrics', event); },
      onActivity: activity => { activityLatest.set(activity.activityId ?? activity.callId, activity); record('activities', activity); },
      onCompaction: event => record('compactions', event), onContext: event => record('context', event),
      onAlive: note => record('liveness', { note }), requestApproval: async () => true });
    latestTranscript = result.transcript;
  } catch (failure) { error = String(failure); }
  finally { clearTimeout(timer); process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
  json(join(phaseDir, 'transcript.json'), latestTranscript);
  const after = inventory(); const sourceFingerprint = digest(JSON.stringify(after));
  json(join(phaseDir, 'sources-after.json'), after);
  for (const [name, entry] of Object.entries(after)) {
    if (!entry.sha256) continue;
    const path = join(phaseDir, 'candidate', name); fs.mkdirSync(dirname(path), { recursive: true });
    fs.copyFileSync(join(workspace, name), path);
  }
  const check = async action => {
    const command = ['./sdk/nilbuild', action, '--project', 'nil.project.json', '--sdk', sdkPath];
    const beginning = Date.now(); const limit = 4 * 1024 * 1024;
    return await new Promise(resolveResult => {
      const child = spawn('bwrap', [...sandbox(workspace), ...command], { cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let bytes = 0; let stopped = null; let spawnError = null; const parts = { stdout: [], stderr: [] };
      const stop = reason => { stopped = reason; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
      const deadline = setTimeout(() => stop('timeout'), config.checkTimeoutSeconds * 1000);
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
        if (bytes + chunk.length > limit) { stop('output-limit'); return; } bytes += chunk.length; parts[stream].push(chunk);
      });
      child.on('error', failure => { spawnError = String(failure); });
      child.on('close', (code, signal) => {
        clearTimeout(deadline);
        const stdout = Buffer.concat(parts.stdout).toString('utf8'); const stderr = Buffer.concat(parts.stderr).toString('utf8');
        fs.writeFileSync(join(phaseDir, action + '.stdout.txt'), stdout); fs.writeFileSync(join(phaseDir, action + '.stderr.txt'), stderr);
        resolveResult({ command, code, signal, elapsedMs: Date.now() - beginning, stopped, error: spawnError,
          namedResultLines: stdout.split('\n').filter(line => /\b(?:PASS|FAIL)\b/.test(line)), provesAcceptance: false });
      });
    });
  };
  const checks = [];
  const sdkIntegrity = { manifestMatches: false, payloadFilesVerified: 0, errors: [] };
  try {
    const bytes = fs.readFileSync(join(sdkPath, 'manifest.json'));
    if (digest(bytes) !== config.sdkAttestation.manifestSha256) throw new Error('SDK manifest changed.');
    sdkIntegrity.manifestMatches = true;
    const manifest = JSON.parse(bytes.toString('utf8'));
    for (const entry of manifest.payload.files) {
      const path = join(sdkPath, entry.path);
      if (!fs.lstatSync(path).isFile() || fs.statSync(path).size !== entry.bytes || digest(fs.readFileSync(path)) !== entry.sha256) {
        throw new Error(`SDK payload changed: ${entry.path}`);
      }
      sdkIntegrity.payloadFilesVerified++;
    }
  } catch (failure) { sdkIntegrity.errors.push(String(failure)); }
  // Explicit cancellation must not start another compiler/VM. Budget expiry still permits bounded evidence checks.
  if (!sdkIntegrity.errors.length && !['SIGINT', 'SIGTERM'].includes(stopSignal)) for (const action of ['check', 'run']) checks.push(await check(action));
  let memoryStatus = activeMemory.state();
  {
    try { memoryStatus = await activeMemory.invoke(workspace, { op: 'status' }); }
    catch (failure) { memoryStatus = { error: String(failure) }; }
  }
  const complete = rounds.filter(event => event.metrics.phase === 'complete');
  const sum = field => complete.some(event => typeof event.metrics[field] === 'number') ? complete.reduce((sum, event) => sum + (event.metrics[field] ?? 0), 0) : null;
  const summary = { schema: 1, phase, continuationOf, session, runId, startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started,
    acceptance: config.task === 'warehouse' ? 'requires-human-review' : 'see-independent-acceptance', task: config.task, comparison: config.comparison, retrieval: config.memory, compilerFeedback: 'on', sourceFingerprint, promptSha256: fixture.prompts[phase].sha256,
    stopReason: stopSignal ?? result?.reason ?? 'error', error, model: config.model, servedModel: result?.servedModel ?? null,
    requests, rounds: result?.rounds ?? null, toolCalls: result?.toolCalls ?? null,
    tokens: { prompt: sum('promptTokens'), completion: sum('completionTokens'), reasoning: sum('reasoningTokens') },
    toolCounts: [...activityLatest.values()].filter(activity => ['done', 'failed', 'denied'].includes(activity.status)).reduce((counts, activity) => { counts[activity.toolName] = (counts[activity.toolName] ?? 0) + 1; return counts; }, {}),
    checks, sdkIntegrity, memoryStatus, sourceFiles: Object.keys(after),
    nonMatrixSourceCandidates: Object.keys(after).filter(name => /\.(?:py|ny|js|mjs|cjs|ts|sh)$/i.test(name)),
    limitations: ['Named PASS lines and exit codes are observations, not application acceptance. Hidden micro tests establish only public API behavior; model-authored tests and full task completion need review.', 'Human review must verify actual assertions, requirements, language compliance, reuse, and absence of hardcoded answers.', ...preflight.differencesFromGUI] };
  json(join(phaseDir, 'result.json'), summary);
  console.log(JSON.stringify({ result: join(phaseDir, 'result.json'), stopReason: summary.stopReason, acceptance: summary.acceptance, sourceFingerprint }, null, 2));
  if (error) process.exitCode = 1;
}
