import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BotChatPage, type PublicBotChatDraft } from '../../renderer/src/components/botChat/BotChatPage';
import { SettingsPage } from '../../renderer/src/components/settings/SettingsPage';
import { LeftRail } from '../../renderer/src/components/layout/LeftRail';
import { useBotChatState } from '../../renderer/src/lib/useBotChat';
import { getAppearance, initializeAppearance, saveAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import type { BotChatAPI, BotChatChannel, BotChatMessage, BotChatPage as Page, BotChatState, BotChatChange } from '../../src/api/botChat';
import type { AppPage } from '../../renderer/src/types';
import type { SettingsTarget } from '../../renderer/src/components/settings/navigation';

initializeAppearance({ initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, update: async (patch) => ({ ...DEFAULT_APPEARANCE, ...patch }), onChanged: () => () => {} });
const copy = <T,>(value: T): T => structuredClone(value);
const calls: Array<{ action: string; args: unknown[] }> = []; const opened: string[] = [];
const listeners = new Set<(event: BotChatChange) => void>();
const baseChannel = (id: string, name = id): BotChatChannel => ({ id, name, description: `${name} public discussion`, archived: false, postingPaused: false, createdAt: 1700000000000, revision: 1 });
let state: BotChatState = { enabled: false, generation: 1, channels: [baseChannel('general'), baseChannel('slow')], targets: [
  { id: 'ny', title: 'Ny compiler', workspace: 'exec-lang-ny', running: true }, { id: 'ui', title: 'Antimatter UI', workspace: 'exec-antimatter', running: false },
] };
const messages: BotChatMessage[] = Array.from({ length: 45 }, (_, index) => ({ id: `public-${index + 1}`, channelId: 'general', sequence: index + 1, createdAt: 1700000000000 + index * 60000,
  sender: index === 40 ? { kind: 'human', name: 'You' } : { kind: 'agent', threadId: 'ny', title: 'Ny compiler', workspace: 'exec-lang-ny', runId: 'run-ny' },
  body: index === 44 ? 'Public result: <img src=x onerror="window.injected=true">. Agent output remains plain text.' : `Engineering update ${index + 1}: the public channel contains this published summary only.`, mentionThreadIds: [], ...(index === 43 ? { replyTo: 'public-43' } : {}),
}));
let sequence = 45; let failPost = false; let failConfigure = false; let deferSlow = true;
let pendingRead: ((page: Page) => void) | null = null;
const emit = (channelIds: string[] = [], settingsChanged = false) => { for (const listener of listeners) listener({ channelIds, settingsChanged, threadIds: [] }); };
const page = (channelId: string, before?: number, limit = 40): Page => {
  const all = messages.filter((message) => message.channelId === channelId && (before === undefined || message.sequence < before));
  const selected = all.slice(-limit); return copy({ channel: state.channels.find((channel) => channel.id === channelId)!, messages: selected, nextBefore: all.length > selected.length ? selected[0].sequence : null, truncated: false });
};
const api: BotChatAPI = {
  state: async () => copy(state),
  configure: async (patch) => { calls.push({ action: 'configure', args: [patch] }); if (failConfigure) throw new Error('Could not save the opt-in setting.'); state = { ...state, ...patch, generation: state.generation + 1 }; emit([], true); return copy(state); },
  createChannel: async (input) => { calls.push({ action: 'create', args: [input] }); const channel = { ...baseChannel(`channel-${state.channels.length}`, input.name), description: input.description ?? '' }; state = { ...state, channels: [...state.channels, channel] }; emit([channel.id]); return copy(state); },
  updateChannel: async (id, patch) => { calls.push({ action: 'update', args: [id, patch] }); state = { ...state, channels: state.channels.map((channel) => channel.id === id ? { ...channel, ...patch, revision: channel.revision + 1 } : channel) }; emit([id]); return copy(state); },
  read: async (id, options) => { calls.push({ action: 'read', args: [id, options] }); if (id === 'slow' && deferSlow) return new Promise((resolve) => { pendingRead = resolve; }); return page(id, options?.before, options?.limit); },
  post: async (id, input) => { calls.push({ action: 'post', args: [id, copy(input)] }); if (failPost) throw new Error('Public post could not be saved.');
    messages.push({ id: `human-${++sequence}`, channelId: id, sequence, createdAt: Date.now(), sender: { kind: 'human', name: 'You' }, body: input.body, replyTo: input.replyTo, mentionThreadIds: input.mentionThreadIds ?? [] }); emit([id]); return page(id); },
  moderate: async (id, messageId, reason) => { calls.push({ action: 'moderate', args: [id, messageId, reason] }); const message = messages.find((message) => message.id === messageId)!; message.body = ''; message.redactedAt = Date.now(); message.moderationReason = reason; emit([id]); return page(id); },
  onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
const subscribe = () => () => {};
window.electronAPI = { botChat: api, onHubDownloads: subscribe, hub: { downloads: async () => [] }, onUpdateState: subscribe, updates: { state: async () => ({ install: { kind: 'development' } }) } } as unknown as typeof window.electronAPI;
let navigate: (page: AppPage) => void;
function Fixture() {
  const [view, setView] = useState<AppPage>('settings'); const [target, setTarget] = useState<SettingsTarget>({ section: 'experimental' });
  const draftState = useState<Record<string, PublicBotChatDraft>>({});
  const { state: publicState } = useBotChatState(api, true); navigate = setView;
  const settings = () => { setTarget({ section: 'experimental' }); setView('settings'); };
  return <div className="flex h-screen bg-surface text-ink">
    <LeftRail page={view} botChatEnabled={!!publicState?.enabled} threads={[]} projects={[]} pinned={[]} activeProjectId="" activeThreadId={null} search="" onSearchChange={() => {}} onSelectThread={() => {}} onSelectProject={() => {}} onOpenPinned={() => {}} onUnpin={() => {}} onDeleteThread={() => {}} onRenameThread={() => {}} onPinThread={() => {}} onNewThread={() => {}} onChangePage={(page) => page === 'settings' ? settings() : setView(page)} onOpenToolWindow={() => {}} isToolWindowOpen={() => false} drafts={{}} working={new Set()} />
    <div className="relative flex min-w-0 flex-1 flex-col">{view === 'settings' ? <SettingsPage sources={[]} target={target} onNavigate={setTarget} onSourcesChanged={() => {}} onClose={() => setView('bot-chat')} onOpenMemory={() => {}} onOpenModels={() => {}} onOpenBotChat={() => setView('bot-chat')} onVoiceConfigurationChanged={() => {}} /> : <BotChatPage draftState={draftState} api={api} onClose={settings} onOpenSettings={settings} onOpenThread={(id) => { opened.push(id); return id !== 'missing'; }} />}</div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
const button = (label: string) => [...document.querySelectorAll('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent?.trim() === label);
Object.assign(window, { botChatSmoke: {
  settings: () => navigate('settings'), history: () => navigate('bot-chat'), appearance: saveAppearance,
  failPost: (value: boolean) => { failPost = value; }, failConfigure: (value: boolean) => { failConfigure = value; },
  releaseRead: () => { deferSlow = false; pendingRead?.({ ...page('slow'), channel: { ...baseChannel('slow'), description: 'STALE CHANNEL DESCRIPTION' } }); pendingRead = null; },
  incoming: () => { messages.push({ id: `background-${++sequence}`, channelId: 'general', sequence, createdAt: Date.now(), sender: { kind: 'agent', threadId: 'ui', title: 'Antimatter UI', workspace: 'exec-antimatter', runId: 'run-ui' }, body: `Background public update ${sequence}`, mentionThreadIds: [] }); emit(['general']); },
  click: (label: string) => { const element = button(label); if (!element || element.disabled) throw new Error(`Button unavailable: ${label}`); element.click(); },
  toggle: (label: string) => { const element = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((element) => element.getAttribute('aria-label') === label || element.closest('label')?.textContent?.trim() === label); if (!element || element.disabled) throw new Error(`Checkbox unavailable: ${label}`); element.click(); },
  input: (label: string, value: string) => { const element = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement; if (!element || element.disabled) throw new Error(`Input unavailable: ${label}`); Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); },
  mention: (id: string) => { const element = document.querySelector<HTMLSelectElement>('[aria-label="Mention a public participant"]')!; element.value = id; element.dispatchEvent(new Event('change', { bubbles: true })); },
  postAction: (text: string, action: string) => { const article = [...document.querySelectorAll('article')].find((element) => element.textContent?.includes(text)); const element = [...(article?.querySelectorAll('button') ?? [])].find((element) => element.textContent?.trim() === action); if (!element || element.disabled) throw new Error(`Post action unavailable: ${action}`); element.click(); },
  scroll: (where: 'top' | 'bottom') => { const element = document.querySelector<HTMLDivElement>('[aria-label^="Public posts in "]')!; element.scrollTop = where === 'top' ? 0 : element.scrollHeight; element.dispatchEvent(new Event('scroll')); },
  snapshot: () => { const element = document.querySelector<HTMLDivElement>('[aria-label^="Public posts in "]'); return { text: document.body.textContent, calls: copy(calls), state: copy(state), opened, images: document.querySelectorAll('img').length, nav: !!document.querySelector('button[aria-label="Bot chat"]'),
    draft: (document.querySelector('[aria-label="Public Bot chat post"]') as HTMLTextAreaElement)?.value, postDisabled: button('Post publicly')?.disabled, alert: document.querySelector('[role="alert"]')?.textContent ?? null,
    requestedAccent: getAppearance().secondaryAccent, accent: getComputedStyle(document.documentElement).getPropertyValue('--ds-primary').trim(), focused: document.activeElement?.textContent, posts: [...document.querySelectorAll('article')].map((element) => element.textContent), mentionOptions: [...document.querySelectorAll('[aria-label="Mention a public participant"] option')].map((element) => element.textContent),
    feed: element ? { top: element.scrollTop, remaining: element.scrollHeight - element.scrollTop - element.clientHeight } : null }; },
} });
