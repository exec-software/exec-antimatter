import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { cachedTokenPath, defaultHubCache } from './cache';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from '../privateState';

/**
 * The Model Hub's own settings: the Hugging Face token, and where downloads go.
 *
 * The token is sealed with the OS keyring exactly as source API keys are, and it never travels
 * to the renderer — the Settings page learns only whether one is set and, on request, whose it
 * is. Antimatter does not pick up a token from the environment or `hf auth login` on its own
 * account: a credential it sends is one somebody put here, which "Import" does on request.
 */

export interface SecretBox {
  available(): boolean;
  seal(value: string): string;
  open(sealed: string): string;
}

interface SettingsFile {
  version: 1;
  tokenCipher?: string;
  /** Only where the OS has no keyring; the UI says so. */
  tokenPlain?: string;
  /** Null or absent means the Hugging Face cache huggingface_hub itself would use. */
  root?: string | null;
}

export interface TokenState {
  configured: boolean;
  encrypted: boolean;
  /** A token `hf auth login` or HF_TOKEN left on this machine, which Import can copy in. */
  importable: 'env' | 'file' | null;
  importPath: string;
}

export interface RootState {
  path: string;
  isDefault: boolean;
  defaultPath: string;
}

/** Tokens are opaque, but a pasted one with spaces or line breaks in it is a paste gone wrong. */
export function normalizeToken(value: string): string {
  const token = value.trim();
  if (!token) throw new Error('The token is empty.');
  if (/\s/.test(token)) throw new Error('The token contains spaces or line breaks; paste just the token.');
  if (token.length < 8 || token.length > 512) throw new Error('That does not look like a Hugging Face token.');
  return token;
}

export class HubSettings {
  private cache: SettingsFile | null = null;

  constructor(
    private readonly path: string,
    private readonly secrets: SecretBox,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  private read(): SettingsFile {
    if (this.cache) return this.cache;
    const ownsDirectory = migratePrivateDirectory(dirname(this.path));
    if (!existsSync(this.path)) return (this.cache = { version: 1 });
    if (ownsDirectory) migratePrivateFile(this.path);
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as SettingsFile;
      this.cache = parsed?.version === 1 ? parsed : { version: 1 };
    } catch (error) {
      console.error('[hub] unreadable settings, starting empty:', error);
      this.cache = { version: 1 };
    }
    return this.cache;
  }

  private write(next: SettingsFile): void {
    writePrivateFileAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`);
    this.cache = next;
  }

  token(): string | null {
    const stored = this.read();
    if (stored.tokenCipher) {
      try {
        return this.secrets.open(stored.tokenCipher) || null;
      } catch (error) {
        console.error('[hub] could not unseal the Hugging Face token:', error);
        return null;
      }
    }
    return stored.tokenPlain || null;
  }

  setToken(value: string | null): TokenState {
    const { tokenCipher: _cipher, tokenPlain: _plain, ...rest } = this.read();
    if (value === null) {
      this.write({ ...rest, version: 1 });
      return this.tokenState();
    }
    const token = normalizeToken(value);
    this.write({
      ...rest,
      version: 1,
      ...(this.secrets.available() ? { tokenCipher: this.secrets.seal(token) } : { tokenPlain: token }),
    });
    return this.tokenState();
  }

  /** Copies in the token HF_TOKEN or `hf auth login` provides. Returns false when there is none. */
  importToken(): boolean {
    const found = this.findImportable();
    if (!found) return false;
    this.setToken(found.token);
    return true;
  }

  private findImportable(): { source: 'env' | 'file'; token: string } | null {
    const fromEnv = this.env.HF_TOKEN?.trim() || this.env.HUGGING_FACE_HUB_TOKEN?.trim();
    if (fromEnv) return { source: 'env', token: fromEnv };
    try {
      const fromFile = readFileSync(cachedTokenPath(this.env), 'utf8').trim();
      if (fromFile) return { source: 'file', token: fromFile };
    } catch {
      // No login on this machine.
    }
    return null;
  }

  tokenState(): TokenState {
    const stored = this.read();
    return {
      configured: !!(stored.tokenCipher || stored.tokenPlain),
      // A legacy cipher remains readable through open(), but it is not described as keyring-grade
      // when the current platform has only Linux basic_text (or no secure backend at all).
      encrypted: !!stored.tokenCipher && this.secrets.available(),
      importable: this.findImportable()?.source ?? null,
      importPath: cachedTokenPath(this.env),
    };
  }

  root(): string {
    return this.read().root || defaultHubCache(this.env);
  }

  rootState(): RootState {
    const defaultPath = defaultHubCache(this.env);
    const stored = this.read().root;
    return { path: stored || defaultPath, isDefault: !stored, defaultPath };
  }

  setRoot(path: string | null): RootState {
    const current = this.read();
    if (path !== null && !isAbsolute(path)) throw new Error('Choose an absolute directory for downloads.');
    this.write({ ...current, version: 1, root: path ? resolve(path) : null });
    return this.rootState();
  }
}
