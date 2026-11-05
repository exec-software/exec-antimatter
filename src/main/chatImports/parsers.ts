import { createHash } from 'node:crypto';
import type { ConversationMessage, ConversationToolActivity } from '../conversations';

export interface ParsedImportConversation {
  source: 'claude' | 'codex' | 'opencode';
  format: 'claude-export' | 'claude-code' | 'codex-rollout' | 'opencode-export';
  externalId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
}

// These are parsing limits, not retention rules: refuse excess input instead of losing history.
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_CONVERSATIONS = 1000;
const MAX_MESSAGES = 20_000;
const MAX_TOOLS = 2000;
const MAX_CONTENT = 16 * 1024 * 1024;
type Row = Record<string, unknown>;
type Entry = { row: Row; index: number; resultsOnly?: boolean };
const record = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const historical = 'Imported historical tool record; not executed or independently verified by Antimatter.';
const sourceNames = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' } as const;

class Context {
  readonly warnings = new Set<string>();
  messages = 0;
  warn(message: string): void { this.warnings.add(message); }
  message(): void { if (++this.messages > MAX_MESSAGES) throw new Error(`Import exceeds the ${MAX_MESSAGES.toLocaleString('en-US')}-message limit. Split the export and try again.`); }
}

function text(value: string, label = 'Message'): string {
  if (value.length > MAX_CONTENT) throw new Error(`${label} exceeds the 16 MiB content limit.`);
  return value;
}

function id(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new Error('An imported record identifier is invalid or exceeds 256 characters.');
  return value;
}

function time(value: unknown, fallback: number, context: Context): number {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number' ? value < 100_000_000_000 ? value * 1000 : value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 8.64e15) return parsed;
  context.warn('Some invalid timestamps were replaced with the conversation timestamp.');
  return fallback;
}

function json(value: unknown): string {
  try { return text(JSON.stringify(value ?? {}) ?? '{}', 'Tool arguments'); }
  catch { throw new Error('Tool arguments could not be represented safely or exceed the content limit.'); }
}

function fingerprint(value: unknown): string {
  try { return digest(JSON.stringify(value)); }
  catch { throw new Error('An imported record is nested too deeply to compare safely.'); }
}

function label(value: unknown, fallback: string): string {
  const result = typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
  if (result.length > 240) throw new Error('An imported tool name exceeds 240 characters.');
  return result || fallback;
}

/** Only a textual description survives. Paths, data URLs, blob contents and asset IDs never do. */
function attachment(kind: string, context: Context): string {
  context.warn('Images, audio, documents, and other attachments are placeholders only; no files or URLs were opened.');
  return `[Imported ${kind} omitted — attachment data is not loaded.]`;
}

function contentText(value: unknown, context: Context, depth = 0): string {
  if (depth > 16) throw new Error('Imported content nesting exceeds the supported depth.');
  if (typeof value === 'string') return text(value);
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    if (value.length > MAX_RECORDS) throw new Error('Imported content has too many blocks.');
    return text(value.map((part) => contentText(part, context, depth + 1)).filter(Boolean).join('\n'));
  }
  const block = record(value);
  if (!block) {
    context.warn('Unsupported content blocks were preserved as inert placeholders.');
    return '[Unsupported imported content block omitted.]';
  }
  if (['text', 'input_text', 'output_text'].includes(String(block.type))) {
    if (typeof block.text !== 'string') throw new Error('An imported text block is missing its text.');
    return text(block.text);
  }
  if (['image', 'input_image', 'image_url'].includes(String(block.type))) return attachment('image', context);
  if (['audio', 'input_audio', 'output_audio'].includes(String(block.type))) return attachment('audio', context);
  if (['document', 'file', 'attachment', 'input_file'].includes(String(block.type))) return attachment('document', context);
  if (['thinking', 'redacted_thinking', 'reasoning', 'encrypted_content'].includes(String(block.type))) {
    context.warn('Hidden reasoning and encrypted content were not imported.');
    return '';
  }
  context.warn('Unsupported content blocks were preserved as inert placeholders.');
  return '[Unsupported imported content block omitted.]';
}

function knownResult(value: unknown, depth = 0): boolean {
  if (depth > 16) throw new Error('Imported content nesting exceeds the supported depth.');
  if (typeof value === 'string') return true;
  if (Array.isArray(value)) return value.every((part) => knownResult(part, depth + 1));
  const block = record(value);
  return !!block && ['text', 'input_text', 'output_text'].includes(String(block.type)) && typeof block.text === 'string';
}

type Result = { content: string; failed: boolean };

class Transcript {
  readonly messages: ConversationMessage[] = [];
  private readonly calls = new Map<string, ConversationToolActivity>();
  private readonly results = new Map<string, Result>();
  private sequence = 0;
  constructor(readonly key: string, readonly source: ParsedImportConversation['source'], readonly context: Context, readonly createdAt: number) {}

  begin(role: 'user' | 'assistant', at: number, forceNew = false): ConversationMessage {
    const previous = this.messages.at(-1);
    if (role === 'assistant' && previous?.role === 'assistant' && !forceNew) return previous;
    this.context.message();
    const message: ConversationMessage = {
      id: `import-${digest(this.key)}-${++this.sequence}`, role, content: '',
      meta: { createdAt: at, sourceName: `Imported ${sourceNames[this.source]} history` },
    };
    this.messages.push(message);
    return message;
  }

  append(message: ConversationMessage, value: string, separate = false): void {
    if (!value) return;
    message.content = text(message.content + (separate && message.content ? '\n\n' : '') + value);
  }

  call(message: ConversationMessage, value: { callId?: unknown; name?: unknown; args?: unknown; rawArguments?: boolean }): void {
    const callId = id(value.callId, `import-call-${digest(this.key)}-${this.calls.size + 1}`);
    if (this.calls.has(callId)) throw new Error('Duplicate tool call identifiers make this transcript ambiguous. Export a single conversation branch.');
    const tools = message.meta.tools ??= [];
    if (tools.length >= MAX_TOOLS) throw new Error(`A message exceeds the ${MAX_TOOLS}-tool import limit.`);
    const tool: ConversationToolActivity = {
      callId, requestId: `import-request-${digest(this.key)}`, serverName: `${sourceNames[this.source]} history`,
      toolName: label(value.name, 'unknown imported tool'), tier: 'read', contentOffset: message.content.length,
      args: value.rawArguments && typeof value.args === 'string' ? text(value.args, 'Tool arguments') : json(value.args),
      status: 'failed', result: '[Historical note: no matching tool result was present in this export.]', caution: historical,
    };
    // Never copy activityId, approvalId, serverId, awaitingApproval, previews or subagent links.
    tools.push(tool);
    this.calls.set(callId, tool);
  }

  result(callIdValue: unknown, content: unknown, failed = false): void {
    const callId = id(callIdValue, '');
    if (!callId) throw new Error('An imported tool result is missing its call identifier.');
    const known = knownResult(content);
    const next = { content: contentText(content, this.context), failed: failed || !known };
    if (!known) {
      this.context.warn('Some tool results were missing or used unsupported content; they were marked failed historical records.');
      next.content = `[Historical note: complete tool result text was not available.]${next.content ? '\n' + next.content : ''}`;
    }
    const previous = this.results.get(callId);
    if (previous) {
      if (previous.content === next.content && previous.failed === next.failed) return;
      this.context.warn('A tool had multiple result records; their historical output was combined in file order.');
      next.content = text(previous.content + '\n\n' + next.content, 'Tool result');
      next.failed ||= previous.failed;
    }
    this.results.set(callId, next);
  }

  finish(): ConversationMessage[] {
    for (const [callId, tool] of this.calls) {
      const result = this.results.get(callId);
      if (!result) {
        this.context.warn('Some tool calls had no matching result and were marked failed historical records.');
        continue;
      }
      tool.result = result.content || '[Historical tool returned empty output.]';
      tool.status = result.failed ? 'failed' : 'done';
      this.results.delete(callId);
    }
    for (const [callId, result] of this.results) {
      this.context.warn('Some tool results had no matching call; they were retained as failed historical records.');
      const message = this.begin('assistant', this.createdAt);
      this.call(message, { callId, name: 'unmatched imported tool result' });
      const tool = this.calls.get(callId)!;
      tool.result = `[Historical note: the original tool call is missing.]\n${result.content}`;
      tool.status = 'failed';
    }
    return this.messages.filter((message) => message.content.length > 0 || !!message.meta.tools?.length);
  }
}

function title(value: unknown, messages: ConversationMessage[], source: string, context: Context): string {
  const supplied = typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f]+/g, ' ') : '';
  const firstUser = messages.find((message) => message.role === 'user')?.content.trim().split('\n')[0];
  const result = supplied || firstUser || `Imported ${source} conversation`;
  if (result.length > 240) context.warn('Long conversation titles were shortened to 240 characters; message content was retained.');
  return result.slice(0, 240);
}

function finish(transcript: Transcript, format: ParsedImportConversation['format'], externalId: string, name: unknown, updatedAt?: number): ParsedImportConversation | null {
  const messages = transcript.finish();
  if (!messages.length) { transcript.context.warn('Conversations without supported user or assistant history were skipped.'); return null; }
  return { source: transcript.source, format, externalId, title: title(name, messages, transcript.source, transcript.context),
    createdAt: transcript.createdAt, updatedAt: Math.max(transcript.createdAt, updatedAt ?? 0, ...messages.map((message) => message.meta.createdAt)), messages };
}

function claudeContent(transcript: Transcript, role: 'user' | 'assistant', value: unknown, at: number, options: { forceNew?: boolean; fallbackText?: unknown; attachments?: unknown } = {}): void {
  const context = transcript.context;
  const blocks = Array.isArray(value) ? value : typeof value === 'string' ? [{ type: 'text', text: value }] : value === undefined || value === null ? [] : [value];
  if (blocks.length > MAX_RECORDS) throw new Error('Imported content has too many blocks.');
  // Export `text` mirrors its text blocks. Use it only when structured content has no text.
  const fallback = string(options.fallbackText);
  const hasText = blocks.some((block) => record(block)?.type === 'text');
  let message: ConversationMessage | undefined;
  let separate = true;
  const current = () => message ??= transcript.begin(role, at, options.forceNew);
  if (!hasText && fallback) { transcript.append(current(), fallback, true); separate = false; }
  for (const raw of blocks) {
    const block = record(raw);
    if (block?.type === 'tool_use') {
      if (role !== 'assistant') { context.warn('Tool calls embedded in user content were retained as inert text, not actions.'); transcript.append(current(), '[Imported tool-call data in user content omitted.]', separate); separate = false; continue; }
      transcript.call(current(), { callId: block.id, name: block.name, args: block.input });
    } else if (block?.type === 'tool_result') {
      transcript.result(block.tool_use_id, block.content, block.is_error === true);
    } else {
      const content = contentText(raw, context);
      if (content) { transcript.append(current(), content, separate); separate = false; }
    }
  }
  if (Array.isArray(options.attachments) && options.attachments.length) {
    for (const _ of options.attachments) transcript.append(current(), attachment('attachment', context), true);
  }
}

function claudeExport(values: unknown[], context: Context, fileKey: string): ParsedImportConversation[] {
  if (values.length > MAX_CONVERSATIONS) throw new Error(`Import exceeds the ${MAX_CONVERSATIONS}-conversation limit.`);
  const conversations: ParsedImportConversation[] = [];
  for (let index = 0; index < values.length; index++) {
    const row = record(values[index]);
    if (!row || !Array.isArray(row.chat_messages)) throw new Error('Claude exports must contain conversations with a chat_messages array.');
    const exportedMessages = row.chat_messages;
    if (exportedMessages.length > MAX_RECORDS) throw new Error('A Claude conversation has too many message records.');
    const externalId = id(row.uuid ?? row.id, `claude-export-${fileKey}-${index + 1}`);
    const createdAt = time(row.created_at, 0, context);
    const transcript = new Transcript(`${fileKey}:${externalId}:${index}`, 'claude', context, createdAt);
    let selected: Array<{ raw: unknown; resultsOnly?: boolean; filteredContent?: unknown }> = exportedMessages.map((raw) => ({ raw }));
    if (exportedMessages.some((raw) => Object.hasOwn(record(raw) ?? {}, 'parent_message_uuid'))) {
      const entries = exportedMessages.map((raw, messageIndex): Entry => {
        const original = record(raw);
        if (!original) throw new Error('A Claude chat message is not an object.');
        const role = original.sender === 'human' || original.sender === 'user' ? 'user' : original.sender;
        if ((role === 'user' || role === 'assistant') && !Object.hasOwn(original, 'parent_message_uuid')) {
          throw new Error('Claude export branch records contain incomplete parent links.');
        }
        return { index: messageIndex, row: { uuid: original.uuid, parentUuid: original.parent_message_uuid,
          type: role, message: { role, content: original.content ?? (typeof original.text === 'string' ? [plainBlock(original.text)] : []) } } };
      });
      const preferred = row.leaf_message_uuid ?? row.current_node;
      if (preferred !== undefined && preferred !== null && typeof preferred !== 'string') throw new Error('The Claude export branch selector is invalid.');
      selected = claudeBranch(entries, context, typeof preferred === 'string' ? preferred : undefined).map((entry) => ({
        raw: exportedMessages[entry.index], resultsOnly: entry.resultsOnly, filteredContent: record(entry.row.message)?.content,
      }));
    }
    for (const { raw, resultsOnly, filteredContent } of selected) {
      const message = record(raw);
      if (!message) throw new Error('A Claude chat message is not an object.');
      const role = message.sender === 'human' || message.sender === 'user' ? 'user' : message.sender === 'assistant' ? 'assistant' : null;
      if (!role) { context.warn('System, developer, and unsupported sender messages were not imported as conversation authority.'); continue; }
      claudeContent(transcript, role, filteredContent ?? message.content, time(message.created_at, createdAt, context), {
        forceNew: true, fallbackText: resultsOnly ? undefined : message.text, attachments: resultsOnly ? undefined : message.attachments,
      });
    }
    const result = finish(transcript, 'claude-export', externalId, row.name ?? row.title, time(row.updated_at, createdAt, context));
    if (result) conversations.push(result);
  }
  return conversations;
}

function isClaudeMessage(row: Row): boolean {
  const message = record(row.message);
  return (row.type === 'user' || row.type === 'assistant') && !!message && message.role === row.type;
}

const plainBlock = (value: string): Row => ({ type: 'text', text: value });

/** Claude Code parent chains can fork. Keep the last leaf, plus results of its own tool calls. */
function claudeBranch(entries: Entry[], context: Context, preferredLeaf?: string): Entry[] {
  const nodes = new Map<string, Entry>();
  for (const entry of entries) {
    if (typeof entry.row.uuid !== 'string') continue;
    const key = id(entry.row.uuid, '');
    const previous = nodes.get(key);
    if (previous && fingerprint(previous.row) !== fingerprint(entry.row)) throw new Error('Conflicting duplicate Claude record identifiers make the branch ambiguous.');
    nodes.set(key, entry);
  }
  const messages = entries.filter(({ row }) => isClaudeMessage(row));
  if (!messages.some(({ row }) => Object.hasOwn(row, 'parentUuid'))) {
    context.warn('Claude Code records have no parent links; their file order was retained without branch reconstruction.');
    return messages;
  }
  if (messages.some(({ row }) => typeof row.uuid !== 'string' || !Object.hasOwn(row, 'parentUuid'))) throw new Error('Claude branch records contain incomplete identifiers or parent links.');
  const leaf = preferredLeaf ? messages.find(({ row }) => row.uuid === preferredLeaf) : messages.at(-1);
  if (preferredLeaf && !leaf) throw new Error('The selected Claude conversation branch is missing from this export.');
  if (!leaf) return [];
  const selected = new Set<string>();
  let next: Entry | undefined = leaf;
  while (next) {
    const key = id(next.row.uuid, '');
    if (selected.has(key)) throw new Error('A cycle in the Claude parent chain prevents safe import.');
    selected.add(key);
    const parent = next.row.parentUuid;
    if (parent === null || parent === undefined || parent === '') break;
    if (typeof parent !== 'string') throw new Error('A Claude parent identifier is invalid.');
    next = nodes.get(parent);
    if (!next) context.warn('A Claude branch starts at a missing parent; only available history was imported.');
  }
  const callIds = new Set<string>();
  for (const { row } of messages) if (selected.has(String(row.uuid))) {
    const blocks = record(row.message)?.content;
    if (Array.isArray(blocks)) for (const block of blocks) {
      const value = record(block);
      if (value?.type === 'tool_use' && typeof value.id === 'string') callIds.add(value.id);
    }
  }
  const result: Entry[] = [];
  const seen = new Set<string>();
  for (const entry of messages) {
    const uuid = String(entry.row.uuid);
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    if (selected.has(uuid)) { result.push(entry); continue; }
    const message = record(entry.row.message)!;
    const results = Array.isArray(message.content) ? message.content.filter((raw) => {
      const block = record(raw);
      return block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && callIds.has(block.tool_use_id);
    }) : [];
    if (results.length) result.push({ ...entry, resultsOnly: true, row: { ...entry.row, message: { ...message, content: results } } });
    if (results.length !== (Array.isArray(message.content) ? message.content.length : 0) || !results.length) {
      context.warn('Claude conversation contained divergent branches; only the selected/latest parent-linked branch and its tool results were imported.');
    }
  }
  return result;
}

function claudeCode(entries: Entry[], context: Context, fileKey: string): ParsedImportConversation[] {
  const groups = new Map<string, Entry[]>();
  let session = `claude-code-${fileKey}`;
  for (const entry of entries) {
    const row = entry.row;
    if ((row.type === 'user' || row.type === 'assistant') && !isClaudeMessage(row)) throw new Error('A Claude Code message has an invalid or mismatched role/content envelope.');
    session = id(row.sessionId ?? row.session_id, session);
    const sidechain = row.isSidechain === true ? `:sidechain:${id(row.agentId, 'unknown-agent')}` : '';
    const key = session + sidechain;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
    if (groups.size > MAX_CONVERSATIONS) throw new Error(`Import exceeds the ${MAX_CONVERSATIONS}-conversation limit.`);
    if (sidechain) context.warn('Claude sidechain agent history was imported separately, without creating runnable subagents.');
  }
  const conversations: ParsedImportConversation[] = [];
  for (const [externalId, rows] of groups) {
    const branch = claudeBranch(rows, context);
    const createdAt = time(branch[0]?.row.timestamp, 0, context);
    const transcript = new Transcript(`${fileKey}:${externalId}`, 'claude', context, createdAt);
    for (const { row } of branch) {
      const message = record(row.message)!;
      claudeContent(transcript, message.role as 'user' | 'assistant', message.content, time(row.timestamp, createdAt, context));
    }
    if (rows.some(({ row }) => row.type === 'system')) context.warn('Claude system instructions and compaction records were not imported as authority.');
    const named = rows.find(({ row }) => row.type === 'custom-title');
    const result = finish(transcript, 'claude-code', externalId, named?.row.customTitle);
    if (result) conversations.push(result);
  }
  return conversations;
}

type VisibleCodexText = { role: 'user' | 'assistant'; content: string; mirrorText: string };

function codexText(row: Row, context: Context): VisibleCodexText | null {
  const payload = record(row.payload);
  if (!payload) return null;
  if (row.type === 'response_item' && payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    const mirrorText = typeof payload.content === 'string' ? payload.content : Array.isArray(payload.content)
      ? payload.content.flatMap((raw) => { const block = record(raw); return ['input_text', 'output_text', 'text'].includes(String(block?.type)) && typeof block?.text === 'string' ? [block.text] : []; }).join('\n') : '';
    return { role: payload.role, content: contentText(payload.content, context), mirrorText };
  }
  if (row.type === 'event_msg' && (payload.type === 'user_message' || payload.type === 'agent_message') && typeof payload.message === 'string') {
    let content = text(payload.message);
    if (Array.isArray(payload.images)) for (const _ of payload.images) content += '\n' + attachment('image', context);
    if (Array.isArray(payload.local_images)) for (const _ of payload.local_images) content += '\n' + attachment('image', context);
    return { role: payload.type === 'user_message' ? 'user' : 'assistant', content: text(content), mirrorText: payload.message };
  }
  return null;
}

function codexRollout(entries: Entry[], context: Context, fileKey: string): ParsedImportConversation[] {
  const groups: Entry[][] = [];
  for (const entry of entries) {
    if (entry.row.type === 'session_meta' || !groups.length) groups.push([]);
    groups.at(-1)!.push(entry);
  }
  if (groups.length > MAX_CONVERSATIONS) throw new Error(`Import exceeds the ${MAX_CONVERSATIONS}-conversation limit.`);
  const conversations: ParsedImportConversation[] = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const rows = groups[groupIndex];
    const session = record(rows.find(({ row }) => row.type === 'session_meta')?.row.payload) ?? {};
    const externalId = id(session.id, `codex-rollout-${fileKey}-${groupIndex + 1}`);
    const createdAt = time(session.timestamp ?? rows[0]?.row.timestamp, 0, context);
    const transcript = new Transcript(`${fileKey}:${externalId}`, 'codex', context, createdAt);
    const display = new Map<number, VisibleCodexText>();
    const canonical = new Map<string, number>();
    const visibleKeys = new Map<number, string>();
    const segments = { user: 0, assistant: 0 };
    for (const { row, index } of rows) {
      const payload = record(row.payload);
      if ((row.type === 'response_item' && /call|output/.test(String(payload?.type))) ||
          (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_started', 'turn_complete', 'turn_aborted'].includes(String(payload?.type)))) {
        segments.user++; segments.assistant++;
      }
      const visible = codexText(row, context);
      if (!visible) continue;
      display.set(index, visible);
      // A user turn, tool operation or explicit turn boundary separates repeated utterances.
      // Mirrored records of the same role share a segment; events in older turns cannot steal
      // a later canonical record just because both happened to say "OK" or "continue".
      const key = `${visible.role}:${segments[visible.role]}:${visible.mirrorText}`;
      visibleKeys.set(index, key);
      segments[visible.role === 'user' ? 'assistant' : 'user']++;
      if (row.type === 'response_item') {
        canonical.set(key, (canonical.get(key) ?? 0) + 1);
      }
    }
    const mirrored = new Set<number>();
    for (const { row, index } of rows) {
      if (row.type !== 'event_msg') continue;
      const visible = display.get(index);
      if (!visible) continue;
      const key = visibleKeys.get(index)!;
      const count = canonical.get(key) ?? 0;
      if (!count) continue;
      canonical.set(key, count - 1); mirrored.add(index);
    }
    const responseIds = new Map<string, string>();
    for (const { row, index } of rows) {
      const payload = record(row.payload);
      if (!payload) { if (row.type !== 'session_meta') context.warn('Unsupported Codex metadata records were skipped.'); continue; }
      if (row.type === 'event_msg' && payload.type === 'thread_rolled_back') throw new Error('This Codex rollout contains rollback edits. Export a single resolved branch before importing it.');
      if (row.type === 'response_item' && typeof payload.id === 'string') {
        const key = id(payload.id, '');
        const contents = fingerprint(payload);
        if (responseIds.has(key)) {
          if (responseIds.get(key) !== contents) throw new Error('Conflicting Codex response identifiers make this transcript ambiguous.');
          continue;
        }
        responseIds.set(key, contents);
      }
      const visible = display.get(index);
      if (visible) {
        if (!mirrored.has(index) && visible.content) {
          transcript.append(transcript.begin(visible.role, time(row.timestamp, createdAt, context)), visible.content, true);
          if (row.type === 'event_msg') context.warn('Some Codex text was recovered from event records because no matching canonical response item was present.');
        }
        continue;
      }
      if (row.type !== 'response_item') {
        if (row.type === 'compacted') context.warn('Codex compaction metadata was omitted; only recorded user/assistant history was imported.');
        continue;
      }
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'local_shell_call' || payload.type === 'tool_search_call') {
        transcript.call(transcript.begin('assistant', time(row.timestamp, createdAt, context)), {
          callId: payload.call_id ?? payload.id, name: payload.name ?? (payload.type === 'local_shell_call' ? 'local_shell' : 'tool_search'),
          args: payload.type === 'custom_tool_call' ? payload.input : payload.type === 'local_shell_call' ? payload.action : payload.arguments,
          rawArguments: payload.type === 'custom_tool_call' || payload.type === 'function_call',
        });
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output' || payload.type === 'tool_search_output') {
        transcript.result(payload.call_id, payload.type === 'tool_search_output' ? json(payload.tools) : payload.output,
          payload.status === 'failed' || payload.is_error === true);
      } else if (payload.type === 'web_search_call' || payload.type === 'image_generation_call') {
        const message = transcript.begin('assistant', time(row.timestamp, createdAt, context));
        transcript.call(message, { callId: payload.id, name: payload.type, args: payload.action ?? {} });
        if (payload.type === 'image_generation_call') transcript.append(message, attachment('generated image', context), true);
        context.warn('Provider-managed search/image tool output was not fully available; its historical call was marked failed.');
      } else if (payload.type === 'message') {
        context.warn('System, developer, and unsupported sender messages were not imported as conversation authority.');
      } else if (payload.type === 'agent_message') {
        context.warn('Codex inter-agent messages were omitted rather than merged into the user conversation.');
      } else if (['reasoning', 'compaction', 'context_compaction', 'compaction_trigger'].includes(String(payload.type))) {
        context.warn('Hidden reasoning, encrypted content, and compaction instructions were not imported.');
      } else context.warn('Unsupported Codex response items were skipped.');
    }
    const result = finish(transcript, 'codex-rollout', externalId, session.title);
    if (result) conversations.push(result);
  }
  return conversations;
}

function requiredOpenCodeId(value: unknown): string {
  const result = id(value, '');
  if (!result || !result.trim()) throw new Error('An OpenCode record is missing a required identifier. Select a complete session JSON export.');
  return result;
}

function openCodeTime(value: unknown): number {
  // OpenCode writes Date.now() milliseconds, unlike some Claude/Codex timestamps.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 8.64e15) {
    throw new Error('An OpenCode record has a missing or invalid millisecond timestamp.');
  }
  return value;
}

/**
 * Official v1 export: cli/cmd/export.ts -> { info, messages: MessageV2.WithParts[] }.
 * Structural schemas: anomalyco/opencode packages/schema/src/v1/session.ts.
 * This intentionally accepts exported snapshots, not event streams or raw database rows.
 */
function openCodeExport(root: Row, context: Context, fileKey: string): ParsedImportConversation[] {
  const info = record(root.info);
  const sessionTime = record(info?.time);
  if (!info || !sessionTime || typeof info.title !== 'string' || !Array.isArray(root.messages)) {
    throw new Error('OpenCode imports require a complete session JSON export with info and messages.');
  }
  const sessionID = requiredOpenCodeId(info.id);
  const createdAt = openCodeTime(sessionTime.created);
  let updatedAt = openCodeTime(sessionTime.updated);
  if (info.revert !== undefined && info.revert !== null) {
    throw new Error('This OpenCode session has an unresolved revert. Resolve the undo state in OpenCode and export again so undone turns are not imported.');
  }
  if (root.messages.length > MAX_MESSAGES) throw new Error(`Import exceeds the ${MAX_MESSAGES.toLocaleString('en-US')}-message limit. Split the export and try again.`);
  if (info.parentID !== undefined) context.warn('This OpenCode child session was imported independently; parent sessions and live agent links were not restored.');
  const transcript = new Transcript(`${fileKey}:opencode:${sessionID}`, 'opencode', context, createdAt);
  const messages = new Set<string>();
  const userMessages = new Set<string>();
  const parts = new Set<string>();
  for (const raw of root.messages) {
    const envelope = record(raw);
    const messageInfo = record(envelope?.info);
    if (!messageInfo || !Array.isArray(envelope?.parts)) throw new Error('An OpenCode message is missing its info or parts array.');
    const messageID = requiredOpenCodeId(messageInfo.id);
    if (requiredOpenCodeId(messageInfo.sessionID) !== sessionID) throw new Error('OpenCode message ownership does not match its exported session.');
    if (messages.has(messageID)) throw new Error('Duplicate OpenCode message identifiers make this export ambiguous.');
    messages.add(messageID);
    const at = openCodeTime(record(messageInfo.time)?.created);
    updatedAt = Math.max(updatedAt, at);
    if (messageInfo.role !== 'user' && messageInfo.role !== 'assistant') throw new Error('An OpenCode export contains an unsupported message role.');
    if (messageInfo.role === 'user') userMessages.add(messageID);
    else if (!userMessages.has(requiredOpenCodeId(messageInfo.parentID))) {
      throw new Error('An OpenCode assistant message has a missing, out-of-order, or ambiguous parent. Select a complete single-session export.');
    }
    if (messageInfo.system !== undefined || messageInfo.tools !== undefined || messageInfo.format !== undefined) {
      context.warn('OpenCode system prompts, tool configuration, and output instructions were not imported as conversation authority.');
    }
    if (messageInfo.summary !== undefined && messageInfo.role === 'assistant' && typeof messageInfo.summary !== 'boolean') {
      throw new Error('An OpenCode assistant summary flag is invalid.');
    }
    if (messageInfo.summary === true) context.warn('OpenCode compaction summaries and instructions were omitted; available original history was retained.');
    let message: ConversationMessage | undefined;
    const current = () => message ??= transcript.begin(messageInfo.role as 'user' | 'assistant', at, true);
    for (const rawPart of envelope.parts) {
      const part = record(rawPart);
      if (!part || typeof part.type !== 'string' || !part.type) throw new Error('An OpenCode part is missing its type or structural data.');
      const partID = requiredOpenCodeId(part.id);
      if (requiredOpenCodeId(part.sessionID) !== sessionID || requiredOpenCodeId(part.messageID) !== messageID) {
        throw new Error('OpenCode part ownership does not match its exported message.');
      }
      if (parts.has(partID)) throw new Error('Duplicate OpenCode part identifiers make this export ambiguous.');
      parts.add(partID);
      if (parts.size > MAX_RECORDS) throw new Error(`Import exceeds the ${MAX_RECORDS.toLocaleString('en-US')}-record limit.`);
      if (messageInfo.summary === true) continue;
      if (part.type === 'text') {
        if (typeof part.text !== 'string' || (part.synthetic !== undefined && typeof part.synthetic !== 'boolean') || (part.ignored !== undefined && typeof part.ignored !== 'boolean')) {
          throw new Error('An OpenCode text part is missing text or has invalid flags.');
        }
        if (part.synthetic === true || part.ignored === true) {
          context.warn('OpenCode synthetic context and ignored text were omitted rather than presented as user-authored conversation.');
          continue;
        }
        transcript.append(current(), part.text, true);
      } else if (part.type === 'tool') {
        if (messageInfo.role !== 'assistant') throw new Error('An OpenCode tool part is not owned by an assistant message.');
        const callID = requiredOpenCodeId(part.callID);
        const state = record(part.state);
        if (typeof part.tool !== 'string' || !part.tool.trim() || !state || !record(state.input) || !['pending', 'running', 'completed', 'error'].includes(String(state.status))) {
          throw new Error('An OpenCode tool part has incomplete or unsupported state.');
        }
        transcript.call(current(), { callId: callID, name: part.tool, args: state.input });
        if (state.status === 'completed') {
          if (typeof state.output !== 'string') throw new Error('A completed OpenCode tool is missing its output text.');
          const compacted = record(state.time)?.compacted;
          if (compacted !== undefined) openCodeTime(compacted);
          if (state.attachments !== undefined && !Array.isArray(state.attachments)) throw new Error('OpenCode tool attachments must be an array.');
          let output = text(state.output, 'Tool result');
          if (compacted !== undefined) {
            output = '[Historical note: OpenCode compacted this tool result; complete original output is unavailable.]';
            context.warn('Compacted OpenCode tool results were marked failed historical records; cleared output was not reconstructed.');
          }
          for (const media of (state.attachments as unknown[] | undefined) ?? []) {
            const item = record(media);
            if (!item || item.type !== 'file' || typeof item.mime !== 'string' || typeof item.url !== 'string') throw new Error('An OpenCode tool attachment has incomplete structural data.');
            output = text(`${output}\n${attachment('tool attachment', context)}`, 'Tool result');
          }
          transcript.result(callID, output, compacted !== undefined);
        } else if (state.status === 'error') {
          if (typeof state.error !== 'string') throw new Error('A failed OpenCode tool is missing its error text.');
          const metadata = record(state.metadata);
          const partial = metadata?.interrupted === true && typeof metadata.output === 'string' ? metadata.output : undefined;
          const output = partial === undefined ? state.error : `${state.error}\n[Historical partial output before interruption]\n${partial}`;
          transcript.result(callID, text(output, 'Tool result'), true);
        } else {
          context.warn('Pending or running OpenCode tools were marked failed historical records and will not resume.');
          transcript.result(callID, '[Historical note: tool execution was unfinished when exported; it was not resumed or executed by Antimatter.]', true);
        }
      } else if (part.type === 'file') {
        if (typeof part.mime !== 'string' || typeof part.url !== 'string') throw new Error('An OpenCode file part has incomplete structural data.');
        const kind = part.mime.startsWith('image/') ? 'image' : part.mime.startsWith('audio/') ? 'audio' : 'file';
        transcript.append(current(), attachment(kind, context), true);
      } else if (part.type === 'reasoning') {
        context.warn('Hidden reasoning and encrypted content were not imported.');
      } else if (['compaction', 'subtask', 'agent', 'system', 'developer', 'config'].includes(part.type)) {
        context.warn('OpenCode compaction, agent, and configuration instructions were omitted; no live agents or authority were restored.');
      } else if (['step-start', 'step-finish', 'snapshot', 'patch', 'retry'].includes(part.type)) {
        context.warn('OpenCode step bookkeeping, snapshots, patches, and retry metadata were omitted; no workspace changes were restored.');
      } else {
        context.warn('Unsupported OpenCode parts were preserved as inert placeholders.');
        transcript.append(current(), '[Unsupported imported OpenCode part omitted.]', true);
      }
    }
    if (messageInfo.role === 'assistant' && messageInfo.error !== undefined) {
      context.warn('Some OpenCode assistant messages ended with an error; available historical content was retained.');
      transcript.append(current(), '[Historical note: this OpenCode response ended with an error.]', true);
      current().meta.failed = true;
    }
  }
  const result = finish(transcript, 'opencode-export', sessionID, info.title, updatedAt);
  return result ? [result] : [];
}

/** Pure conversion only. No filesystem access, network requests, tool execution or provider calls. */
export function parseChatImport(input: string, fileName: string): { conversations: ParsedImportConversation[]; warnings: string[] } {
  if (Buffer.byteLength(input, 'utf8') > MAX_BYTES) throw new Error('The import exceeds the 32 MiB file limit.');
  const source = input.replace(/^\uFEFF/, '').trim();
  if (!source) throw new Error('The selected import is empty.');
  const context = new Context();
  const fileKey = digest(source);
  let whole: unknown;
  try { whole = JSON.parse(source); } catch { /* JSONL is parsed with precise line numbers below. */ }
  const object = record(whole);
  let conversations: ParsedImportConversation[];
  if (Array.isArray(whole)) conversations = claudeExport(whole, context, fileKey);
  else if (object && Array.isArray(object.conversations)) conversations = claudeExport(object.conversations, context, fileKey);
  else if (object && Array.isArray(object.chat_messages)) conversations = claudeExport([object], context, fileKey);
  else if (object && (Object.hasOwn(object, 'info') || Object.hasOwn(object, 'messages'))) conversations = openCodeExport(object, context, fileKey);
  else {
    const entries: Entry[] = [];
    const lines = whole === undefined ? source.split(/\r?\n/) : [source];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(lines[index]); } catch { throw new Error(`Invalid JSON at line ${index + 1}; no messages were imported.`); }
      const row = record(parsed);
      if (!row) throw new Error(`Import line ${index + 1} must contain a JSON object.`);
      entries.push({ row, index });
      if (entries.length > MAX_RECORDS) throw new Error(`Import exceeds the ${MAX_RECORDS.toLocaleString('en-US')}-record limit.`);
    }
    const codex = entries.some(({ row }) => ['session_meta', 'response_item', 'event_msg'].includes(String(row.type)));
    const claude = entries.some(({ row }) => isClaudeMessage(row));
    if (codex && claude) throw new Error('Mixed Claude and Codex records cannot be imported as one transcript.');
    if (codex) conversations = codexRollout(entries, context, fileKey);
    else if (claude) conversations = claudeCode(entries, context, fileKey);
    else if (/(?:^|[\\/])history\.jsonl$/i.test(fileName) || entries.some(({ row }) => Object.hasOwn(row, 'session_id') && Object.hasOwn(row, 'text'))) {
      throw new Error('history.jsonl contains prompt history, not a complete Codex conversation. Select a rollout JSONL file instead.');
    } else throw new Error('This file is not a supported Claude export, Claude Code transcript, Codex rollout, or OpenCode session export.');
  }
  if (!conversations.length) throw new Error('The import contains no supported user or assistant conversation history.');
  return { conversations, warnings: [...context.warnings] };
}
