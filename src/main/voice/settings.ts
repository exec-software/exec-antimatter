import { existsSync, readFileSync } from 'node:fs';
import type { ProviderConfig } from '../../api/types';
import type { VoiceSettings, VoiceSource } from '../../api/voice';
import { writePrivateFileAtomic } from '../privateState';
import { isLocalVoiceSource } from './backend';

export function voiceSources(sources: ProviderConfig[]): VoiceSource[] {
  return sources.filter((source) => !source.protocol || source.protocol === 'openai-chat').map((source) => {
    return { id: source.id, name: source.name, local: isLocalVoiceSource(source), models: source.models.map((model) => model.id) };
  });
}
export function defaultVoiceSettings(sources: ProviderConfig[]): VoiceSettings {
  const available = voiceSources(sources);
  const streaming = available.find((entry) => entry.local && entry.models.some((model) => /moonshine.*streaming/i.test(model)));
  const source = streaming ?? available.find((entry) => entry.local && entry.models.some((model) => /qwen3[-_]?omni/i.test(model)));
  const speech = available.find((entry) => entry.local && entry.models.some((model) => /kokoro/i.test(model)));
  return { inputSourceId: source?.id ?? '', inputModel: source?.models.find((model) => streaming ? /moonshine.*streaming/i.test(model) : /qwen3[-_]?omni/i.test(model)) ?? '',
    inputMode: streaming ? 'realtime' : 'chat-audio', speechSourceId: speech?.id ?? '', speechModel: speech?.models.find((model) => /kokoro/i.test(model)) ?? 'kokoro',
    speechVoice: 'coral', speechEnabled: !!speech, allowRemote: false };
}
const value = (input: unknown, max: number): string => {
  if (typeof input !== 'string' || input.length > max || /[\x00-\x1f\x7f]/.test(input)) throw new Error('Invalid voice configuration.');
  return input.trim();
};
export function validateVoiceSettings(input: unknown): VoiceSettings {
  if (!input || typeof input !== 'object') throw new Error('Invalid voice configuration.');
  const raw = input as Record<string, unknown>;
  if (!['chat-audio', 'transcriptions', 'realtime'].includes(String(raw.inputMode)) || typeof raw.speechEnabled !== 'boolean') throw new Error('Invalid voice configuration.');
  return { inputSourceId: value(raw.inputSourceId, 200), inputModel: value(raw.inputModel, 300), inputMode: raw.inputMode as VoiceSettings['inputMode'],
    speechSourceId: value(raw.speechSourceId, 200), speechModel: value(raw.speechModel, 300), speechVoice: value(raw.speechVoice, 100), speechEnabled: raw.speechEnabled, allowRemote: raw.allowRemote === true };
}
export class VoiceSettingsStore {
  constructor(private readonly path: string, private readonly sources: () => ProviderConfig[]) {}
  read(): VoiceSettings {
    if (!existsSync(this.path)) return defaultVoiceSettings(this.sources());
    try { return validateVoiceSettings(JSON.parse(readFileSync(this.path, 'utf8'))); }
    catch { throw new Error('Voice settings could not be read. Save a new configuration to repair them.'); }
  }
  save(input: unknown): VoiceSettings {
    const next = validateVoiceSettings(input);
    const available = voiceSources(this.sources());
    if (!available.some((source) => source.id === next.inputSourceId) || !next.inputModel) throw new Error('Choose an existing compatible input source and audio model.');
    if (next.speechEnabled && (!available.some((source) => source.id === next.speechSourceId) || !next.speechModel || !next.speechVoice)) throw new Error('Choose an existing speech source, speech model, and voice.');
    writePrivateFileAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
