import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkloadView } from '../api/workloads';
import type { DownloadManager } from './hub/downloads';
import { snapshotPath } from './hub/cache';
import type { InferenceSource } from './sourceStore';
import { writePrivateFileAtomic } from './privateState';
import { listWorkloads, renderWorkloadPreset, workloadById } from './workloads';

interface Deployment { peers: string[]; }
export const workloadSourceId = (id: string): string => `workload-${id}`;
export const isWorkloadSource = (id: string): boolean => id.startsWith('workload-');

/** Installs catalog presets only after the download queue verified every pinned shard. */
export class WorkloadDeployments {
  private readonly file: string;
  constructor(userData: string, private readonly downloads: Pick<DownloadManager, 'list'>,
    private readonly sourceExists: (sourceId: string) => boolean = () => true) {
    this.file = join(userData, 'workload-deployments.json');
  }

  private read(): Record<string, Deployment> {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: number; deployments?: Record<string, Deployment> };
      if (parsed.version !== 1 || !parsed.deployments || typeof parsed.deployments !== 'object' || Array.isArray(parsed.deployments)) throw new Error('Invalid deployment store.');
      for (const [id, deployment] of Object.entries(parsed.deployments)) {
        if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment) || !Array.isArray(deployment.peers)) throw new Error('Invalid deployment.');
        // The same catalog and peer rules apply after restart as during initial setup. Do not
        // pass malformed stored values to the renderer or turn them into runtime options.
        const stored = workloadById(id);
        renderWorkloadPreset(stored.id, '/validated-model.gguf', deployment.peers,
          stored.projector ? '/validated-mmproj.gguf' : undefined);
      }
      return parsed.deployments;
    } catch {
      throw new Error('Workload settings could not be read.');
    }
  }

  list(): WorkloadView[] {
    const deployments = this.read();
    return listWorkloads(this.downloads).map((workload) => ({ ...workload,
      ...(deployments[workload.id] && this.sourceExists(workloadSourceId(workload.id)) ? { deployment: {
        sourceId: workloadSourceId(workload.id), modelId: workload.id, peers: deployments[workload.id].peers,
      } } : {}),
    }));
  }

  /**
   * Every pinned file must be present, verified, and still the right size on disk before a
   * preset is written. A projector is checked exactly as strictly as the weights: serving a
   * media model without it reports no vision support rather than failing, which is worse.
   */
  private resolvedFiles(id: string): { model: string; projector?: string } {
    const workload = workloadById(id);
    const records = this.downloads.list();
    const resolve = (variantKey: string, files: typeof workload.files): string => {
      const record = records.find((entry) => entry.repoId === workload.repoId &&
        entry.revision === workload.revision && entry.variantKey === variantKey && entry.state === 'ready');
      if (!record) throw new Error('Finish downloading and verifying this workload before setting it up.');
      for (const file of files) {
        const saved = record.files.find((entry) => entry.path === file.path);
        if (!saved?.done || saved.sha256 !== file.sha256 || saved.size !== file.size) throw new Error('This workload has an unverified model shard.');
        const path = snapshotPath(record.root, workload.repoId, workload.revision, file.path);
        if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size !== file.size) throw new Error('A workload model shard is missing or changed. Download it again.');
      }
      return snapshotPath(record.root, workload.repoId, workload.revision, files[0].path);
    };
    const model = resolve(workload.variantKey, workload.files);
    return workload.projector
      ? { model, projector: resolve(workload.projector.variantKey, [workload.projector.file]) }
      : { model };
  }

  configure(value: unknown, peers: string[]): { source: InferenceSource; contextTokens: number } {
    const workload = workloadById(value);
    const paths = this.resolvedFiles(workload.id);
    const preset = renderWorkloadPreset(workload.id, paths.model, peers, paths.projector);
    const deployments = this.read();
    deployments[workload.id] = { peers: [...peers] };
    writePrivateFileAtomic(join(this.file.slice(0, -'.json'.length), `${workload.id}.ini`), `version = 1\n\n${preset}`);
    writePrivateFileAtomic(this.file, JSON.stringify({ version: 1, deployments }, null, 2) + '\n');
    const contextTokens = workload.contextTokens;
    return { contextTokens, source: {
      id: workloadSourceId(workload.id), name: workload.name, kind: 'llama-cpp', protocol: 'openai-chat',
      apiKey: '', baseUrl: 'http://127.0.0.1:6769/v1', supportsStreaming: true, createdAt: Date.now(),
      models: [{ id: workload.id, name: workload.name, contextWindow: contextTokens,
        quantization: workload.quantization, deployment: peers.length ? 'distributed' : 'local', manuallyDeclared: true }],
    } };
  }

  runtime(sourceId: string): { sourceId: string; modelId: string; modelPath: string; preset: string } {
    if (!isWorkloadSource(sourceId)) throw new Error('Choose a managed workload source.');
    const id = sourceId.slice('workload-'.length);
    const workload = workloadById(id);
    const deployment = this.read()[id];
    if (!deployment) throw new Error('Set up this workload from the setup wizard first.');
    const paths = this.resolvedFiles(id);
    return { sourceId, modelId: id, modelPath: paths.model,
      preset: `version = 1\n\n${renderWorkloadPreset(workload.id, paths.model, deployment.peers, paths.projector)}` };
  }
}
