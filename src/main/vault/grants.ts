import * as store from './store';

/**
 * Armed grants: the only path a Vault secret takes out of the store, and it does not pass through
 * the model.
 *
 * `vault_use` arms a grant after the user approves that exact call. Arming unseals the secret and
 * holds it here, in this process, keyed by the run that asked for it. The next command that run
 * executes is spawned by src/main/terminal.ts with the secret as an environment variable, so the
 * shell can use it while the model only ever knows the variable's *name*.
 *
 * Why an environment variable and not a tool argument:
 *
 *  - A tool argument is recorded. Arguments are what the transcript shows, what the approval
 *    prompt quotes, and what is replayed to the provider on every later round of the turn — so a
 *    secret placed there is written to disk and sent to the model for the rest of the
 *    conversation. That is the exact failure this feature exists to prevent.
 *  - A command line is public. On Linux `/proc/<pid>/cmdline` is world readable, so a password
 *    interpolated into the command itself is visible to every process on the box for as long as
 *    it runs. `/proc/<pid>/environ` is readable only by the owner.
 *
 * The remaining hole is that a shell can print a variable it can read, and the model reads command
 * output. `redact` closes the accidental case — `env`, a script that echoes its configuration, a
 * log line — by masking the secret out of every tool result before the model or the transcript
 * sees it. It does not close the deliberate case: a model that wants to exfiltrate a secret it was
 * granted can encode it first. Nothing short of not granting it prevents that, which is why
 * `vault_use` always asks a person first and names what the secret is wanted for.
 */

/** How long an approved grant stays usable. Long enough for a build, short enough to be a grant. */
const GRANT_TTL_MS = 5 * 60_000;

/**
 * How many commands one approval covers.
 *
 * Not one: a privileged step is routinely two or three commands — update the index, install, then
 * verify — and re-approving each turns a considered decision into a reflex. Not unbounded: an
 * approval is for a piece of work, not for the rest of the turn.
 */
const GRANT_MAX_USES = 10;

interface Grant {
  runId: string;
  tag: string;
  label: string;
  envName: string;
  secret: string;
  purpose: string;
  armedAt: number;
  expiresAt: number;
  uses: number;
}

/** Keyed by `${runId}\u0000${tag}`, so one run may hold grants for two different credentials. */
const grants = new Map<string, Grant>();

const key = (runId: string, tag: string): string => `${runId}\u0000${tag}`;

const sweep = (now = Date.now()): void => {
  for (const [id, grant] of grants) {
    if (grant.expiresAt <= now || grant.uses >= GRANT_MAX_USES) {
      // Overwrite before dropping the reference. It does not erase every copy V8 may have made,
      // but it does stop this one outliving the grant in a heap snapshot or a core dump.
      grant.secret = '';
      grants.delete(id);
    }
  }
};

export interface ArmedGrant {
  tag: string;
  label: string;
  envName: string;
  expiresAt: number;
  maxUses: number;
}

/**
 * Unseals a credential and arms it for one run. The caller must already have the user's approval
 * for this exact call: nothing here asks.
 */
export function arm(runId: string, tag: string, purpose: string): ArmedGrant {
  sweep();
  if (!store.enabled()) throw new Error('The Vault is off. Turn it on in Settings to let a credential be used.');
  const entry = store.find(tag);
  if (!entry) throw new Error(`No credential in the Vault is tagged "${store.normalizeTag(tag)}".`);

  const secret = store.unseal(entry.tag);
  const now = Date.now();
  const grant: Grant = {
    runId,
    tag: entry.tag,
    label: entry.label,
    envName: entry.envName,
    secret,
    purpose,
    armedAt: now,
    expiresAt: now + GRANT_TTL_MS,
    uses: 0,
  };
  grants.set(key(runId, entry.tag), grant);
  return { tag: grant.tag, label: grant.label, envName: grant.envName, expiresAt: grant.expiresAt, maxUses: GRANT_MAX_USES };
}

/**
 * Whether a command actually asks for a variable, so one that does not is neither given the
 * secret nor charged for it.
 *
 * Matched on the variable name preceded by `$`, in both the bare and braced forms a shell
 * accepts, with a boundary after it so `$ANTIMATTER_VAULT_SUDO_OLD` is not read as a reference to
 * `$ANTIMATTER_VAULT_SUDO`. Deliberately generous about *where* in the line it appears: the
 * command may build it up in any number of ways, and the cost of a false positive is a variable
 * set on a shell the same turn already had approval to run.
 */
const referencesVariable = (command: string, envName: string): boolean =>
  new RegExp(String.raw`\$(?:\{\s*)?${envName}\b`).test(command);

/**
 * The environment a run's command should be spawned with, or undefined when it holds no grant
 * that this command asks for.
 *
 * Charged here rather than when the command finishes, because this is the moment the secret
 * reaches a process: a command that never returns cannot hold a grant open indefinitely.
 *
 * Narrowed by the command on purpose. Injecting into every command of an approved turn would
 * widen nothing — they all run as the user, in the same turn, under the same approval — but it
 * would spend the budget on them, so ten incidental `ls` calls could exhaust an approval before
 * the command it was given for. A command that never names the variable is left alone.
 */
export function environmentFor(runId: string | undefined, command?: string): Record<string, string> | undefined {
  if (!runId) return undefined;
  sweep();
  const env: Record<string, string> = {};
  let found = false;
  for (const grant of grants.values()) {
    if (grant.runId !== runId) continue;
    if (command !== undefined && !referencesVariable(command, grant.envName)) continue;
    env[grant.envName] = grant.secret;
    grant.uses += 1;
    found = true;
    store.recordUse(grant.tag);
  }
  sweep();
  return found ? env : undefined;
}

/** What a run currently holds, for the chat view and the system note. Never the secret. */
export function activeFor(runId: string | undefined): ArmedGrant[] {
  if (!runId) return [];
  sweep();
  return [...grants.values()]
    .filter((grant) => grant.runId === runId)
    .map((grant) => ({ tag: grant.tag, label: grant.label, envName: grant.envName, expiresAt: grant.expiresAt, maxUses: GRANT_MAX_USES }));
}

/**
 * Masks every live secret out of text on its way to the model, the transcript, or the renderer.
 *
 * Deliberately not scoped to one run. A secret written into a file by one turn and read back by
 * the next is the same secret, and the cost of checking a handful of short strings against a tool
 * result is nothing next to the cost of missing one.
 */
export function redact(text: string): string {
  if (!text) return text;
  sweep();
  let result = text;
  for (const grant of grants.values()) {
    // A one-character secret would turn the whole result into mask characters; such a value
    // cannot be meaningfully protected in output anyway.
    if (grant.secret.length < 4) continue;
    while (result.includes(grant.secret)) {
      result = result.replace(grant.secret, `[vault:${grant.tag} redacted]`);
    }
  }
  return result;
}

/** True when anything is armed, so a caller can skip scanning results it does not need to. */
export const anyActive = (): boolean => {
  sweep();
  return grants.size > 0;
};

/** Drops a run's grants when its turn ends, rather than waiting for the TTL. */
export function release(runId: string): void {
  for (const [id, grant] of grants) {
    if (grant.runId !== runId) continue;
    grant.secret = '';
    grants.delete(id);
  }
}

/** Drops every grant: the Vault was turned off, or an entry the grant came from was changed. */
export function releaseAll(): void {
  for (const grant of grants.values()) grant.secret = '';
  grants.clear();
}

export const GRANT_LIMITS = { ttlMs: GRANT_TTL_MS, maxUses: GRANT_MAX_USES };
