import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeatureMutation, FeatureState } from '../../api/features';
import { FeatureStore, featureIdentifier } from './store';

/** Private local socket. No browser origins, network binding, executable commands or credentials. */
export class FeatureService {
  private server: Server | null = null;
  private endpoint: string | null = null;
  private directory: string | null = null;
  private error: string | null = null;
  private transition: Promise<unknown> = Promise.resolve();
  private clients = new Set<Socket>();
  constructor(readonly store: FeatureStore, private changed: () => void = () => {}) {}
  get(): FeatureState {
    const record = this.store.read();
    return { revision: record.revision, applications: record.applications, audit: record.audit,
      api: { enabled: record.apiEnabled, endpoint: this.endpoint, error: this.error } };
  }
  update(revision: number, mutation: FeatureMutation): FeatureState { this.store.update(revision, mutation); this.changed(); return this.get(); }
  configureApi(enabled: boolean): Promise<FeatureState> {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Choose on or off.'));
    const run = this.transition.then(async () => {
      if (enabled) {
        await this.start();
        try { if (!this.store.read().apiEnabled) this.store.setApi(true); }
        catch (error) { await this.stop(); throw error; }
      } else { this.store.setApi(false); await this.stop(); }
      this.error = null; this.changed(); return this.get();
    }).catch((error) => { this.error = error instanceof Error ? error.message : 'Local API failed.'; this.changed(); throw error; });
    this.transition = run.catch(() => undefined); return run;
  }
  async initialize(): Promise<void> { if (this.store.read().apiEnabled) await this.configureApi(true); }
  private async start(): Promise<void> {
    if (this.server) return;
    if (process.platform === 'win32') throw new Error('The native feature SDK currently supports Linux and macOS. Dashboard controls are available on this platform.');
    const directory = mkdtempSync(join(tmpdir(), 'antimatter-features-')); chmodSync(directory, 0o700);
    const endpoint = join(directory, 'api.sock');
    const server = createServer((socket) => {
      if (this.clients.size >= 16) { socket.destroy(); return; }
      this.clients.add(socket); socket.setTimeout(2000, () => socket.destroy());
      socket.on('error', () => {}); socket.once('close', () => this.clients.delete(socket));
      let input = Buffer.alloc(0), handled = false;
      socket.on('data', (chunk) => {
        if (handled) return;
        if (input.length + chunk.length > 4096) { socket.destroy(); return; }
        input = Buffer.concat([input, chunk]);
        const end = input.indexOf(10); if (end < 0) return;
        handled = true;
        if (end !== input.length - 1) { socket.end('ERR\tOne request per connection.\n'); return; }
        try { socket.end(this.protocol(input.subarray(0, end).toString('utf8'))); }
        catch (error) { socket.end(`ERR\t${(error instanceof Error ? error.message : 'Request failed.').replace(/[\r\n\t]/g, ' ').slice(0, 300)}\n`); }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); }); });
      chmodSync(endpoint, 0o600);
      server.on('error', () => { this.error = 'Local feature API failed.'; this.changed(); });
      this.server = server; this.directory = directory; this.endpoint = endpoint;
    } catch (error) { server.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
  }
  async stop(): Promise<void> {
    const server = this.server, directory = this.directory;
    this.server = null; this.endpoint = null; this.directory = null;
    for (const socket of this.clients) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
  protocol(line: string): string {
    const [version, operation, application, key, value, ...extra] = line.split('\t');
    if (version !== '1' || extra.length) throw new Error('Unsupported feature protocol.');
    featureIdentifier(application);
    let current = this.store.read();
    if (!current.apiEnabled) throw new Error('The local API is disabled.');
    const app = current.applications.find((entry) => entry.id === application);
    if (!app) throw new Error('Register this application in Antimatter first.');
    if (operation === 'LIST' && key === undefined) return `OK\t${JSON.stringify(app.features)}\n`;
    featureIdentifier(key);
    if (operation === 'DECLARE' && (value === '0' || value === '1')) {
      current = this.store.update(current.revision, { kind: 'declare', application, key, description: '', defaultEnabled: value === '1' }, 'sdk');
      this.changed();
    } else if (operation === 'SET' && ['0', '1', '-1'].includes(value)) {
      current = this.store.update(current.revision, { kind: 'override', application, key, value: value === '-1' ? null : value === '1' }, 'sdk');
      this.changed();
    } else if (operation !== 'GET' || value !== undefined) throw new Error('Invalid feature operation.');
    const feature = current.applications.find((entry) => entry.id === application)?.features.find((entry) => entry.key === key);
    if (!feature) throw new Error('Feature not found.');
    return `OK\t${feature.enabled ? 1 : 0}\n`;
  }
}
