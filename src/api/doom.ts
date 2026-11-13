export interface DoomWad { name: string; gameId: string; bytes: Uint8Array }
export interface DoomRuntime { javascript: string; wasm: Uint8Array; data: Uint8Array }
export interface DoomSave { name: string; bytes: Uint8Array }
export interface DoomSession { token: string; gameId: string; saves: DoomSave[] }
export interface DoomAPI {
  runtime(): Promise<DoomRuntime>;
  chooseWad(): Promise<DoomWad | null>;
  openSession(gameId: string): Promise<DoomSession>;
  save(token: string, files: DoomSave[]): Promise<void>;
}
export const DEFAULT_DOOM_GAME_ID = 'freedoom2-0.13.0';
export const MAX_WAD_BYTES = 64 * 1024 * 1024;
export const MAX_DOOM_SAVE_BYTES = 2 * 1024 * 1024;
export const MAX_DOOM_SAVES = 8;

export function validateDoomGameId(value: unknown): string {
  if (value !== DEFAULT_DOOM_GAME_ID && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw new Error('Invalid game identity.');
  return value as string;
}
export function validateDoomSaves(value: unknown): DoomSave[] {
  if (!Array.isArray(value) || value.length > MAX_DOOM_SAVES) throw new Error('Invalid game saves.');
  const names = new Set<string>(); let total = 0;
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !/^doomsav[0-7]\.dsg$/.test(entry.name) || names.has(entry.name)
      || !(entry.bytes instanceof Uint8Array) || !entry.bytes.length || entry.bytes.length > MAX_DOOM_SAVE_BYTES) throw new Error('Invalid save slot.');
    names.add(entry.name); total += entry.bytes.length;
    if (total > 8 * 1024 * 1024) throw new Error('Game saves exceed 8 MB.');
    return { name: entry.name, bytes: new Uint8Array(entry.bytes) };
  });
}
