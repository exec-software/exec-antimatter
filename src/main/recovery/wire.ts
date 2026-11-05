import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { BrowserWindow } from 'electron';
import type { Message } from '../../api/types';
import type { ProviderManager } from '../../api/providers';
import * as conversations from '../conversations';
import { fitToBudget, promptBudget } from '../context';
import * as mcp from '../mcp';
import { withMcpControl } from '../mcpLease';
import * as mcpStore from '../mcpStore';
import * as modelChoice from '../modelChoice';
import * as modelProfiles from '../modelProfiles';
import { mergeInstructions, withSituation } from '../prompt';
import { runToolLoop } from '../toolLoop';
import { approvalOf, createRecoveryShell, type RecoveryDeps, type RecoveryRunOptions, type RecoveryRunResult, type RecoveryShell } from './shell';
import { install as installLogCapture, read as readLogs } from './logs';

/**
 * Turning the recovery shell on (src/main/recovery/shell.ts) with the app's real services.
 *
 * The shell itself is deliberately dumb about the app; this module is the only place that knows
 * how to turn a turn on. It supplies the deps (provider, model choice, workspace, an actual
 * agent turn via runToolLoop, /run through a bounded shell), and it registers the two built-in
 * MCP tools — recovery_status and recovery_use — that let a chat or orchestrator turn reach the
 * same shell while the window that would show it is broken.
 */

/** The recovery tools must not be offered to the shell's own turns, or a repair could loop. */
const RECOVERY_TOOLS = new Set(['recovery_status', 'recovery_use']);

/** Command output must not flood the transcript that is trying to be legible. */
const COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_MAX_OUTPUT = 4 * 1024 * 1024;

/** Runs one command line in the workspace and returns its captured output, bounded and killable. */
export function runShellCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, output: string) => {
      if (settled) return;
      settled = true;
      resolve({ ok, output });
    };
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, timeout: timeoutMs, maxBuffer: COMMAND_MAX_OUTPUT, windowsHide: true, env: process.env },
      (error, stdout, stderr) => {
        const output = [stdout?.toString() ?? '', stderr?.toString() ?? ''].filter(Boolean).join('\n').trim();
        if (!error) return finish(true, output);
        const code = (error as { code?: unknown }).code;
        finish(
          false,
          output ||
            (code === 'ETIMEDOUT'
              ? `the command timed out after ${Math.round(timeoutMs / 1000)}s`
              : (error as { killed?: boolean }).killed
                ? 'the command was stopped.'
                : (error as Error).message)
        );
      }
    );
    const kill = () => child.kill('SIGTERM');
    if (signal?.aborted) kill();
    else signal?.addEventListener('abort', kill, { once: true });
  });
}

/** The model/context profile for one provider-model, like the chat window computes it. */
function profileFor(providerManager: ProviderManager, providerId: string, modelId: string) {
  const source = providerManager.listProviders().find((entry) => entry.id === providerId);
  return modelProfiles.resolveSourceProfile(source?.models ?? [], providerId, modelId);
}

export interface RecoveryApp {
  /** Pushes a state update to whatever the window is showing, when it can. */
  send(channel: string, payload: unknown): void;
  /** The main window, which shows both the app and the recovery page inside it. */
  window(): BrowserWindow | null;
  /** Puts the app's own page back into the window (reload, or leaving the shell). */
  backToApp(window: BrowserWindow): Promise<void>;
  /** Relaunches Antimatter, as the updater's restart does. */
  relaunchApplication(): void;
}

export interface WireResult {
  shell: RecoveryShell;
}

export function wireRecovery(app: RecoveryApp, providerManager: ProviderManager): WireResult {
  // The shell's /logs answers from a ring of the main process's own console lines; capture them.
  installLogCapture();
  let shell!: RecoveryShell;

  const deps: RecoveryDeps = {
    provider: () => {
      const choice = modelChoice.read();
      return choice?.modelId ? { providerId: choice.providerId, model: choice.modelId } : null;
    },
    sources: () =>
      providerManager.listProviders().map((source) => ({
        id: source.id,
        name: source.name,
        models: source.models.map((model) => ({ id: model.id })),
      })),
    saveModel: (choice) => {
      modelChoice.save({ providerId: choice.providerId, modelId: choice.model });
    },
    workspace: () => mcpStore.workspace(),
    workspaceConfirmed: () => mcpStore.workspaceConfirmed(),
    // Choosing a directory here is itself the confirmation. The global control runtime is
    // reconnected so the settings panel sees the new aim; the shell's own turns build isolated
    // runtimes that read the new workspace directly.
    setWorkspace: (directory, confirmed = true) => {
      void withMcpControl(async () => {
        mcpStore.setWorkspace(directory, confirmed);
        await mcp.shutdown();
        await mcp.connectEnabled();
      });
      app.send('mcp:workspace-changed', { workspace: mcpStore.workspace(), confirmed });
    },
    run: (question, options) => runRecoveryTurn(providerManager, shell, question, options),
    logs: (count) =>
      readLogs(count).map((entry) => {
        const stamp = new Date(entry.at).toISOString().slice(11, 19);
        return `[${entry.level.toUpperCase()}] ${stamp} ${entry.text}`;
      }),
    conversations: () =>
      conversations
        .load()
        .threads.map((thread) => ({ id: thread.id, title: thread.title, createdAt: Number(thread.createdAt) || 0 })),
    runCommand: (command, signal) => runShellCommand(command, mcpStore.workspace(), signal),
    reloadWindow: () => {
      const window = app.window();
      if (window && !window.isDestroyed()) void app.backToApp(window);
    },
    restartApp: () => app.relaunchApplication(),
    hideShell: () => {
      shell.hide();
      const window = app.window();
      if (window && !window.isDestroyed()) void app.backToApp(window);
    },
  };

  shell = createRecoveryShell(deps);

  // An agent's turn can inspect and drive the shell even though it is the window's fallback: a
  // UI that a turn broke is fixed by the next turn asking the shell to repair it, then reloading.
  mcp.registerBuiltinTool('recovery_status', async () => {
    const state = shell.state();
    const lines = [
      `visible: ${state.visible}`,
      state.trigger ? `last fallback: ${state.trigger.kind} — ${state.trigger.detail}` : 'no fallback engaged',
      `busy: ${state.busy}`,
      `model: ${state.model ? `${state.model.model} (${state.model.providerId})` : 'none configured'}`,
      `workspace: ${state.workspace}`,
    ];
    return lines.join('\n');
  });
  mcp.registerBuiltinTool('recovery_use', async (_toolName, args, options) => {
    const line = typeof args?.line === 'string' ? (args.line as string).trim() : '';
    if (!line) throw new Error('recovery_use needs a "line" for the recovery shell.');
    const result = await shell.sendLineAndWait(line, options?.signal);
    if (!result.ok) throw new Error(result.content ?? 'the recovery shell could not answer that.');
    return result.content ?? 'done.';
  });

  return { shell };
}

/** Runs one question as a real agent turn, the same loop the chat window uses. */
async function runRecoveryTurn(
  providerManager: ProviderManager,
  shell: RecoveryShell,
  question: string,
  options: RecoveryRunOptions
): Promise<RecoveryRunResult> {
  const { providerId, model } = options.model;
  const provider = providerManager.getProvider(providerId);
  if (!provider) return { content: '', ok: false, error: `No configured source named ${providerId}` };

  const workspace = mcpStore.workspace();
  const workspaceConfirmed = mcpStore.workspaceConfirmed();
  const profile = profileFor(providerManager, providerId, model);

  const runtime = await mcp.createWorkspaceRuntime(workspace, options.signal);
  try {
    const runId = randomUUID();
    const toolNames = runtime
      .enabledTools()
      .map((entry) => entry.tool.name)
      .filter((name) => !RECOVERY_TOOLS.has(name));
    const system = withSituation(mergeInstructions(profile.instructions), {
      workspace,
      workspaceConfirmed,
      mode: 'ask',
      tools: toolNames,
      maxOutputTokens: profile.maxOutputTokens,
    });
    const messages: Message[] = [
      { id: `${runId}-system`, role: 'system', content: system },
      { id: `${runId}-user`, role: 'user', content: question },
    ];

    const result = await runToolLoop({
      provider,
      request: {
        messages,
        model,
        providerId,
        requestId: runId,
        responseMessageId: `${runId}-assistant`,
        maxTokens: profile.maxOutputTokens,
        maxToolCalls: profile.maxToolCallsPerMessage,
        accessMode: 'ask',
        useTools: true,
      },
      runId,
      mode: 'ask',
      signal: options.signal,
      workspace,
      workspaceConfirmed,
      toolFilter: (name) => !RECOVERY_TOOLS.has(name),
      fit: (conversation, tools) => fitToBudget(conversation, promptBudget(profile, tools)),
      onContent: options.onContent,
      onActivity: options.onActivity,
      // Machine-changing calls are put to whoever is watching the shell. If no window is
      // showing it (an agent drove the shell via recovery_use while the UI is down), there is
      // nobody to answer, so the call is refused rather than hanging a turn forever.
      requestApproval: (activity, signal) =>
        shell.state().visible
          ? options.onAsk(
              {
                approvalId: activity.approvalId ?? activity.callId,
                what: approvalOf(activity),
                ...(activity.caution ? { caution: activity.caution } : {}),
              },
              signal
            )
          : Promise.resolve(false),
    });
    return { content: result.content, ok: true };
  } catch (error) {
    if (options.signal.aborted) return { content: '', ok: false, error: 'Stopped' };
    return { content: '', ok: false, error: (error as Error).message };
  } finally {
    await runtime.shutdown();
  }
}
