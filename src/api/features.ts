export interface ManagedFeature { key: string; description: string; defaultEnabled: boolean; override: boolean | null; enabled: boolean }
export interface FeatureApplication { id: string; name: string; features: ManagedFeature[] }
export interface FeatureAudit { at: number; application: string; key: string | null; action: string; actor: 'desktop' | 'sdk' }
export interface FeatureState {
  revision: number; applications: FeatureApplication[]; audit: FeatureAudit[];
  api: { enabled: boolean; endpoint: string | null; error: string | null };
}
export type FeatureMutation =
  | { kind: 'application'; id: string; name: string }
  | { kind: 'remove-application'; id: string }
  | { kind: 'declare'; application: string; key: string; description: string; defaultEnabled: boolean }
  | { kind: 'override'; application: string; key: string; value: boolean | null }
  | { kind: 'remove-feature'; application: string; key: string };
export interface FeaturesAPI {
  get(): Promise<FeatureState>;
  update(revision: number, mutation: FeatureMutation): Promise<FeatureState>;
  configureApi(enabled: boolean): Promise<FeatureState>;
  onChanged(callback: () => void): () => void;
}
