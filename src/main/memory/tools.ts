import type { McpTool, ToolCallResult } from '../mcp';
import type { ToolRuntime } from '../toolLoop';
import type { MemoryAccess } from './context';
import * as person from './person';
import * as store from './store';
import type { MemoryNote, MemoryScope } from './store';

/**
 * The model's hands on its own memory: remember, recall, forget, and about_user.
 *
 * Served by the app rather than an MCP server because the notes are the app's state, kept outside
 * the workspace — the file tools are confined to the workspace and could not reach them, and
 * should not be able to. Only the conversation's own model is given them. An agent is a worker
 * with a brief; what is worth remembering is for the conversation it reports to to decide.
 *
 * The prompt lists every note by its summary line (context.ts), so there is no tool for listing
 * or searching: recall is for the detail behind a line the model has already seen.
 *
 * about_user is the odd one out, and deliberately narrow: a name and pronouns, which a person
 * says once and expects to be known from then on. Everything else about them is a note, and the
 * paragraph they wrote about themselves on the Settings page is theirs alone (see person.ts).
 */

export const SERVER_ID = 'antimatter.memory';
export const SERVER_NAME = 'Memory';
export const REMEMBER = 'remember';
export const RECALL = 'recall';
export const FORGET = 'forget';
export const ABOUT_USER = 'about_user';
export const MEMORY_TOOLS = [REMEMBER, RECALL, FORGET, ABOUT_USER];

export interface MemoryToolContext {
  workspace: string;
  /** `read` offers recall alone; `write` offers all four. `list` offers none, and is not wrapped. */
  access: Exclude<MemoryAccess, 'list'>;
  /** Live permission state, checked when offering tools and again immediately before a call. */
  currentAccess?: () => Exclude<MemoryAccess, 'list'>;
  /** Tells whatever is showing the notes that they changed. */
  changed?: () => void;
}

const SCOPE = {
  type: 'string',
  enum: ['project', 'user'],
} as const;

export function definitions(access: MemoryToolContext['access']): McpTool[] {
  const recall: McpTool = {
    name: RECALL,
    description:
      'Read one of your notes in full. The notes are listed in your instructions by name and summary; this gives the ' +
      'rest. There is nothing to search beyond that list, so if a name is not there, the note does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The note, by the name it is listed under.' },
        scope: { ...SCOPE, description: 'Which list it is in. Leave out to look in this project first, then the user\'s.' },
      },
      required: ['name'],
    },
    enabled: true,
  };
  if (access === 'read') return [recall];
  return [
    {
      name: REMEMBER,
      description:
        'Save a note that later conversations will be given: something about the user, or about this project, that is ' +
        'worth knowing next time. One subject per note, kept short. A note with the same name as an existing one ' +
        'replaces it, which is how a note is corrected or brought up to date.',
      inputSchema: {
        type: 'object',
        // Name and scope first: a model writes arguments in the order they are listed, and a reply cut off
        // at its output limit then loses the end of the content rather than which note it was.
        properties: {
          name: { type: 'string', description: 'A title of a few words. Reusing a name replaces that note.' },
          scope: {
            ...SCOPE,
            description:
              '"project" for something about this project (the default). "user" for something about the user that holds in ' +
              'every project: who they are, how they like to work, a correction to how you work.',
          },
          description: {
            type: 'string',
            description:
              'One line saying what the note says, specific enough to act on alone: it is what later conversations see ' +
              'before they read the rest.',
          },
          content: {
            type: 'string',
            description: 'The note itself. For a correction or a preference: the rule, then why, then how to apply it.',
          },
        },
        required: ['name', 'content'],
      },
      enabled: true,
    },
    recall,
    {
      name: ABOUT_USER,
      description:
        'Record who the user is: their name, and their pronouns if they give them. Only for what they have actually ' +
        'told you about themselves — never a guess, and never from a git log or a file. Everything else you learn ' +
        'about them is a note: use remember for that. What they have written about themselves is theirs to edit, and ' +
        'this does not touch it.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'What to call them, as they said it.' },
          pronouns: { type: 'string', description: 'For example "she/her" or "they/them". Leave out unless they said.' },
        },
        required: [],
      },
      enabled: true,
    },
    {
      name: FORGET,
      description: 'Delete one of your notes: one that is wrong or no longer true, or one the user asks you to forget.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The note, by the name it is listed under.' },
          scope: { ...SCOPE, description: 'Which list it is in. Leave out to look in this project first, then the user\'s.' },
        },
        required: ['name'],
      },
      enabled: true,
    },
  ];
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const scopeOf = (value: unknown): MemoryScope | null => (value === 'user' || value === 'project' ? value : null);

const where = (scope: MemoryScope): string => (scope === 'user' ? "the user's notes" : "this project's notes");

const missing = (name: string): ToolCallResult => ({
  ok: false,
  attempted: true,
  text:
    `There is no note called "${name}". The notes that exist are the ones listed in your instructions, and any you ` +
    'saved in this conversation; there is nowhere else to look, so do not ask for this one again.',
});

export function withMemory(runtime: ToolRuntime, context: MemoryToolContext): ToolRuntime {
  const projectRoot = store.projectRoot(context.workspace);
  // Callers without a resolver keep their original snapshot semantics. Interactive turns can
  // change access without rebuilding this wrapper or retaining an obsolete write capability.
  const initialAccess = context.access;
  const offered = () => definitions(context.currentAccess?.() ?? initialAccess);

  /** A named note in the scope given, or in this project and then the user's when none is. */
  const locate = (name: string, scope: MemoryScope | null): MemoryNote | null => {
    for (const candidate of scope ? [scope] : (['project', 'user'] as const)) {
      const found = store.findNote(store.notesFor(candidate, projectRoot), name);
      if (found) return found;
    }
    return null;
  };

  const remember = (args: Record<string, unknown>): ToolCallResult => {
    const scope = scopeOf(args.scope) ?? 'project';
    const { note, created } = store.rememberNote(scope, projectRoot, {
      name: text(args.name),
      description: text(args.description),
      content: typeof args.content === 'string' ? args.content : '',
    });
    context.changed?.();
    return {
      ok: true,
      attempted: true,
      text:
        `${created ? 'Saved' : 'Replaced'} "${note.name}" in ${where(scope)}. Later conversations${
          scope === 'project' ? ' in this project' : ''
        } will see it as: ${note.description}`,
    };
  };

  const recall = (args: Record<string, unknown>): ToolCallResult => {
    const name = text(args.name);
    const note = locate(name, scopeOf(args.scope));
    if (!note) return missing(name);
    const saved = new Date(note.updatedAt).toISOString().slice(0, 10);
    return {
      ok: true,
      attempted: true,
      text: `${note.name} (${where(note.scope)}, saved ${saved})\n${note.description}\n\n${note.content}`,
    };
  };

  const aboutUser = (args: Record<string, unknown>): ToolCallResult => {
    const patch: { name?: string; pronouns?: string } = {};
    if (args.name !== undefined) patch.name = text(args.name);
    if (args.pronouns !== undefined) patch.pronouns = text(args.pronouns);
    if (patch.name === undefined && patch.pronouns === undefined) {
      return {
        ok: false,
        attempted: false,
        text: 'about_user records a name, pronouns, or both. Call it with what the user actually told you.',
      };
    }
    const who = person.save(patch);
    context.changed?.();
    return {
      ok: true,
      attempted: true,
      text: who.name
        ? `Noted: the user is called ${who.name}${who.pronouns ? ` (${who.pronouns})` : ''}. Later conversations start knowing it.`
        : `Noted: the user's pronouns are ${who.pronouns}. Later conversations start knowing it.`,
    };
  };

  const forget = (args: Record<string, unknown>): ToolCallResult => {
    const name = text(args.name);
    const note = locate(name, scopeOf(args.scope));
    if (!note || !store.removeNote(note.scope, projectRoot, note.id)) return missing(name);
    context.changed?.();
    return { ok: true, attempted: true, text: `Forgot "${note.name}" from ${where(note.scope)}.` };
  };

  return {
    enabledTools: () => [
      ...runtime.enabledTools(),
      ...offered().map((tool) => ({ serverId: SERVER_ID, serverName: SERVER_NAME, tool })),
    ],
    prepareTool: async (serverId, toolName, args, options) =>
      serverId !== SERVER_ID && runtime.prepareTool ? runtime.prepareTool(serverId, toolName, args, options) : { args },
    callTool: async (serverId, toolName, args, options) => {
      if (serverId !== SERVER_ID) return runtime.callTool(serverId, toolName, args, options);
      // Recheck at execution: a tool offered before a downgrade no longer has write access.
      if (!offered().some((tool) => tool.name === toolName)) {
        return { ok: false, attempted: false, text: `${toolName} is not available in this conversation.` };
      }
      try {
        if (toolName === REMEMBER) return remember(args);
        if (toolName === RECALL) return recall(args);
        if (toolName === ABOUT_USER) return aboutUser(args);
        return forget(args);
      } catch (error) {
        // A note that is too long, empty, or holds a key: the model can fix each, so none ends the turn.
        return { ok: false, attempted: true, text: (error as Error).message };
      }
    },
    connectionErrors: () => runtime.connectionErrors?.() ?? [],
  };
}
