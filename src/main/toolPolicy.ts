import type { AccessMode, ToolDefinition, ToolTier } from '../api/types';
import type { McpTool } from './mcp';
import { OWNED_WINDOW_ARG } from './preview/targets';
import { isLoopbackVisionEndpoint, publicVisionEndpoint } from './preview/vision';

/**
 * Tools that only observe: they read files, search, or report. Safe to run in any mode.
 * Anything not listed here is treated as changing something, which is the safer default
 * for a server we have not classified yet.
 */
const READ_TOOLS = new Set([
  // Antimatter's own server (mcp/tools/*).
  'workspace_info',
  'read_file',
  'list_directory',
  'find_files',
  'search_text',
  'file_info',
  'git_status',
  'git_log',
  'git_diff',
  'scan_secrets',
  'scan_code',
  'list_patterns',
  'fetch_text',
  // Goetic reads. They reach a loopback work tracker with a scoped agent credential and change
  // nothing there; what the credential may read is Goetic's own per-board decision, which no
  // Antimatter permission mode can widen.
  'goetic_status',
  'goetic_universes',
  'goetic_board',
  'goetic_cards',
  'goetic_card',
  'goetic_card_history',
  // Served by the app itself. Starting an agent, or waiting for one, changes nothing by itself:
  // every call the agent makes is gated by the conversation's own permissions, which it never
  // exceeds.
  'start_agent',
  'wait_for_agents',
  'send_agent_message',
  'stop_agent',
  // Showing the user a file they already have and opening a page in a panel change nothing.
  // Image analysis is also a read; the non-loopback egress case is separately gated below.
  'preview_image',
  'preview_url',
  'look_at_image',
  // Reading the page Antimatter is already showing, and photographing that pane. Both are
  // confined to a view the application owns: no other window, no other display, nothing the
  // person did not already put on their own screen inside this one. Unlike `screenshot`,
  // there is nothing here for a capture permission to protect.
  'preview_read',
  'preview_capture',
  // Reading the Vault's catalogue. It returns tags, labels and account names — never a secret —
  // so it is a read in the strict sense: there is nothing here for a permission to protect.
  'vault_list',
  // Reading one of the model's own notes.
  'recall',
  'pensieve_recall',
  'pensieve_library_recall',
  'connection_accounts',
  'connection_folders',
  'connection_messages',
  'connection_message',
  'pensieve_check_project',
  'read_skill',
  'read_pull_request',
  // Asking the person a question. It reads nothing and writes nothing; its whole effect is that
  // someone is shown a card and clicks an answer. Gating it behind an approval would be asking
  // permission to ask, which is one prompt to answer two questions.
  'ask_user',
  'list_connected_chats',
  'read_chat',
  'list_bot_chat_channels',
  'list_bot_chat_participants',
  'read_bot_chat',

  // Beholder servers, when they are enabled.
  'audio_list_voices',
  'coding_workspace_info',
  'coding_git_log',
  'coding_git_diff',
  'coding_search_codebase',
  'coding_find_files',
  'coding_read_file',
  'discord_list_projects',
  'image_list_models',
  'memory_list',
  'memory_read',
  'memory_search',
  'notebook_list_sections',
  'notebook_list',
  'notebook_read',
  'notebook_search',
  'notebook_get_today',
  'rag_search',
  'rag_list_namespaces',
  'rag_stats',
  'recon_file_info',
  'recon_strings',
  'recon_hexdump',
  'recon_disasm',
  'recon_check_tools',
  'security_scan_file',
  'security_scan_directory',
  'security_scan_inline',
  'security_get_scan',
  'security_list_scans',
  'security_list_patterns',
  'web_fetch',
  'web_fetch_text',
  'web_search',
]);

/** Runs arbitrary commands, or reaches out to somewhere we don't control. */
const DANGER_TOOLS = new Set([
  // Antimatter's own server.
  'run_command',
  'launch_program',
  'open_path',
  'http_request',

  // Beholder servers.
  'coding_run_command',
  'recon_run_command',
  'recon_http_request',
  'discord_post',
  'discord_post_release',
  'discord_post_status',
]);

/** Mutations that are understood well enough to expose to an unattended coding run. */
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'coding_write_file',
  'coding_edit_file',
  'coding_apply_patch',
  // Saves a PNG into the workspace, but first reads pixels from outside it. `machineWide` puts
  // every capture to the person even when the model supplies a window title.
  'screenshot',
  // Goetic writes. Listed here deliberately: an unattended run whose whole job is to carry work
  // through a tracker cannot do it if filing and moving a card need a person at a dialog. They
  // are safe to expose because the damage they can do is bounded and recoverable — a card is
  // never destroyed (archiving preserves its history and can be undone), a stale write is
  // refused rather than applied, and what the credential may touch at all is Goetic's own
  // per-board decision, which no Antimatter permission mode widens.
  'goetic_create_card',
  'goetic_update_card',
  'goetic_move_card',
  'goetic_archive_card',
  'goetic_restore_card',
]);

/**
 * Posting publishes to a channel other people read, which is not undoable by editing a file.
 * These ask every time, including under Full access.
 *
 * `vault_use` is here for a different reason: it spends one of the user's own credentials. No
 * permission level stands in for that decision, because the question is not "may this turn change
 * things" but "may this turn act as you" — and the answer depends entirely on what it is about to
 * do, which only the prompt in front of the person can say.
 */
const ALWAYS_CONFIRM = new Set(['discord_post', 'discord_post_release', 'discord_post_status', 'vault_use', 'connection_send']);

export const BUILTIN_SERVER_ID = 'antimatter';

const OWN_TOOLS = new Set([
  'workspace_info',
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'find_files',
  'search_text',
  'file_info',
  'git_status',
  'git_log',
  'git_diff',
  'scan_secrets',
  'scan_code',
  'list_patterns',
  'fetch_text',
  'run_command',
  'launch_program',
  'open_path',
  'http_request',
  'recovery_status',
  'recovery_use',
  'goetic_status',
  'goetic_universes',
  'goetic_board',
  'goetic_cards',
  'goetic_card',
  'goetic_card_history',
  'goetic_create_card',
  'goetic_update_card',
  'goetic_move_card',
  'goetic_archive_card',
  'goetic_restore_card',
]);
const PREVIEW_TOOLS = new Set(['preview_image', 'preview_url', 'look_at_image', 'screenshot', 'preview_read', 'preview_capture']);
const AGENT_TOOLS = new Set(['start_agent', 'wait_for_agents', 'send_agent_message', 'stop_agent']);
const MEMORY_TOOLS = new Set(['remember', 'recall', 'forget', 'about_user']);
/**
 * The Vault. Served by the app's own main process, which is where the keyring and the unsealed
 * value live; no configured server can borrow these names, because a credential handed to an
 * unknown implementation is a credential given away.
 */
const VAULT_TOOLS = new Set(['vault_list', 'vault_use']);
const CONVERSATION_TOOLS = new Set(['list_connected_chats', 'read_chat', 'send_chat_message']);
const BOT_CHAT_TOOLS = new Set(['list_bot_chat_channels', 'list_bot_chat_participants', 'read_bot_chat', 'post_bot_chat_message']);
// These operations read source and write only the review's local annotations. They cannot edit
// project files, grant access, or make the human's final review decision.
const CODE_REVIEW_TOOLS = new Set(['list_code_reviews', 'read_code_review', 'create_code_review',
  'add_review_finding', 'reply_to_review', 'update_review_finding']);
/**
 * Changing the notes later conversations are given. That is not the project, so it does not wait
 * for a nominated workspace, but it is a change all the same: read-only permissions refuse it and
 * "Ask first" puts it to the person, which is also what stands between a page that talks a model
 * into saving an instruction and every conversation after it.
 */
const MEMORY_WRITE_TOOLS = new Set(['remember', 'forget', 'about_user']);
const BEHOLDER_PREFIXES = new Set(['audio', 'coding', 'discord', 'image', 'memory', 'notebook', 'rag', 'recon', 'security', 'web']);
const OTHER_BEHOLDER_TOOLS = new Set([
  'audio_tts',
  'audio_play',
  'coding_create_commit',
  'coding_create_directory',
  'coding_delete',
  'coding_find_symbol',
  'coding_get_outline',
  'coding_run_tests',
  'image_edit',
  'image_from_pixels',
  'image_from_svg',
  'image_generate',
  'image_upscale',
  'image_variations',
  'memory_append',
  'memory_write',
  'notebook_append',
  'notebook_daily_log',
  'notebook_write',
  'rag_delete',
  'rag_index_dir',
  'rag_index_file',
  'rag_index_text',
  'security_add_pattern',
  'security_mark_false_positive',
]);

/** The one app-owned/configured server identity allowed to confer meaning on each known name. */
const expectedServer = (toolName: string): string | null => {
  if (OWN_TOOLS.has(toolName)) return BUILTIN_SERVER_ID;
  if (PREVIEW_TOOLS.has(toolName)) return 'antimatter.preview';
  if (AGENT_TOOLS.has(toolName)) return 'antimatter.agents';
  if (MEMORY_TOOLS.has(toolName)) return 'antimatter.memory';
  if (VAULT_TOOLS.has(toolName)) return 'antimatter.vault';
  if (toolName === 'ask_user') return 'antimatter.ask';
  if (toolName === 'pensieve_recall' || toolName === 'pensieve_check_project') return 'antimatter.pensieve';
  if (toolName === 'pensieve_library_recall') return 'antimatter.pensieve-library';
  if (['connection_accounts', 'connection_folders', 'connection_messages', 'connection_message', 'connection_send'].includes(toolName)) return 'antimatter.connections';
  if (CONVERSATION_TOOLS.has(toolName)) return 'antimatter.conversations';
  if (BOT_CHAT_TOOLS.has(toolName)) return 'antimatter.bot-chat';
  if (CODE_REVIEW_TOOLS.has(toolName)) return 'antimatter.code-review';
  if (toolName === 'read_skill') return 'antimatter.skills';
  if (toolName === 'read_pull_request') return 'antimatter.pull-requests';
  const prefix = toolName.split('_', 1)[0];
  if (
    BEHOLDER_PREFIXES.has(prefix) &&
    (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName) || DANGER_TOOLS.has(toolName) || OTHER_BEHOLDER_TOOLS.has(toolName))
  ) {
    return `beholder.${prefix}`;
  }
  return null;
};

/** A familiar bare name is trusted only on the server that actually owns that capability. */
export const isTrustedTool = (toolName: string, serverId: string): boolean => expectedServer(toolName) === serverId;

const policyServer = (toolName: string, serverId?: string): string =>
  serverId ?? expectedServer(toolName) ?? BUILTIN_SERVER_ID;

export const tierOf = (toolName: string, serverId?: string): ToolTier => {
  if (!isTrustedTool(toolName, policyServer(toolName, serverId))) return 'danger';
  if (READ_TOOLS.has(toolName) || CODE_REVIEW_TOOLS.has(toolName)) return 'read';
  if (toolName === 'send_chat_message' || toolName === 'post_bot_chat_message') return 'write';
  return WRITE_TOOLS.has(toolName) || MEMORY_WRITE_TOOLS.has(toolName) ? 'write' : 'danger';
};

/**
 * Unattended runs get an explicit allowlist. A newly installed MCP tool must not become
 * auto-approved merely because nobody has classified its destructive or outward-facing side
 * effects yet.
 */
export const allowedUnattended = (toolName: string, serverId?: string): boolean => {
  // A credential is spent with someone's consent or not at all. An unattended run has nobody to
  // give it, so the Vault is not merely unapproved there — it is absent, catalogue included.
  if (VAULT_TOOLS.has(toolName)) return false;
  if (toolName.startsWith('connection_')) return false;
  // A question needs someone to answer it. An unattended run has nobody, so the tool is absent
  // there rather than merely unapproved — see `withAsk`, which does not offer it either. Both
  // checks exist because either alone would be a single point of failure for a wedged run.
  if (toolName === 'ask_user') return false;
  // A persistent chat connection belongs to its two interactive conversations. It never
  // grants scheduled work, orchestration, or a delegated worker access to either history.
  if (CONVERSATION_TOOLS.has(toolName) || BOT_CHAT_TOOLS.has(toolName)) return false;
  if (!isTrustedTool(toolName, policyServer(toolName, serverId))) return false;
  return (
    READ_TOOLS.has(toolName) ||
    CODE_REVIEW_TOOLS.has(toolName) ||
    WRITE_TOOLS.has(toolName) ||
    ['run_command', 'launch_program', 'coding_run_command'].includes(toolName)
  );
};

export type Decision = 'allow' | 'ask' | 'deny';

interface VisionDestination {
  provider: string;
  model: string;
  baseUrl: string;
}

const shortText = (value: unknown, limit = 240): string =>
  typeof value === 'string' ? value.trim().slice(0, limit) : '';

const visionDestination = (args?: Record<string, unknown>): VisionDestination | null => {
  const value = args?.vision_destination;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const provider = shortText(entry.provider);
  const model = shortText(entry.model);
  const baseUrl = publicVisionEndpoint(shortText(entry.baseUrl, 1000)) ?? '';
  return provider && model && baseUrl ? { provider, model, baseUrl } : null;
};

/**
 * Why a command-line screen capture is put to the person, kept as a constant because the advice
 * that follows a refusal is chosen by matching it: the generic command advice sends a model off
 * to build a virtual environment, which is exactly the wrong next move here.
 */
const SCREEN_CAPTURE_COMMAND =
  'it photographs the screen, whose contents are outside the project, and the system capture ' +
  'tools wait for someone to click';

/** Tools whose argument is a command line. */
const COMMAND_TOOLS = new Set(['run_command', 'launch_program', 'coding_run_command']);

/** Where a command word starts: the beginning, or after a separator. Not after a quote. */
const AT_COMMAND = String.raw`(?:^|[;&|(\n` + '`' + String.raw`]\s*|\$\(\s*)`;

/**
 * Commands whose effects reach past the project — into the operating system, or into every
 * program the user runs — with why, in words the person asked about them can follow.
 *
 * The system prompt says these are the user's call, and that was not enough. Asked for a GIMP
 * clone, qwen3-coder-next-80b found Ubuntu's Pillow had no ImageTk. With full access it ran
 * apt-get, which failed only for want of root, and then pip install --break-system-packages, which
 * put Pillow 12.3 and an unrelated PyPI package called "tk" in front of every Python program on
 * the machine.
 */
/**
 * Will this command stop and ask the machine's own password?
 *
 * Deliberately more inclusive than the approval patterns below. The cost of a false positive is
 * a console the person did not need opened; the cost of a false negative is a sudo prompt they
 * never see, with the turn apparently hung. So this matches sudo at a command position — after
 * a separator, inside `$( )`, at the start — and also after plain whitespace, which catches
 * wrappers like `time sudo ...` that AT_COMMAND alone would step over.
 */
const NEEDS_PASSWORD = new RegExp(String.raw`(?:^|[\s;&|(\n` + '`' + String.raw`]|\$\()\s*sudo(?:\s|$)`);

export const needsLocalInput = (command: string | undefined | null): boolean =>
  typeof command === 'string' && NEEDS_PASSWORD.test(command);

const MACHINE_WIDE: ReadonlyArray<readonly [RegExp, string]> = [
  [/--break-system-packages\b/, "pip's --break-system-packages installs outside any virtual environment"],
  [new RegExp(`${AT_COMMAND}sudo\\s`), 'sudo runs it as root'],
  [
    new RegExp(
      `${AT_COMMAND}(?:(?:apt|apt-get|aptitude|snap|dnf|yum|zypper)\\s+(?:-\\S+\\s+)*` +
        '(?:install|reinstall|remove|purge|upgrade|dist-upgrade|full-upgrade|autoremove)\\b' +
        '|dpkg\\s+(?:-\\S+\\s+)*(?:-i|--install|-r|--remove|-P|--purge)\\b' +
        '|pacman\\s+-[A-Za-z]*[SRU])'
    ),
    "it changes the operating system's packages",
  ],
  [
    new RegExp(`${AT_COMMAND}(?:(?:npm|pnpm)\\s+(?:install|i|add)\\b[^;&|\\n]*\\s(?:-g|--global)\\b|yarn\\s+global\\s+add\\b)`),
    'it installs a package for the whole machine',
  ],
  [
    new RegExp(`${AT_COMMAND}(?:pip3?|python3?\\s+-m\\s+pip)\\s+install\\b[^;&|\\n]*\\s--user\\b`),
    'pip --user installs for every Python program the user runs',
  ],
  // A model told it may not photograph the screen looks for another way to photograph the screen,
  // and the system tools are the obvious one. They are worse than the tool it was refused: most
  // open a picker or a crosshair and wait for a person to click, so an unattended run stops dead
  // on a dialog nobody is watching, with no indication of what it is waiting for. `import` and
  // `xwd` are matched only in a form that names a target, since both words occur innocently.
  [
    new RegExp(
      `${AT_COMMAND}(?:gnome-screenshot|spectacle|flameshot|scrot|maim|grim|shutter|ksnip|` +
        'screencapture|snippingtool|xfce4-screenshooter|deepin-screenshot' +
        '|import\\s+(?:-\\S+\\s+)*(?:-window\\b|[^;&|\\n]*\\.(?:png|jpg|jpeg)\\b)' +
        '|xwd\\s+(?:-\\S+\\s+)*-root\\b)'
    ),
    SCREEN_CAPTURE_COMMAND,
  ],
];

/**
 * Why a call reaches past the project, or null when it stays inside it.
 *
 * Command lines are one way; the other is the camera. A screenshot reads pixels outside the
 * project and writes a copy into it. A window title narrows the requested capture, but it is a
 * model-supplied substring rather than provenance that Antimatter launched or owns that window;
 * it therefore cannot remove the person's approval boundary. A capture without one includes one
 * selected desktop display — the mail client, the password manager, whatever else is visible.
 */
export function machineWide(toolName: string, args?: Record<string, unknown>): string | null {
  if (toolName === 'look_at_image') {
    const destination = visionDestination(args);
    if (!destination || isLoopbackVisionEndpoint(destination.baseUrl)) return null;
    const path = shortText(args?.path) || '(unspecified image)';
    return (
      `it sends workspace image ${JSON.stringify(path)} to non-loopback vision source ` +
      `${JSON.stringify(destination.provider)}, model ${JSON.stringify(destination.model)}, at ${destination.baseUrl}`
    );
  }
  if (toolName === 'screenshot') {
    // Set by the preview runtime from Electron, after discarding anything the model put there:
    // the window that would actually be photographed is one of Antimatter's own, so it shows
    // only what Antimatter is already showing and reaches past nothing.
    if (args?.[OWNED_WINDOW_ARG] === true) return null;
    const window = typeof args?.window === 'string' ? args.window.trim() : '';
    return window
      ? 'it photographs a desktop window, whose contents are outside the project'
      : 'it photographs one desktop display, whose contents are outside the project';
  }
  if (!COMMAND_TOOLS.has(toolName)) return null;
  const command = typeof args?.command === 'string' ? args.command : '';
  return MACHINE_WIDE.find(([pattern]) => pattern.test(command))?.[1] ?? null;
}

/**
 * What a model is told when such a call did not run, so that it looks for the narrower way.
 *
 * The narrower way differs by tool, and advice for the wrong one is worse than none: a model
 * told to make a virtual environment after a declined screenshot will go and make one.
 */
export const machineWideAdvice = (why: string, toolName?: string): string => {
  const refused = `It was put to the user because it reaches past the project: ${why}.`;
  if (toolName === 'screenshot') {
    return (
      `${refused} The capture did not run. Naming the exact window in the window argument narrows a later ` +
      'request to that window instead of one selected display, but every screen capture still needs the user’s approval.'
    );
  }
  if (toolName === 'look_at_image') {
    return (
      `${refused} No image was sent. A loopback vision source can run automatically; otherwise the user can ` +
      'explicitly approve a future look_at_image request for the named destination.'
    );
  }
  if (why === SCREEN_CAPTURE_COMMAND) {
    return (
      `${refused} Nothing was captured. Use the screenshot tool instead of a command: it returns an image ` +
      'without waiting for anyone to click, and naming the exact window in its window argument captures that ' +
      'window rather than a whole display.'
    );
  }
  return (
    `${refused} Keep what the work needs inside the project instead. For Python, make a virtual environment: ` +
    'python3 -m venv .venv, then .venv/bin/pip install <package>, and run the program with .venv/bin/python. ' +
    'If something only the system can provide is missing, tell the user what it is and why it is needed, and ' +
    'leave installing it to them.'
  );
};

export interface PolicyContext {
  mode: AccessMode;
  /** The server advertising the bare tool name; omitted only by direct/legacy policy callers. */
  serverId?: string;
  /**
   * Whether a person nominated the directory the tools are pointed at.
   *
   * The tools always have *a* working directory — a leftover, a default, or one the
   * orchestrator set for a run. A turn once rewrote this repository's README because the tools
   * happened to be aimed at it and nobody had said so. Reading an unnominated directory is
   * harmless; changing it is not, so writes wait for someone to say where they are.
   */
  workspaceConfirmed?: boolean;
  /**
   * Whether the person has already said a screen capture may run without being asked.
   *
   * Passed in rather than read here, so this stays a decision about its arguments alone, and asked
   * again at each call by the loop above it, so turning it off stops the next capture rather than
   * the next turn.
   */
  screenCaptureWithoutAsking?: boolean;
  /**
   * Whether the person has already said a command that changes the machine may run without being
   * asked.
   *
   * Like `screenCaptureWithoutAsking`: passed in rather than read here, and asked again at each
   * call by the loop above, so turning it off stops the next command rather than the next turn.
   * It covers the commands that change the machine — `sudo`, a system package manager, an install
   * that lands outside any virtual environment. It does not cover the screen, which has its own
   * standing answer, and it does not cover the command-line capture tools: the prompt in front of
   * those protects the run itself, since most open a picker and wait for a click that an
   * unattended turn will never make.
   */
  machineWideWithoutAsking?: boolean;
}

export function decide(toolName: string, context: AccessMode | PolicyContext, args?: Record<string, unknown>): Decision {
  const { mode, workspaceConfirmed = true, serverId, screenCaptureWithoutAsking, machineWideWithoutAsking } =
    typeof context === 'string' ? { mode: context } : context;
  const effectiveServer = policyServer(toolName, serverId);
  const trusted = isTrustedTool(toolName, effectiveServer);
  const tier = tierOf(toolName, effectiveServer);

  /**
   * The Vault, before permissions are consulted at all.
   *
   * Reading the catalogue is allowed in every mode: it holds no secrets, and a model that cannot
   * see which credentials exist asks the person for one in chat, which is the outcome this whole
   * feature exists to avoid. Spending one always asks, in every mode including Read only — a
   * credential is not a file in the project, so neither the access level nor whether a working
   * directory was nominated speaks to it.
   */
  if (VAULT_TOOLS.has(toolName)) {
    if (!trusted) return 'deny';
    return toolName === 'vault_use' ? 'ask' : 'allow';
  }

  // Only the workspace-bound app runtime implements annotation-only review semantics.
  // An external server cannot borrow this permission by advertising a familiar name.
  if (CODE_REVIEW_TOOLS.has(toolName)) return trusted ? 'allow' : 'deny';

  // Only the app-owned, source-bound runtime can validate a person's exact chat connection.
  // A third-party server advertising the same name must not gain even per-call authority.
  if (CONVERSATION_TOOLS.has(toolName)) {
    if (!trusted || !workspaceConfirmed) return 'deny';
    return toolName === 'send_chat_message' && mode === 'read' ? 'deny' : 'allow';
  }
  // A public-channel opt-in is checked by the interactive runtime on every call. It grants
  // neither unattended access nor a way for another server to impersonate this capability.
  if (BOT_CHAT_TOOLS.has(toolName)) {
    if (!trusted) return 'deny';
    return toolName === 'post_bot_chat_message' && mode === 'read' ? 'deny' : 'allow';
  }

  // A configured server may choose any advertised name. A collision with `read_file` must not
  // inherit the bundled server's read-only or unattended authority; a person can still approve
  // the unknown capability in an interactive Ask/Full turn after choosing the workspace.
  if (!trusted) {
    if (!workspaceConfirmed || mode === 'read') return 'deny';
    return 'ask';
  }

  if (toolName.startsWith('connection_')) {
    if (!workspaceConfirmed) return 'deny';
    if (toolName === 'connection_send') return mode === 'read' ? 'deny' : 'ask';
  }
  if (ALWAYS_CONFIRM.has(toolName)) return 'ask';
  // Reading a workspace image is local; transmitting it to another host is not. Read-only mode
  // cannot grant egress, while Ask first and Full access both require this exact call's consent.
  if (toolName === 'look_at_image' && machineWide(toolName, args)) return mode === 'read' ? 'deny' : 'ask';
  if (tier === 'read') return 'allow';
  if (MEMORY_WRITE_TOOLS.has(toolName)) return mode === 'read' ? 'deny' : mode === 'full' ? 'allow' : 'ask';
  // Before permissions even come into it: a change needs a directory somebody chose.
  if (!workspaceConfirmed) return 'deny';
  if (mode === 'read') return 'deny';
  /**
   * Standing consent is for the camera and for nothing else.
   *
   * `screenshot`'s reach past the project is that it photographs the screen the person who turned
   * this on is sitting in front of — a question they can answer in advance, and on a session with
   * no window titles the only question they are ever asked. Every other machine-wide call changes
   * the machine, and none of those can be agreed to before it is seen.
   */
  const standingCapture = toolName === 'screenshot' && screenCaptureWithoutAsking === true;
  /**
   * The same thing for the command line, and only for the part of it that is about this machine.
   *
   * A development box where `sudo` is already wired to a Vault credential answers this question
   * the same way every time, and asking it again on each `apt-get` is twenty dialogs for one
   * afternoon's work. The command-line capture tools are excluded deliberately: that prompt is
   * not protecting the machine, it is protecting the turn from stopping dead on a picker nobody
   * is watching, and the advice after it points at the `screenshot` tool, which cannot hang.
   */
  const standingCommand =
    COMMAND_TOOLS.has(toolName) && machineWideWithoutAsking === true && machineWide(toolName, args) !== SCREEN_CAPTURE_COMMAND;
  // Full access is for the project. A change to the machine is still put to the person, unless
  // they have already answered for this machine.
  if (mode === 'full') return machineWide(toolName, args) && !standingCapture && !standingCommand ? 'ask' : 'allow';
  return 'ask';
}

export const denialReason = (
  toolName: string,
  workspaceConfirmed = true,
  workspace?: string,
  args?: Record<string, unknown>
) => {
  if (VAULT_TOOLS.has(toolName)) {
    return 'Refused: Vault tools must come from Antimatter\u2019s own main process, which holds the keyring. ' +
      'No configured server can serve a credential. Nothing was unsealed.';
  }
  if (CODE_REVIEW_TOOLS.has(toolName)) {
    return 'Refused: code review tools must come from Antimatter’s workspace-bound Code Review runtime. ' +
      'Review annotations do not edit source or grant final human approval.';
  }
  if (BOT_CHAT_TOOLS.has(toolName)) {
    return 'Refused: public Bot chat requires the user to enable the experiment and an active interactive chat. ' +
      'Read only cannot post public messages. Models cannot enable or moderate Bot chat.';
  }
  if (CONVERSATION_TOOLS.has(toolName)) {
    return 'Refused: chat coordination requires an active, user-connected chat in this workspace. ' +
      'Sending a chat message also requires Ask first or Full access; Read only cannot send messages.';
  }
  if (MEMORY_WRITE_TOOLS.has(toolName)) {
    return (
      `Refused: ${toolName} changes the notes later conversations are given, and permissions are set to Read only. ` +
      'Switch to "Ask first" or "Full access" to let it run, or the user can change the note on the Memory page.'
    );
  }
  const caution = machineWide(toolName, args);
  if (toolName === 'look_at_image' && caution) {
    return (
      `Refused: ${caution}, and permissions are set to Read only. No image was sent. ` +
      'Switch to "Ask first" or "Full access" to approve this destination per call, or use a loopback vision source.'
    );
  }
  return workspaceConfirmed
    ? `Refused: ${toolName} would change things, and permissions are set to Read only. Switch to "Ask first" or "Full access" to let it run.`
    : `Refused: ${toolName} would change files in ${workspace ?? 'the current working directory'}, which nobody has chosen ` +
      `as the working directory — it was inherited. Confirm it, or pick another, from the permissions menu beside the composer. ` +
      `Reading is unaffected.`;
};

/** OpenAI function names allow [a-zA-Z0-9_-]; our server ids contain dots. */
const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');

export interface ToolTarget {
  serverId: string;
  serverName: string;
  toolName: string;
}

export interface Toolset {
  definitions: ToolDefinition[];
  lookup: Map<string, ToolTarget>;
}

/** Turns the connected servers' enabled tools into function definitions plus a way back. */
export function buildToolset(enabled: { serverId: string; serverName: string; tool: McpTool }[]): Toolset {
  const definitions: ToolDefinition[] = [];
  const lookup = new Map<string, ToolTarget>();

  for (const { serverId, serverName, tool } of enabled) {
    const name = `${sanitize(serverId)}__${tool.name}`.slice(0, 64);
    if (lookup.has(name)) continue;

    lookup.set(name, { serverId, serverName, toolName: tool.name });
    definitions.push({
      type: 'function',
      function: {
        name,
        description: tool.description || tool.name,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    });
  }

  return { definitions, lookup };
}
