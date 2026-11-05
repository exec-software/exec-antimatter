import { createHash } from 'node:crypto';
import type { AccessMode, ChatRequest, InferenceMetrics, LivenessNote, Message, StreamCallback, StreamResult, ToolCall, ToolDefinition, ToolTier } from '../api/types';
import { DEFAULT_MAX_TOOL_CALLS, isToolArgumentObject, toolCallCap, toolCallForHistory } from '../api/toolArguments';
import { withoutReasoningHistory } from '../api/requestMessages';
import * as mcp from './mcp';
import * as modelUse from './modelUse';
import {
  AUTO_CONTINUE_NUDGE,
  DEFAULT_AUTO_CONTINUE,
  normalizeAutoContinue,
  shouldAutoContinue,
  type AutoContinueReason,
  type AutoContinueSettings,
} from './autoContinue';
import {
  compactionDigest,
  compactionNotice,
  conversationTokens,
  fitWithCompactionNotice,
  isCompactionNotice,
  type FitResult,
} from './context';
import {
  keptReason,
  notKeptReason,
  repeatedAtSeam,
  salvageWrite,
  SEAM_LINES,
  tailOf,
  type SalvagedWrite,
} from './salvage';
import {
  BUILTIN_SERVER_ID,
  buildToolset,
  decide,
  denialReason,
  machineWide,
  machineWideAdvice,
  tierOf,
  type ToolTarget,
} from './toolPolicy';

/**
 * The agentic tool-call loop, shared by interactive chat and the orchestrator.
 *
 * It was inline in the chat IPC handler, which made it unreachable from anywhere else and hard
 * wired one approval policy: ask the renderer and wait forever. An unattended orchestrator run
 * has nobody to answer, so approval arrives here as a resolver the caller supplies.
 */

/**
 * The ceiling on tool rounds — a safety net, not the place a turn is expected to end.
 *
 * It used to be 8, which is roughly the length of "set the project up", and a real task is
 * longer than that. A turn asked to build something would be cut off mid-way with its last tool
 * call still warm, and nothing said so except a line at the end of the reply; the model looked
 * like it had given up when it had in fact been stopped.
 *
 * A turn now ends when the model answers without calling a tool (it is finished), or when it is
 * demonstrably going in circles. This number is what is left: the backstop for the case neither
 * of those catches.
 */
export const MAX_TOOL_ROUNDS = 64;

/**
 * The most tool calls one reply may ask for when the model's profile does not say.
 *
 * The reasoning lives with the constant in `api/toolArguments`, because the providers enforce it
 * while the stream is still open: a batch the loop would trim is a batch the engine is still
 * being paid to decode. This bounds one batch, while MAX_TOOL_ROUNDS bounds how many batches a
 * turn may take, and `ChatRequest.maxToolCalls` narrows it per model.
 */
export const MAX_CALLS_PER_MESSAGE = DEFAULT_MAX_TOOL_CALLS;

/**
 * Overrunning the batch cap this many rounds in a row means the model is not going to stop.
 *
 * One overrun is a misjudgement, and the note telling the model its batch was cut is usually
 * enough. What was actually observed is the other thing: a model whose context has just been
 * compacted emits a degenerate batch, is told, and emits another. Each of those rounds costs a
 * full prompt and a capped batch of decoding for nothing, and the turn walks its whole round
 * allowance without advancing. At that point the turn is stuck in the same way a repeated call
 * is stuck, and is ended the same way — with the model asked to report what it did find.
 */
const BATCH_OVERRUN_LIMIT = 3;

/**
 * The same call, with the same arguments, this many times in a row means it is stuck. Two in a
 * row is ordinary — reading a file again after an edit, retrying a command. Three identical
 * calls with nothing in between is a loop, and no number of further rounds will break it.
 */
const REPEAT_LIMIT = 3;

/** Changing the wording of an echo must not buy another round of completion summaries. */
const COMPLETION_ONLY_LIMIT = 3;
const COMPLETION_ONLY_NOTICE = 'Antimatter stopped this turn after three responses claimed completion while only ' +
  'printing completion messages or exiting the shell. Those commands did not verify the application. ' +
  'No further automatic retries were started.';
const REPEATED_VALIDATION_LIMIT = 3;
const REPEATED_VALIDATION_NOTICE = 'Antimatter stopped this turn after three completion claims repeated previously observed ' +
  'validation results without intervening productive work. Repeating those checks does not establish that the requested ' +
  'application is correct. No further automatic retries were started.';

/** A deliberately narrow claim, not a general judgement about whether a task is finished. */
function claimsCompletion(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`]*`/g, '').replace(/’/g, "'");
  return prose.split(/[.!?;\n]+/).some(clause => {
    // A negated status such as "Not all tests pass yet" is not a completion claim.
    // Prefer missing an ambiguous claim over stopping an honest progress report.
    if (/\b(?:not|never|no|neither|nor|cannot|\w+n't|false|untrue)\b/i.test(clause)) return false;
    return /\b(?:implementation|task|work|project|application|engine)\s+(?:is\s+|has\s+been\s+)?(?:complete(?:d)?|finished|done)\b/i.test(clause) ||
      /\b(?:i|we)\s+(?:have\s+)?(?:successfully\s+)?(?:completed|finished|implemented|delivered)\b/i.test(clause) ||
      /\ball\s+(?:requirements|tests)\s+(?:are\s+|have\s+been\s+)?(?:met|implemented|satisfied|pass(?:ed)?|complete(?:d)?)\b/i.test(clause);
  });
}

/**
 * Recognize only literal echo/exit commands, optionally joined by &&. This is not a shell parser:
 * any expansion, redirection, pipeline, glob, escape, comment or other command is unknown and
 * cannot count against the guard. In particular, `echo "$(check)"` is real work, not an echo.
 */
function literalShellClauses(command: unknown): string[][] | null {
  if (typeof command !== 'string' || command.length > 8192) return null;
  const clauses: string[][] = [];
  let words: string[] = []; let word = ''; let started = false; let quote = '';
  const flush = () => { if (started) { words.push(word); word = ''; started = false; } };
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (/[\n\r\0$`\\]/.test(character)) return null;
    if (quote) {
      if (character === quote) quote = ''; else word += character;
    } else if (character === '"' || character === "'") {
      quote = character; started = true;
    } else if (character === ' ' || character === '\t') flush();
    else if (character === '&' && command[index + 1] === '&') {
      flush(); if (!words.length) return null;
      clauses.push(words); words = []; index++;
    } else if (/[;&|<>()*?\[\]{}#]/.test(character)) return null;
    else { word += character; started = true; }
  }
  if (quote) return null;
  flush(); if (!words.length) return null; clauses.push(words);
  return clauses;
}

function isCompletionOnlyCall(call: ToolCall, target: ToolTarget | undefined): boolean {
  if (target?.serverId !== BUILTIN_SERVER_ID || target.toolName !== 'run_command') return false;
  let command: unknown;
  try { command = JSON.parse(call.function.arguments).command; } catch { return false; }
  const clauses = literalShellClauses(command);
  if (!clauses) return false;
  return clauses.every(clause => clause.length === 2 && clause[0] === 'exit' && clause[1] === '0' ||
    clause[0] === 'echo' && claimsCompletion(clause.slice(1).join(' ')));
}

const VALIDATION_INSPECTIONS = new Set(['workspace_info', 'read_file', 'list_directory', 'find_files',
  'search_text', 'file_info', 'git_status', 'git_diff', 'git_log']);
type CompletionValidation = { signature: string; evidence: string } | 'inspection' | null;
const validationDigest = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Only known literal validations are comparable. A shell result is not source attestation:
 * this detects redundant completion checks after no observed edits, not unnoticed external
 * changes that happen to print the same output. Pensieve supplies exact source identity.
 */
function completionValidation(call: ToolCall, target: ToolTarget | undefined, text: string): CompletionValidation {
  if (!target) return null;
  if (target.serverId === BUILTIN_SERVER_ID && VALIDATION_INSPECTIONS.has(target.toolName) ||
      target.serverId === 'antimatter.pensieve' && target.toolName === 'pensieve_recall' ||
      isCompletionOnlyCall(call, target)) return 'inspection';
  const pensieveCheck = target.serverId === 'antimatter.pensieve' && target.toolName === 'pensieve_check_project';
  if (!pensieveCheck && (target.serverId !== BUILTIN_SERVER_ID || target.toolName !== 'run_command')) return null;
  let args: Record<string, unknown>;
  try { args = JSON.parse(call.function.arguments); } catch { return null; }
  if (!isToolArgumentObject(args)) return null;
  if (pensieveCheck) {
    if (Object.keys(args).some(key => key !== 'path') || args.path !== undefined && typeof args.path !== 'string') return null;
    try {
      const result = JSON.parse(text);
      if (result.verification !== 'compile-only' || result.success !== true || result.sourceStable !== true ||
          typeof result.entry !== 'string' || typeof result.task !== 'string' || typeof result.output !== 'string' ||
          !isToolArgumentObject(result.capturedSourceHashes)) return null;
      const hashes = Object.entries(result.capturedSourceHashes).sort(([a], [b]) => a.localeCompare(b));
      if (!hashes.length || !hashes.every(([, value]) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) return null;
      return { signature: JSON.stringify([target.serverId, target.toolName, args.path ?? null]),
        evidence: validationDigest(JSON.stringify([result.verification, result.success, result.entry, result.task,
          result.output, hashes, result.entryScopeWarning ?? null])) };
    } catch { return null; }
  }
  if (target.serverId !== BUILTIN_SERVER_ID || target.toolName !== 'run_command') return null;
  const clauses = literalShellClauses(args.command);
  if (clauses?.length !== 1) return null;
  const words = clauses[0];
  if (!/(?:^|\/)nilbuild(?:\.exe)?$/.test(words[0]) || !['check', 'run'].includes(words[1])) return null;
  const seen = new Set<string>();
  for (let index = 2; index < words.length; index += 2) {
    if (!['--project', '--sdk'].includes(words[index]) || seen.has(words[index]) || !words[index + 1] || words[index + 1].startsWith('-')) return null;
    seen.add(words[index]);
  }
  // Ignore the app-owned automatic feedback prefix; compare the production shell report.
  const marker = '\nOriginal tool result:\n';
  const original = text.slice(text.lastIndexOf(marker) < 0 ? 0 : text.lastIndexOf(marker) + marker.length);
  if (original.includes('[timeout]') || original.includes('output truncated')) return null;
  const report = /^\$ [^\n]*\n\[cwd\] ([^\n]+)\n\[exit\] 0\n--- stdout \(\d+ bytes\) ---\n([\s\S]*?)\n--- stderr \(\d+ bytes\) ---\n([\s\S]*)$/.exec(original);
  if (!report) return null;
  // nilbuild's compiler footer names a fresh staging directory on every run. Only this known
  // footer is normalized; changed stdout, diagnostics, source paths and other output are new evidence.
  const stderr = report[3].replace(/^(Compiled files to '[^'\n]*\/)\.nilbuild-[A-Za-z0-9]+(\/[^'\n]*' in topological order:)$/gm,
    '$1.nilbuild-<stage>$2');
  return { signature: JSON.stringify([target.serverId, target.toolName, words, report[1]]),
    evidence: validationDigest(JSON.stringify([report[2], stderr])) };
}

/**
 * Drops a read-only call a reply has already made, keeping the first of each.
 *
 * Every call in one reply is chosen before any of their results come back, so asking for the same
 * read twice cannot tell the model anything the first one will not. It is not free, though: the
 * second result is a second copy of the same file in the window. Measured on carbon 95bf32a1, a
 * batch of sixteen read `src/main/index.ts` four times and `src/main/toolLoop.ts` three times, and
 * 39% of that round's 16,110 tokens of results — about 6,250 — were byte-identical repeats.
 *
 * Only read tools. Two identical `run_command`s in one reply are two runs, and a model that meant
 * to append twice has said so; collapsing that would change what the turn did.
 */
function withoutRepeatedReads(
  calls: ToolCall[],
  lookup: Map<string, ToolTarget>
): { calls: ToolCall[]; dropped: number } {
  const seen = new Set<string>();
  const kept: ToolCall[] = [];
  let dropped = 0;
  for (const call of calls) {
    const target = lookup.get(call.function.name);
    const name = target?.toolName ?? call.function.name;
    if (tierOf(name, target?.serverId) !== 'read') {
      kept.push(call);
      continue;
    }
    const signature = `${name}(${call.function.arguments})`;
    if (seen.has(signature)) {
      dropped += 1;
      continue;
    }
    seen.add(signature);
    kept.push(call);
  }
  return { calls: kept, dropped };
}

/**
 * How many rounds one turn may lose to the output lid while deliberating.
 *
 * A reasoning model's thinking is billed as output, so a round can spend the whole reply budget
 * and be cut off having written nothing — no answer, no tool call. That is not the model choosing
 * to stop, and treating it as the end of the turn throws away everything the turn has done:
 * carbon e2b3a672 lost 97 tool calls and an hour and a half to one such round, at the point where
 * it had just said it was nearly ready to write.
 *
 * So it is worth another round. Unlike auto-continue, which guesses at whether a model that chose
 * to stop meant it, there is nothing to guess here — the reply was cut mid-sentence — so this is
 * not behind a setting and does not spend the person's continue allowance. It is bounded low
 * because a model that is still deliberating its budget away two prompts later is not going to
 * stop on a third, and each of those rounds costs a full prompt and a full reply.
 */
const RAN_OUT_THINKING_RETRIES = 2;

/**
 * What to say to a model whose round the lid cut off.
 *
 * It never sees its own thinking again — that is not carried in the transcript — so it will
 * deliberate from the top unless told plainly not to. The instruction is to act, not to think
 * further, and it names the budget so the model has a reason rather than a scolding.
 */
const RAN_OUT_THINKING =
  'Your previous reply reached its output limit while you were still thinking, so none of it was ' +
  'kept and nothing was written. This is Antimatter telling you, not the user. Do not deliberate ' +
  'again from the beginning: every tool result from this turn is still in front of you. Take the ' +
  'next concrete step now — make the tool calls you had settled on, or write the answer — and ' +
  'keep this reply short enough to finish.';

/**
 * A turn holding for background work looks up this often — a note from the person has no event of
 * its own — and says it is alive this often, because no stream is open to say it.
 */
const IDLE_POLL_MS = 1_000;
const IDLE_ALIVE_MS = 5_000;

export type StopReason = 'finished' | 'limit' | 'stalled' | 'truncated' | 'flooding' | 'no-progress';

export interface ToolActivity {
  /** Identifies the run these events belong to: a chat message id, or an agent session id. */
  runId: string;
  callId: string;
  /** App-owned occurrence id; provider fallback call ids can repeat on later rounds. */
  activityId?: string;
  /** Unique across concurrent runs; approval routing must not trust provider call ids alone. */
  approvalId?: string;
  /** UTF-16 offset in the visible assistant text where this occurrence first began. */
  contentOffset?: number;
  serverId: string;
  serverName: string;
  toolName: string;
  tier: ToolTier;
  args: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'denied';
  result?: string;
  awaitingApproval?: boolean;
  /** Why a command reaches past the project, which is why it is put to the person in any mode. */
  caution?: string;
  /** Set on a start_agent call, or a report from one, so the transcript can show whose run it is. */
  subagent?: { taskId: string; agentId: string; agentName: string; title: string; finished?: boolean };
  /** Set on a call that showed something: the picture it drew, or the page it opened. */
  preview?: { kind: 'image' | 'page'; target: string; title: string; workspace?: string };
}

/** Structural, so the loop does not depend on a concrete provider class. */
export interface StreamingProvider {
  /** Only history this adapter can serialize should consume the active prompt budget. */
  prepareMessages?(request: ChatRequest): Message[];
  stream(
    request: ChatRequest,
    callback: StreamCallback,
    onAlive?: (note?: LivenessNote) => void,
    signal?: AbortSignal
  ): Promise<StreamResult>;
}

/** What a runtime is told about a call beyond its arguments. */
export interface ToolCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The occurrence being run, as the transcript knows it, for a runtime that reports on it. */
  activity?: ToolActivity;
  /** Runtime-private state returned by prepareTool. It is never serialized into an activity. */
  prepared?: unknown;
  /** A salvaged first part must create a still-absent path, never replace a file that appeared meanwhile. */
  createOnly?: boolean;
  /**
   * Holds the call the way the turn holds between steps, for a tool whose job is to wait on
   * background work: until `ready()` is true, the person has something to say, or `timeoutMs`
   * has passed.
   */
  idle?(ready: () => boolean, timeoutMs?: number): Promise<IdleOutcome>;
}

/** Why a wait ended: what it was waiting for happened, the person spoke, or time ran out. */
export type IdleOutcome = 'ready' | 'steered' | 'timeout';

export interface PreparedToolCall {
  /** Effective public arguments used for policy, approval, activity display, and execution. */
  args: Record<string, unknown>;
  /** Runtime-private state carried to callTool without entering a transcript or approval prompt. */
  prepared?: unknown;
}

export interface ToolRuntime {
  enabledTools(): ReturnType<typeof mcp.enabledTools>;
  /**
   * Resolves facts a policy decision needs but the model cannot safely or reliably supply.
   * Called exactly once before policy; secrets belong in `prepared`, never in returned args.
   */
  prepareTool?(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: Pick<ToolCallOptions, 'signal'>
  ): Promise<PreparedToolCall>;
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: ToolCallOptions
  ): Promise<mcp.ToolCallResult>;
  /** Present on run-owned runtimes; the global settings runtime reports these via status. */
  connectionErrors?(): mcp.McpConnectionError[];
}

/** Work that finished in the background, as the model is told of it and as the transcript shows it. */
export interface BackgroundReport {
  /** Peer content is data from an app-owned tool, never a human instruction. */
  kind?: 'tool-result';
  /** Stable mailbox identity for recovery after a checkpoint succeeded but its receipt did not. */
  id?: string;
  /** App-owned function name for synthetic tool data. Defaults to private connected-chat mail. */
  toolResultName?: string;
  /** A message of its own for the model, delivered between steps. */
  note: string;
  /** A settled event marking where in the turn the model learned of it. */
  activity: Omit<ToolActivity, 'runId'>;
  /** Marks a durable mailbox claim delivered, only after its transcript checkpoint succeeds. */
  consumed?(): void;
}

/**
 * Work a turn started that runs alongside it: the agents it handed pieces to.
 *
 * The model does not wait for them. It carries on, and whatever has finished is given to it at
 * the next point it is between steps. It cannot end the turn while any is still running: the loop
 * waits, delivers the reports, and lets it go on from there. That is what lets a turn start a
 * review and fix a typo while the review runs, instead of standing still until it is done.
 */
export interface BackgroundWork {
  /** Finished work the model has not been told about. Taking it marks it told. */
  take(): BackgroundReport[];
  /** How many pieces are still running. */
  running(): number;
  /** How many have finished and are waiting to be told. */
  ready(): number;
  /** Calls back each time a piece finishes, until the returned function is called. */
  onSettle(listener: () => void): () => void;
}

/**
 * A message typed while the turn is still running.
 *
 * Steering is not the same as stopping. The turn continues; the note joins the conversation at
 * the next point the model is between things, which is either after its tools have come back or
 * when it was about to finish. "Now" cuts the current generation short instead of waiting for
 * that boundary — what it had already written is kept, because half an answer is still context.
 */
export interface Steering {
  /** Takes the queued message and clears it, or null when nothing is waiting. */
  take(): string | null;
  /** True when someone asked for it to land immediately rather than at the next boundary. */
  pending(): boolean;
  /** Aborts only the stream in flight. The turn itself keeps going. */
  interrupt: AbortSignal;
  /** Re-arms the interrupt for the next round, since an AbortSignal only fires once. */
  rearm(): void;
}

export interface InferenceRoundMetrics {
  round: number;
  providerId: string;
  model: string;
  metrics: InferenceMetrics;
}

export interface ToolLoopOptions {
  onMetrics?(event: InferenceRoundMetrics): void;
  provider: StreamingProvider;
  request: ChatRequest;
  runId: string;
  /** The permissions this turn started under, and the fallback when nothing can say otherwise. */
  mode: AccessMode;
  /**
   * The permissions as they stand right now, asked once per tool call.
   *
   * A turn is not an instant. An agentic one runs for minutes over many tool calls, and someone
   * watching it do the wrong thing reaches for the permission control — which, when the mode was
   * read once at dispatch, changed nothing until the turn was abandoned and started again. Asked
   * here instead, a change applies to the next call the model makes.
   *
   * Absent for callers with no one watching (scheduled agents, orchestrator runs), where the mode
   * is fixed by configuration for the length of the run.
   */
  currentMode?: () => AccessMode;
  /** Wakes an approval already waiting when the owner changes the run's permissions. */
  onAccessChange?: (listener: () => void) => () => void;
  /**
   * Whether a screen capture may run without asking, as the person has it set at this moment.
   *
   * A getter for the same reason `currentMode` is one: read at each call, so turning it off stops
   * the next capture instead of the next turn. Absent means ask, which is what Antimatter does
   * when nobody has said otherwise.
   */
  screenCaptureWithoutAsking?: () => boolean;
  machineWideWithoutAsking?: () => boolean;
  /** Rebuilds grounding at inference boundaries without adding synthetic conversation turns. */
  systemPromptForMode?: (mode: AccessMode) => string;
  maxRounds?: number;
  signal?: AbortSignal;
  steer?: Steering;
  /**
   * Whether the working directory was chosen by a person. Defaults to true, so an unattended
   * run — whose workspace comes from configuration — is not blocked by an interactive guard.
   */
  workspaceConfirmed?: boolean;
  /** Named in the refusal, so the message can say which directory it means. */
  workspace?: string;
  /**
   * Trims the conversation back into the model's window between rounds.
   *
   * A long agentic turn grows its own context: every tool result is another message, and a few
   * directory listings will fill a window that the opening question fitted into easily. Without
   * this, raising the round ceiling just moves the failure from "stopped early" to "the server
   * refused a prompt that was too long".
   */
  fit?(messages: Message[], tools: readonly ToolDefinition[]): Message[] | FitResult;
  /** App-owned evidence enters before fitting so it shares the real context budget. */
  prepareMessages?(messages: readonly Message[], round: number): Promise<Message[]>;
  /**
   * Narrows which tools are offered at all, by both their bare name and advertising server. An
   * agent with a short allowlist sees a short toolset, which is the difference between a
   * specialist and a generalist holding back. It can only ever subtract: policy still gates
   * whatever survives.
   */
  toolFilter?(toolName: string, serverId: string): boolean;
  /**
   * A bare MCP tool name that must be called before a prose-only answer can finish the turn.
   * Used only for explicit requests such as "use Bash"; ordinary prompts remain auto-select.
   */
  requiredTool?: string;
  /** Require at least one real tool call, without prescribing which tool. */
  requireToolCall?: boolean;
  /**
   * When the loop stops a run that had not finished — out of rounds, or going in circles — ask
   * the model once more, with its tools withdrawn, for an account of where the work stands.
   *
   * For an unattended run. Nobody is there to say "continue", so without this the run's last
   * words are whatever it said before its final tool call: "Let me check whether ImageTk is
   * available", followed by nothing, delivered to the person as the result.
   */
  reportWhenStopped?: boolean;
  /** Agents and the like that the turn's own tools started and did not wait for. */
  background?: BackgroundWork;
  /** Injectable for unit tests; production uses the connected MCP runtime. */
  toolRuntime?: ToolRuntime;
  /** Hard ceiling for one MCP call. Defaults to five minutes. */
  toolTimeoutMs?: number;
  /** Called with each streamed content fragment, in order. */
  onContent(chunk: string): void;
  /**
   * Called with each fragment of the model's thinking, in order, separately from its answer.
   *
   * On a reasoning model this is most of what a turn generates and none of what it says: a
   * measured MiMo turn here decoded 12,400 tokens to emit about 300. Nothing depends on it, and
   * a caller that does not want it may leave it unset — but an unattended turn is then silent
   * for as long as it takes, which is indistinguishable from a hang.
   */
  onReasoning?(chunk: string): void;
  /** Snapshot after hidden tool/history mutations, so callers can preserve interrupted work. */
  onTranscript?(messages: Message[]): void;
  /** A rolling-window fit removed history; `noticePersisted` says whether its marker fit too. */
  onCompaction?(event: ToolLoopCompaction): void;
  /**
   * The current prompt fit, once per round, whether or not anything was compacted.
   *
   * `onCompaction` only fires when history was actually dropped, so a meter fed from it alone
   * sits still through the whole climb and then jumps at the cliff — which is the moment it was
   * supposed to give warning of. This reports every round so the approach is visible.
   */
  onContext?(event: ToolLoopContextReport): void;
  /** A steer message was taken up, so the transcript can show where it landed. */
  onSteer?(note: string): void;
  /**
   * Carrying on a turn the model put down mid-work. Off unless the person turns it on in
   * Developer settings; see autoContinue.ts for what counts as putting it down.
   */
  autoContinue?: AutoContinueSettings;
  /** The turn was carried on rather than allowed to end, so a carbon can record that it was. */
  onAutoContinue?(event: {
    round: number;
    attempt: number;
    of: number;
    reason: AutoContinueReason;
  }): void;
  /**
   * The server is still there but has nothing to show yet. A turn that is building a tool call
   * produces no content at all until the call is complete, so on a slow model this is the only
   * evidence for minutes at a time that anything is happening.
   */
  onAlive?(note?: LivenessNote): void;
  /**
   * The turn has started or stopped holding for background work. Nothing streams meanwhile, and
   * what it is doing is waiting, not generating.
   */
  onWaiting?(waiting: boolean): void;
  onActivity(activity: ToolActivity): void;
  /**
   * Decides a call the policy says to ask about. Interactive chat forwards this to the human;
   * an unattended runner answers from its own policy so the turn cannot hang.
   */
  requestApproval(activity: ToolActivity, signal?: AbortSignal): Promise<boolean>;
}

export interface ToolLoopCompaction {
  /** The zero-based inference round whose request was compacted. */
  round: number;
  /** Messages removed at this boundary, excluding an older compaction marker. */
  compacted: number;
  /** All rolling removals represented by the notice, or reported as telemetry when it could not fit. */
  totalCompacted: number;
  /** The exact messages omitted by this fit, when the fitter supplied or preserved them. */
  dropped: Message[];
  /** The marker text for this compaction event. */
  notice: Message;
  /** False when preserving the current request left no room for the optional marker. */
  noticePersisted: boolean;
  /** The live definitions whose serialized size the fitter should budget for. */
  tools: readonly ToolDefinition[];
  estimatedTokens?: number;
  budgetTokens?: number;
  overflowTokens?: number;
  minimumRecentMet?: boolean;
}

/** A per-round fit snapshot. Same numbers the compaction event carries, without the drop. */
export interface ToolLoopContextReport {
  round: number;
  estimatedTokens: number;
  /** How many messages the durable marker already stands for, before this round's drop. */
  totalCompacted: number;
  budgetTokens?: number;
  overflowTokens?: number;
  minimumRecentMet?: boolean;
  tools: readonly ToolDefinition[];
}

export interface ToolLoopResult {
  /** Everything the model emitted across every round, concatenated. */
  content: string;
  rounds: number;
  toolCalls: number;
  /** True when the round limit ended the loop rather than the model finishing. */
  stoppedAtLimit: boolean;
  /** Why it ended, so the caller can say something more useful than "stopped". */
  reason: StopReason;
  /**
   * The conversation as the model actually saw it, tool calls and results included.
   *
   * The renderer's copy of a thread holds prose only, so a turn that continues an earlier one
   * would otherwise start blind — able to read what it said it did, but not what it did. Handing
   * this back lets the caller keep it and carry on from it.
   */
  transcript: Message[];
  /**
   * The model the source says answered, from the first round that named one.
   *
   * The first rather than the last: a turn's rounds all go to the same source with the same id,
   * so a later round cannot be more authoritative, and the first is the one that would have
   * triggered a substitution.
   */
  servedModel?: string;
}

/** One signal that fires when either input does, plus a disposer for non-fired listeners. */
function anyOf(a?: AbortSignal, b?: AbortSignal): { signal: AbortSignal | undefined; dispose(): void } {
  if (!a) return { signal: b, dispose: () => undefined };
  if (!b || a === b) return { signal: a, dispose: () => undefined };
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener('abort', stop, { once: true });
  b.addEventListener('abort', stop, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      a.removeEventListener('abort', stop);
      b.removeEventListener('abort', stop);
    },
  };
}

/**
 * What a call whose arguments were cut off by the reply's output limit is told.
 *
 * Reported as unreadable JSON, it looks like a mistake the model can correct by trying again, so
 * it writes the same oversized call again — a whole application in one write_file, cut off at the
 * same place every time, several minutes of generation per attempt on a local model.
 */
export function cutOffReason(toolName: string, maxTokens?: number): string {
  const limit = maxTokens ? `its output limit of ${maxTokens} tokens` : 'its output limit';
  return (
    `The reply reached ${limit} while it was still writing this ${toolName} call, so the arguments ` +
    `were cut off and nothing ran. The limit applies to every reply, so trying the same call again ` +
    `fails the same way. Split the work instead: write a large file in parts — create it with ` +
    `write_file, then add each further part with write_file and "append": true — or spread it ` +
    `across several smaller files, keeping each call well under the limit.` +
    // A write whose content came first cannot be saved as far as it got: the path never arrived.
    (toolName === 'write_file'
      ? ' A cut-off replacement is never put over a file that already exists; use edit_file for a smaller exact ' +
        'change, or send the complete replacement in one call. For a new file, give "path" and "append" before ' +
        '"content", so that a cut-off first part can still be saved as far as it got.'
      : '')
  );
}

/**
 * Where files that a cut-off write was saved into now end, by path, for the turn that is writing
 * them. The next part appended to one of them is checked for lines that repeat that end.
 */
type Continuations = Map<string, string[]>;

const pathKey = (path: string) => path.trim().replace(/^(?:\.\/)+/, '');

/**
 * What of a call cut off by the output limit can still be run: a write_file whose path arrived,
 * with the content as far as it got. Only when what the model meant is plain:
 *
 *  - the call explicitly said it appends;
 *  - the file does not exist yet;
 *  - or this turn was asked to continue that file with append, and this is not a rewrite, so it
 *    is the next part.
 *
 * A cut-off replacement is never put over an existing file. Matching its first lines only proves
 * that the model started a rewrite; it does not prove that the replacement reached its end. The
 * old behaviour deliberately replaced the file with that prefix, turning an output-limit event
 * into a plausible-looking truncation of the user's dirty work.
 */
async function salvageable(
  options: ToolLoopOptions,
  target: ToolTarget,
  rawArguments: string,
  runtime: ToolRuntime,
  continuations: Continuations | undefined
): Promise<SalvagedWrite | null> {
  if (target.serverId !== BUILTIN_SERVER_ID || target.toolName !== 'write_file') return null;
  const salvaged = salvageWrite(rawArguments);
  if (!salvaged || salvaged.append === true) return salvaged;
  const ask = (toolName: string, args: Record<string, unknown>) =>
    runtime
      .callTool(target.serverId, toolName, args, { signal: options.signal, timeoutMs: options.toolTimeoutMs })
      .catch(() => null);
  const info = await ask('file_info', { path: salvaged.path });
  if (!info) return null;
  if (!info.ok) return /ENOENT|no such file/i.test(info.text) ? salvaged : null;
  if (salvaged.append === false) return null;
  return continuations?.has(pathKey(salvaged.path)) ? { ...salvaged, append: true } : null;
}

/** The first part appended after a cut, without the lines it repeats from the end of the file. */
function withoutRepeat(
  toolName: string,
  args: Record<string, unknown>,
  continuations: Continuations | undefined
): { args: Record<string, unknown>; repeated: number } {
  if (toolName !== 'write_file' || args.append !== true || typeof args.path !== 'string' || typeof args.content !== 'string') {
    return { args, repeated: 0 };
  }
  const tail = continuations?.get(pathKey(args.path));
  if (!tail) return { args, repeated: 0 };
  continuations!.delete(pathKey(args.path));
  const repeated = repeatedAtSeam(tail, args.content);
  if (!repeated) return { args, repeated: 0 };
  return { args: { ...args, content: args.content.split('\n').slice(repeated).join('\n') }, repeated };
}

/** Runs one tool: gates it, reports each state change, and returns the text the model sees. */
async function runOne(
  options: ToolLoopOptions,
  callId: string,
  activityId: string,
  target: ToolTarget,
  rawArguments: string,
  cutOff = false,
  idle?: ToolCallOptions['idle'],
  continuations?: Continuations,
  onExecutionStart?: () => void
): Promise<{ text: string; executed: boolean }> {
  const { runId, mode, onActivity } = options;
  const runtime: ToolRuntime = options.toolRuntime ?? mcp;

  let args: Record<string, unknown> = {};
  let unreadable = false;
  try {
    const parsed: unknown = rawArguments ? JSON.parse(rawArguments) : {};
    if (!isToolArgumentObject(parsed)) throw new TypeError('tool arguments must be a JSON object');
    args = parsed;
  } catch {
    unreadable = true;
  }
  /** A cut-off write going ahead with what arrived of it. */
  let salvaged = unreadable && cutOff ? await salvageable(options, target, rawArguments, runtime, continuations) : null;
  if (salvaged) {
    args = { path: salvaged.path, ...(salvaged.append ? { append: true } : {}), content: salvaged.content };
  } else if (unreadable) {
    const text = cutOff
      ? cutOffReason(target.toolName, options.request.maxTokens)
      : `Antimatter could not read the arguments for ${target.toolName}: ${rawArguments.slice(0, 200)}`;
    onActivity({
      runId,
      callId,
      activityId,
      serverId: target.serverId,
      serverName: target.serverName,
      toolName: target.toolName,
      tier: tierOf(target.toolName, target.serverId),
      args: rawArguments.slice(0, 400),
      status: 'failed',
      result: text,
    });
    return { text, executed: false };
  }

  // A part appended after a cut can start by repeating where the file stopped; that is left out,
  // before anyone is asked, so what is approved is what is written.
  const trimmed = withoutRepeat(target.toolName, args, continuations);
  args = trimmed.args;
  if (salvaged && trimmed.repeated) {
    salvaged = { ...salvaged, content: String(args.content), lines: Math.max(0, salvaged.lines - trimmed.repeated) };
  }
  const leftOut = trimmed.repeated
    ? ` (Its first ${trimmed.repeated} line${trimmed.repeated === 1 ? '' : 's'} repeated the end of the file, so ` +
      `Antimatter left ${trimmed.repeated === 1 ? 'it' : 'them'} out.)`
    : '';

  // Some policy facts exist only at execution time. In particular, image analysis chooses one
  // configured vision source here so the approval names the exact destination that callTool will
  // later use. Only public args are displayed; opaque prepared state stays inside the runtime.
  let prepared: unknown;
  if (runtime.prepareTool) {
    const preparation = await runtime.prepareTool(target.serverId, target.toolName, args, {
      signal: options.signal,
    });
    args = preparation.args;
    prepared = preparation.prepared;
  }

  // Read per call, not per turn: a permission changed while this turn is running applies to the
  // next thing it tries, rather than to the next turn.
  const caution = machineWide(target.toolName, args);
  const base: ToolActivity = {
    runId,
    callId,
    activityId,
    serverId: target.serverId,
    serverName: target.serverName,
    toolName: target.toolName,
    tier: tierOf(target.toolName, target.serverId),
    args: JSON.stringify(args, null, 2),
    status: 'pending',
    ...(caution ? { caution } : {}),
  };
  const confirmed = options.workspaceConfirmed ?? true;
  const decisionNow = () => decide(target.toolName, {
    mode: options.currentMode?.() ?? mode,
    workspaceConfirmed: confirmed,
    serverId: target.serverId,
    screenCaptureWithoutAsking: options.screenCaptureWithoutAsking?.() ?? false,
    machineWideWithoutAsking: options.machineWideWithoutAsking?.() ?? false,
  }, args);
  const maxTokens = options.request.maxTokens;
  // Whatever stops a salvaged write, the model still has to hear that its call was cut off.
  const unwritten = (text: string) => (salvaged ? `${text} ${notKeptReason(salvaged, maxTokens)}` : text);

  const denied = () => {
    const text = unwritten(denialReason(target.toolName, confirmed, options.workspace, args));
    onActivity({ ...base, status: 'denied', awaitingApproval: false, result: text });
    return { text, executed: false };
  };

  let approved = false;
  let approvalAttempt = 0;
  const running: ToolActivity = { ...base, status: 'running', awaitingApproval: false };
  for (;;) {
    if (decisionNow() === 'deny') return denied();
    if (decisionNow() !== 'ask' || approved) {
      onActivity(running);
      // Activity delivery is synchronous but can itself cause a permission change. Nothing has
      // executed yet: check at the actual handoff, not only when the approval was first shown.
      if (options.signal?.aborted) throw new Error('the run was cancelled');
      if (decisionNow() === 'deny') return denied();
      if (decisionNow() !== 'ask' || approved) break;
    }
    const approvalId = `${runId}:${activityId}${approvalAttempt ? `:retry-${approvalAttempt}` : ''}`;
    approvalAttempt += 1;
    const approval = { ...base, approvalId, status: 'pending' as const, awaitingApproval: true };
    onActivity(approval);
    const outcome = await new Promise<'approved' | 'declined' | 'interrupted' | 'changed'>((resolve, reject) => {
      // Cancelling only this prompt removes stale renderer/remote approval ids without stopping
      // the turn. The adapter must not be allowed to turn that cancellation into a late grant.
      const prompt = new AbortController();
      let settled = false;
      let unsubscribe = () => {};
      const cleanup = () => {
        options.signal?.removeEventListener('abort', interrupted);
        unsubscribe();
      };
      const finish = (result: 'approved' | 'declined' | 'interrupted' | 'changed') => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
        if (result === 'changed' || result === 'interrupted') prompt.abort();
      };
      const interrupted = () => finish('interrupted');
      const reconsider = () => {
        if (options.signal?.aborted) interrupted();
        // Full access is not blanket approval: machine-wide and always-confirm operations,
        // and tools from untrusted servers, remain pending whenever policy still says ask.
        else if (decisionNow() !== 'ask') finish('changed');
      };
      options.signal?.addEventListener('abort', interrupted, { once: true });
      unsubscribe = options.onAccessChange?.(reconsider) ?? (() => {});
      // A subscription may notify synchronously, and the pending activity above may already
      // have changed the mode. Cover both without leaking listeners or showing a stale prompt.
      if (settled) unsubscribe();
      reconsider();
      if (settled) return;
      try {
        Promise.resolve(options.requestApproval(approval, prompt.signal)).then(
          (allowed) => {
            if (options.signal?.aborted) interrupted();
            else finish(allowed ? 'approved' : 'declined');
          },
          (error) => {
            if (settled) return;
            if (options.signal?.aborted) interrupted();
            else {
              settled = true;
              cleanup();
              prompt.abort();
              reject(error);
            }
          }
        );
      } catch (error) {
        if (settled) return;
        settled = true;
        cleanup();
        prompt.abort();
        reject(error);
      }
    });

    // Some approval adapters resolve false when their signal fires. Keep the signal as the
    // authority: closing/reloading the renderer or stopping the turn is not a human decision.
    if (options.signal?.aborted || outcome === 'interrupted') {
      const text = unwritten(`Interrupted while waiting for approval to run ${target.toolName}; nothing ran.`);
      onActivity({ ...approval, status: 'failed', awaitingApproval: false, result: text });
      return { text, executed: false };
    }
    if (outcome === 'declined') {
      const text = unwritten(
        `${target.toolName} was declined, so nothing ran.${caution ? ` ${machineWideAdvice(caution, target.toolName)}` : ''}`
      );
      onActivity({ ...approval, status: 'denied', awaitingApproval: false, result: text });
      return { text, executed: false };
    }
    approved = outcome === 'approved';
  }

  // This is the exact recovery boundary: validation and any required approval completed, and
  // the runtime is about to receive the call. From here its side effect may happen even if the
  // transport never returns a settled result.
  onExecutionStart?.();
  const result = await runtime.callTool(target.serverId, target.toolName, args, {
    signal: options.signal,
    timeoutMs: options.toolTimeoutMs,
    activity: running,
    prepared,
    createOnly: !!salvaged && salvaged.append !== true,
    idle,
  });
  const said = result.text || (result.ok ? '(the tool returned nothing)' : 'the tool reported an error');
  // A salvaged write that went through: the model is told where the file stops and how to go on.
  const text = (!salvaged ? said : result.ok ? keptReason(salvaged, maxTokens) : unwritten(said)) + (result.ok ? leftOut : '');
  if (salvaged && result.ok) continuations?.set(pathKey(salvaged.path), tailOf(salvaged.content, SEAM_LINES));
  onActivity({
    ...base,
    status: result.ok ? 'done' : 'failed',
    awaitingApproval: false,
    result: (salvaged || leftOut ? text : result.text).slice(0, 4000),
    // What the call showed, if it showed anything. The transcript keeps it so the Preview
    // section can be rebuilt from the conversation rather than from a store beside it.
    ...(result.preview ? { preview: result.preview } : {}),
  });

  return {
    text,
    // A failed MCP result still represents a real call. Unknown, malformed, or denied calls do
    // not; nor does a call for which the runtime had already lost its transport.
    executed: result.attempted !== false,
  };
}

const summaryNotice = (message: Message): boolean => isCompactionNotice(message) && /messages, summarized\]/.test(message.content);

const noticeCount = (message: Message): number => {
  if (!isCompactionNotice(message)) return 0;
  const generic = /^\[(\d+) earlier messages? (?:was|were) dropped\b/.exec(message.content);
  const summary = /^\[Earlier in this conversation — (\d+) messages, summarized\]/.exec(message.content);
  return Number(generic?.[1] ?? summary?.[1] ?? 0);
};

/** The stable opening in front of which no compaction marker belongs. */
const openingCount = (messages: readonly Message[]): number => {
  let count = messages[0]?.role === 'system' ? 1 : 0;
  if (messages[count]?.role === 'user') count += 1;
  return count;
};

const omittedBy = (before: readonly Message[], after: readonly Message[]): Message[] => {
  const key = (message: Message) => `${message.role}\u0000${message.id}\u0000${message.toolCallId ?? ''}`;
  const kept = new Map<string, number>();
  for (const message of after) kept.set(key(message), (kept.get(key(message)) ?? 0) + 1);
  return before.filter((message) => {
    const name = key(message);
    const count = kept.get(name) ?? 0;
    if (!count) return true;
    kept.set(name, count - 1);
    return false;
  });
};

/** Repairs persisted history from builds that stored partial JSON verbatim. */
const messageForHistory = (message: Message): Message =>
  message.toolCalls?.length
    ? { ...message, toolCalls: message.toolCalls.map((call) => toolCallForHistory(call)) }
    : message;

/**
 * Streams a turn, executes any tools the model asked for, feeds the results back, and repeats
 * until it answers without calling a tool or the round limit is reached.
 */
async function runToolLoopUnlocked(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxRounds = options.maxRounds ?? MAX_TOOL_ROUNDS;
  const autoContinue = normalizeAutoContinue(options.autoContinue ?? DEFAULT_AUTO_CONTINUE);
  /** Rounds this turn may use. Auto-continue buys another `maxRounds` when it extends the turn. */
  let ceiling = maxRounds;
  let autoContinued = 0;
  const runtime: ToolRuntime = options.toolRuntime ?? mcp;
  const toolsetForRound = () => {
    if (options.request.useTools === false) return null;
    const enabled = runtime.enabledTools();
    const offered = options.toolFilter
      ? enabled.filter((entry) => options.toolFilter!(entry.tool.name, entry.serverId))
      : enabled;
    return buildToolset(offered);
  };
  const messages: Message[] = (options.provider.prepareMessages?.(options.request) ??
    options.request.messages.map(withoutReasoningHistory)).map(messageForHistory);
  /** Whichever model the source first named as the one answering; see ToolLoopResult. */
  let servedModel: string | undefined;
  const checkpoint = () => options.onTranscript?.([...messages]);
  let groundedMode: AccessMode | undefined;
  const refreshGrounding = (): AccessMode => {
    const mode = options.currentMode?.() ?? options.mode;
    if (options.systemPromptForMode && mode !== groundedMode) {
      const content = options.systemPromptForMode(mode);
      const index = messages.findIndex((message) => message.role === 'system');
      if (index === -1) messages.unshift({ id: 'system', role: 'system', content });
      else if (messages[index].content !== content) messages[index] = { ...messages[index], content };
      groundedMode = mode;
      checkpoint();
    }
    return mode;
  };
  const checkpointToolBatch = (pending: StreamResult['toolCalls'], firstStarted = false): void => {
    if (!pending.length) return checkpoint();
    // A provider requires one result for every call in an assistant batch. Persist placeholders
    // only in the recovery snapshot—not the live transcript—so each completed side effect and
    // each begun-but-unsettled call is durable while recovery history remains protocol-valid.
    options.onTranscript?.([
      ...messages,
      ...pending.map((call, index) => ({
        id: call.id,
        role: 'tool' as const,
        toolCallId: call.id,
        name: call.function.name,
        content:
          firstStarted && index === 0
            ? 'Execution began, but its outcome was not durably recorded. Verify the target state before retrying this tool call.'
            : 'Not run before this multi-call response was interrupted.',
      })),
    ]);
  };
  checkpoint();
  const reportedConnectionErrors = new Set<string>();

  const connectionErrors = () => runtime.connectionErrors?.() ?? [];
  const withConnectionErrors = (message: string): string => {
    const failures = connectionErrors();
    return failures.length
      ? `${message} Tool server errors: ${failures.map((failure) => `${failure.serverName}: ${failure.message}`).join('; ')}`
      : message;
  };
  const reportConnectionErrors = () => {
    for (const failure of connectionErrors()) {
      const key = `${failure.serverId}:${failure.message}`;
      if (reportedConnectionErrors.has(key)) continue;
      reportedConnectionErrors.add(key);
      options.onActivity({
        runId: options.runId,
        callId: `connect:${failure.serverId}`,
        activityId: `connect:${reportedConnectionErrors.size}:${failure.serverId}`,
        serverId: failure.serverId,
        serverName: failure.serverName,
        toolName: 'connect',
        tier: 'read',
        args: JSON.stringify({ workspace: options.workspace ?? null }),
        status: 'failed',
        result: failure.message,
      });
    }
  };

  let content = '';
  /**
   * Set when what the model writes next should start a paragraph: the last round only wrote
   * text and the turn is going on anyway, or a note or a report has just been given to it.
   */
  let separate = false;
  let toolCalls = 0;
  let executedToolCalls = 0;
  let steered = 0;
  /** The last few call signatures, for noticing when it is going round in circles. */
  const recent: string[] = [];
  let stalled = false;
  /** Lives across developer auto-continue extensions; only new work/evidence resets it. */
  let completionOnlyRounds = 0;
  let repeatedValidationRounds = 0;
  const validationResults = new Map<string, string>();
  const resetValidationLoop = () => { repeatedValidationRounds = 0; validationResults.clear(); };
  /** Consecutive rounds whose reply asked for more tool calls than this model is allowed. */
  let batchOverruns = 0;
  let requiredSatisfied = false;
  let requiredRetries = 0;
  /** Rounds this turn has lost to the output lid mid-deliberation; see RAN_OUT_THINKING. */
  let thinkingRetries = 0;
  /** What one reply of this model's may ask for; see ChatRequest.maxToolCalls. */
  const maxCallsPerMessage = toolCallCap(options.request.maxToolCalls);

  /**
   * The last word from a run that was stopped rather than finished. Tools are withdrawn, so what
   * comes back is prose about the work instead of one more step of it. A report is a courtesy:
   * failing to get one leaves the run stopped, not crashed.
   */
  const reportOnStop = async (reason: 'limit' | 'stalled' | 'flooding', rounds: number): Promise<void> => {
    if (!options.reportWhenStopped) return;
    const why =
      reason === 'limit'
        ? `That was the last of your ${rounds} rounds of tool calls, so no more will run.`
        : reason === 'flooding'
          ? `Your last ${BATCH_OVERRUN_LIMIT} replies each asked for more than ${maxCallsPerMessage} ` +
            'tool calls and were cut off, so no more will run.'
          : `You made the same tool call with the same arguments ${REPEAT_LIMIT} times in a row, so no more will run.`;
    messages.push({
      id: `report_${rounds}`,
      role: 'user',
      content:
        `${why} Write your report now, from what the tool results above actually show: what you ` +
        `did, what you found, what is still unfinished, and what would finish it. Do not call a ` +
        `tool, and do not describe work you did not do.`,
    });
    checkpoint();
    // Separated from whatever the last round said, which usually ends mid-thought.
    const lead = content.trim() ? '\n\n' : '';
    let started = false;
    try {
      const liveMode = refreshGrounding();
      const result = await options.provider.stream(
        { ...options.request, messages, accessMode: liveMode, tools: undefined },
        (data) => {
          if (data.metrics) options.onMetrics?.({ round: rounds + 1, providerId: options.request.providerId, model: options.request.model, metrics: data.metrics });
          if (data.reasoning) options.onReasoning?.(data.reasoning);
          if (!data.content) return;
          const chunk = started ? data.content : `${lead}${data.content}`;
          started = true;
          content += chunk;
          options.onContent(chunk);
        },
        (note) => options.onAlive?.(note),
        options.signal
      );
      if (result.metrics) options.onMetrics?.({ round: rounds + 1, providerId: options.request.providerId, model: options.request.model, metrics: result.metrics });
      if (result.content.trim()) {
        messages.push({ id: `report_answer_${rounds}`, role: 'assistant', content: result.content,
          ...(result.reasoningHistory ? { reasoningHistory: result.reasoningHistory } : {}) });
        checkpoint();
      }
    } catch (error) {
      if (options.signal?.aborted) throw new Error('the run was cancelled');
      console.error('[tools] the stopped run could not report:', error);
    }
  };

  /**
   * Tells the model what finished in the background since it last looked, each as a message of
   * its own, and marks the point in the transcript where it heard.
   */
  let reported = 0;
  const absorbBackground = (): boolean => {
    if (options.signal?.aborted) throw new Error('the run was cancelled');
    const reports = options.background?.take() ?? [];
    for (const report of reports) {
      if (options.signal?.aborted) throw new Error('the run was cancelled');
      const id = report.id ?? `background_${options.runId}_${reported}`;
      const name = report.toolResultName ?? 'antimatter_conversations__receive_chat_message';
      if (report.kind === 'tool-result' && messages.some((message) => message.role === 'tool' &&
          message.toolCallId === id && message.name === name && message.content === report.note)) {
        // The mailbox's durable receipt may lag the transcript after a crash. Acknowledge the
        // existing data boundary below without injecting the same note a second time.
        continue;
      }
      options.onActivity({ ...report.activity, runId: options.runId });
      if (options.signal?.aborted) throw new Error('the run was cancelled');
      if (report.kind === 'tool-result') {
        messages.push({ id: `${id}_call`, role: 'assistant', content: '', toolCalls: [{
          id, type: 'function', function: { name, arguments: '{}' },
        }] });
        messages.push({ id: `${id}_result`, role: 'tool', toolCallId: id, name, content: report.note });
      } else {
        messages.push({ id: `background_${reported}`, role: 'user', content: report.note });
      }
      reported += 1;
    }
    if (reports.length) {
      checkpoint();
      if (options.onTranscript) for (const report of reports) report.consumed?.();
    }
    return reports.length > 0;
  };

  /**
   * Holds the turn while background work runs: until `ready()` is true, the person says something
   * — nobody should have to wait for an agent to finish to be heard — or the time is up. Stopping
   * the turn ends the wait at once.
   */
  const continuations: Continuations = new Map();
  let waits = 0;
  const idle = async (ready: () => boolean, timeoutMs?: number): Promise<IdleOutcome> => {
    waits += 1;
    const deadline = timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
    const outcome = (): IdleOutcome | null => {
      if (options.signal?.aborted) throw new Error('the run was cancelled');
      if (ready()) return 'ready';
      if (options.steer?.pending()) return 'steered';
      return Date.now() >= deadline ? 'timeout' : null;
    };
    const early = outcome();
    if (early) return early;

    let wake = () => {};
    const nudge = () => wake();
    const unsubscribe = options.background?.onSettle(nudge);
    // "Steer now" has no stream to cut short here; it ends the wait instead.
    const interrupt = options.steer?.interrupt;
    options.signal?.addEventListener('abort', nudge);
    interrupt?.addEventListener('abort', nudge);
    options.onWaiting?.(true);
    try {
      let lastSign = 0;
      for (;;) {
        if (Date.now() - lastSign >= IDLE_ALIVE_MS) {
          lastSign = Date.now();
          options.onAlive?.();
        }
        const pauseMs = Math.max(0, Math.min(IDLE_POLL_MS, deadline - Date.now()));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pauseMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        const settled = outcome();
        if (settled) return settled;
      }
    } finally {
      unsubscribe?.();
      options.signal?.removeEventListener('abort', nudge);
      interrupt?.removeEventListener('abort', nudge);
      options.onWaiting?.(false);
    }
  };

  /** Adds a queued steer to the conversation. Returns false when there was nothing waiting. */
  const absorbSteer = (): boolean => {
    const note = options.steer?.take();
    if (!note) return false;
    messages.push({ id: `steer_${steered}`, role: 'user', content: note });
    checkpoint();
    steered += 1;
    options.onSteer?.(note);
    return true;
  };

  for (let round = 0; round < ceiling; round += 1) {
    if (options.signal?.aborted) throw new Error('the run was cancelled');

    // The boundary: anything typed while the last round ran joins the conversation here, and so
    // does whatever background work finished meanwhile. What the model writes next answers
    // those, so it starts a paragraph of its own.
    // Put completed background reports in first so a simultaneous human correction remains the
    // newest mandatory group when an extremely tight context can preserve only one of them.
    const reportedNow = absorbBackground();
    const noted = absorbSteer();
    if (reportedNow || noted) { separate = true; completionOnlyRounds = 0; resetValidationLoop(); }
    options.steer?.rearm();
    // Execution gates and the model's instructions must describe the same current mode. Replace
    // grounding rather than appending conflicting system notes after tool-call/result batches.
    const liveMode = refreshGrounding();

    // MCP processes can disappear while a long turn is running. Rebuild the offered set at each
    // inference boundary so a closed server is neither advertised nor mistaken for a real call.
    reportConnectionErrors();
    const toolset = toolsetForRound();
    const tools = toolset?.definitions.length ? toolset.definitions : undefined;

    if (options.prepareMessages) {
      const prepared = await options.prepareMessages([...messages], round);
      if (options.signal?.aborted) throw new Error('the run was cancelled');
      messages.splice(0, messages.length, ...prepared);
      checkpoint();
    }

    // Keep the turn inside the model's window as its own tool results accumulate. The exact live
    // definitions go with it: they are serialized into this same request and can be larger than
    // the transcript on a many-server setup.
    if (options.fit) {
      const before = [...messages];
      const fittedValue = options.fit(messages, tools ?? []);
      const fit = Array.isArray(fittedValue) ? undefined : fittedValue;
      const fitted = Array.isArray(fittedValue) ? fittedValue : fittedValue.messages;
      let dropped = fit?.dropped ?? omittedBy(before, fitted);
      let newlyDropped = dropped.filter((message) => !isCompactionNotice(message)).length;
      const changed =
        fitted.length !== before.length || fitted.some((message, index) => message !== before[index]);

      if (changed || newlyDropped > 0) {
        let next = [...fitted];
        let compaction: ToolLoopCompaction | undefined;
        if (newlyDropped > 0) {
          // Preserve an initial summarized marker verbatim, but fold repeated generic loop
          // markers into one. This makes the gap durable without spending more context every
          // time another old exchange rolls out.
          const summaries = before.filter(summaryNotice);
          const uniqueSummaries = summaries.filter(
            (message, index) => summaries.findIndex((candidate) => candidate.id === message.id) === index
          );
          const previousGeneric = before
            .filter((message) => isCompactionNotice(message) && !summaryNotice(message))
            .reduce((total, message) => total + noticeCount(message), 0);
          let totalCompacted = previousGeneric + newlyDropped;
          let notice: Message;
          let noticePersisted = false;
          let finalMinimumRecentMet = fit?.minimumRecentMet;

          if (fit?.budgetTokens !== undefined) {
            // Production fitters return their budget. Re-run the whole fit with the marker as an
            // input so inserting it can never push the actual provider request back over budget.
            //
            // A turn's own rounds are where compaction actually bites: forty of them can roll the
            // evidence of the turn's first ten out of the window while the model is still working
            // from it. There is no summarizing model available mid-turn — that would be a second
            // inference inside the loop that produced the overflow — so the marker carries a list
            // of the calls themselves, read straight out of the messages leaving the window.
            const digest = compactionDigest([...before.filter(isCompactionNotice), ...dropped]);
            const finalFit = fitWithCompactionNotice(before, fit.budgetTokens, digest);
            next = [...finalFit.messages];
            finalMinimumRecentMet = finalFit.minimumRecentMet;
            dropped = omittedBy(before, next).filter((message) => !isCompactionNotice(message));
            newlyDropped = dropped.length;
            totalCompacted = previousGeneric + newlyDropped;
            const oldIds = new Set(before.map((message) => message.id));
            // The marker this fit inserted, in whichever form survived: the digest above is a
            // summarized marker, and the fallbacks below it are generic ones.
            const inserted = next.find(
              (message) => isCompactionNotice(message) && !oldIds.has(message.id)
            );
            noticePersisted = !!inserted;
            notice = inserted ?? compactionNotice(totalCompacted);
            if (inserted) totalCompacted = noticeCount(inserted);
          } else {
            // Legacy array fitters cannot report a numeric budget. Still feed the marker back
            // through that fitter until the fitted request and its represented count stabilize.
            notice = compactionNotice(totalCompacted);
            next = next.filter((message) => !isCompactionNotice(message));
            next.splice(openingCount(next), 0, ...uniqueSummaries, notice);
            let previousSignature = '';
            for (let pass = 0; pass <= before.length + 2; pass += 1) {
              const refittedValue = options.fit(next, tools ?? []);
              const refitted = Array.isArray(refittedValue) ? refittedValue : refittedValue.messages;
              dropped = omittedBy(before, refitted).filter((message) => !isCompactionNotice(message));
              newlyDropped = dropped.length;
              totalCompacted = previousGeneric + newlyDropped;
              const replacement = compactionNotice(totalCompacted);
              notice = { ...notice, content: replacement.content };
              noticePersisted = refitted.some((message) => message.id === notice.id);
              next = refitted.map((message) => (message.id === notice.id ? notice : message));
              if (!noticePersisted) break;
              const signature = `${totalCompacted}:${next.map((message) => message.id).join('\0')}:${notice.content}`;
              if (signature === previousSignature) break;
              previousSignature = signature;
            }
          }

          const estimatedTokens = conversationTokens(next);
          compaction = {
            round,
            compacted: newlyDropped,
            totalCompacted,
            dropped,
            notice,
            noticePersisted,
            tools: tools ?? [],
            estimatedTokens,
            budgetTokens: fit?.budgetTokens,
            overflowTokens:
              fit?.budgetTokens === undefined
                ? fit?.overflowTokens
                : Math.max(0, estimatedTokens - fit.budgetTokens),
            minimumRecentMet: finalMinimumRecentMet,
          };
        }

        messages.length = 0;
        messages.push(...next);
        checkpoint();
        if (compaction) options.onCompaction?.(compaction);
      }

      // Every round, after any compaction has settled, so the meter reflects the prompt this
      // round will actually send rather than the one the turn opened with. Reuses the numbers
      // already computed above; the only extra work is counting the settled transcript.
      if (options.onContext) {
        const settled = conversationTokens(messages);
        const priorCompacted = messages
          .filter((message) => isCompactionNotice(message))
          .reduce((total, message) => total + noticeCount(message), 0);
        options.onContext({
          round,
          estimatedTokens: settled,
          totalCompacted: priorCompacted,
          budgetTokens: fit?.budgetTokens,
          overflowTokens: fit?.budgetTokens === undefined
            ? fit?.overflowTokens
            : Math.max(0, settled - fit.budgetTokens),
          minimumRecentMet: fit?.minimumRecentMet,
          tools: tools ?? [],
        });
      }
    }

    const requiredEntry = options.requiredTool
      ? [...(toolset?.lookup.entries() ?? [])].find(([, target]) => target.toolName === options.requiredTool)
      : undefined;
    if (options.requiredTool && !requiredSatisfied && !requiredEntry) {
      throw new Error(withConnectionErrors(`The required tool ${options.requiredTool} is not connected and enabled.`));
    }
    if (options.requireToolCall && executedToolCalls === 0 && !toolset?.definitions.length) {
      throw new Error(withConnectionErrors('This run requires a tool call, but no eligible tools are connected and enabled.'));
    }

    let result: StreamResult;
    let roundContent = '';
    const streamSignal = options.steer ? anyOf(options.signal, options.steer.interrupt) : anyOf(options.signal);
    try {
      result = await options.provider.stream(
        // The cap goes down with the request so the provider can stop the stream at it, rather
        // than the loop trimming a batch the engine has already been paid to finish.
        { ...options.request, messages, accessMode: liveMode, tools, maxToolCalls: maxCallsPerMessage },
        (data) => {
          if (data.metrics) options.onMetrics?.({ round: round + 1, providerId: options.request.providerId, model: options.request.model, metrics: data.metrics });
          // Thinking arrives on its own frames and is not part of the answer being assembled.
          if (data.reasoning) options.onReasoning?.(data.reasoning);
          if (!data.content) return;
          let chunk = data.content;
          // Otherwise the two run together, with nothing to show where one ended.
          if (separate && chunk) {
            separate = false;
            if (content && !content.endsWith('\n\n')) chunk = `${content.endsWith('\n') ? '\n' : '\n\n'}${chunk}`;
          }
          content += chunk;
          roundContent += data.content;
          options.onContent(chunk);
        },
        (note) => options.onAlive?.(note),
        // Either signal ends this stream; only the outer one ends the turn.
        streamSignal.signal
      );
      if (result.metrics) options.onMetrics?.({ round: round + 1, providerId: options.request.providerId, model: options.request.model, metrics: result.metrics });
      servedModel ??= result.servedModel;
    } catch (error) {
      // Cut short to steer: keep what it managed to say, then go round again with the note.
      if (options.steer?.interrupt.aborted && !options.signal?.aborted) {
        if (roundContent.trim()) {
          messages.push({ id: `assistant_${round}`, role: 'assistant', content: roundContent });
          checkpoint();
        }
        absorbSteer();
        continue;
      }
      if (roundContent.trim()) {
        messages.push({ id: `assistant_${round}`, role: 'assistant', content: roundContent });
        checkpoint();
      }
      throw error;
    } finally {
      // A normal stream completion does not fire either signal. Remove both listeners now so a
      // long tool loop does not accumulate one pair per round on the same outer controller.
      streamSignal.dispose();
    }

    // A provider is allowed to settle its promise even after abort. Cancellation still belongs
    // to the outer run, so never accept that late completion as a normal answer.
    if (options.signal?.aborted) {
      if (roundContent.trim()) {
        messages.push({ id: `assistant_${round}`, role: 'assistant', content: roundContent });
        checkpoint();
      }
      throw new Error('the run was cancelled');
    }

    if (!result.toolCalls.length || !toolset) {
      // It was about to finish. If something is waiting, this is the moment it is ready for it —
      // a note from the person, or a report from work it started. Work still running is waited
      // for: a turn does not end with its agents still out.
      const background = options.background;
      const unfinished = !!background && (background.running() > 0 || background.ready() > 0);
      if (options.steer?.pending() || unfinished) {
        if (result.content.trim()) {
          messages.push({ id: `assistant_${round}`, role: 'assistant', content: result.content,
            ...(result.reasoningHistory ? { reasoningHistory: result.reasoningHistory } : {}) });
          checkpoint();
          separate = true;
        }
        if (background) await idle(() => background.ready() > 0 || background.running() === 0);
        continue;
      }
      const missingNamedTool = !!options.requiredTool && !requiredSatisfied;
      const missingAnyTool = !!options.requireToolCall && executedToolCalls === 0;
      if (missingNamedTool || missingAnyTool) {
        if (result.content.trim()) {
          messages.push({ id: `assistant_${round}`, role: 'assistant', content: result.content,
            ...(result.reasoningHistory ? { reasoningHistory: result.reasoningHistory } : {}) });
          checkpoint();
        }
        if (requiredRetries >= 1) {
          throw new Error(
            missingNamedTool
              ? `The model returned no required ${options.requiredTool} tool call after a corrective retry.`
              : 'The model returned no tool call after a corrective retry.'
          );
        }
        requiredRetries += 1;
        messages.push({
          id: `required_tool_${round}`,
          role: 'user',
          content:
            (missingNamedTool
              ? `You were explicitly asked to use the ${options.requiredTool} tool, but your response did not call it. ` +
                `Call ${requiredEntry![0]} now. `
              : 'This task requires inspecting or changing the workspace, but your response called no tool. Call an appropriate tool now. ') +
            'Do not narrate a call or claim it ran; make the actual tool call.',
        });
        checkpoint();
        continue;
      }

      // No tool calls means it has said its piece — unless it never reached the piece. A
      // reasoning model can spend its entire output budget thinking and be cut off before writing
      // anything, which arrives here as empty content with finish_reason 'length'. Reported as an
      // ordinary finish, that is a turn that simply stops: no answer, no error, nothing in the
      // transcript to explain it. Whatever else is true, an empty reply must say why it is empty.
      const truncated = !result.content.trim() && (result.finishReason === 'length' || !!result.reasoning?.trim());

      // Cut off mid-deliberation, with work behind it: ask for the step rather than ending the
      // turn on it. Only when the lid is what stopped it — an empty reply the server called
      // 'stop' is a model with nothing to say, and telling that one to try harder is a loop.
      if (
        truncated &&
        result.finishReason === 'length' &&
        executedToolCalls > 0 &&
        thinkingRetries < RAN_OUT_THINKING_RETRIES
      ) {
        thinkingRetries += 1;
        messages.push({ id: `ran_out_thinking_${round}`, role: 'user', content: RAN_OUT_THINKING });
        checkpoint();
        options.onAutoContinue?.({
          round,
          attempt: thinkingRetries,
          of: RAN_OUT_THINKING_RETRIES,
          reason: 'ran-out-thinking',
        });
        separate = true;
        continue;
      }

      // Or it stopped on the announcement of its next step, which is what a smaller model does
      // instead of finishing. Carry it on before the turn closes, up to the person's allowance.
      if (
        !truncated &&
        shouldAutoContinue(autoContinue, {
          reason: 'stopped-mid-work',
          used: autoContinued,
          executedToolCalls,
          content: result.content,
        })
      ) {
        if (result.content.trim()) {
          messages.push({ id: `assistant_${round}`, role: 'assistant', content: result.content,
            ...(result.reasoningHistory ? { reasoningHistory: result.reasoningHistory } : {}) });
        }
        autoContinued += 1;
        messages.push({
          id: `auto_continue_${round}`,
          role: 'user',
          content: AUTO_CONTINUE_NUDGE['stopped-mid-work'],
        });
        checkpoint();
        options.onAutoContinue?.({
          round,
          attempt: autoContinued,
          of: autoContinue.maxContinues,
          reason: 'stopped-mid-work',
        });
        separate = true;
        continue;
      }
      if (result.content.trim()) {
        messages.push({
          id: options.request.responseMessageId ?? options.runId,
          role: 'assistant',
          content: result.content,
          ...(result.reasoningHistory ? { reasoningHistory: result.reasoningHistory } : {}),
        });
        checkpoint();
      } else if (truncated) {
        // This one is durable: the model reads it back on a "continue", so it is an account of
        // what happened rather than advice, and it says the retries were spent so a continued
        // turn does not begin by deliberating its way into the same wall.
        const thinking = result.reasoning?.trim() ? ' Its output budget went to reasoning rather than an answer.' : '';
        const tried = thinkingRetries
          ? ` It was asked for the step instead, ${thinkingRetries} time${thinkingRetries === 1 ? '' : 's'}, and ran out again.`
          : '';
        messages.push({
          id: options.request.responseMessageId ?? options.runId,
          role: 'assistant',
          content:
            `(No answer: the model reached its output limit before writing one.${thinking}${tried} ` +
            `The work this turn did is still above. Carry on from it with a concrete step rather ` +
            `than reconsidering it from the start.)`,
        });
        checkpoint();
      }
      return {
        content,
        rounds: round + 1,
        toolCalls,
        stoppedAtLimit: false,
        reason: truncated ? 'truncated' : 'finished',
        transcript: messages,
        servedModel,
      };
    }

    // Hold one reply's batch to a size the window can carry. The provider ordinarily stops the
    // stream at the cap, so `requested` is already the allowed prefix; this trims anyway because
    // a server that answered in one frame had nothing to stop. Trimming before the assistant
    // message is recorded is what keeps the transcript valid: a call that never runs must not be
    // in it at all, or it is a tool_call with no result on every later request.
    // Before the cap, so a reply that repeated itself spends its allowance on distinct work, and
    // before the assistant message is recorded, for the same reason the trim below is.
    const { calls: requested, dropped: repeatedReads } = withoutRepeatedReads(result.toolCalls, toolset.lookup);
    const overflowed = Math.max(0, requested.length - maxCallsPerMessage);
    const batch = overflowed ? requested.slice(0, maxCallsPerMessage) : requested;
    /** The reply asked for more than it is allowed, whether the stream was cut or the loop trimmed. */
    const batchCut = overflowed > 0 || !!result.toolCallsCutOff;
    batchOverruns = batchCut ? batchOverruns + 1 : 0;
    const completionOnly = !batchCut && batch.length > 0 && claimsCompletion(result.content) &&
      batch.every(call => isCompletionOnlyCall(call, toolset.lookup.get(call.function.name)));
    const executedBeforeRound = executedToolCalls;
    const waitsBeforeRound = waits;
    const validations: CompletionValidation[] = [];

    // Only the reply's last call can have been interrupted, and only by the output limit — and
    // only when that call is still in the batch. A cut batch ends well before it.
    const cutOffAt = !batchCut && result.finishReason === 'length' ? batch.length - 1 : -1;

    // Execution still receives the raw stream (a cut-off write may be salvageable), but history
    // must always be valid JSON. Otherwise this one truncated call is re-sent and repaired by the
    // server on every later round, long after its tool result already explained the failure.
    messages.push({
      id: `assistant_${round}`,
      role: 'assistant',
      content: result.content,
      ...(result.reasoningHistory ? { reasoningHistory: result.reasoningHistory } : {}),
      toolCalls: batch.map((call, index) =>
        toolCallForHistory(call, index === cutOffAt ? 'output_limit' : 'invalid_json')
      ),
    });

    /** Signatures this reply has already counted toward the repeat run; see below. */
    const seenThisRound = new Set<string>();

    for (let callIndex = 0; callIndex < batch.length; callIndex += 1) {
      const call = batch[callIndex];
      const activityId = `${round}:${callIndex}:${call.id}`;
      if (options.signal?.aborted) {
        for (const pending of batch.slice(callIndex)) {
          messages.push({
            id: pending.id,
            role: 'tool',
            toolCallId: pending.id,
            name: pending.function.name,
            content: 'Cancelled before this tool call could run.',
          });
        }
        checkpoint();
        throw new Error('the run was cancelled');
      }

      // Pair the assistant batch immediately. Until validation and approval finish, every
      // remaining call is still accurately recoverable as not run.
      checkpointToolBatch(batch.slice(callIndex));

      const target = toolset.lookup.get(call.function.name);
      const waitsBefore = waits;
      let text: string;
      try {
        if (target) {
          const execution = await runOne(
            options,
            call.id,
            activityId,
            target,
            call.function.arguments,
            callIndex === cutOffAt,
            idle,
            continuations,
            () => checkpointToolBatch(batch.slice(callIndex), true)
          );
          text = execution.text;
          if (execution.executed) {
            executedToolCalls += 1;
            if (target.toolName === options.requiredTool) requiredSatisfied = true;
          }
        } else {
          text = `Antimatter has no tool named ${call.function.name}.`;
          options.onActivity({
            runId: options.runId,
            callId: call.id,
            activityId,
            serverId: 'unknown',
            serverName: 'Unknown server',
            toolName: call.function.name,
            tier: tierOf(call.function.name, 'unknown'),
            args: call.function.arguments.slice(0, 400),
            status: 'failed',
            result: text,
          });
        }
      } catch (error) {
        text = `Tool call failed: ${(error as Error).message}`;
        options.onActivity({
          runId: options.runId,
          callId: call.id,
          activityId,
          serverId: target?.serverId ?? 'unknown',
          serverName: target?.serverName ?? 'Unknown server',
          toolName: target?.toolName ?? call.function.name,
          tier: tierOf(target?.toolName ?? call.function.name, target?.serverId ?? 'unknown'),
          args: call.function.arguments.slice(0, 400),
          status: 'failed',
          result: text,
        });
        messages.push({ id: call.id, role: 'tool', toolCallId: call.id, name: call.function.name, content: text });
        for (const pending of batch.slice(callIndex + 1)) {
          messages.push({
            id: pending.id,
            role: 'tool',
            toolCallId: pending.id,
            name: pending.function.name,
            content: 'Skipped because an earlier tool call in this response failed.',
          });
        }
        checkpoint();
        throw error;
      }
      toolCalls += 1;
      validations.push(completionValidation(call, target, text));

      messages.push({ id: call.id, role: 'tool', toolCallId: call.id, name: call.function.name, content: text });
      checkpointToolBatch(batch.slice(callIndex + 1));

      // Same tool, same arguments, three times running: it is not going to get anywhere. Unless
      // the call waited on background work — asking again after a wait is how a model waits
      // longer, and the work it waits on moves on meanwhile.
      //
      // "Running" means across replies. A reply chooses its whole batch before it sees any of the
      // results, so the same call three times inside one of them is a single careless batch, not a
      // model going round in circles — and ending the turn on it throws away everything the turn
      // did. Carbon 95bf32a1 died that way on its first round, and what the person was told was
      // that something it needed was not where it was looking, which was not true of anything.
      if (waits !== waitsBefore) {
        recent.length = 0;
        seenThisRound.clear();
      } else {
        const signature = `${call.function.name}(${call.function.arguments})`;
        if (!seenThisRound.has(signature)) {
          seenThisRound.add(signature);
          recent.push(signature);
        }
      }
      if (recent.length > REPEAT_LIMIT) recent.shift();
      if (recent.length === REPEAT_LIMIT && recent.every((entry) => entry === recent[0])) stalled = true;
    }
    // Say what was left, in the same place a tool result would be said. Without this the model
    // sees results for the calls it made and no sign that the rest of its batch never existed,
    // so it carries on as though the whole thing had run. It cannot be told how many it asked
    // for: the stream was stopped at the cap, so the rest of that batch was never generated.
    if (batchCut) {
      const note =
        `That reply asked for more than ${maxCallsPerMessage} tool calls, so it was cut off after ` +
        `${batch.length} and the rest was never generated. A reply may ask for at most ` +
        `${maxCallsPerMessage} at once, because one assistant message and all of its results have to ` +
        'stay together in the context window. Only the calls above ran. Ask for what you still ' +
        'need in batches this size — and if you were about to read the same file at many offsets, ' +
        'read it once and stop.' +
        // Said only here, where the reply has already overreached and this is why: a batch that
        // fits has nothing to learn from it, and the transcript above already shows one of each.
        (repeatedReads
          ? ` ${repeatedReads} of them asked again for something this same reply had already read, ` +
            'and were dropped: every call in a reply is chosen before any of their results arrive, ' +
            'so asking twice cannot tell you more than asking once.'
          : '');
      messages.push({ id: `deferred_${round}`, role: 'user', content: note });
      options.onActivity({
        runId: options.runId,
        callId: `deferred_${round}`,
        activityId: `deferred_${round}`,
        serverId: 'antimatter',
        serverName: 'Antimatter tools',
        toolName: 'tool_batch_limit',
        tier: 'read',
        args: JSON.stringify({ limit: maxCallsPerMessage, ran: batch.length }, null, 2),
        status: 'done',
        result: note,
      });
      checkpoint();
      separate = true;
    }

    // callTool reports transport aborts as ordinary failed results so they can be shown in the
    // transcript. Reassert the run-level cancellation here, including on the final allowed round.
    if (options.signal?.aborted) throw new Error('the run was cancelled');

    const backgroundBusy = !!options.background && (options.background.running() > 0 || options.background.ready() > 0);
    completionOnlyRounds = completionOnly && executedToolCalls - executedBeforeRound === batch.length &&
      waits === waitsBeforeRound && !backgroundBusy ? completionOnlyRounds + 1 : 0;
    if (batchCut || executedToolCalls - executedBeforeRound !== batch.length || waits !== waitsBeforeRound ||
        backgroundBusy || options.steer?.pending() || validations.some(value => value === null)) resetValidationLoop();
    else {
      const measured = validations.filter((value): value is Exclude<CompletionValidation, 'inspection' | null> => value !== 'inspection' && value !== null);
      if (measured.length) {
        const changed = measured.some(value => validationResults.has(value.signature) && validationResults.get(value.signature) !== value.evidence);
        if (changed) resetValidationLoop();
        const repeated = measured.every(value => validationResults.get(value.signature) === value.evidence);
        repeatedValidationRounds = repeated && claimsCompletion(result.content) ? repeatedValidationRounds + 1 : 0;
        for (const value of measured) validationResults.set(value.signature, value.evidence);
      }
      // Inspections can separate redundant validation rounds without changing their evidence.
      // A new validation target or any changed result starts a fresh allowance; a batch counts once.
    }
    const completionLoop = completionOnlyRounds >= COMPLETION_ONLY_LIMIT;
    const validationLoop = repeatedValidationRounds >= REPEATED_VALIDATION_LIMIT;
    if ((completionLoop || validationLoop) && !options.steer?.pending()) {
      // Do not ask the same model for yet another summary, even for unattended runs. Keep the
      // reason in both the visible answer and recovery transcript, authored explicitly by the app.
      const explanation = completionLoop ? COMPLETION_ONLY_NOTICE : REPEATED_VALIDATION_NOTICE;
      messages.push({ id: `no_progress_${round}`, role: 'assistant', content: explanation });
      checkpoint();
      const notice = `${content.trim() ? '\n\n' : ''}${explanation}`;
      content += notice; options.onContent(notice);
      options.onActivity({ runId: options.runId, callId: `completion_loop_${round}`, activityId: `completion_loop_${round}`,
        serverId: BUILTIN_SERVER_ID, serverName: 'Antimatter', toolName: 'completion_loop_guard', tier: 'read',
        args: JSON.stringify(completionLoop ? { consecutiveRounds: completionOnlyRounds } : { repeatedValidationRounds }),
        status: 'failed', result: explanation });
      return { content, rounds: round + 1, toolCalls, stoppedAtLimit: false, reason: 'no-progress', transcript: messages, servedModel };
    }

    // Told apart from a repeated call because the way out is different: a repeating model is
    // looking in the wrong place, while a flooding one is asking for too much at once.
    const flooding = !stalled && batchOverruns >= BATCH_OVERRUN_LIMIT;
    if (stalled || flooding) {
      const reason = flooding ? 'flooding' : 'stalled';
      await reportOnStop(reason, round + 1);
      return { content, rounds: round + 1, toolCalls, stoppedAtLimit: false, reason, transcript: messages, servedModel };
    }

    // The ceiling is a guard against a runaway loop, not a judgement that the work is over. When
    // the person has said a turn may be carried on, reaching it buys another allowance of rounds
    // rather than ending the turn — with the model told plainly that it was extended, so it does
    // not read the nudge as a new instruction from the person.
    const lastRound = round === ceiling - 1;
    if (
      lastRound &&
      shouldAutoContinue(autoContinue, {
        reason: 'round-limit',
        used: autoContinued,
        executedToolCalls,
        content: result.content,
      })
    ) {
      autoContinued += 1;
      ceiling += maxRounds;
      messages.push({ id: `auto_continue_${round}`, role: 'user', content: AUTO_CONTINUE_NUDGE['round-limit'] });
      checkpoint();
      options.onAutoContinue?.({
        round,
        attempt: autoContinued,
        of: autoContinue.maxContinues,
        reason: 'round-limit',
      });
      separate = true;
    }
  }

  if (options.signal?.aborted) throw new Error('the run was cancelled');
  await reportOnStop('limit', ceiling);
  return { content, rounds: ceiling, toolCalls, stoppedAtLimit: true, reason: 'limit', transcript: messages, servedModel };
}

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  // Every turn goes through here — chat, agents and the orchestrator alike — which makes it the
  // one place that can say honestly which models are busy. The Library asks before freeing one.
  const release = modelUse.hold(options.request.providerId, options.request.model);
  try {
    // Tests inject a private runtime. Production turns own isolated per-workspace MCP sessions,
    // allowing concurrent agents without any run redirecting another run's stdio tool process.
    if (options.toolRuntime || !options.workspace || options.request.useTools === false) {
      return await runToolLoopUnlocked(options);
    }
    const runtime = await mcp.createWorkspaceRuntime(options.workspace, options.signal);
    try {
      return await runToolLoopUnlocked({ ...options, toolRuntime: runtime });
    } finally {
      await runtime.shutdown();
    }
  } finally {
    release();
  }
}
