import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Cable, Heart, KeyRound, Lock, PackageSearch, Search, Server, TriangleAlert, Wand2, X } from 'lucide-react';
import type {
  HubAccount,
  HubDownload,
  HubFormat,
  HubModelDetail,
  HubModelSummary,
  HubSort,
  HubState,
  HubVariant,
  ProviderConfig,
} from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import { AtomIndicator } from '../status/AtomIndicator';
import type { SettingsTarget } from '../settings/navigation';
import { DownloadCard } from './DownloadCard';
import { ModelDetailPanel } from './ModelDetailPanel';
import { ModelLibrary } from './ModelLibrary';
import { WorkloadCatalog } from '../setup/WorkloadCatalog';
import {
  BUNDLED_ARCHITECTURES,
  bytes,
  compact,
  contextLabel,
  errorText,
  isActive,
  parameters,
  relativeDate,
  useHubDownloads,
} from './presentation';

interface Props {
  embedded?: boolean;
  providers: ProviderConfig[];
  providerId: string;
  modelId: string;
  onClose(): void;
  onOpenSettings(target?: SettingsTarget): void;
  /**
   * Selects a model in the chat picker and goes back to the conversation. `workloadId` launches
   * one of that model's workloads; omitted uses its default.
   */
  onUseModel(providerId: string, modelId: string, workloadId?: string): void;
  /** Reopens the first-run wizard, which shares this catalog as its model step. */
  onOpenSetup(): void;
  selection?: {
    title: string;
    description?: string;
    actionLabel?: string;
    selectedLabel?: string;
  };
}

const SORTS: { value: HubSort; label: string }[] = [
  { value: 'downloads', label: 'Most downloaded' },
  { value: 'trending', label: 'Trending' },
  { value: 'likes', label: 'Most liked' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Newest' },
];

const TASKS: { value: string; label: string }[] = [
  { value: 'text-generation', label: 'Text generation' },
  { value: 'image-text-to-text', label: 'Vision chat' },
  { value: '', label: 'Any task' },
];

const control =
  'rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink focus:border-primary/60 focus:outline-none';
const button =
  'flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';

type Tab = 'library' | 'workloads' | 'browse' | 'downloads' | 'connections';
type Confirming = { kind: 'cancel' | 'remove'; record: HubDownload } | null;

function ResultRow({ model, selected, onSelect }: { model: HubModelSummary; selected: boolean; onSelect(): void }) {
  const [owner, name] = model.id.split('/');
  const architecture = model.gguf?.architecture ?? null;
  const facts = [parameters(model.gguf?.parameters), contextLabel(model.gguf?.contextLength), relativeDate(model.updatedAt)].filter(Boolean);

  return (
    <button
      type="button"
      onClick={onSelect}
      data-repo={model.id}
      className={`block w-full border-b border-line-soft px-3 py-2 text-left transition ${
        selected ? 'bg-surface-3' : 'hover:bg-surface-3/60'
      }`}
    >
      <span className="flex items-center gap-1.5 text-xs">
        {(model.gated || model.private) && <Lock size={11} className="shrink-0 text-primary" />}
        <span className="min-w-0 truncate text-ink">
          <span className="text-ink-3">{owner}/</span>
          {name}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10px] text-ink-3">
          <span className="flex items-center gap-0.5" title={`${model.downloads.toLocaleString()} downloads`}>
            <ArrowDownToLine size={10} />
            {compact(model.downloads)}
          </span>
          <span className="flex items-center gap-0.5" title={`${model.likes.toLocaleString()} likes`}>
            <Heart size={10} />
            {compact(model.likes)}
          </span>
        </span>
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-ink-3">
        {architecture && (
          <span className={BUNDLED_ARCHITECTURES.has(architecture) ? 'text-accent' : undefined}>{architecture}</span>
        )}
        {facts.map((fact) => (
          <span key={String(fact)}>{fact}</span>
        ))}
      </span>
    </button>
  );
}

export function HubPage({ providers, providerId, modelId, onClose, onOpenSettings, onUseModel, onOpenSetup, selection, embedded = false }: Props) {
  const downloads = useHubDownloads();
  const [tab, setTab] = useState<Tab>('library');
  const [state, setState] = useState<HubState | null>(null);
  const [account, setAccount] = useState<HubAccount | null>(null);
  const [accountError, setAccountError] = useState('');

  const [text, setText] = useState('');
  const [sort, setSort] = useState<HubSort>('downloads');
  const [format, setFormat] = useState<HubFormat>('gguf');
  const [task, setTask] = useState('text-generation');
  const [results, setResults] = useState<HubModelSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const searchSeq = useRef(0);

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<HubModelDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionError, setActionError] = useState('');
  const [confirming, setConfirming] = useState<Confirming>(null);

  const refreshState = useCallback(() => {
    window.electronAPI.hub
      .state()
      .then((next) => {
        setState(next);
        if (!next.token.configured) {
          setAccount(null);
          setAccountError('');
          return;
        }
        window.electronAPI.hub
          .whoami()
          .then((who) => {
            setAccount(who);
            setAccountError('');
          })
          .catch((error) => setAccountError(errorText(error)));
      })
      .catch(console.error);
  }, []);

  useEffect(refreshState, [refreshState]);

  // Free space changes as downloads land; re-read it whenever one finishes or is removed.
  const settledCount = downloads.filter((record) => record.state === 'ready').length;
  useEffect(() => {
    window.electronAPI.hub.state().then(setState).catch(console.error);
  }, [settledCount, downloads.length]);

  const runSearch = useCallback(
    async (from: string | null) => {
      const seq = ++searchSeq.current;
      setSearching(true);
      setSearchError('');
      try {
        const page = await window.electronAPI.hub.search({ text, sort, format, task: task || null, cursor: from, limit: 30 });
        if (seq !== searchSeq.current) return;
        setResults((prev) =>
          from ? [...prev, ...page.models.filter((model) => !prev.some((known) => known.id === model.id))] : page.models
        );
        setCursor(page.nextCursor);
      } catch (error) {
        if (seq === searchSeq.current) setSearchError(errorText(error));
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [text, sort, format, task]
  );

  // Typing waits for a pause; changing a filter searches at once. The Hub allows 500 requests
  // per five minutes, and a request per keystroke would spend that on half-typed words.
  useEffect(() => {
    const timer = window.setTimeout(() => void runSearch(null), text.trim() ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [runSearch]);

  // A slow reply for a model clicked a moment ago must not replace the one clicked since.
  const selectedRef = useRef<string | null>(null);
  const loadDetail = useCallback((repoId: string) => {
    selectedRef.current = repoId;
    setSelected(repoId);
    setDetail(null);
    setDetailError('');
    setActionError('');
    setLoadingDetail(true);
    window.electronAPI.hub
      .model(repoId)
      .then((next) => {
        if (selectedRef.current === repoId) setDetail(next);
      })
      .catch((error) => {
        if (selectedRef.current === repoId) setDetailError(errorText(error));
      })
      .finally(() => {
        if (selectedRef.current === repoId) setLoadingDetail(false);
      });
  }, []);

  const act = async (action: () => Promise<unknown>) => {
    setActionError('');
    try {
      await action();
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const download = (variant: HubVariant) => {
    if (!detail) return;
    void act(() =>
      window.electronAPI.hub.download({ repoId: detail.id, revision: detail.revision, variantKey: variant.key })
    );
  };

  const pause = (id: string) => void act(() => window.electronAPI.hub.pause(id));
  const resume = (id: string) => void act(() => window.electronAPI.hub.resume(id));
  const reregister = (id: string) => void act(() => window.electronAPI.hub.reregister(id));

  const inProgress = useMemo(() => downloads.filter(isActive), [downloads]);
  const finished = useMemo(() => downloads.filter((record) => !isActive(record)), [downloads]);
  const running = inProgress.find((record) => record.state === 'downloading');

  const cardHandlers = {
    providers,
    onPause: pause,
    onResume: resume,
    onReregister: reregister,
    onUse: onUseModel,
    onCancel: (record: HubDownload) => setConfirming({ kind: 'cancel', record }),
    onRemove: (record: HubDownload) => setConfirming({ kind: 'remove', record }),
  };

  return (
    <div className={embedded ? 'relative flex h-[65vh] min-h-[420px] flex-col overflow-hidden rounded-lg border border-line bg-surface' : 'absolute inset-0 flex flex-col bg-surface'}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
        <PackageSearch size={16} className="text-primary" />
        <h1 className="text-sm font-semibold text-ink">Models</h1>
        {tab === 'browse' && state && !state.token.configured ? (
          <button type="button" onClick={() => onOpenSettings({ section: 'models', detail: 'downloads' })} className="flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink">
            <KeyRound size={11} />
            No Hugging Face token — gated models need one
          </button>
        ) : tab === 'browse' && account ? (
          <span className="text-[11px] text-ink-3" title={account.tokenName ? `token "${account.tokenName}"` : undefined}>
            Hugging Face · {account.name}
            {account.tokenRole ? ` · ${account.tokenRole} token` : ''}
          </span>
        ) : tab === 'browse' && accountError ? (
          <button type="button" onClick={() => onOpenSettings({ section: 'models', detail: 'downloads' })} className="flex items-center gap-1 text-[11px] text-danger">
            <TriangleAlert size={11} />
            {accountError}
          </button>
        ) : null}

        <div className="ml-auto flex items-center gap-1 rounded-lg border border-line bg-surface-3 p-0.5 text-[11px]">
          {(['library', 'workloads', 'browse', 'downloads', 'connections'] as const).filter((value) => !embedded || value !== 'connections').map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              aria-pressed={tab === value}
              className={`rounded-md px-2.5 py-1 transition ${tab === value ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:text-ink'}`}
            >
              {value === 'library'
                ? 'Library'
                : value === 'workloads'
                  ? 'Workloads'
                  : value === 'browse'
                    ? 'Discover'
                    : value === 'connections'
                      ? 'Sources'
                      : `Downloads${inProgress.length ? ` · ${inProgress.length}` : downloads.length ? ` · ${downloads.length}` : ''}`}
            </button>
          ))}
        </div>
        {!embedded && <button type="button" onClick={onClose} className={button}>
          <X size={12} />
          Done
        </button>}
      </header>

      {tab === 'library' ? (
        <ModelLibrary
          providers={providers}
          providerId={providerId}
          modelId={modelId}
          onUseModel={onUseModel}
          onOpenSettings={() => onOpenSettings({ section: 'models', detail: 'sources' })}
          title={selection?.title}
          description={selection?.description}
          actionLabel={selection?.actionLabel}
          selectedLabel={selection?.selectedLabel}
        />
      ) : tab === 'workloads' ? (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-64 flex-1">
              <h2 className="text-sm font-medium text-ink">Prepared workloads</h2>
              <p className="mt-1 text-xs leading-5 text-ink-2">
                Verified local setups: one download, then one click to create the model card and
                its runtime preset. Each card names the hardware it was recorded on.
              </p>
            </div>
            <button type="button" onClick={onOpenSetup} className={button}>
              <Wand2 size={12} />
              Run setup wizard
            </button>
          </div>
          <WorkloadCatalog onOpenServers={() => onOpenSettings({ section: 'models', detail: 'servers' })} />
        </div>
      ) : tab === 'browse' ? (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
            <div className="relative min-w-[220px] flex-1">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
                type="search"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Search Hugging Face models"
                aria-label="Search Hugging Face models"
                className={`${control} w-full pl-8`}
              />
            </div>
            <select value={sort} onChange={(event) => setSort(event.target.value as HubSort)} aria-label="Sort" className={control}>
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select value={task} onChange={(event) => setTask(event.target.value)} aria-label="Task" className={control}>
              {TASKS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="flex items-center rounded-md border border-line bg-surface-3 p-0.5 text-[11px]" role="group" aria-label="Format">
              {(['gguf', 'any'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFormat(value)}
                  aria-pressed={format === value}
                  className={`rounded px-2 py-1 transition ${format === value ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:text-ink'}`}
                >
                  {value === 'gguf' ? 'GGUF' : 'All formats'}
                </button>
              ))}
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div className="flex min-h-0 flex-col border-r border-line">
              <div className="min-h-0 flex-1 overflow-y-auto">
                {searchError && (
                  <p className="flex items-start gap-1.5 px-3 py-2 text-[11px] text-danger">
                    <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                    {searchError}
                  </p>
                )}
                {!searching && !searchError && results.length === 0 && (
                  <p className="px-4 py-6 text-center text-xs text-ink-3">No models match.</p>
                )}
                {results.map((model) => (
                  <ResultRow key={model.id} model={model} selected={selected === model.id} onSelect={() => loadDetail(model.id)} />
                ))}
                {(searching || cursor) && (
                  <div className="flex justify-center py-3">
                    {searching ? (
                      <AtomIndicator phase="thinking" size={16} />
                    ) : (
                      <button type="button" onClick={() => void runSearch(cursor)} className={button}>
                        Load more
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto">
              {actionError && (
                <p className="flex items-start gap-1.5 border-b border-line px-4 py-2 text-[11px] text-danger">
                  <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                  {actionError}
                </p>
              )}
              <ModelDetailPanel
                repoId={selected}
                detail={detail}
                loading={loadingDetail}
                error={detailError}
                downloads={downloads}
                providers={providers}
                freeBytes={state?.root.freeBytes ?? null}
                tokenConfigured={!!state?.token.configured}
                onDownload={download}
                onPause={pause}
                onResume={resume}
                onUse={onUseModel}
                onOpenSettings={() => onOpenSettings({ section: 'models', detail: 'downloads' })}
              />
            </div>
          </div>

          {running && (
            <button
              type="button"
              onClick={() => setTab('downloads')}
              className="flex items-center gap-3 border-t border-line bg-surface-2 px-4 py-2 text-left text-[11px] text-ink-2 transition hover:bg-surface-3"
            >
              <AtomIndicator phase="streaming" size={13} />
              <span className="min-w-0 truncate">
                {running.repoId} · {running.label}
              </span>
              <span className="h-1 w-40 shrink-0 overflow-hidden rounded-full bg-surface-3">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${(running.bytesDone / Math.max(1, running.bytesTotal)) * 100}%` }}
                />
              </span>
              <span className="shrink-0 font-mono text-ink-3">
                {Math.floor((running.bytesDone / Math.max(1, running.bytesTotal)) * 100)}%
              </span>
              {inProgress.length > 1 && <span className="shrink-0 text-ink-3">+{inProgress.length - 1} more</span>}
            </button>
          )}
        </>
      ) : tab === 'connections' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-4 py-5">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-[240px] flex-1">
                <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
                  <Cable size={14} className="text-primary" /> Sources
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-ink-3">
                  Backends that contribute models to the library. Credentials stay in the main process and are encrypted when the operating-system keyring is available.
                </p>
              </div>
              <button type="button" onClick={() => onOpenSettings({ section: 'models' })} className={button}>
                Manage sources
              </button>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
              {providers.map((source) => (
                <article key={source.id} className="rounded-xl border border-line bg-surface-2 p-3.5">
                  <div className="flex items-start gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-ink-3">
                      <Server size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-ink">{source.name}</span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-3" title={source.baseUrl}>
                        {source.baseUrl}
                      </span>
                    </span>
                    <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-ink-3">
                      {source.kind ?? 'compatible'}
                    </span>
                  </div>
                  <p className="mt-3 text-[10px] text-ink-3">
                    {source.models.length} {source.models.length === 1 ? 'model' : 'models'} in the library
                    {` · ${source.protocol ?? 'openai-chat'}`}
                    {source.credentialConfigured ? ' · credential stored' : ''}
                  </p>
                </article>
              ))}
              {providers.length === 0 && (
                <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-xs text-ink-3 md:col-span-2">
                  No inference sources are configured.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-5">
            <p className="text-xs text-ink-2">
              Downloads resume where they stopped — after a pause, a dropped connection, or quitting Antimatter — and each file
              is checked against the SHA-256 Hugging Face published before it is used.
            </p>
            {state && (
              <p className="mt-1 text-[11px] text-ink-3">
                Saving to <code className="font-mono">{state.root.path}</code>
                {state.root.freeBytes !== null && ` · ${bytes(state.root.freeBytes)} free`} ·{' '}
                <button type="button" onClick={() => onOpenSettings({ section: 'models', detail: 'downloads' })} className="text-primary underline-offset-2 hover:underline">
                  change
                </button>
              </p>
            )}
            {actionError && <p className="mt-2 text-[11px] text-danger">{actionError}</p>}

            {downloads.length === 0 && (
              <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-ink-3">
                  Nothing downloaded yet. Find a model under Discover and pick a quantization.
              </p>
            )}

            {inProgress.length > 0 && (
              <section className="mt-4">
                <h2 className="text-xs font-medium uppercase tracking-wide text-ink-3">In progress</h2>
                <div className="mt-2 grid gap-2">
                  {inProgress.map((record) => (
                    <DownloadCard key={record.id} record={record} {...cardHandlers} />
                  ))}
                </div>
              </section>
            )}

            {finished.length > 0 && (
              <section className="mt-5">
                <h2 className="text-xs font-medium uppercase tracking-wide text-ink-3">Downloaded</h2>
                <div className="mt-2 grid gap-2">
                  {finished.map((record) => (
                    <DownloadCard key={record.id} record={record} {...cardHandlers} />
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={confirming.kind === 'cancel' ? 'Cancel this download?' : 'Remove this model?'}
          message={
            confirming.kind === 'cancel'
              ? `${confirming.record.repoId} ${confirming.record.label} stops, and the ${bytes(confirming.record.bytesDone)} downloaded so far is deleted.`
              : `${confirming.record.repoId} ${confirming.record.label} is taken out of every engine it was registered with, and its ${bytes(confirming.record.bytesTotal)} of files are deleted from ${confirming.record.root}.`
          }
          confirmLabel={confirming.kind === 'cancel' ? 'Cancel download' : 'Remove'}
          tone="danger"
          onConfirm={() => {
            const { kind, record } = confirming;
            setConfirming(null);
            void act(() =>
              kind === 'cancel' ? window.electronAPI.hub.cancel(record.id) : window.electronAPI.hub.remove(record.id, true)
            );
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
