import { randomUUID } from 'node:crypto';

/**
 * The fallback AI MCP shell.
 *
 * When anything other than normal operation happens — a renderer error, a crash, a window that
 * failed to load — the window hands over to this shell. It is a one-line-at-a-time conversation
 * with the configured model, running the same real tool loop as the chat window, plus a set of
 * slash commands that control the app itself. An agent can reach the same surface through the
 * built-in MCP server (recovery_status / recovery_use), which is how a chat turn repairs a UI it
 * broke without the UI being up to watch it.
 *
 * The shell is deliberately stateful and deliberately dumb about the app: it never imports
 * Electron, and everything it needs comes in through `deps`, so the state machine is unit-testable
 * and the wiring in src/main/index.ts is the only place that knows how to turn a turn on.
 */

export type RecoveryRole = 'system' | 'prompt' | 'assistant' | 'tool' | 'note' | 'error';

export interface RecoveryMessage {
  id: string;
  role: RecoveryRole;
  content: string;
  at: number;
}

export interface RecoveryApproval {
  approvalId: string;
  /** `toolName(args…)`, the way the person should read the request. */
  what: string;
  /** A reason the call reaches past the project, e.g. a machine-wide command. */
  caution?: string;
}

export interface RecoveryTrigger {
  kind: string;
  detail: string;
  at: number;
}

export interface RecoveryState {
  visible: boolean;
  trigger: RecoveryTrigger | null;
  messages: RecoveryMessage[];
  busy: boolean;
  approval: RecoveryApproval | null;
  model: { providerId: string; model: string } | null;
  workspace: string;
  version: string;
}

export interface RecoveryRunOptions {
  model: { providerId: string; model: string };
  onContent(chunk: string): void;
  onActivity(activity: unknown): void;
  /** A tool call the policy wants put to someone. Resolve with whether it was allowed. */
  onAsk(
    approval: { approvalId?: string; what: string; caution?: string },
    signal?: AbortSignal
  ): Promise<boolean>;
  signal: AbortSignal;
}

export type RecoveryRunResult = { content: string; ok: boolean; error?: string };

export interface RecoverySource {
  id: string;
  name: string;
  models: { id: string }[];
}

export interface RecoveryDeps {
  /** The source/model the shell should answer on: the one chat last used, when there is one. */
  provider(): { providerId: string; model: string } | null;
  /** Everything configured, so /model can offer and validate a choice. */
  sources(): RecoverySource[];
  /** Persists a model choice, so the shell and the chat land on the same source. */
  saveModel(choice: { providerId: string; model: string }): void;
  workspace(): string;
  workspaceConfirmed(): boolean;
  /** Points the tools at a directory a person actually chose. */
  setWorkspace(directory: string, confirmed?: boolean): void;
  /** Runs the question as a real agent turn against the workspace. */
  run(question: string, options: RecoveryRunOptions): Promise<RecoveryRunResult>;
  /** Last N console lines from the main process. */
  logs(count: number): string[];
  /** Thread list for /conversations, newest first. */
  conversations(): { id: string; title: string; createdAt: number }[];
  /** Runs a command line the person typed, in the workspace, and returns its output. */
  runCommand(command: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }>;
  reloadWindow(): void;
  restartApp(): void;
  hideShell(): void;
}

const MAX_MESSAGES = 120;
const APP_VERSION = 'v72';

/** Builds the approval line exactly as the normal chat does, for the person reading it. */
export const approvalOf = (activity: { toolName: string; args: string; caution?: string }, at = 160): string => {
  const args = activity.args
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, at);
  return `${activity.toolName}${args ? `(${args}${activity.args.length > at ? '…' : ''})` : ''}${
    activity.caution ? ` — ${activity.caution}` : ''
  }`;
};

const HELP = [
  'Controls (the person at the keyboard):',
  '  /help                 this list',
  '  /status               the model, workspace and anything waiting',
  '  /model [name]         show the model, or switch source/model by id or name',
  '  /workspace [dir]      show the working directory, or point it somewhere',
  '  /run <command>        run one command line in the workspace and show its output',
  '  /verify               run "npm run typecheck" in the workspace',
  '  /logs [n]             the last n lines the app wrote to its own console (default 40)',
  '  /conversations        the last forty conversations, to reopen or work from one',
  '  /cancel               stop the turn that is running',
  '  /clear                clear this transcript',
  '  /reload               reload the window (back to the app after a repair)',
  '  /exit                 hide this shell and go back to the app',
  '  /restart              quit and relaunch Antimatter',
  '',
  'Anything else is a prompt: it goes to the model with the same real tools as the chat window,',
  'so it can read the code, make the change and run the checks itself. Commands that change the',
  'machine are still put to you here before they run. Type or paste a normal sentence to start.',
  '',
  'Agents reach the same shell over MCP with recovery_status and recovery_use.',
].join('\n');

export interface SendResult {
  ok: boolean;
  /** A prompt's final text, when it ran to completion. Undefined for control commands. */
  content?: string;
}

export function createRecoveryShell(deps: RecoveryDeps) {
  let visible = false;
  let trigger: RecoveryTrigger | null = null;
  let messages: RecoveryMessage[] = [];
  let busy = false;
  let approval: RecoveryApproval | null = null;
  let controller: AbortController | null = null;
  const approvalResolvers = new Map<string, (allowed: boolean) => void>();
  /** Everything lands in one queue, so the person and an MCP caller never run two turns at once. */
  let tail: Promise<void> = Promise.resolve();
  const listeners = new Set<(state: RecoveryState) => void>();

  /** The source/model the shell should answer on: the one chat last used, when there is one. */
  const model = (): { providerId: string; model: string } | null => deps.provider();

  const snapshot = (): RecoveryState => ({
    visible,
    trigger,
    messages,
    busy,
    approval,
    model: deps.provider(),
    workspace: deps.workspace(),
    version: APP_VERSION,
  });

  const apply = (): void => {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  };

  const trim = (): void => {
    if (messages.length > MAX_MESSAGES) messages = messages.slice(messages.length - MAX_MESSAGES);
  };

  const add = (role: RecoveryRole, content: string): Promise<void> => {
    if (!content.trim()) return Promise.resolve();
    messages = [...messages, { id: randomUUID(), role, content: content.trimEnd(), at: Date.now() }];
    trim();
    apply();
    return Promise.resolve();
  };

  const system = (content: string): Promise<void> => add('system', content);
  const note = (content: string): Promise<void> => add('note', content);
  const error = (content: string): Promise<void> => add('error', content);

  const commonRun = (question: string): { mine: AbortController; promptAt: number; runid: string } => {
    const runid = randomUUID();
    const promptAt = Date.now();
    const mine = new AbortController();
    messages = [...messages, { id: runid, role: 'prompt', content: question.trim(), at: promptAt }];
    controller = mine;
    busy = true;
    approval = null;
    apply();
    return { mine, promptAt, runid };
  };

  const settleRun = (): void => {
    controller = null;
    busy = false;
    approval = null;
    trim();
    apply();
  };

  /**
   * Runs one prompt: appends it, marks the shell busy, streams the run in, and settles it. The
   * shell's single queue guarantees exactly one of these is in flight at a time.
   */
  const runPrompt = (question: string, signal?: AbortSignal): Promise<SendResult> => {
    const chosen = model();
    if (!chosen) {
      return error(
        'No model is configured, so this shell cannot think. Add a source in Settings — a running ' +
          'server answers rather than one that is merely listed — then /model <name>.'
      ).then(() => ({ ok: false }));
    }
    const { mine, promptAt, runid } = commonRun(question);
    let content = '';
    return deps
      .run(question, {
        model: chosen,
        signal: anySignal(signal, mine.signal),
        onContent: (chunk) => {
          content += chunk;
          const line: RecoveryMessage = { id: runid, role: 'assistant', content, at: promptAt };
          messages = messages.map((entry) => (entry.id === runid ? line : entry));
          // Streamed text may arrive after the queue moved on to a later entry; keep it in place.
          let present = false;
          for (const entry of messages) present = present || entry.id === runid;
          if (!present) messages = [...messages, line];
          apply();
        },
        onActivity: (activity) => {
          const { toolName, status } = activity as { toolName?: string; status?: string };
          if (!toolName) return;
          const text =
            status === 'running'
              ? `· ${toolName}…`
              : status === 'done'
                ? `· ${toolName} done`
                : status === 'failed'
                  ? `· ${toolName} failed`
                  : status === 'denied'
                    ? `· ${toolName} declined`
                    : `· ${toolName}`;
          void add('tool', text);
        },
        onAsk: async (request, requestSignal) => {
          const approvalId = request.approvalId ?? randomUUID();
          // One readable line for a person. The tool loop already folds the caution into `what`
          // in some wires; only append it when the call left it out.
          const what =
            request.caution && !request.what.includes(request.caution)
              ? `${request.what} — ${request.caution}`
              : request.what;
          approval = { approvalId, what, ...(request.caution ? { caution: request.caution } : {}) };
          apply();
          return new Promise<boolean>((resolve) => {
            const settleApproval = (allowed: boolean) => {
              approvalResolvers.delete(approvalId);
              if (approval?.approvalId === approvalId) approval = null;
              resolve(allowed);
              apply();
            };
            approvalResolvers.set(approvalId, settleApproval);
            const stop = () => settleApproval(false);
            requestSignal?.addEventListener('abort', stop, { once: true });
            if (signal?.aborted) stop();
          });
        },
      })
      .then((result) => {
        if (result.ok) return { ok: true, content } satisfies SendResult;
        throw new Error(result.error ?? 'the recovery turn did not finish');
      })
      .catch((failure) => {
        if (mine.signal.aborted || signal?.aborted) {
          return system('_Stopped._').then(() => ({ ok: false }) satisfies SendResult);
        }
        return error(`The recovery turn failed: ${(failure as Error).message}`).then(
          () => ({ ok: false }) satisfies SendResult
        );
      })
      .finally(settleRun);
  };

  const abortRun = (): void => {
    controller?.abort();
    for (const resolveApproval of approvalResolvers.values()) resolveApproval(false);
    approvalResolvers.clear();
  };

  const describeSources = (): string =>
    deps
      .sources()
      .map((source) => `${source.name} (${source.models.map((entry) => entry.id).join(', ') || 'no models listed'})`)
      .join('\n');

  const selectModel = (name: string): { providerId: string; model: string } | null => {
    for (const source of deps.sources()) {
      if (source.name === name || source.id === name) {
        if (!source.models.length) return null;
        const choice = { providerId: source.id, model: source.models[0].id };
        deps.saveModel(choice);
        return choice;
      }
      const matching = source.models.find((entry) => entry.id === name);
      if (matching) {
        const choice = { providerId: source.id, model: matching.id };
        deps.saveModel(choice);
        return choice;
      }
    }
    return null;
  };

  const truncate = (text: string, max = 4000): string => (text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text);

  const runCommandInShell = (command: string): Promise<void> => {
    const mine = new AbortController();
    controller = mine;
    busy = true;
    apply();
    return deps
      .runCommand(command, mine.signal)
      .then((result) =>
        system(
          `$ ${command}\n${result.ok ? 'Output: ' : 'Failed: '}${truncate(result.output || (result.ok ? '(no output)' : 'the command did not run'))}`
        )
      )
      .catch((failure) => error(`/run failed: ${(failure as Error).message}`))
      .finally(() => {
        controller = null;
        busy = false;
        apply();
      });
  };

  const commands: Record<string, (args: string) => Promise<SendResult> | SendResult> = {
    help: () => system(HELP).then(() => ({ ok: true })),
    status: () => {
      const chosen = model();
      return system(
        [
          `Version: ${APP_VERSION}`,
          `Model: ${chosen ? `${chosen.model} (${chosen.providerId})` : 'none configured'}`,
          `Workspace: ${deps.workspace()}${deps.workspaceConfirmed() ? '' : ' (not confirmed — writes are refused until it is)'}`,
          `Turn: ${busy ? 'running' : 'idle'}`,
          trigger ? `Last fallback: ${trigger.kind} — ${trigger.detail}` : 'No fallback engaged.',
        ].join('\n')
      ).then(() => ({ ok: true }));
    },
    model: (args) => {
      const query = args.trim();
      if (!query) {
        const chosen = model();
        return system(
          chosen
            ? `This shell answers on ${chosen.model} (${chosen.providerId}).\n\nSources:\n${describeSources()}\n\nSwitch with /model <name>.`
            : `No model is configured yet.\n\nSources:\n${describeSources()}`
        ).then(() => ({ ok: true }));
      }
      const chosen = selectModel(query);
      if (!chosen) {
        return error(`No source or model named "${query}". Sources:\n${describeSources()}`).then(() => ({ ok: false }));
      }
      return system(`Now answering on ${chosen.model} (${chosen.providerId}).`).then(() => ({ ok: true }));
    },
    workspace: (args) => {
      const directory = args.trim();
      if (!directory) {
        return system(
          deps.workspaceConfirmed()
            ? `Tools are pointed at ${deps.workspace()}.`
            : `Tools are pointed at ${deps.workspace()}, inherited rather than chosen. Writes are refused until someone names the directory — use /workspace <path>.`
        ).then(() => ({ ok: true }));
      }
      deps.setWorkspace(directory);
      return system(`Tools are now pointed at ${directory}, chosen here, so writes are allowed.`).then(() => ({
        ok: true,
      }));
    },
    run: (args) => {
      const command = args.trim();
      if (!command) {
        return error('Tell /run what to run, for example: /run npm run build').then(() => ({ ok: false }));
      }
      return runCommandInShell(command).then(() => ({ ok: true }));
    },
    verify: () => runCommandInShell('npm run typecheck').then(() => ({ ok: true })),
    logs: (args) => {
      const count = Math.max(1, Math.min(parseInt(args.trim(), 10) || 40, 400));
      const lines = deps.logs(count);
      return system(lines.length ? lines.join('\n') : '(nothing in the log yet)').then(() => ({ ok: true }));
    },
    conversations: () => {
      const list = deps.conversations().slice(0, 40);
      if (!list.length) return system('(no saved conversations)').then(() => ({ ok: true }));
      return system(
        list
          .map((entry, index) => {
            const day = new Date(entry.createdAt).toLocaleDateString();
            const title = (entry.title || '(untitled)').slice(0, 60);
            return `${String(index + 1).padStart(2)}  ${day}  ${title}`;
          })
          .join('\n')
      ).then(() => ({ ok: true }));
    },
    cancel: () => {
      abortRun();
      return system('_Stopped._').then(() => ({ ok: true }));
    },
    clear: () => {
      messages = [];
      apply();
      return { ok: true };
    },
    reload: () => {
      deps.reloadWindow();
      return system('_Reloading the window…_').then(() => ({ ok: true }));
    },
    exit: () => {
      deps.hideShell();
      return system('_Back to the app._').then(() => ({ ok: true }));
    },
    restart: () => {
      void system('_Relaunching Antimatter…_');
      deps.restartApp();
      return { ok: true };
    },
  };

  const split = (line: string): { name: string; args: string } => {
    const space = line.indexOf(' ');
    return {
      name: (space < 0 ? line.slice(1) : line.slice(1, space)).toLowerCase(),
      args: space < 0 ? '' : line.slice(space + 1),
    };
  };

  const handleNonPrompt = (trimmed: string): Promise<SendResult> | SendResult => {
    const { name, args } = split(trimmed);
    const command = commands[name];
    if (!command) return error(`No such command: /${name}. Try /help.`).then(() => ({ ok: false }) as SendResult);
    return command(args);
  };

  /**
   * Immediate, even while a turn runs: stopping it, or leaving for somewhere that outlives it.
   * Everything else goes through the queue so the person and an agent never interleave.
   */
  const INSTANT = new Set(['cancel', 'exit', 'reload', 'restart', 'clear', 'help']);

  const sendLine = (line: string): Promise<SendResult> => {
    const trimmed = line.trim();
    if (!trimmed) return Promise.resolve({ ok: true });
    if (INSTANT.has(split(trimmed).name)) return Promise.resolve(handleNonPrompt(trimmed));
    if (!trimmed.startsWith('/')) return enqueue(() => runPrompt(trimmed));
    return enqueue(() => Promise.resolve(handleNonPrompt(trimmed)));
  };

  const sendLineAndWait = (line: string, signal?: AbortSignal): Promise<SendResult> => {
    const trimmed = line.trim();
    if (!trimmed) return Promise.resolve({ ok: true });
    if (!trimmed.startsWith('/')) return enqueue(() => runPrompt(trimmed, signal));
    if (split(trimmed).name === 'cancel') {
      abortRun();
      return Promise.resolve({ ok: true });
    }
    return enqueue(() => Promise.resolve(handleNonPrompt(trimmed)));
  };

  const enqueue = <T>(job: () => Promise<T> | T): Promise<T> => {
    const result = tail.then(job, job);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return {
    state: snapshot,
    onChange(listener: (state: RecoveryState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    show: (newTrigger: RecoveryTrigger): void => {
      if (!visible || !trigger || trigger.kind !== newTrigger.kind || trigger.detail !== newTrigger.detail) {
        void system(
          `_Fallback engaged — ${newTrigger.kind}${newTrigger.detail ? `: ${newTrigger.detail}` : ''}._ ` +
            'Type /help for controls, or describe the problem and it will use the same real tools as the chat window to fix it.'
        );
      }
      trigger = newTrigger;
      visible = true;
      apply();
    },
    hide: (): void => {
      visible = false;
      apply();
    },
    sendLine,
    sendLineAndWait,
    approve: (approvalId: string, allowed: boolean): boolean => {
      const resolveApproval = approvalResolvers.get(approvalId);
      if (!resolveApproval) return false;
      resolveApproval(allowed);
      return true;
    },
    cancel: (): boolean => {
      if (!controller && !busy) return false;
      abortRun();
      return true;
    },
    clear: (): void => {
      messages = [];
      apply();
    },
    shutdown: (): void => {
      abortRun();
      listeners.clear();
    },
  };
}

export type RecoveryShell = ReturnType<typeof createRecoveryShell>;

/** One signal across two inputs; fires as soon as either does. */
function anySignal(a?: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!a) return b as AbortSignal;
  if (!b) return a;
  const combined = new AbortController();
  if (a.aborted || b.aborted) combined.abort();
  else {
    const stop = () => combined.abort();
    a.addEventListener('abort', stop, { once: true });
    b.addEventListener('abort', stop, { once: true });
  }
  return combined.signal;
}