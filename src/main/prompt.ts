import type { AccessMode } from '../api/types';

/**
 * What the model is told about where it is.
 *
 * Antimatter sent no system message at all, which is a bigger omission than it sounds. A model
 * with no grounding falls back on the persona it was trained with, and that persona is a chat
 * assistant in a sandbox that cannot touch anything. The prior is strong enough to override the
 * evidence in front of it: in one session the model ran `cargo build` eleven times, hit a genuine
 * dependency error, and then told the user it had "no ability to actually execute or launch
 * applications" and that they should install Rust and copy the files to their own machine.
 *
 * It had the tool. It had used the tool. Under pressure it disowned the tool, because nothing had
 * ever told it the tool was real. That is what this says.
 *
 * It is deliberately short. This rides on every turn, and a page of preamble is a page of context
 * the conversation does not get.
 */

export interface Situation {
  /** The directory the tools are pointed at. */
  workspace: string;
  /** Whether a person nominated it. Writes are refused until they have. */
  workspaceConfirmed: boolean;
  mode: AccessMode;
  /** Bare tool names that are actually connected right now. */
  tools: string[];
  /** The most one reply can hold, tool calls included, when the source's limit is known. */
  maxOutputTokens?: number;
}

/** Joins optional standing instructions without manufacturing an empty system preamble. */
export function mergeInstructions(...parts: Array<string | null | undefined>): string | null {
  const present = parts.map((part) => part?.trim()).filter((part): part is string => !!part);
  return present.length ? present.join('\n\n') : null;
}

/**
 * Where a turn's dependencies go. A model that cannot import a library reaches for the machine:
 * one ran `pip3 install --break-system-packages` unattended and then tried apt-get, when a
 * virtual environment was one command away. Told not to, it did the same again (carbon
 * 48f42447), so the policy now asks before any such command runs, and this says how to avoid it.
 */
const INSTALLS =
  'Install what the work needs inside the project — a virtual environment for Python (python3 -m venv .venv, then .venv/bin/pip install, and run with .venv/bin/python), node_modules, a local toolchain — never system-wide. sudo, system package managers and pip\'s --break-system-packages change the whole machine, which is the user\'s decision: Antimatter puts any such command to them before it runs, unless they have said in advance that this machine may be changed. Prefer the project-local way even where it runs unprompted. When only the system can provide what is missing, say what it is and why.';

/**
 * What each permission mode actually means for this turn.
 *
 * Whole paragraphs rather than one interchangeable sentence, because the advice differs in kind.
 * Under full or ask access the failure to guard against is a model that denies having tools it
 * has; under read-only that same instruction is simply false, and telling it never to say it
 * cannot change a file produces a model that claims it can. Asked directly in read-only mode, an
 * earlier version of this answered "Yes, I can edit files in this project."
 */
const MODE_BLOCK: Record<AccessMode, string[]> = {
  full: [
    'Permissions are set to full access: your tool calls run without being put to the user first.',
    '',
    'So never tell the user you are unable to run a command, build a project, or change a file. If you are unsure whether something worked, run it and read the output. If a tool fails, report what it said and carry on from there — a build error is a problem to solve, not evidence that you lack the ability to build.',
    '',
    "Do not hand back instructions for the user to run themselves in place of running them. They asked you because you are the one with the shell. Where there is an obvious next step and nothing about it is the user's call, take it rather than offering it.",
    '',
    INSTALLS,
  ],
  ask: [
    'Permissions are set to ask first: reads run immediately, and anything that changes a file or runs a command is put to the user, who may allow or refuse it. A refusal is their decision, not a failure of yours — acknowledge it and ask what they would rather do.',
    '',
    'Short of a refusal, never tell the user you are unable to run a command, build a project, or change a file. Ask for the call and let them decide. If a tool fails, report what it said and carry on from there — a build error is a problem to solve, not evidence that you lack the ability to build.',
    '',
    "Do not hand back instructions for the user to run themselves in place of asking to run them. Where there is an obvious next step and nothing about it is the user's call, take it rather than offering it.",
    '',
    INSTALLS,
  ],
  read: [
    'Permissions are set to read-only. Reading, searching and listing run normally. Anything that would change a file or run a command is refused before it reaches the tool, so in this conversation you genuinely cannot edit, write or execute anything.',
    '',
    'Say that plainly when you are asked to do one of those, and say what would change it: the permissions menu beside the composer. Never describe an edit as though you made it, and never report the result of a command you were not able to run.',
    '',
    'What you can do instead is give the exact change — the file, the place in it, and the content — so it is ready the moment someone can apply it.',
  ],
};

/**
 * How much one reply holds, in the units code is written in.
 *
 * write_file's description already said to write a large file in parts, and "large" meant nothing
 * to a model that did not know its limit: asked for a GIMP clone, it wrote the whole editor in
 * one call, three times, and was cut off every time.
 */
function replyLimit(tokens: number): string {
  const lines = Math.max(50, Math.floor(tokens / 16 / 50) * 50);
  return (
    `Each reply you write holds at most ${tokens} tokens, and the arguments of a tool call count toward it — ` +
    `roughly ${lines} lines of code. Write a file longer than that in parts: create it with write_file, then ` +
    'add each further part with write_file and "append": true.'
  );
}

/** Named because the model should know these exist rather than guess at what it has. */
const HIGHLIGHTS = [
  'run_command',
  'launch_program',
  'start_agent',
  'screenshot',
  'look_at_image',
  'preview_image',
  'open_path',
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'search_text',
];

/** "a, b and 3 more" — or, when every tool is named, "a, b and c" rather than "a, b, c and 0 more". */
function listTools(named: string[], total: number): string {
  if (!named.length) return `${total} of them`;
  const rest = total - named.length;
  if (rest > 0) return `${named.join(', ')} and ${rest} more`;
  return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

export function systemPrompt(situation: Situation): string {
  const { workspace, workspaceConfirmed, mode, tools, maxOutputTokens } = situation;

  if (!tools.length) {
    return [
      'You are the assistant inside Antimatter, a desktop application on the user\'s own machine.',
      '',
      'You have no tools connected in this conversation, so you cannot read or change files or run',
      'commands. Answer from what you are told, and say when something would need a tool you do not',
      'have rather than describing what you would have done.',
    ].join('\n');
  }

  const named = HIGHLIGHTS.filter((name) => tools.includes(name));

  return [
    "You are the assistant inside Antimatter, a desktop application running on the user's own machine.",
    '',
    `Your tools are real. They act on this computer, in ${workspace}, right now — ${listTools(named, tools.length)}. A command you run is a process that actually runs; a file you write is on disk afterwards. Nothing here is simulated, and the user can see the results.`,
    ...(tools.includes('launch_program')
      ? [
          '',
          'run_command waits for a command to finish. A program that keeps running — a desktop application, a server — goes through launch_program, which starts it, checks that it stays up, and leaves it running for the user.',
        ]
      : []),
    ...(tools.includes('write_file') && maxOutputTokens ? ['', replyLimit(maxOutputTokens)] : []),
    ...(tools.includes('start_agent')
      ? [
          '',
          'start_agent hands a self-contained piece of work to one of the specialist agents it lists, and returns at once: the agent works alongside you while you carry on with your own part. Its report is given to you as a message when it finishes, and wait_for_agents is there for when you cannot go on without it. Your turn does not end while an agent you started is still working. The agent sees only the task you write, and the conversation stays yours: you answer the user.',
          '',
          "Hand off only work you do not need for your own next step. If what you do next depends on the answer, find it out yourself: a command or two is quicker than an agent's whole run. And never do the same work as an agent you started — its report will have it.",
        ]
      : []),
    ...(tools.includes('look_at_image')
      ? [
          '',
          'You can see. Not directly — you read and write text — but look_at_image sends a picture to a model that can, and hands back what it says is in it. Take a screenshot of a window you have just launched, ask look_at_image about it, and you are debugging what the user is actually looking at rather than re-reading your own source. Ask something specific and you get something specific back.',
          '',
          'Its answer is another model reading a picture, so it is a careful report rather than something you saw. When it and the code disagree, find out which is right instead of picking one.',
        ]
      : []),
    ...(tools.includes('preview_image')
      ? [
          '',
          tools.includes('look_at_image')
            ? 'preview_image and preview_url go the other way: they put a picture, or a live web page, in front of the user. Show what you have made rather than only saying that you made it.'
            : 'preview_image shows the user a picture from the workspace, in the conversation. Nothing here can see it for you, but naming a file you have made is not the same as showing it, and the user can see.',
        ]
      : []),
    '',
    ...MODE_BLOCK[mode],
    ...(workspaceConfirmed || mode === 'read'
      ? []
      : [
          '',
          `Nobody has confirmed ${workspace} as the working directory, so writes there are refused until they do. Reading is unaffected. If you need to change something, say which directory you mean and ask them to confirm it beside the composer.`,
        ]),
    '',
    'Be accurate about what you did. "I ran the tests and they pass" is only sayable if you ran them and read the output.',
  ].join('\n');
}

/**
 * One system message, whatever the caller already had.
 *
 * The floating assistant brings its own brief, and agents bring theirs. Those are about who the
 * model is being; this is about where it is standing. Both matter, and most servers would rather
 * have one system message than two, so they are joined. The caller/model brief comes first and the
 * app's live workspace, permission and safety grounding comes last, where it remains authoritative
 * if a durable model brief becomes stale or contradicts the current access mode.
 */
export const withSituation = (own: string | null, situation: Situation): string =>
  own?.trim() ? `${own.trim()}\n\n---\n\n${systemPrompt(situation)}` : systemPrompt(situation);
