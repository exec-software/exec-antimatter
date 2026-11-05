import { readFileSync } from 'node:fs';
import { writePrivateFileAtomic } from '../privateState';

export const AVATARS = ['atom', 'robot', 'cat'] as const;
export type AvatarKind = typeof AVATARS[number];
export interface DesktopAvatarSettings { enabled: boolean; kind: AvatarKind; x: number | null; y: number | null }
export const DEFAULT_AVATAR: DesktopAvatarSettings = { enabled: false, kind: 'atom', x: null, y: null };

export function normalizeAvatar(value: unknown): DesktopAvatarSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const coordinate = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
  return { enabled: input.enabled === true, kind: AVATARS.includes(input.kind as AvatarKind) ? input.kind as AvatarKind : 'atom',
    x: coordinate(input.x), y: coordinate(input.y) };
}

export function avatarPosition(settings: DesktopAvatarSettings, areas: Array<{ x: number; y: number; width: number; height: number }>) {
  const area = areas.find((a) => settings.x !== null && settings.y !== null &&
    settings.x >= a.x && settings.x < a.x + a.width && settings.y >= a.y && settings.y < a.y + a.height) ??
    areas[0] ?? { x: 0, y: 0, width: 1024, height: 768 };
  const x = settings.x ?? area.x + area.width - 200;
  const y = settings.y ?? area.y + area.height - 240;
  return { x: Math.round(Math.max(area.x, Math.min(area.x + area.width - 180, x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - 208, y))) };
}

export class AvatarSettingsStore {
  constructor(private readonly file: string) {}
  get(): DesktopAvatarSettings {
    try { return normalizeAvatar(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return { ...DEFAULT_AVATAR };
    }
  }
  update(patch: Partial<DesktopAvatarSettings>): DesktopAvatarSettings {
    const next = normalizeAvatar({ ...this.get(), ...patch });
    writePrivateFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
