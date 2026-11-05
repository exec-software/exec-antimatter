import { join } from 'node:path';
import type { Model } from '../../api/types';
import type { InferenceSource } from '../sourceStore';
import { hubEndpoint, HubError, modelDetail, searchModels, whoami, type HubAccount, type HubTransport } from './api';
import * as cache from './cache';
import { DownloadManager, freeBytesAt } from './downloads';
import { Registrar, withRegisteredModels, type BundledStatus } from './engines';
import { HubSettings, type RootState, type SecretBox, type TokenState } from './settings';
import type { DownloadRecord, HubModelDetail, HubSearchPage, HubSearchQuery, HubVariant } from './types';

/**
 * The Model Hub as one object the main process wires to IPC: settings, the download queue, and
 * registration with engines, each of which stays testable on its own.
 */

export interface HubServiceDeps {
  userData: string;
  appVersion: string;
  secrets: SecretBox;
  send(channel: string, payload: unknown): void;
  sources(): InferenceSource[];
  saveSource(source: InferenceSource): void;
  sourceBusy(sourceId: string): boolean;
  probe(baseUrl: string, apiKey?: string): Promise<{ ok: boolean; models: Model[]; error?: string }>;
  beholdd: {
    basePath(): string;
    port(): number;
    status(): Promise<BundledStatus>;
    restart(target: { host: string; port: number }): Promise<{ ready: boolean }>;
  };
  transport?: HubTransport;
}

export interface VariantWithLocal extends HubVariant {
  /** Bytes of this variant already in the download directory, finished or partial. */
  localBytes: number;
}

export interface HubModelView extends Omit<HubModelDetail, 'variants'> {
  variants: VariantWithLocal[];
}

export interface HubState {
  token: TokenState;
  root: RootState & { freeBytes: number | null };
  endpoint: string;
}

const DETAIL_CACHE = 24;
const HEALTH_TIMEOUT_MS = 3000;

async function health(baseUrl: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${new URL(baseUrl).origin}/health`, { signal: controller.signal });
    // It answered: whether it can take a path is decided by what it said, and a refusal says "no".
    return response.ok ? await response.json().catch(() => ({})) : {};
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class HubService {
  readonly settings: HubSettings;
  readonly downloads: DownloadManager;
  readonly registrar: Registrar;
  private readonly details = new Map<string, HubModelDetail>();

  constructor(private readonly deps: HubServiceDeps) {
    this.settings = new HubSettings(join(deps.userData, 'hub-settings.json'), deps.secrets);

    this.registrar = new Registrar({
      overlayPath: join(deps.userData, 'beholdd', 'config.hub.yaml'),
      basePath: deps.beholdd.basePath,
      sources: deps.sources,
      saveSource: deps.saveSource,
      bundledPort: deps.beholdd.port,
      bundledStatus: deps.beholdd.status,
      restartBundled: deps.beholdd.restart,
      sourceBusy: deps.sourceBusy,
      probe: deps.probe,
      health,
      records: () => this.downloads.list(),
      setRegistrations: (id, registrations) => this.downloads.setRegistrations(id, registrations),
      changed: () => deps.send('providers:changed', { at: Date.now() }),
      log: (message) => console.log(`[hub] ${message}`),
    });

    this.downloads = new DownloadManager({
      storePath: join(deps.userData, 'hub-downloads.json'),
      root: () => this.settings.root(),
      token: () => this.settings.token(),
      endpoint: () => hubEndpoint(),
      userAgent: `antimatter/${deps.appVersion}`,
      transport: deps.transport,
      emit: (records) => deps.send('hub:downloads', records),
      onReady: (record) => {
        void this.registrar.register(record).catch((error) => console.error('[hub] registration failed:', error));
      },
      onRemove: (record) => this.registrar.unregister(record),
    });
  }

  /** Loads the queue (resuming what was running) and re-registers what already finished. */
  start(): void {
    this.downloads.load();
    void this.downloads
      .fillMissingFacts()
      .catch((error) => console.error('[hub] could not re-read a download header:', error))
      .then(() => this.registrar.reconcile())
      .catch((error) => console.error('[hub] could not reconcile registrations:', error));
  }

  shutdown(): void {
    this.downloads.shutdown();
  }

  private client() {
    return { token: this.settings.token(), transport: this.deps.transport };
  }

  search(query: HubSearchQuery): Promise<HubSearchPage> {
    return searchModels(query, this.client());
  }

  private remember(detail: HubModelDetail): void {
    const key = `${detail.id}@${detail.revision}`;
    this.details.delete(key);
    this.details.set(key, detail);
    while (this.details.size > DETAIL_CACHE) this.details.delete(this.details.keys().next().value!);
  }

  async model(repoId: string): Promise<HubModelView> {
    const detail = await modelDetail(repoId, this.client());
    this.remember(detail);
    const root = this.settings.root();
    return {
      ...detail,
      variants: detail.variants.map((variant) => ({
        ...variant,
        localBytes: variant.files.reduce(
          (total, file) =>
            total +
            (cache.hasFile(root, detail.id, detail.revision, file.path, file.size)
              ? file.size
              : file.sha256
                ? Math.min(cache.bytesOnDisk(root, detail.id, file.sha256), file.size)
                : 0),
          0
        ),
      })),
    };
  }

  /**
   * Queues a variant by key. The file list comes from the main process's own listing of that
   * commit, never from the renderer, so what is written to disk is what the Hub published.
   */
  async download(input: { repoId: string; revision: string; variantKey: string }): Promise<DownloadRecord[]> {
    const detail =
      this.details.get(`${input.repoId}@${input.revision}`) ??
      (await modelDetail(input.repoId, { ...this.client(), revision: input.revision }));
    this.remember(detail);
    const variant = detail.variants.find((candidate) => candidate.key === input.variantKey);
    if (!variant) throw new HubError('not_found', `${input.repoId} has no file set named ${input.variantKey} at that commit.`);
    this.downloads.enqueue({ repoId: detail.id, revision: detail.revision, variant });
    return this.downloads.list();
  }

  /** Registers a finished download again, for when an engine was down the first time. */
  async reregister(id: string): Promise<DownloadRecord[]> {
    const record = this.downloads.find(id);
    if (record?.state === 'ready') await this.registrar.register(record);
    return this.downloads.list();
  }

  state(): HubState {
    const root = this.settings.rootState();
    return { token: this.settings.tokenState(), root: { ...root, freeBytes: freeBytesAt(root.path) }, endpoint: hubEndpoint() };
  }

  whoami(): Promise<HubAccount> {
    return whoami(this.client());
  }

  /** Adds back the path models this source had registered, after a refresh rewrote its list. */
  withRegisteredModels(source: InferenceSource): InferenceSource {
    return withRegisteredModels(source, this.downloads.list());
  }
}
