import { useEffect, useRef, useState } from 'react';
import type { ConnectionsAPI, ConnectionPlugin, ConnectionProvider, ConnectionState } from '../../../../src/api/connections';
import { connectionPlugin, CONNECTION_PROVIDERS } from '../../../../src/api/connections';

export const connectionLabels: Record<ConnectionProvider, string> = { discord: 'Discord', slack: 'Slack', teams: 'Teams', outlook: 'Outlook', gmail: 'Google Mail', yahoo: 'Yahoo Mail' };
export const connectionButton = 'rounded border border-line px-3 py-1.5 text-xs text-ink hover:bg-surface-3 disabled:opacity-40';
export const connectionInput = 'min-w-0 rounded border border-line bg-surface px-2 py-1.5 text-xs text-ink';
const reasons = (error: unknown): string => (error instanceof Error ? error.message : 'Connection failed.').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

export function ConnectionSettings({ api, plugin, state, onChange }: { api: ConnectionsAPI; plugin: ConnectionPlugin; state: ConnectionState; onChange(state: ConnectionState): void }) {
  const initialProvider = plugin === 'comms' ? 'slack' : 'outlook';
  const initialRegistration = state.registrations.find((entry) => entry.provider === initialProvider);
  const [provider, setProvider] = useState<ConnectionProvider>(initialProvider);
  const [label, setLabel] = useState(''); const [address, setAddress] = useState(''); const [guild, setGuild] = useState('');
  const [credential, setCredential] = useState(''); const [clientId, setClientId] = useState(initialRegistration?.clientId ?? ''); const [redirect, setRedirect] = useState(initialRegistration?.redirectUri ?? (plugin === 'email' ? 'http://127.0.0.1:47831/callback' : ''));
  const [clientSecret, setClientSecret] = useState(''); const [tenant, setTenant] = useState(initialRegistration?.tenant ?? 'common'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{ id: string; manual: boolean } | null>(null); const [callback, setCallback] = useState('');
  const busyRef = useRef(false); const active = useRef(true); const attemptRef = useRef(attempt); attemptRef.current = attempt;
  useEffect(() => { active.current = true; return () => { active.current = false; if (attemptRef.current) { void api.cancelAuthorization(attemptRef.current.id).catch(() => {}); } }; }, [api]);
  const registration = state.registrations.find((entry) => entry.provider === provider);
  const run = async (work: () => Promise<void>) => { if (busyRef.current) { return; } busyRef.current = true; setError(''); setBusy(true); try { await work(); } catch (cause) { if (active.current) { setError(reasons(cause)); } } finally { busyRef.current = false; if (active.current) { setBusy(false); } } };
  const changed = (next: ConnectionState) => { if (active.current) { onChange(next); } };
  const changeProvider = (next: ConnectionProvider) => {
    setProvider(next); setCredential(''); setClientSecret(''); setError(''); setCallback('');
    const saved = state.registrations.find((entry) => entry.provider === next);
    setClientId(saved?.clientId ?? ''); setTenant(saved?.tenant ?? 'common');
    setRedirect(saved?.redirectUri ?? (['slack', 'yahoo'].includes(next) ? '' : 'http://127.0.0.1:47831/callback'));
  };
  return <section aria-label="Connection settings" className="space-y-4 rounded border border-line bg-surface-2 p-4">
    <h2 className="text-sm font-semibold">Add account</h2>
    {!state.secureStorage && <p role="alert" className="text-xs text-warning">Unlock your system keyring to connect an account. On Linux, use Secret Service or KWallet.</p>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <fieldset disabled={busy || !!attempt} className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-xs">Provider<select className={connectionInput} aria-label="Connection provider" value={provider} disabled={busy || !!attempt} onChange={(event) => changeProvider(event.target.value as ConnectionProvider)}>{CONNECTION_PROVIDERS.filter((entry) => connectionPlugin(entry) === plugin).map((entry) => <option key={entry} value={entry}>{connectionLabels[entry]}</option>)}</select></label>
      <label className="grid gap-1 text-xs">Account name<input className={connectionInput} value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder="Work" /></label>
      {plugin === 'email' && <label className="grid gap-1 text-xs">Email address<input className={connectionInput} type="email" value={address} onChange={(event) => setAddress(event.target.value)} autoComplete="email" /></label>}
      {provider === 'discord' && <label className="grid gap-1 text-xs">Discord server ID<input className={connectionInput} value={guild} onChange={(event) => setGuild(event.target.value)} /></label>}
    </fieldset>
    {provider !== 'discord' && <details key={provider}><summary className="cursor-pointer text-xs">App registration {registration ? '· configured' : '· required for browser sign-in'}</summary>
      <fieldset disabled={busy || !!attempt} className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs">Client ID<input className={connectionInput} value={clientId} onChange={(event) => setClientId(event.target.value)} /></label>
        <label className="grid gap-1 text-xs">Redirect URL<input className={connectionInput} value={redirect} onChange={(event) => setRedirect(event.target.value)} placeholder="Your registered HTTPS callback" /></label>
        {['outlook', 'teams'].includes(provider) && <label className="grid gap-1 text-xs">Microsoft tenant<input className={connectionInput} value={tenant} onChange={(event) => setTenant(event.target.value)} /></label>}
        {['slack', 'yahoo', 'gmail'].includes(provider) && <label className="grid gap-1 text-xs">Client secret {provider === 'gmail' ? '(if issued)' : ''}<input className={connectionInput} type="password" autoComplete="new-password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder={registration?.hasSecret ? 'Stored · leave blank to keep' : 'Stored in system keyring'} /></label>}
      </fieldset>
      <p className="mt-2 text-xs text-ink-3">Use your own app registration. Microsoft and Google use desktop loopback sign-in. Slack and Yahoo use your HTTPS callback; paste its completed URL below. Shared app secrets should be managed by your organization’s sign-in service.</p>
      <button type="button" disabled={busy || !!attempt} className={`${connectionButton} mt-3`} onClick={() => void run(async () => {
        changed(await api.registration({ provider, clientId, redirectUri: redirect, tenant, ...(clientSecret ? { clientSecret } : {}) })); setClientSecret('');
      })}>Save registration</button>
    </details>}
    {provider !== 'discord' && <button type="button" className={connectionButton} disabled={busy || !!attempt || !registration || !state.secureStorage || !label.trim() || !state.plugins[plugin]} onClick={() => void run(async () => { const next = await api.authorize({ provider, label, address }); if (active.current) { attemptRef.current = next; setAttempt(next); } else { await api.cancelAuthorization(next.id); } })}>Sign in with {connectionLabels[provider]}</button>}
    {attempt && <div className="space-y-2 rounded border border-line p-3">
      <p className="text-xs">Complete sign-in in your browser, then refresh your accounts. The request expires after five minutes.</p>
      {attempt.manual && <><label className="grid gap-1 text-xs">Completed callback URL<input className={`${connectionInput} w-full`} type="password" value={callback} disabled={busy} autoComplete="off" onChange={(event) => setCallback(event.target.value)} /></label><button type="button" className={connectionButton} disabled={busy || !callback} onClick={() => void run(async () => { changed(await api.complete(attempt.id, callback)); setCallback(''); setAttempt(null); })}>Finish sign-in</button></>}
      <button type="button" className={`${connectionButton} ml-2`} disabled={busy} onClick={() => void run(async () => { await api.cancelAuthorization(attempt.id); setAttempt(null); setCallback(''); changed(await api.get()); })}>Close sign-in</button>
    </div>}
    {['discord', 'slack', 'yahoo'].includes(provider) && <details open={provider === 'discord'}><summary className="cursor-pointer text-xs">{provider === 'discord' ? 'Bot token' : provider === 'yahoo' ? 'Use an app password' : 'Use an existing bot token'}</summary>
      <p className="my-2 text-xs text-ink-3">{provider === 'discord' ? 'Use a Discord bot installed in your server with message access. Personal account tokens are not supported.' : provider === 'yahoo' ? 'Generate an app password in Yahoo Account Security. Your normal account password is not used.' : 'Use a Slack app bot token with channel history and chat:write permissions. Invite the bot to the channels you want to use.'}</p>
      <label className="grid gap-1 text-xs">{provider === 'yahoo' ? 'App password' : 'Bot token'}<input className={connectionInput} type="password" value={credential} disabled={busy || !!attempt} autoComplete="new-password" onChange={(event) => setCredential(event.target.value)} /></label>
      <button type="button" className={`${connectionButton} mt-2`} disabled={busy || !!attempt || !state.secureStorage || !state.plugins[plugin] || !credential || !label.trim()} onClick={() => void run(async () => { changed(await api.connect({ provider, label, address, guild, credential })); setCredential(''); })}>{busy ? 'Connecting…' : 'Connect account'}</button>
    </details>}
  </section>;
}
