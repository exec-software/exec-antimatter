import { useEffect, useState } from 'react';
import { Atom, Bot, Cat } from 'lucide-react';

type State = Awaited<ReturnType<Window['electronAPI']['avatar']['get']>>;
export function AvatarPanel({ active = true }: { active?: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const refresh = () => window.electronAPI.avatar.get().then((value) => { if (alive) setState(value); })
      .catch((reason) => { if (alive) setError(String(reason)); });
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [active]);
  const update = async (patch: Parameters<Window['electronAPI']['avatar']['update']>[0]) => {
    setBusy(true); setError('');
    try { setState(await window.electronAPI.avatar.update(patch)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Avatar settings could not be saved.'); }
    finally { setBusy(false); }
  };
  return <section className="border-t border-line pt-6">
    <h3 className="text-sm font-medium text-ink">Desktop avatar</h3>
    <p className="mt-2 text-xs text-ink-2">A movable companion stays on your desktop while Antimatter works. Drag the avatar, its name, or its status to move it. Use the window icon below it to return to the app.</p>
    <label className="my-3 flex items-center gap-2 text-xs text-ink">
      <input type="checkbox" checked={state?.enabled ?? false} disabled={!state || busy}
        onChange={(event) => void update({ enabled: event.target.checked })} /> Show desktop avatar
    </label>
    <div className="flex gap-2" role="group" aria-label="Choose desktop avatar">
      {([{ kind: 'atom', name: 'Atom', Icon: Atom }, { kind: 'robot', name: 'Robot', Icon: Bot }, { kind: 'cat', name: 'Cat', Icon: Cat }] as const).map(({ kind, name, Icon }) =>
        <button type="button" key={kind} disabled={!state || busy} aria-pressed={state?.kind === kind} onClick={() => void update({ kind })}
          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs disabled:opacity-40 ${state?.kind === kind ? 'border-primary text-primary' : 'border-line text-ink-2'}`}><Icon size={20} />{name}</button>)}
    </div>
    <p className="mt-3 text-[11px] text-ink-3">Shows active work and approval requests. Use its three-dot menu to change it or hide it. Its choice and position survive restarts.</p>
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </section>;
}
