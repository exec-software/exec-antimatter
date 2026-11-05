import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, AudioLines, Cpu, FlaskConical, Info, KeyRound, Plus, RefreshCw, Settings as SettingsIcon, Smartphone, Sparkles, UserRound, Vault, X } from 'lucide-react';
import type { ProviderConfig, SourceKind, SourceStoreInfo } from '../../types';
import type { VoiceConfiguration } from '../../../../src/api/voice';
import { AboutYouPanel } from './AboutYouPanel';
import { AssistantPanel } from './AssistantPanel';
import { AddSourceForm } from './AddSourceForm';
import { BeholddPanel } from './BeholddPanel';
import { InferenceServersPanel } from './InferenceServersPanel';
import { InferenceNodesPanel } from './InferenceNodesPanel';
import { HuggingFacePanel } from './HuggingFacePanel';
import { UpdatesPanel } from './UpdatesPanel';
import { WhatsNewPage } from '../whatsnew/WhatsNewPage';
import { SourceList } from './SourceList';
import { RemoteConnectionsPanel } from './RemoteConnectionsPanel';
import { AvatarPanel } from './AvatarPanel';
import { AppearancePanel } from './AppearancePanel';
import { NotificationsPanel } from './NotificationsPanel';
import { VoicePreferencesPanel } from './VoicePreferencesPanel';
import { MachineWideSection } from './MachineWideSection';
import { ScreenCaptureSection } from './ScreenCaptureSection';
import { SettingsDisclosure } from './SettingsDisclosure';
import { BotChatSettings } from './BotChatSettings';
import { HagExperimentalPanel } from './HagExperimentalPanel';
import { PensieveExperimental } from './PensieveExperimental';
import { VaultPanel } from './VaultPanel';
import { matchingSource, SETTINGS_SECTIONS, type SettingsSection, type SettingsTarget } from './navigation';

interface Props {
  sources: ProviderConfig[];
  target: SettingsTarget;
  onNavigate(target: SettingsTarget): void;
  onSourcesChanged(): void;
  onClose(): void;
  onOpenMemory(): void;
  onOpenModels(): void;
  onOpenSetup?(): void;
  onOpenBotChat?(): void;
  onVoiceConfigurationChanged(config: VoiceConfiguration): void;
}

const ICONS = { general: UserRound, models: Cpu, voice: AudioLines, devices: Smartphone, vault: Vault, application: RefreshCw, experimental: FlaskConical };
const link = 'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-ink-2 transition hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';

export function SettingsPage({ sources, target, onNavigate, onSourcesChanged, onClose, onOpenMemory, onOpenModels, onOpenSetup, onOpenBotChat, onVoiceConfigurationChanged }: Props) {
  const section = target.section;
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set([section]));
  const [store, setStore] = useState<SourceStoreInfo | null>(null);
  const [storeError, setStoreError] = useState('');
  const [aboutError, setAboutError] = useState('');
  const [prefill, setPrefill] = useState<{ kind: SourceKind; baseUrl: string } | null>(null);
  const [adding, setAdding] = useState(target.detail === 'add-source' || sources.length === 0);
  const [serversOpen, setServersOpen] = useState(target.detail === 'servers');
  const [engineOpen, setEngineOpen] = useState(target.detail === 'engine');
  const [downloadsOpen, setDownloadsOpen] = useState(target.detail === 'downloads');
  const [nodesOpen, setNodesOpen] = useState(target.detail === 'nodes');
  const [sourceNotice, setSourceNotice] = useState('');
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const info = SETTINGS_SECTIONS.find((entry) => entry.id === section)!;
  const shown = (id: SettingsSection) => section === id || visited.has(id);

  useEffect(() => {
    setVisited((current) => new Set([...current, section]));
    scroll.current?.scrollTo(0, 0);
    if (target.detail === 'servers') setServersOpen(true);
    if (target.detail === 'engine') setEngineOpen(true);
    if (target.detail === 'downloads') setDownloadsOpen(true);
    if (target.detail === 'add-source') setAdding(true);
    if (target.detail) {
      const frame = requestAnimationFrame(() => document.getElementById(`settings-detail-${target.detail}`)?.scrollIntoView({ block: 'nearest' }));
      return () => cancelAnimationFrame(frame);
    }
  }, [target, section]);
  useEffect(() => {
    if (section !== 'models') return;
    let alive = true;
    setStoreError('');
    void window.electronAPI.providers.storeInfo().then((value) => { if (alive) setStore(value); })
      .catch(() => { if (alive) setStoreError('Could not read credential-storage status.'); });
    return () => { alive = false; };
  }, [sources, section]);

  const useLocalSource = (next: { kind: SourceKind; baseUrl: string }) => {
    const existing = matchingSource(sources, next.baseUrl);
    if (existing) { setSourceNotice(`${existing.name} already uses this endpoint. Test or refresh it in Sources above.`); return; }
    setSourceNotice(''); setPrefill(next); setAdding(true);
    onNavigate({ section: 'models', detail: 'add-source' });
  };

  return <div className="absolute inset-0 bg-surface">
    <div hidden={showWhatsNew} className="h-full">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
          <SettingsIcon size={16} className="text-ink-3" /><h1 className="text-sm font-semibold text-ink">Settings</h1>
          <button type="button" onClick={onClose} className={`${link} ml-auto`}><X size={13} />Done</button>
        </header>
        <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col md:flex-row">
          <nav aria-label="Settings categories" className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-3 md:w-52 md:flex-col md:gap-1 md:border-b-0 md:border-r md:px-3 md:py-5">
            {SETTINGS_SECTIONS.map((entry) => {
              const Icon = ICONS[entry.id];
              return <button key={entry.id} type="button" aria-current={section === entry.id ? 'page' : undefined}
                onClick={() => onNavigate({ section: entry.id })}
                className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2.5 text-left text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${section === entry.id ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`}>
                <Icon size={15} className={section === entry.id ? 'text-ink' : 'text-ink-3'} />{entry.label}
              </button>;
            })}
          </nav>
          <div ref={scroll} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-6 md:px-8">
            <div className="mx-auto max-w-3xl">
              <header className="mb-7"><h2 className="text-lg font-semibold text-ink">{info.label}</h2><p className="mt-1 text-xs leading-5 text-ink-3">{info.description}</p></header>
              <div hidden={section !== 'general'}>{shown('general') && <>
                <AppearancePanel />
                <section className="mb-6"><h3 className="text-sm font-medium text-ink">About you</h3>
                  <p className="mb-3 mt-1 text-xs leading-5 text-ink-3">What every conversation should know. Your saved memories are managed separately.</p>
                  <AboutYouPanel onOpenMemory={onOpenMemory} />
                </section>
                <AvatarPanel active={section === 'general' && !showWhatsNew} />
                <section className="mb-6 border-t border-line pt-6">
                  <h3 className="mb-3 text-sm font-medium text-ink">Your assistant</h3>
                  <AssistantPanel onOpenSetup={onOpenSetup} />
                </section>
                <NotificationsPanel />
                <ScreenCaptureSection />
                <MachineWideSection />
              </>}</div>
              <div hidden={section !== 'models'}>{shown('models') && <>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <p className="min-w-48 flex-1 text-xs leading-5 text-ink-2">Choose models, prompts, and generation settings in the Model Library.</p>
                  <button type="button" onClick={onOpenModels} className={link}>Model Library<ArrowUpRight size={13} /></button>
                </div>
                <section aria-label="Inference sources" className="pb-6">
                  <div className="mb-2 flex items-center gap-2"><h3 className="flex-1 text-sm font-medium text-ink">Sources <span className="ml-1 text-xs font-normal text-ink-3">{sources.length}</span></h3>
                    <button type="button" aria-expanded={adding} aria-controls="settings-add-source" onClick={() => setAdding((open) => !open)} className={link}><Plus size={13} />{adding ? 'Close add source' : 'Add source'}</button>
                  </div>
                  <SourceList sources={sources} onChanged={onSourcesChanged} onManageEngine={() => onNavigate({ section: 'models', detail: 'engine' })} />
                  <div id="settings-detail-add-source"><div id="settings-add-source" hidden={!adding} className="mt-4">
                    <AddSourceForm key={prefill?.baseUrl ?? 'blank'} prefill={prefill} onAdded={() => { setPrefill(null); setAdding(false); onSourcesChanged(); }} />
                  </div></div>
                </section>
                <SettingsDisclosure id="servers" title="Inference servers" description="Stop or restart the local servers Antimatter starts, including the router that serves prepared workloads." open={serversOpen} onToggle={() => setServersOpen((open) => !open)}>
                  <InferenceServersPanel active={section === 'models' && serversOpen && !showWhatsNew} />
                </SettingsDisclosure>
                <SettingsDisclosure id="nodes" title="Inference nodes" description="Let other machines read this box's spare capacity, and pair the boxes this one can use." open={nodesOpen} onToggle={() => setNodesOpen((open) => !open)}>
                  {/* Unmounted when collapsed on purpose: a pairing code must not outlive the screen that showed it. */}
                  {nodesOpen && !showWhatsNew && <InferenceNodesPanel />}
                </SettingsDisclosure>
                <SettingsDisclosure id="downloads" title="Model downloads" description="Hugging Face account, access token, and download folder." open={downloadsOpen} onToggle={() => setDownloadsOpen((open) => !open)}><HuggingFacePanel /></SettingsDisclosure>
                <SettingsDisclosure id="engine" title="Local engine" description="Start, stop, or configure the bundled beholdd server. Inspect its logs here." open={engineOpen} onToggle={() => setEngineOpen((open) => !open)}>
                  <BeholddPanel active={section === 'models' && engineOpen && !showWhatsNew} onUseAsSource={useLocalSource} />
                  {sourceNotice && <p role="status" className="mt-3 text-xs text-ink-2">{sourceNotice}</p>}
                </SettingsDisclosure>
                <details className="border-t border-line py-4"><summary className="cursor-pointer text-xs text-ink-3">Credential storage{store && !store.encrypted && <span className="text-danger"> · API keys stored without encryption</span>}</summary>
                  <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-ink-3"><KeyRound size={14} className="mt-0.5 shrink-0" /><span>{storeError || (!store ? 'Reading credential-storage status…' : store.encrypted ? 'API keys are encrypted with the OS keyring.' : 'No OS keyring is available. API keys are stored in plain text.')}
                    {store && <code className="mt-1 block break-all text-[11px]">{store.path}</code>}</span></p>
                </details>
              </>}</div>
              <div hidden={section !== 'voice'}>{shown('voice') && <VoicePreferencesPanel active={section === 'voice' && !showWhatsNew} onSaved={onVoiceConfigurationChanged} />}</div>
              <div hidden={section !== 'experimental'}>{shown('experimental') && <div className="space-y-4">
                <PensieveExperimental active={section === 'experimental' && !showWhatsNew} />
                <HagExperimentalPanel active={section === 'experimental' && !showWhatsNew} onChanged={onSourcesChanged} />
                <BotChatSettings onOpen={onOpenBotChat} />
              </div>}</div>
              {/* A hidden QR must not remain a live pairing offer. This category intentionally unmounts. */}
              {section === 'devices' && !showWhatsNew && <><p className="mb-4 text-xs leading-5 text-ink-2">Chats and tools run on this computer. A pairing code closes when you leave this section.</p><RemoteConnectionsPanel /></>}
              {/*
                Also unmounted rather than hidden, for the same class of reason: the add form holds
                a secret the person is part way through typing, and a hidden form keeps it in the
                window's memory for the rest of the session. Leaving the section discards it.
              */}
              {section === 'vault' && !showWhatsNew && <VaultPanel />}
              <div hidden={section !== 'application'}>{shown('application') && <>
                <UpdatesPanel />
                <div className="mt-6 divide-y divide-line border-y border-line">
                  <button type="button" onClick={() => setShowWhatsNew(true)} className="flex w-full items-center gap-3 py-4 text-left text-sm text-ink-2 hover:text-ink"><Sparkles size={16} className="text-ink-3" /><span className="flex-1">What’s new</span><ArrowUpRight size={14} /></button>
                  <button type="button" onClick={() => { setAboutError(''); void window.electronAPI.about.open().catch(() => setAboutError('Could not open About Antimatter.')); }} className="flex w-full items-center gap-3 py-4 text-left text-sm text-ink-2 hover:text-ink"><Info size={16} className="text-ink-3" /><span className="flex-1">About Antimatter</span><ArrowUpRight size={14} /></button>
                </div>
                {aboutError && <p role="alert" className="mt-3 text-xs text-danger">{aboutError}</p>}
              </>}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    {showWhatsNew && <WhatsNewPage onClose={() => setShowWhatsNew(false)} />}
  </div>;
}
