import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { FeatureApplication, FeatureAudit, FeatureMutation } from '../../api/features';
import { writePrivateFileAtomic } from '../privateState';

export interface FeatureRecord { version: 1; revision: number; applications: FeatureApplication[]; audit: FeatureAudit[]; apiEnabled: boolean }
export function featureIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(value)) throw new Error('Use an identifier beginning with a letter, followed by letters, digits, dots, dashes or underscores.');
  return value;
}
function featureText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid feature text.');
  return value.trim();
}
const flag = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new Error('Expected on or off.'); return value; };
const empty = (): FeatureRecord => ({ version: 1, revision: 0, applications: [], audit: [], apiEnabled: false });

export class FeatureStore {
  constructor(private readonly file: string, private readonly write = writePrivateFileAtomic) {}
  read(): FeatureRecord {
    let fd: number | undefined;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid feature store.');
      const buffer = Buffer.alloc(stat.size + 1); const size = readSync(fd, buffer, 0, buffer.length, 0);
      if (size !== stat.size) throw new Error('The feature store changed while reading.');
      const value = JSON.parse(buffer.subarray(0, size).toString('utf8'));
      if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.apiEnabled !== 'boolean'
          || !Array.isArray(value.applications) || value.applications.length > 100 || !Array.isArray(value.audit) || value.audit.length > 200) throw new Error('Unsupported feature store.');
      const applications: FeatureApplication[] = value.applications.map((application: FeatureApplication) => {
        if (!Array.isArray(application.features) || application.features.length > 1000) throw new Error('Invalid application features.');
        const features = application.features.map((feature) => {
          if (feature.override !== null && typeof feature.override !== 'boolean') throw new Error('Invalid feature override.');
          return { key: featureIdentifier(feature.key), description: featureText(feature.description, 500), defaultEnabled: flag(feature.defaultEnabled),
            override: feature.override, enabled: feature.override ?? feature.defaultEnabled };
        });
        if (new Set(features.map((feature) => feature.key)).size !== features.length) throw new Error('Duplicate feature identifiers.');
        return { id: featureIdentifier(application.id), name: featureText(application.name, 120), features };
      });
      if (new Set(applications.map((application) => application.id)).size !== applications.length) throw new Error('Duplicate applications.');
      const audit: FeatureAudit[] = value.audit.map((entry: FeatureAudit) => {
        if (!Number.isSafeInteger(entry.at) || entry.at < 0 || !['desktop', 'sdk'].includes(entry.actor)) throw new Error('Invalid feature audit.');
        return { at: entry.at, application: featureIdentifier(entry.application), key: entry.key === null ? null : featureIdentifier(entry.key),
          actor: entry.actor, action: featureText(entry.action, 120) };
      });
      return { version: 1, revision: value.revision, applications, audit, apiEnabled: value.apiEnabled };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  private save(value: FeatureRecord): FeatureRecord {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error('The feature store is full.');
    this.write(this.file, serialized); return structuredClone(value);
  }
  setApi(enabled: boolean): void { const current = this.read(); current.apiEnabled = flag(enabled); current.revision++; this.save(current); }
  update(revision: number, mutation: FeatureMutation, actor: 'desktop' | 'sdk' = 'desktop'): FeatureRecord {
    const current = this.read();
    if (revision !== current.revision) throw new Error('Features changed. Refresh before saving.');
    if (!mutation || typeof mutation !== 'object') throw new Error('Invalid feature action.');
    let application: string, key: string | null = null;
    if (mutation.kind === 'application' || mutation.kind === 'remove-application') {
      if (actor !== 'desktop') throw new Error('Applications must be managed in Antimatter.');
      application = featureIdentifier(mutation.id);
      const existing = current.applications.find((entry) => entry.id === application);
      if (mutation.kind === 'application') {
        const name = featureText(mutation.name, 120); if (!name) throw new Error('Enter an application name.');
        if (existing) existing.name = name;
        else { if (current.applications.length >= 100) throw new Error('The application limit is reached.'); current.applications.push({ id: application, name, features: [] }); }
      } else { if (!existing) throw new Error('Application not found.'); current.applications = current.applications.filter((entry) => entry.id !== application); }
    } else {
      application = featureIdentifier(mutation.application); key = featureIdentifier(mutation.key);
      const app = current.applications.find((entry) => entry.id === application);
      if (!app) throw new Error('Register this application in Antimatter first.');
      const feature = app.features.find((entry) => entry.key === key);
      if (mutation.kind === 'declare') {
        const defaultEnabled = flag(mutation.defaultEnabled), description = featureText(mutation.description, 500);
        if (feature) {
          // SDK declarations are idempotent; redeploying an app cannot erase desktop overrides or metadata.
          if (actor === 'sdk') return current;
          feature.description = description; feature.defaultEnabled = defaultEnabled; feature.enabled = feature.override ?? defaultEnabled;
        } else {
          if (app.features.length >= 1000) throw new Error('The feature limit is reached.');
          app.features.push({ key, description, defaultEnabled, override: null, enabled: defaultEnabled });
        }
      } else if (mutation.kind === 'override') {
        if (!feature) throw new Error('Feature not found.');
        if (mutation.value !== null && typeof mutation.value !== 'boolean') throw new Error('Choose default, on, or off.');
        feature.override = mutation.value; feature.enabled = mutation.value ?? feature.defaultEnabled;
      } else if (mutation.kind === 'remove-feature') {
        if (actor !== 'desktop' || !feature) throw new Error('Feature not found or removal not allowed.');
        app.features = app.features.filter((entry) => entry.key !== key);
      } else throw new Error('Unknown feature action.');
    }
    current.revision++;
    current.audit.unshift({ at: Date.now(), application, key, action: mutation.kind, actor }); current.audit.splice(200);
    return this.save(current);
  }
}
