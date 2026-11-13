import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent } from 'electron';
import { MAX_WAD_BYTES, validateDoomGameId, validateDoomSaves, type DoomRuntime, type DoomSave, type DoomSession } from '../api/doom';
import { writePrivateFileAtomic } from './privateState';

function boundedRead(file: string, max: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw new Error('File exceeds the allowed size.');
    const bytes = Buffer.alloc(stat.size + 1); const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size) throw new Error('File changed while reading.');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}

export class DoomSaveStore {
  private sessions = new Map<string, string>();
  constructor(private readonly directory: string, private readonly write = writePrivateFileAtomic) {}
  open(gameId: string): DoomSession {
    validateDoomGameId(gameId);
    let saves: DoomSave[] = [];
    try {
      const stored = JSON.parse(boundedRead(join(this.directory, `${gameId}.json`), 12 * 1024 * 1024).toString('utf8'));
      if (stored.version !== 1 || stored.gameId !== gameId || !Array.isArray(stored.saves)) throw new Error('Invalid saved game.');
      saves = validateDoomSaves(stored.saves.map((entry: { name: string; base64: string }) => {
        if (typeof entry.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64)) throw new Error('Invalid saved game data.');
        return { name: entry.name, bytes: new Uint8Array(Buffer.from(entry.base64, 'base64')) };
      }));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved games could not be read. Existing files were kept.'); }
    // Only the newest instance may save this WAD: moving/reopening a panel cannot overwrite it
    // with a delayed message from the previous iframe.
    for (const [token, id] of this.sessions) if (id === gameId) this.sessions.delete(token);
    if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomUUID(); this.sessions.set(token, gameId);
    return { token, gameId, saves };
  }
  save(token: string, input: unknown): void {
    const gameId = this.sessions.get(token);
    if (!gameId) throw new Error('This game session is no longer active.');
    const saves = validateDoomSaves(input);
    this.write(join(this.directory, `${gameId}.json`), JSON.stringify({ version: 1, gameId, saves: saves.map((save) => ({ name: save.name, base64: Buffer.from(save.bytes).toString('base64') })) }) + '\n');
  }
}

export function readDoomRuntime(directory: string): DoomRuntime {
  const manifest = JSON.parse(boundedRead(join(directory, 'runtime-manifest.json'), 32768).toString('utf8'));
  if (manifest.revision !== '64de0924591dec59a7d49a7d10467e125b50ea99' || !Array.isArray(manifest.assets)) throw new Error('Doom runtime manifest is unsupported.');
  const read = (name: string, max: number): Buffer => {
    const asset = manifest.assets.find((entry: { name: string }) => entry.name === name);
    if (!asset) throw new Error(`Doom runtime is incomplete: ${name}`);
    const bytes = boundedRead(join(directory, name), max);
    if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Doom runtime checksum failed: ${name}`);
    return bytes;
  };
  // Source and notices must accompany the runtime in shipping builds; the release verifier
  // hashes them all. Runtime startup checks their presence without reading the source archive.
  for (const name of ['corresponding-source.tar.gz', 'CHOCOLATE-DOOM-GPL-2.0.md', 'FREEDOOM-COPYING.txt', 'EMSCRIPTEN-LICENSE.txt', 'SDL2-LICENSE.txt']) {
    const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (!fstatSync(fd).isFile()) throw new Error('Doom source or license file is invalid.'); } finally { closeSync(fd); }
  }
  return { javascript: read('chocolate-doom.js', 512 * 1024).toString('utf8'), wasm: new Uint8Array(read('chocolate-doom.wasm', 8 * 1024 * 1024)), data: new Uint8Array(read('chocolate-doom.data', 40 * 1024 * 1024)) };
}

export function registerDoomIpc(options: { ipcMain: IpcMain; authorize(event: IpcMainInvokeEvent): void; dialog: Dialog; getWindow(): BrowserWindow | null; runtimeDirectory: string; saves: DoomSaveStore }): void {
  const { ipcMain, authorize, dialog, getWindow, runtimeDirectory, saves } = options;
  ipcMain.handle('doom:runtime', (event) => { authorize(event); return readDoomRuntime(runtimeDirectory); });
  ipcMain.handle('doom:choose-wad', async (event) => {
    authorize(event); const window = getWindow(); if (!window) throw new Error('Main window unavailable.');
    const result = await dialog.showOpenDialog(window, { title: 'Choose Doom game data', properties: ['openFile'], filters: [{ name: 'Doom IWAD', extensions: ['wad', 'iwad'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0]; const bytes = boundedRead(file, MAX_WAD_BYTES);
    if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'IWAD') throw new Error('Choose a complete IWAD (game data), not an add-on PWAD.');
    const count = bytes.readUInt32LE(4), offset = bytes.readUInt32LE(8);
    if (count > 1000000 || offset < 12 || offset + count * 16 > bytes.length) throw new Error('The WAD directory is invalid.');
    return { name: basename(file), gameId: createHash('sha256').update(bytes).digest('hex'), bytes: new Uint8Array(bytes) };
  });
  ipcMain.handle('doom:open-session', (event, gameId: unknown) => { authorize(event); return saves.open(validateDoomGameId(gameId)); });
  ipcMain.handle('doom:save', (event, token: unknown, files: unknown) => { authorize(event); if (typeof token !== 'string') throw new Error('Invalid game session.'); saves.save(token, files); });
}
