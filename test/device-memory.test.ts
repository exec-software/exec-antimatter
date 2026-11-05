import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  cgroupPath,
  parseMemoryEvents,
  readDeviceMemory,
  totalsFromFdinfo,
  unitFromCgroup,
} from '../src/main/deviceMemory';

const write = (path: string, content: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

/**
 * A fixture /sys and /proc. The reader takes a root precisely so this is possible: none of its
 * behaviour should need a GPU to exercise, and the parsing is where the mistakes live.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'device-memory-'));
  const card = join(root, 'sys/class/drm/card1/device');
  mkdirSync(card, { recursive: true });
  write(join(card, 'mem_info_vram_total'), '103079215104\n');
  write(join(card, 'mem_info_vram_used'), '62243897344\n');
  write(join(card, 'mem_info_gtt_total'), '16441278464\n');
  write(join(card, 'mem_info_gtt_used'), '15682306048\n');
  write(join(card, 'uevent'), 'DRIVER=amdgpu\nPCI_ID=1002:1586\n');

  // A render-only node with no memory counters must not become a row of dashes.
  mkdirSync(join(root, 'sys/class/drm/card0/device'), { recursive: true });
  write(join(root, 'sys/class/drm/card0/device/uevent'), 'DRIVER=amdgpu\n');

  write(join(root, 'sys/module/ttm/parameters/pages_limit'), '4013711\n');

  const unit = 'llama-mistral-small-4.service';
  const cg = `/user.slice/user-1000.slice/user@1000.service/antimatter-inference.slice/${unit}`;
  const proc = join(root, 'proc/4242');
  mkdirSync(join(proc, 'fd'), { recursive: true });
  mkdirSync(join(proc, 'fdinfo'), { recursive: true });
  write(join(proc, 'comm'), 'llama-server\n');
  write(join(proc, 'cgroup'), `0::${cg}\n`);
  // Two fds on the same card, each reporting the same client totals -- the shape that makes a
  // naive sum report twice the truth.
  for (const fd of ['3', '4']) {
    symlinkSync('/dev/dri/renderD128', join(proc, 'fd', fd));
    write(join(proc, 'fdinfo', fd), [
      'pos:\t0',
      'drm-driver:\tamdgpu',
      'drm-pdev:\t0000:c2:00.0',
      'drm-memory-vram:\t59661924 KiB',
      'drm-memory-gtt:\t15153532 KiB',
      '',
    ].join('\n'));
  }
  // A non-GPU fd on the same process must not be read as one.
  symlinkSync('/dev/null', join(proc, 'fd', '5'));
  write(join(proc, 'fdinfo', '5'), 'pos:\t0\n');

  const cgDir = join(root, 'sys/fs/cgroup', cg);
  mkdirSync(cgDir, { recursive: true });
  write(join(cgDir, 'memory.current'), '10737418240\n');
  write(join(cgDir, 'memory.peak'), '10737418240\n');
  write(join(cgDir, 'memory.high'), '10737418240\n');
  write(join(cgDir, 'memory.max'), '15032385536\n');
  write(join(cgDir, 'memory.events'), 'low 0\nhigh 60166\nmax 0\noom 0\noom_kill 0\n');
  return root;
}

test('a client reporting the same totals on every fd is counted once, not once per fd', () => {
  const totals = totalsFromFdinfo([
    'drm-pdev:\t0000:c2:00.0\ndrm-memory-vram:\t1024 KiB\ndrm-memory-gtt:\t512 KiB\n',
    'drm-pdev:\t0000:c2:00.0\ndrm-memory-vram:\t1024 KiB\ndrm-memory-gtt:\t512 KiB\n',
    'drm-pdev:\t0000:c2:00.0\ndrm-memory-vram:\t1024 KiB\ndrm-memory-gtt:\t512 KiB\n',
  ]);
  assert.equal(totals.vram, 1024 * 1024);
  assert.equal(totals.gtt, 512 * 1024);
});

test('fds on two different cards sum, because that is two allocations', () => {
  const totals = totalsFromFdinfo([
    'drm-pdev:\t0000:c2:00.0\ndrm-memory-vram:\t1024 KiB\n',
    'drm-pdev:\t0000:03:00.0\ndrm-memory-vram:\t2048 KiB\n',
  ]);
  assert.equal(totals.vram, 3072 * 1024);
});

test('an unreported counter stays null rather than becoming zero', () => {
  assert.deepEqual(totalsFromFdinfo([]), { vram: null, gtt: null });
  const gttOnly = totalsFromFdinfo(['drm-pdev:\tx\ndrm-memory-gtt:\t64 KiB\n']);
  assert.equal(gttOnly.vram, null);
  assert.equal(gttOnly.gtt, 64 * 1024);
});

test('a reported zero is preserved as zero', () => {
  const totals = totalsFromFdinfo(['drm-pdev:\tx\ndrm-memory-vram:\t0 KiB\ndrm-memory-gtt:\t0 KiB\n']);
  assert.equal(totals.vram, 0);
  assert.equal(totals.gtt, 0);
});

test('only the unified cgroup v2 line is read, and the unit is its last component', () => {
  assert.equal(cgroupPath('12:pids:/legacy\n0::/user.slice/a.service\n'), '/user.slice/a.service');
  assert.equal(cgroupPath('12:pids:/legacy\n'), null);
  assert.equal(unitFromCgroup('/user.slice/x.slice/llama-coder.service'), 'llama-coder.service');
  // A bare slice is not a unit worth attributing a process to.
  assert.equal(unitFromCgroup('/user.slice/user-1000.slice'), null);
  assert.equal(unitFromCgroup(null), null);
});

test('memory.events yields the throttle and kill counters', () => {
  const events = parseMemoryEvents('low 0\nhigh 60166\nmax 3\noom 1\noom_kill 2\n');
  assert.equal(events.highEvents, 60166);
  assert.equal(events.maxEvents, 3);
  assert.equal(events.oomKills, 2);
  const missing = parseMemoryEvents('');
  assert.equal(missing.highEvents, null);
});

test('a reading resolves devices, the GTT ceiling, the engine, and its cgroup pressure', () => {
  const root = fixture();
  try {
    const reading = readDeviceMemory(['llama-mistral-small-4.service'], { root, now: () => 1 });
    assert.equal(reading.supported, true);
    assert.equal(reading.sampledAt, 1);

    // card0 publishes no memory counters and is omitted rather than shown empty.
    assert.equal(reading.devices.length, 1);
    assert.equal(reading.devices[0].card, 'card1');
    assert.equal(reading.devices[0].name, 'amdgpu');
    assert.equal(reading.devices[0].vramTotal, 103079215104);
    assert.equal(reading.devices[0].gttUsed, 15682306048);

    assert.equal(reading.gttLimit, 4013711 * 4096);

    assert.equal(reading.clients.length, 1);
    assert.equal(reading.clients[0].pid, 4242);
    assert.equal(reading.clients[0].name, 'llama-server');
    assert.equal(reading.clients[0].unit, 'llama-mistral-small-4.service');
    assert.equal(reading.clients[0].vram, 59661924 * 1024);
    assert.equal(reading.clients[0].gtt, 15153532 * 1024);

    assert.equal(reading.cgroups.length, 1);
    assert.equal(reading.cgroups[0].current, 10737418240);
    assert.equal(reading.cgroups[0].high, 10737418240);
    assert.equal(reading.cgroups[0].max, 15032385536);
    assert.equal(reading.cgroups[0].highEvents, 60166);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a unit nobody asked about gets no cgroup row', () => {
  const root = fixture();
  try {
    const reading = readDeviceMemory([], { root });
    assert.equal(reading.clients.length, 1, 'the client is still found');
    assert.deepEqual(reading.cgroups, [], 'but its cgroup is not read unasked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unset cgroup limit reads as null rather than as the string max', () => {
  const root = fixture();
  try {
    const cg = join(root, 'sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service',
      'antimatter-inference.slice/llama-mistral-small-4.service');
    writeFileSync(join(cg, 'memory.high'), 'max\n');
    const reading = readDeviceMemory(['llama-mistral-small-4.service'], { root });
    assert.equal(reading.cgroups[0].high, null);
    assert.equal(reading.cgroups[0].max, 15032385536);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty tree reports nothing rather than failing', () => {
  const root = mkdtempSync(join(tmpdir(), 'device-memory-empty-'));
  try {
    const reading = readDeviceMemory(['nothing.service'], { root });
    assert.equal(reading.supported, true);
    assert.deepEqual(reading.devices, []);
    assert.deepEqual(reading.clients, []);
    assert.deepEqual(reading.cgroups, []);
    assert.equal(reading.gttLimit, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the process scan is bounded, so a pathological /proc cannot stall the main process', () => {
  const root = mkdtempSync(join(tmpdir(), 'device-memory-many-'));
  try {
    for (let pid = 1; pid <= 50; pid++) {
      const proc = join(root, 'proc', String(pid));
      mkdirSync(join(proc, 'fd'), { recursive: true });
      mkdirSync(join(proc, 'fdinfo'), { recursive: true });
      write(join(proc, 'comm'), 'llama-server\n');
      write(join(proc, 'cgroup'), '0::/user.slice/a.service\n');
      symlinkSync('/dev/dri/renderD128', join(proc, 'fd', '3'));
      write(join(proc, 'fdinfo', '3'), 'drm-pdev:\tx\ndrm-memory-vram:\t16 KiB\n');
    }
    assert.equal(readDeviceMemory([], { root }).clients.length, 50);
    assert.equal(readDeviceMemory([], { root, maxProcesses: 10 }).clients.length, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clients sort by what they hold, so the carveout’s occupant is the first row', () => {
  const root = mkdtempSync(join(tmpdir(), 'device-memory-sort-'));
  try {
    const sizes: Record<string, number> = { '10': 64, '11': 4096, '12': 512 };
    for (const [pid, kib] of Object.entries(sizes)) {
      const proc = join(root, 'proc', pid);
      mkdirSync(join(proc, 'fd'), { recursive: true });
      mkdirSync(join(proc, 'fdinfo'), { recursive: true });
      write(join(proc, 'comm'), `p${pid}\n`);
      write(join(proc, 'cgroup'), '0::/\n');
      symlinkSync('/dev/dri/renderD128', join(proc, 'fd', '3'));
      write(join(proc, 'fdinfo', '3'), `drm-pdev:\tx\ndrm-memory-vram:\t${kib} KiB\n`);
    }
    assert.deepEqual(readDeviceMemory([], { root }).clients.map((c) => c.pid), [11, 12, 10]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
