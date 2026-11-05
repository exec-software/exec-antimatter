import { ArrowDownToLine, CircleCheck, ExternalLink, Lock, MessageSquare, Pause, Play, RotateCw, TriangleAlert } from 'lucide-react';
import type { HubDownload, HubModelDetail, HubVariant, ProviderConfig } from '../../types';
import { AtomIndicator } from '../status/AtomIndicator';
import {
  BUNDLED_ARCHITECTURES,
  bytes,
  contextLabel,
  externalBeholdds,
  parameters,
  relativeDate,
  usableTarget,
} from './presentation';

interface Props {
  repoId: string | null;
  detail: HubModelDetail | null;
  loading: boolean;
  error: string;
  downloads: HubDownload[];
  providers: ProviderConfig[];
  freeBytes: number | null;
  tokenConfigured: boolean;
  onDownload(variant: HubVariant): void;
  onPause(id: string): void;
  onResume(id: string): void;
  onUse(providerId: string, modelId: string): void;
  onOpenSettings(): void;
}

const button =
  'flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';
const primary =
  'flex items-center gap-1.5 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-on-primary transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-40';
const SPACE_MARGIN = 512 * 1024 * 1024;

function Engines({ architecture, providers }: { architecture: string | null; providers: ProviderConfig[] }) {
  const external = externalBeholdds(providers);
  const bundled = !!architecture && BUNDLED_ARCHITECTURES.has(architecture);

  return (
    <div className="mt-3 grid gap-1 text-[11px]">
      <p className={bundled ? 'text-accent' : 'text-ink-3'}>
        {bundled
          ? 'The bundled beholdd can run this architecture; it restarts to load a finished download.'
          : `The bundled beholdd runs ${[...BUNDLED_ARCHITECTURES].join(' and ')} only${architecture ? `, not ${architecture}` : ''}.`}
      </p>
      {external.map((source) => (
        <p key={source.id} className="text-accent">
          Registered on {source.name} by path as soon as it finishes, if that server loads models by path.
        </p>
      ))}
      {!bundled && external.length === 0 && (
        <p className="flex items-start gap-1.5 text-primary">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          No engine configured here can run it. It will download, but nothing will load it until a GPU beholdd is added
          in Settings.
        </p>
      )}
    </div>
  );
}

function VariantRow({
  variant,
  record,
  props,
}: {
  variant: HubVariant;
  record: HubDownload | undefined;
  props: Props;
}) {
  const needed = Math.max(0, variant.bytes - variant.localBytes);
  const noRoom = props.freeBytes !== null && !record && needed > 0 && needed + SPACE_MARGIN > props.freeBytes;
  const gatedWithoutToken = !!props.detail?.gated && !props.tokenConfigured;
  const onDisk = variant.localBytes >= variant.bytes && variant.bytes > 0;
  const partial = !onDisk && variant.localBytes > 0;
  const target = record?.state === 'ready' ? usableTarget(record, props.providers) : null;
  const fraction = record?.bytesTotal ? record.bytesDone / record.bytesTotal : 0;

  let note: string | null = null;
  if (!variant.complete) note = `missing shards (${variant.files.length} of ${variant.shards})`;
  else if (record?.state === 'ready') note = 'downloaded';
  else if (record?.state === 'downloading') note = `${Math.floor(fraction * 100)}% · downloading`;
  else if (record?.state === 'queued') note = 'queued';
  else if (record?.state === 'paused') note = `${Math.floor(fraction * 100)}% · paused`;
  else if (record?.state === 'failed') note = 'failed';
  else if (onDisk) note = 'already on disk';
  else if (partial) note = `${Math.floor((variant.localBytes / variant.bytes) * 100)}% on disk · resumes`;
  else if (noRoom) note = `needs ${bytes(needed)}, ${bytes(props.freeBytes ?? 0)} free`;

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3 py-2 first:border-t-0"
      data-variant={variant.key}
    >
      <span className="w-28 shrink-0 truncate font-mono text-xs text-ink" title={variant.key}>
        {variant.label}
      </span>
      <span className="w-20 shrink-0 font-mono text-[11px] text-ink-2">{bytes(variant.bytes)}</span>
      {variant.shards > 1 && <span className="text-[11px] text-ink-3">{variant.shards} files</span>}
      {note && (
        <span
          className={`text-[11px] ${
            record?.state === 'failed' || noRoom || !variant.complete
              ? 'text-danger'
              : record?.state === 'ready' || onDisk
                ? 'text-accent'
                : 'text-ink-3'
          }`}
        >
          {note}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        {record?.state === 'downloading' && <AtomIndicator phase="streaming" size={13} />}
        {target ? (
          <button type="button" onClick={() => props.onUse(target.providerId, target.modelId)} className={primary}>
            <MessageSquare size={12} />
            Use
          </button>
        ) : record?.state === 'ready' ? (
          <CircleCheck size={14} className="text-accent" />
        ) : record?.state === 'downloading' || record?.state === 'queued' ? (
          <button type="button" onClick={() => props.onPause(record.id)} className={button}>
            <Pause size={12} />
            Pause
          </button>
        ) : record?.state === 'paused' || record?.state === 'failed' ? (
          <button type="button" onClick={() => props.onResume(record.id)} className={button}>
            {record.state === 'paused' ? <Play size={12} /> : <RotateCw size={12} />}
            {record.state === 'paused' ? 'Resume' : 'Retry'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => props.onDownload(variant)}
            disabled={!variant.complete || noRoom || gatedWithoutToken}
            title={gatedWithoutToken ? 'This repository is gated: add a Hugging Face token in Settings first' : undefined}
            className={primary}
          >
            <ArrowDownToLine size={12} />
            {onDisk ? 'Add' : partial ? 'Resume' : 'Download'}
          </button>
        )}
      </div>
    </div>
  );
}

export function ModelDetailPanel(props: Props) {
  const { repoId, detail, loading, error } = props;

  if (!repoId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-ink-3">
        Pick a model to see its files. Quantized GGUF files are what the local engines load; smaller quants trade
        accuracy for memory.
      </div>
    );
  }

  if (loading || (!detail && !error)) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-ink-3">
        <AtomIndicator phase="thinking" size={16} />
        Reading {repoId}…
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="p-4">
        <p className="flex items-start gap-1.5 text-xs text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          {error}
        </p>
      </div>
    );
  }

  const [owner, name] = detail.id.split('/');
  const models = detail.variants.filter((variant) => variant.role === 'model');
  const projectors = detail.variants.filter((variant) => variant.role === 'projector');
  const recordFor = (variant: HubVariant) =>
    props.downloads.find(
      (record) => record.repoId === detail.id && record.revision === detail.revision && record.variantKey === variant.key
    );
  const facts = [
    detail.gguf?.architecture,
    parameters(detail.gguf?.parameters) && `${parameters(detail.gguf?.parameters)} params`,
    contextLabel(detail.gguf?.contextLength),
    detail.license && `license ${detail.license}`,
    relativeDate(detail.updatedAt) && `updated ${relativeDate(detail.updatedAt)}`,
  ].filter(Boolean);

  return (
    <div className="p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm text-ink">
            <span className="text-ink-3">{owner}/</span>
            <span className="font-semibold">{name}</span>
          </h2>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-ink-3">
            {facts.map((fact) => (
              <span key={String(fact)}>{fact}</span>
            ))}
            <span className="font-mono" title={detail.revision}>
              @{detail.revision.slice(0, 7)}
            </span>
          </p>
        </div>
        <a
          href={`https://huggingface.co/${detail.id}`}
          target="_blank"
          rel="noreferrer"
          className={`${button} ml-auto shrink-0`}
        >
          <ExternalLink size={12} />
          Model card
        </a>
      </div>

      {detail.gated && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-2 text-[11px] text-ink-2">
          <Lock size={12} className="mt-0.5 shrink-0 text-primary" />
          <span>
            Gated: accept its terms on the model card with your Hugging Face account
            {props.tokenConfigured ? ', then download with the token in Settings.' : ', and add a token in '}
            {!props.tokenConfigured && (
              <button type="button" onClick={props.onOpenSettings} className="text-primary underline-offset-2 hover:underline">
                Settings
              </button>
            )}
            {!props.tokenConfigured && '.'}
          </span>
        </p>
      )}

      <Engines architecture={detail.gguf?.architecture ?? null} providers={props.providers} />

      {models.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-ink-3">
          No GGUF files in this repository{detail.otherFiles ? ` — its ${detail.otherFiles} files are in formats the local engines do not load` : ''}.
        </p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface-2">
          {models.map((variant) => (
            <VariantRow key={variant.key} variant={variant} record={recordFor(variant)} props={props} />
          ))}
        </div>
      )}

      {projectors.length > 0 && (
        <>
          <h3 className="mt-4 text-[11px] font-medium uppercase tracking-wide text-ink-3">Vision projectors</h3>
          <p className="mt-1 text-[11px] text-ink-3">Needed beside the model for image input; they are not models on their own.</p>
          <div className="mt-2 overflow-hidden rounded-xl border border-line bg-surface-2">
            {projectors.map((variant) => (
              <VariantRow key={variant.key} variant={variant} record={recordFor(variant)} props={props} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
