import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Exercise the real start/stop implementations with synthetic process and HTTP boundaries.
// No listener, service, process, model, or GPU is created by this fixture.
test('cancelled managed starts retire their own process before retry; warm cancellation preserves the owner', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-start-cancellation-'));
  const config = join(root, 'config.yaml');
  const model = join(root, 'model.gguf');
  writeFileSync(config, 'models: []\n'); writeFileSync(model, 'fixture');
  for (const path of ['vendor/beholdd/bin', 'vendor/llama-vulkan/runtime']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'vendor/beholdd/bin/beholdd'), 'fixture');
  writeFileSync(join(root, 'vendor/llama-vulkan/runtime/llama-server'), 'fixture');
  const children: FakeChild[] = [];
  let ready = false;
  let holdExit = true;
  let spawned: ((child: FakeChild) => void) | undefined;
  let onProbe: (() => void) | undefined;
  class FakeChild extends EventEmitter {
    pid = 900_000_000 + children.length;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    signals: NodeJS.Signals[] = [];
    kill(signal: NodeJS.Signals): boolean {
      this.signals.push(signal);
      if (!holdExit) this.exit();
      return true;
    }
    exit() {
      if (this.exitCode !== null) return;
      this.exitCode = 0;
      this.emit('exit', 0, null); this.emit('close', 0, null);
    }
  }
  type Loader = (name: string, parent: unknown, isMain: boolean) => unknown;
  const module = require('node:module') as { _load: Loader };
  const load = module._load;
  const kill = process.kill;
  const childProcess = require('node:child_process');
  module._load = function (name, parent, isMain) {
    if (name === 'electron') return { app: { isPackaged: false, getAppPath: () => root, getPath: () => join(root, 'data') } };
    if (name === 'node:child_process') return { ...childProcess, spawn: () => {
      const child = new FakeChild(); children.push(child); spawned?.(child); return child;
    } };
    if (name === 'node:http') return { request: (_options: unknown, callback: (response: unknown) => void) => {
      const request = Object.assign(new EventEmitter(), {
        destroy() { this.emit('error', new Error('closed')); },
        end() { queueMicrotask(() => {
          onProbe?.();
          if (!ready || !children.some((child) => child.exitCode === null)) { this.emit('error', new Error('not ready')); return; }
          const response = Object.assign(new EventEmitter(), { statusCode: 200, resume() {}, destroy() {} });
          callback(response);
          response.emit('data', JSON.stringify({ object: 'list', data: [{ id: 'fixture-model' }] }));
          response.emit('end');
        }); },
      });
      return request;
    } };
    if (name === 'node:net') return { connect: () => {
      const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
      queueMicrotask(() => socket.emit('error', new Error('unoccupied'))); return socket;
    } };
    return load.call(this, name, parent, isMain);
  };
  process.kill = ((pid: number, signal: NodeJS.Signals | number = 'SIGTERM') => {
    const child = children.find((entry) => entry.pid === Math.abs(pid) && entry.exitCode === null);
    if (!child) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    if (signal !== 0) child.kill(signal as NodeJS.Signals);
    return true;
  }) as typeof process.kill;
  const native = require('../src/main/beholdd') as typeof import('../src/main/beholdd');
  const router = require('../src/main/llamaVulkan') as typeof import('../src/main/llamaVulkan');
  t.after(async () => {
    holdExit = false; onProbe = undefined;
    for (const child of children) child.exit();
    await native.stop(); await router.stop();
    process.kill = kill; module._load = load;
    rmSync(root, { recursive: true, force: true });
  });
  const selection = { sourceId: 'fixture', modelId: 'fixture-model', modelPath: model, preset: '[fixture-model]\n' };
  for (const engine of [
    { name: 'native', start: (signal?: AbortSignal) => native.start({ configPath: config }, signal), stop: native.stop, state: native.status },
    { name: 'router', start: (signal?: AbortSignal) => router.start(selection, signal), stop: router.stop, state: router.status },
  ]) {
    ready = false; holdExit = true;
    const controller = new AbortController();
    const started = new Promise<FakeChild>((resolve) => { spawned = resolve; });
    let settled = false;
    const pending = engine.start(controller.signal).finally(() => { settled = true; });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    const child = await started;
    controller.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(child.signals, ['SIGTERM'], engine.name);
    assert.equal(settled, false, `${engine.name} retains its lease until retirement`);
    const count = children.length;
    ready = true;
    const retry = engine.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(children.length, count, `${engine.name} cannot overlap the retiring process`);
    child.exit(); holdExit = false;
    await rejected; await retry;
    assert.equal(children.length, count + 1, `${engine.name} retry starts exactly once`);
    assert.equal(engine.state().ownership, 'app');
    const warm = children.at(-1)!;
    const cancelWarm = new AbortController();
    onProbe = () => cancelWarm.abort();
    await assert.rejects(engine.start(cancelWarm.signal), { name: 'AbortError' });
    onProbe = undefined;
    assert.equal(warm.exitCode, null, `${engine.name} cancellation does not stop a preexisting owner`);
    assert.deepEqual(warm.signals, []);
    await engine.stop();
    assert.equal(engine.state().running, false);
  }
});
