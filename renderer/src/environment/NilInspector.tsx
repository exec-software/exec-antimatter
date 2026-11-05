import { useEffect, useMemo, useState } from 'react';
import { Binary, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Search } from 'lucide-react';
import type { NyInspectedFunction, NyInspectedInstruction, NyModuleInspection } from '../../../src/api/nyInspector';
import { NIL_PAGE_SIZE, nilByteSize, nilMatchingFunctions, nilMatchingInstructions, nilSourceFiles, nilValuePreview } from './nilInspectionView';

interface Props {
  path: string;
  /** A new build of the same file must reload its decoded contents. */
  refreshKey?: string | number;
  onReveal(path: string, line: number): void;
}
type Section = 'instructions' | 'constants' | 'types' | 'sources';
const button = 'inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-[11px] text-ink-2 hover:border-primary hover:text-ink disabled:opacity-40';
const readable = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
const matches = (value: string, query: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

function PageControls({ count, page, onChange }: { count: number; page: number; onChange(page: number): void }) {
  const pages = Math.max(1, Math.ceil(count / NIL_PAGE_SIZE));
  return <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-[10px] text-ink-3">
    <span>{count ? `${page * NIL_PAGE_SIZE + 1}–${Math.min(count, (page + 1) * NIL_PAGE_SIZE)} of ${count.toLocaleString()}` : 'No matches'}</span>
    {pages > 1 && <div className="flex items-center gap-2">
      <button type="button" className={button} aria-label="Previous NIL page" disabled={page === 0} onClick={() => onChange(page - 1)}><ChevronLeft size={12} /></button>
      <span>Page {page + 1} of {pages}</span>
      <button type="button" className={button} aria-label="Next NIL page" disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}><ChevronRight size={12} /></button>
    </div>}
  </div>;
}

function SourceLink({ instruction, onReveal }: { instruction: NyInspectedInstruction; onReveal: Props['onReveal'] }) {
  const source = instruction.source;
  if (source?.workspacePath) return <button type="button" className="inline-flex max-w-full items-center gap-1 text-primary hover:underline" title={`Open ${source.workspacePath}:${source.line}`} onClick={() => onReveal(source.workspacePath!, source.line)}>
    <ExternalLink size={10} className="shrink-0" /><span className="truncate">{nilValuePreview(source.workspacePath, '', 256)}:{source.line}</span>
  </button>;
  if (source) return <span className="text-ink-3" title="The mapped source is not available inside this workspace">{nilValuePreview(source.path, '', 256)}:{source.line}</span>;
  if (instruction.debugLine > 0) return <span className="text-ink-3" title="This NIL has a line number without a source file mapping">Line {instruction.debugLine}</span>;
  return <span className="text-ink-3">—</span>;
}

function InstructionRows({ fn, query, page, onReveal }: { fn: NyInspectedFunction; query: string; page: number; onReveal: Props['onReveal'] }) {
  const rows = nilMatchingInstructions(fn, query).slice(page * NIL_PAGE_SIZE, (page + 1) * NIL_PAGE_SIZE);
  if (!rows.length) return <p className="p-4 text-xs text-ink-3">This function has no matching instructions.</p>;
  return <table className="w-full min-w-[640px] table-fixed text-left font-mono text-[11px]">
    <thead className="sticky top-0 bg-surface-2 text-[10px] text-ink-3"><tr>
      <th scope="col" className="w-14 px-3 py-2 font-normal" title="Zero-based instruction index within this function">Index</th>
      <th scope="col" className="w-32 px-2 py-2 font-normal">Opcode</th>
      <th scope="col" className="px-2 py-2 font-normal" title="Long operands show a bounded preview; search brings matching text into view">Operands</th>
      <th scope="col" className="w-44 px-2 py-2 font-normal">Source</th>
    </tr></thead>
    <tbody>{rows.map((instruction) => <tr key={instruction.offset} className="border-t border-line-soft align-top hover:bg-surface-2/60" data-nil-instruction={instruction.offset}>
      <td className="px-3 py-2 text-ink-3">{instruction.offset}</td>
      <td className="break-words px-2 py-2 text-primary">{nilValuePreview(instruction.opcode, query, 80)}</td>
      <td className="break-words px-2 py-2 text-ink">
        <code className="whitespace-pre-wrap">{nilValuePreview(instruction.operands.join(' '), query, 2048) || '—'}</code>
        {!!instruction.locals?.length && <details className="mt-1 text-[10px] text-ink-3"><summary className="cursor-pointer hover:text-ink">{instruction.locals.length} visible {instruction.locals.length === 1 ? 'local' : 'locals'}</summary>
          <dl className="mt-1 space-y-1">{instruction.locals.slice(0, NIL_PAGE_SIZE).map((local, index) => <div key={`${local.storage}:${index}`}><dt className="inline text-ink-2">{nilValuePreview(`${local.name}: ${local.type}`, query, 256)}</dt><dd className="inline"> · {nilValuePreview(local.storage, query, 256)} · scope {local.depth}</dd></div>)}</dl>
          {instruction.locals.length > NIL_PAGE_SIZE && <p>Showing the first {NIL_PAGE_SIZE} locals.</p>}
        </details>}
      </td>
      <td className="break-words px-2 py-2"><SourceLink instruction={instruction} onReveal={onReveal} /></td>
    </tr>)}</tbody>
  </table>;
}

/** Read-only structured NIL view. Bytes and symbol metadata never become executable HTML. */
export function NilInspector({ path, refreshKey, onReveal }: Props) {
  const [inspection, setInspection] = useState<NyModuleInspection | null>(null);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0); const [section, setSection] = useState<Section>('instructions');
  const [query, setQuery] = useState(''); const [selected, setSelected] = useState(''); const [page, setPage] = useState(0);
  const [functionLimit, setFunctionLimit] = useState(NIL_PAGE_SIZE);
  useEffect(() => {
    let alive = true; setLoading(true); setError(''); setInspection(null); setPage(0);
    void window.electronAPI.ny.inspectNil(path).then((value) => { if (alive) setInspection(value); })
      .catch((reason) => { if (alive) setError(readable(reason)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, refreshKey, reload]);
  useEffect(() => { setQuery(''); setSelected(''); setSection('instructions'); setFunctionLimit(NIL_PAGE_SIZE); }, [path]);
  const functions = useMemo(() => inspection ? nilMatchingFunctions(inspection, query) : [], [inspection, query]);
  const current = functions.find((fn) => fn.name === selected) ?? functions.find((fn) => fn.name === 'main' || fn.name.endsWith('::main') || fn.name.endsWith('.main')) ?? functions[0];
  const constants = useMemo(() => inspection?.constants.filter((value) => matches(`${value.name}\n${value.value}`, query)) ?? [], [inspection, query]);
  const types = useMemo(() => inspection?.types.filter((value) => matches(JSON.stringify(value), query)) ?? [], [inspection, query]);
  const allSourceFiles = useMemo(() => inspection ? nilSourceFiles(inspection) : [], [inspection]);
  const sourceFiles = useMemo(() => allSourceFiles.filter((source) => matches(source.path, query) || matches(source.workspacePath ?? '', query)), [allSourceFiles, query]);
  const instructionCount = current ? nilMatchingInstructions(current, query).length : 0;
  const rowCount = section === 'instructions' ? instructionCount : section === 'constants' ? constants.length : types.length;
  const visiblePage = Math.min(page, Math.max(0, Math.ceil(rowCount / NIL_PAGE_SIZE) - 1));
  const tabs: { id: Section; label: string; count: number }[] = [
    { id: 'instructions', label: 'Instructions', count: inspection?.functions.reduce((total, fn) => total + fn.instructions.length, 0) ?? 0 },
    { id: 'constants', label: 'Constants', count: inspection?.constants.length ?? 0 },
    { id: 'types', label: 'Types', count: inspection?.types.length ?? 0 },
    { id: 'sources', label: 'Sources', count: allSourceFiles.length + (inspection?.embeddedSources.length ?? 0) },
  ];
  return <section aria-label="NIL inspector" className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface text-ink">
    <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
      <Binary size={15} className="shrink-0 text-primary" />
      <div className="min-w-0 flex-1"><h2 className="text-xs font-semibold">NIL inspector</h2><p className="truncate text-[10px] text-ink-3" title={path}>{path}</p></div>
      <span className="text-[10px] text-ink-3">Read only</span>
      <button type="button" className={button} aria-label="Reload NIL" disabled={loading} onClick={() => setReload((value) => value + 1)}><RefreshCw size={12} />Reload</button>
    </header>
    {loading && <p role="status" className="p-4 text-xs text-ink-3">Reading NIL module…</p>}
    {error && <div role="alert" className="p-4 text-xs"><p className="font-medium text-danger">Unable to inspect this NIL file.</p><p className="mt-1 whitespace-pre-wrap text-ink-2">{error}</p><button type="button" className={`${button} mt-3`} onClick={() => setReload((value) => value + 1)}>Try again</button></div>}
    {inspection && <>
      <dl className="flex shrink-0 flex-wrap gap-x-5 gap-y-1 border-b border-line px-3 py-2 text-[10px]">
        {[
          ['Module', nilValuePreview(inspection.moduleName, '', 256) || 'Unnamed module'],
          ['Format', `${inspection.format === 'binary' ? 'Binary' : 'Text'} NIL${inspection.version === null ? '' : ` v${inspection.version}`}`],
          ['Kind', inspection.library ? 'Library' : 'Executable'], ['Size', nilByteSize(inspection.byteLength)],
          ['Source map', inspection.debugInfo ? 'Available' : 'Not included'],
          ['Flags', `0x${inspection.flags.toString(16)}`], ['Tests', inspection.tests.length.toLocaleString()],
        ].map(([name, value]) => <div key={name}><dt className="inline text-ink-3">{name} </dt><dd className="inline break-all text-ink-2">{value}</dd></div>)}
      </dl>
      {!!inspection.warnings.length && <details className="shrink-0 border-b border-line bg-surface-2 px-3 py-1.5 text-[10px] text-ink-3"><summary className="cursor-pointer">Inspection notes ({inspection.warnings.length})</summary><ul className="mt-1 list-inside list-disc space-y-1">{inspection.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-2 py-1.5">
        <div role="tablist" aria-label="NIL sections" className="flex items-center gap-1">{tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={section === tab.id} className={`rounded px-2 py-1 text-[11px] ${section === tab.id ? 'bg-primary text-on-primary' : 'text-ink-3 hover:bg-surface-3 hover:text-ink'}`} onClick={() => { setSection(tab.id); setPage(0); }}>{tab.label} <span className="text-[9px]">{tab.count}</span></button>)}</div>
        <label className="ml-auto flex min-w-[150px] items-center gap-1 rounded border border-line bg-surface px-2 py-1 text-ink-3"><Search size={12} /><input aria-label="Search NIL" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); setFunctionLimit(NIL_PAGE_SIZE); }} placeholder={section === 'instructions' ? 'Functions, opcodes, operands…' : `Search ${section}…`} className="min-w-0 flex-1 bg-transparent text-[11px] text-ink placeholder:text-ink-3 focus:outline-none" /></label>
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 overflow-hidden">
        {section === 'instructions' && <>
          <nav aria-label="NIL functions" className="w-48 shrink-0 overflow-auto border-r border-line bg-surface-2 py-1">
            <p className="px-3 py-1 text-[10px] text-ink-3">{functions.length} {functions.length === 1 ? 'function' : 'functions'}</p>
            {functions.slice(0, functionLimit).map((fn, index) => <button type="button" key={`${fn.name}:${index}`} aria-current={current === fn ? 'true' : undefined} className={`block w-full border-l-2 px-3 py-2 text-left ${current === fn ? 'border-primary bg-primary/10 text-ink' : 'border-transparent text-ink-3 hover:bg-surface-3 hover:text-ink'}`} onClick={() => { setSelected(fn.name); setPage(0); }}>
              <span className="block truncate font-mono text-[11px]" title={nilValuePreview(fn.name, query, 512)}>{nilValuePreview(fn.name, query, 256)}</span><span className="text-[9px]">{fn.instructions.length.toLocaleString()} instructions{fn.test ? ' · test' : ''}{fn.inline ? ' · inline' : ''}</span>
            </button>)}
            {functions.length > functionLimit && <button type="button" className={`${button} m-2`} onClick={() => setFunctionLimit((value) => value + NIL_PAGE_SIZE)}>Show more functions</button>}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            {current ? <>
              <div className="shrink-0 border-b border-line px-3 py-2"><p className="break-words font-mono text-xs text-ink">{nilValuePreview(`${current.name}${current.generics.length ? `<${current.generics.join(', ')}>` : ''}(${current.parameters.join(', ')})${current.returnType ? ` → ${current.returnType}` : ''}`, query, 2048)}</p>
                {!!current.annotations.length && <p className="mt-1 whitespace-pre-wrap font-mono text-[10px] text-ink-3">{nilValuePreview(current.annotations.join(' '), query, 1024)}</p>}
              </div>
              <div className="min-h-0 flex-1 overflow-auto"><InstructionRows fn={current} query={query} page={visiblePage} onReveal={onReveal} /></div>
              <PageControls count={instructionCount} page={visiblePage} onChange={setPage} />
            </> : <p className="p-4 text-xs text-ink-3">{query ? 'No functions or instructions match your search.' : 'This module contains no executable functions.'}</p>}
          </div>
        </>}
        {section === 'constants' && <div className="flex min-w-0 flex-1 flex-col"><div className="min-h-0 flex-1 overflow-auto">
          {constants.length ? <table className="w-full table-fixed text-left text-[11px]"><thead className="sticky top-0 bg-surface-2 text-ink-3"><tr><th className="w-1/4 px-3 py-2 font-normal">Name</th><th className="w-24 px-3 py-2 font-normal">Storage</th><th className="px-3 py-2 font-normal">Value preview</th></tr></thead><tbody>
            {constants.slice(visiblePage * NIL_PAGE_SIZE, (visiblePage + 1) * NIL_PAGE_SIZE).map((constant, index) => <tr key={`${constant.name}:${index}`} className="border-t border-line-soft align-top"><td className="break-words px-3 py-2 font-mono text-primary">{nilValuePreview(constant.name, query, 256)}</td><td className="px-3 py-2 text-ink-3">{constant.encoding}<br />{nilByteSize(constant.byteLength)}</td><td className="break-words px-3 py-2"><code className="whitespace-pre-wrap">{nilValuePreview(constant.value, query)}</code></td></tr>)}
          </tbody></table> : <p className="p-4 text-xs text-ink-3">No constants match this view.</p>}
        </div><PageControls count={constants.length} page={visiblePage} onChange={setPage} /></div>}
        {section === 'types' && <div className="flex min-w-0 flex-1 flex-col"><div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
          {types.slice(visiblePage * NIL_PAGE_SIZE, (visiblePage + 1) * NIL_PAGE_SIZE).map((type, index) => {
            const wholeType = matches(`${type.kind} ${type.name}`, query);
            const members = type.members.filter((member) => wholeType || matches(`${member.name} ${member.type}`, query));
            const methods = (type.methods ?? []).filter((method) => wholeType || matches(JSON.stringify(method), query));
            return <article key={`${type.name}:${index}`} className="rounded border border-line bg-surface-2 p-3">
            <h3 className="break-words font-mono text-xs"><span className="text-primary">{type.kind}</span> {type.name}</h3>
            {!!type.bases?.length && <p className="mt-1 text-[10px] text-ink-3">Inherits {type.bases.join(', ')}</p>}
            {!!members.length && <dl className="mt-2 space-y-1 font-mono text-[11px]">{members.slice(0, NIL_PAGE_SIZE).map((member, index) => <div key={index}><dt className="inline text-ink-2">{member.name}</dt><dd className="inline text-ink-3">{member.type ? `: ${member.type}` : ''}</dd></div>)}</dl>}
            {members.length > NIL_PAGE_SIZE && <p className="mt-2 text-[10px] text-ink-3">Showing {NIL_PAGE_SIZE} of {members.length} members. Search for a member to narrow this view.</p>}
            {!!methods.length && <div className="mt-2 space-y-1 border-t border-line pt-2 font-mono text-[10px] text-ink-3">{methods.slice(0, NIL_PAGE_SIZE).map((method, index) => <p key={index} className="break-words">{method.abstract ? 'abstract ' : ''}{method.virtual ? 'virtual ' : ''}{method.name}({method.parameters.join(', ')}) → {method.returnType}{method.implementation ? ` · ${method.implementation}` : ''}</p>)}</div>}
            {methods.length > NIL_PAGE_SIZE && <p className="mt-2 text-[10px] text-ink-3">Showing {NIL_PAGE_SIZE} of {methods.length} methods. Search for a method to narrow this view.</p>}
          </article>; })}
          {!types.length && <p className="text-xs text-ink-3">No types match this view.</p>}
        </div><PageControls count={types.length} page={visiblePage} onChange={setPage} /></div>}
        {section === 'sources' && <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3 text-xs">
          <div><h3 className="mb-2 text-ink-2">Instruction source maps</h3>
            {!sourceFiles.length && <p className="text-[11px] text-ink-3">{query ? 'No mapped source files match this search.' : 'No source file mappings are included. A build with debug info can connect instructions to Ny or Matrix source.'}</p>}
            {sourceFiles.map((source) => <div key={source.workspacePath ?? source.path} className="mb-1 flex flex-wrap items-center gap-2">
              {source.workspacePath ? <button type="button" className="break-all font-mono text-[11px] text-primary hover:underline" onClick={() => onReveal(source.workspacePath!, source.line)}>{source.workspacePath}:{source.line}</button> : <span className="break-all font-mono text-[11px] text-ink-3" title="Source is not available inside this workspace">{source.path}</span>}
              <span className="text-[10px] text-ink-3">{source.instructionCount.toLocaleString()} mapped instructions{source.workspacePath ? '' : ' · source unavailable'}</span>
            </div>)}
          </div>
          {!!inspection.embeddedSources.length && <div><h3 className="mb-2 text-ink-2">Embedded source records</h3>{inspection.embeddedSources.filter((source) => matches(source.path, query)).map((source, index) => <p key={index} className="mb-1 break-all font-mono text-[11px] text-ink-3">{source.path} · {nilByteSize(source.byteLength)}</p>)}</div>}
          {!!inspection.dependencies.length && <div><h3 className="mb-2 text-ink-2">Dependencies</h3>{inspection.dependencies.filter((dependency) => matches(dependency, query)).map((dependency, index) => <p key={index} className="mb-1 break-all font-mono text-[11px] text-ink-3">{dependency}</p>)}</div>}
        </div>}
      </div>
    </>}
  </section>;
}
