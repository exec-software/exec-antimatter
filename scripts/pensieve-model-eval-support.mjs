import * as fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const screeningTasks = ['quote', 'stock'];

export function assertMicroContinuation(task, initial, sourceFingerprint) {
  if (!screeningTasks.includes(task)) throw new Error('Continuation is supported only for micro tasks.');
  if (!initial || initial.phase !== 'reservation' || initial.task !== task || typeof initial.sourceFingerprint !== 'string') {
    throw new Error('Continuation requires this task\'s completed reservation result.');
  }
  if (initial.sourceFingerprint !== sourceFingerprint) {
    throw new Error('Candidate changed since the reservation snapshot. Continuation refuses manual or external edits.');
  }
  return { session: initial.session, sourceFingerprint: initial.sourceFingerprint, initialStopReason: initial.stopReason };
}

export function continuationPrompt(original) {
  return original + '\n\nContinue this unfinished task in a fresh conversation. Before editing, query Pensieve for relevant prior work or compiler lessons from this project and report any lesson you reuse; if none is returned, say so. The same requirements still apply. Finish the implementation and actually run the tests.';
}

const sha = text => createHash('sha256').update(text).digest('hex');

/** Keep production capture/check paths identical; only retrieved material differs. */
export function memoryAblationAdapter(memory, mode, onMaskedRecall = () => {}) {
  if (!['on', 'off'].includes(mode)) throw new Error('Invalid retrieval arm.');
  return {
    get enabled() { return memory.enabled; },
    async invoke(workspace, request, signal) {
      if (mode === 'off' && request.op === 'recall') {
        signal?.throwIfAborted();
        onMaskedRecall(request);
        return { text: 'Retrieved references and experiences are withheld for this retrieval-ablation arm. Compiler feedback remains active. Consult the local SDK documentation.', items: [] };
      }
      return memory.invoke(workspace, request, signal);
    },
  };
}

export function createMicroFixture(task) {
  const common = 'Implement this small Matrix application using the pinned SDK. All application logic and tests must be Matrix; existing SDK libraries are allowed. Use Pensieve for language guidance, resolve compiler feedback, and run your tests with ./sdk/nilbuild run --project nil.project.json. Keep src/main.matrix as the entry point, importing the public API from book probe.logic at src/probe/logic.matrix. Do not replace the requested implementation with printed answers.\n\n';
  const requirements = {
    quote: 'Implement public paragraph quote-order with four number parameters named units, unit-price, free-threshold, and shipping-fee; it returns number. Return -1 if units is zero or negative, or any other parameter is negative. Otherwise subtotal is units times unit-price. If subtotal is at least free-threshold, return subtotal; otherwise return subtotal plus shipping-fee. Use integer cents throughout. Include meaningful tests for invalid input, the exact threshold, a zero unit price, and ordinary orders. The grader will import this API and call additional inputs, so calculate results from parameters. Report commands and actual test outcomes.',
    stock: 'Implement public record stock-state with number fields available, reserved, and fulfilled. Implement four public paragraphs: new-stock receives units as number and returns stock-state; reserve-stock, cancel-stock, and fulfill-stock each receive current as stock-state and units as number, returning stock-state. new-stock initializes available to max(units, 0), with reserved and fulfilled zero. reserve-stock moves units from available to reserved only when units > 0 and units <= available. cancel-stock moves units from reserved back to available only when units > 0 and units <= reserved. fulfill-stock moves units from reserved to fulfilled only when units > 0 and units <= reserved. Invalid operations leave all values unchanged. Every operation must return a newly constructed record and leave its input record unchanged; retained earlier states must remain usable. Include tests for several sequential transitions, invalid/overdrawn operations, conservation of total units, and input immutability. The grader will import this API and test additional sequences. Report commands and actual test outcomes.',
  };
  if (!(task in requirements)) throw new Error('Unknown micro task: ' + task);
  const text = common + requirements[task];
  return { schema: 1, task, source: 'Independent preregistered Matrix screening contracts; no warehouse solution supplied.', prompts: { reservation: { text, sha256: sha(text) } } };
}

// The process sees only system binaries/libraries, the candidate, and its sealed SDK.
// Prior candidates, logs, memory databases, evaluator source, and host projects are absent.
export function isolatedSandbox(workspace, sdkPath, cwd = workspace, writable = true) {
  const mounts = ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr'];
  for (const path of ['/bin', '/sbin', '/lib', '/lib64']) if (fs.existsSync(path)) {
    const stat = fs.lstatSync(path);
    mounts.push(...(stat.isSymbolicLink() ? ['--symlink', fs.readlinkSync(path), path] : ['--ro-bind', path, path]));
  }
  if (fs.existsSync('/etc/ld.so.cache')) mounts.push('--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache');
  mounts.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', writable ? '--bind' : '--ro-bind', workspace, workspace,
    '--ro-bind', sdkPath, sdkPath, '--chdir', cwd, '--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'NIL_SDK_PATH', sdkPath);
  return mounts;
}

function casesFor(task) {
  let state = 0x51e20a7;
  const next = max => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  if (task === 'quote') {
    const cases = [[0, 4, 20, 2], [-3, 4, 20, 2], [3, -1, 20, 2], [3, 4, -1, 2], [3, 4, 20, -1], [4, 5, 20, 3], [3, 5, 20, 3], [1, 0, 0, 8], [1, 0, 5, 8], [11, 7, 20, 13]];
    for (let i = 0; i < 32; i++) cases.push([next(20) - 2, next(100), next(1500), next(100)]);
    return cases;
  }
  const sequences = [
    { initial: 17, actions: [['reserve', 5], ['fulfill', 3], ['cancel', 2], ['reserve', 20], ['reserve', 0], ['cancel', -2], ['fulfill', 1]] },
    { initial: -2, actions: [['reserve', 1], ['fulfill', 0], ['cancel', 1]] },
    { initial: 0, actions: [['reserve', 1], ['reserve', -1], ['cancel', -1]] },
  ];
  for (let i = 0; i < 9; i++) {
    const actions = [];
    for (let j = 0; j < 12; j++) actions.push([['reserve', 'cancel', 'fulfill'][next(3)], next(15) - 2]);
    sequences.push({ initial: next(30), actions });
  }
  return sequences;
}

export function buildVerifier(task, marker = 'PENSIEVE-EVAL-' + randomBytes(12).toString('hex')) {
  const lines = ['book verifier.runner', '', 'read everything from probe.logic', '', 'main returns number begin paragraph', `    say "${marker}-BEGIN"`];
  const expected = []; const cases = casesFor(task);
  if (task === 'quote') {
    for (const [units, price, threshold, shipping] of cases) {
      lines.push(`    say quote-order with units being ${units}, unit-price being ${price}, free-threshold being ${threshold}, shipping-fee being ${shipping}`);
      const subtotal = units * price;
      expected.push(units <= 0 || price < 0 || threshold < 0 || shipping < 0 ? -1 : subtotal + (subtotal < threshold ? shipping : 0));
    }
  } else if (task === 'stock') {
    let number = 0;
    for (const sequence of cases) {
      let values = [Math.max(0, sequence.initial), 0, 0]; let previous = 'state' + number++;
      lines.push(`    value ${previous} is new-stock with units being ${sequence.initial}`);
      for (const field of ['available', 'reserved', 'fulfilled']) lines.push(`    say ${previous}.${field}`);
      expected.push(...values);
      const history = [{ name: previous, values: [...values] }];
      for (const [operation, units] of sequence.actions) {
        const current = 'state' + number++;
        lines.push(`    value ${current} is ${operation}-stock with current being ${previous}, units being ${units}`);
        const result = [...values];
        if (units > 0 && units <= values[operation === 'reserve' ? 0 : 1]) {
          if (operation === 'reserve') { result[0] -= units; result[1] += units; }
          if (operation === 'cancel') { result[0] += units; result[1] -= units; }
          if (operation === 'fulfill') { result[1] -= units; result[2] += units; }
        }
        for (const field of ['available', 'reserved', 'fulfilled']) lines.push(`    say ${current}.${field}`);
        expected.push(...result);
        // Check all retained states after every call to catch shared-handle mutation.
        for (const item of history) {
          for (const field of ['available', 'reserved', 'fulfilled']) lines.push(`    say ${item.name}.${field}`);
          expected.push(...item.values);
        }
        // A new record is part of the contract even for rejected transitions.
        // Perturb only the returned record, check the caller's input, then restore it.
        lines.push(`    set ${current}.available to ${current}.available plus 1`);
        for (const field of ['available', 'reserved', 'fulfilled']) lines.push(`    say ${previous}.${field}`);
        expected.push(...values);
        lines.push(`    set ${current}.available to ${current}.available minus 1`);
        values = result; previous = current; history.push({ name: current, values: [...values] });
      }
    }
  } else throw new Error('Unknown task.');
  lines.push(`    say "${marker}-END"`, '    give 0', 'end paragraph', '');
  return { source: lines.join('\n'), expected, cases, marker };
}

export function verifyMicroCandidate({ task, workspace, sdkPath, directory, timeoutMs = 60000 }) {
  if (!screeningTasks.includes(task)) throw new Error('Only micro tasks have automatic API acceptance.');
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  const candidate = join(directory, 'project'); fs.mkdirSync(candidate);
  const files = []; const violations = [];
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['sdk', 'build', 'dist', 'node_modules'].includes(entry.name)) continue;
      const source = join(from, entry.name); const target = join(to, entry.name); const path = relative(workspace, source).split(sep).join('/');
      if (entry.isSymbolicLink()) { violations.push('Application symlink: ' + path); continue; }
      if (entry.isDirectory()) copy(source, target);
      else if (entry.isFile()) {
        files.push(path);
        if (/\.(?:py|ny|js|mjs|cjs|ts|sh)$/i.test(path)) violations.push('Non-Matrix application source: ' + path);
        fs.copyFileSync(source, target);
      }
    }
  };
  copy(workspace, candidate);
  if (!files.includes('src/probe/logic.matrix')) violations.push('Required public API file is missing.');
  if (!files.includes('src/main.matrix')) violations.push('Required application entry is missing.');
  const verifier = buildVerifier(task);
  fs.writeFileSync(join(candidate, 'acceptance.matrix'), verifier.source);
  fs.writeFileSync(join(candidate, 'nil.project.json'), JSON.stringify({ schema: 'nil.project.v1', name: 'independent-matrix-acceptance', entry: 'acceptance.matrix', includePaths: ['src'], outputDirectory: 'build' }, null, 2));
  const command = [join(sdkPath, 'nilbuild'), 'run', '--project', 'nil.project.json', '--sdk', sdkPath];
  const started = Date.now();
  const result = spawnSync('bwrap', [...isolatedSandbox(candidate, sdkPath), ...command], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  const stdout = result.stdout ?? ''; const stderr = result.stderr ?? '';
  fs.writeFileSync(join(directory, 'stdout.txt'), stdout); fs.writeFileSync(join(directory, 'stderr.txt'), stderr);
  const begin = stdout.indexOf(verifier.marker + '-BEGIN\n'); const end = stdout.indexOf(verifier.marker + '-END', Math.max(0, begin));
  const body = begin < 0 || end < 0 ? null : stdout.slice(begin + verifier.marker.length + 7, end).trim();
  const actual = body === null ? null : body.split(/\r?\n/).map(line => /^-?\d+$/.test(line.trim()) ? Number(line.trim()) : line);
  const mismatches = [];
  for (let i = 0; i < Math.max(actual?.length ?? 0, verifier.expected.length); i++) if (actual?.[i] !== verifier.expected[i]) mismatches.push({ index: i, expected: verifier.expected[i] ?? null, actual: actual?.[i] ?? null });
  const apiAcceptance = result.status === 0 && !result.error && !violations.length && !mismatches.length ? 'passed' : 'failed';
  const report = { schema: 1, task, apiAcceptance, taskAcceptance: apiAcceptance === 'passed' ? 'requires-review' : 'failed',
    acceptance: apiAcceptance === 'passed' ? 'requires-task-review' : 'failed',
    scope: 'Independent public API calls, additional generated inputs and retained-state invariants. Does not validate the model-authored main/tests, establish full task completion, warehouse acceptance, or general model capability. Language-extension scanning is an aid, not a complete language-compliance proof.',
    exitCode: result.status, signal: result.signal, error: result.error?.message ?? null, elapsedMs: Date.now() - started, command,
    expectedComparisons: verifier.expected.length, actualComparisons: actual?.length ?? 0, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 40), violations,
    verifierSha256: sha(verifier.source), expected: verifier.expected, actual, cases: verifier.cases };
  fs.writeFileSync(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
