export type LibraryKind = 'note' | 'schema' | 'reference';
export type LibraryLanguage = 'shared' | 'rust' | 'cpp' | 'matrix' | 'ny' | 'nil';
export interface LibraryEntry {
  id: string;
  title: string;
  kind: LibraryKind;
  language: LibraryLanguage;
  content: string;
  origin: 'shipped' | 'custom';
  scope: 'global' | 'project';
  enabled: boolean;
  updatedAt: number | null;
}
export interface PensieveLibraryState {
  revision: number;
  enabled: boolean;
  entries: LibraryEntry[];
  project: string | null;
  notice: string | null;
}
export type LibraryMutation =
  | { kind: 'enable'; enabled: boolean }
  | { kind: 'toggle'; id: string; enabled: boolean }
  | { kind: 'save'; id?: string; title: string; content: string; entryKind: LibraryKind; language: LibraryLanguage; scope: 'global' | 'project' }
  | { kind: 'delete'; id: string };
export interface PensieveLibraryAPI {
  get(workspace?: string | null): Promise<PensieveLibraryState>;
  update(input: { workspace?: string | null; revision: number; mutation: LibraryMutation }): Promise<PensieveLibraryState>;
  onChanged(listener: () => void): () => void;
}
