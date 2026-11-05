import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import { insideWorkspace } from '../../../mcp/workspace';
import type { McpTool, ToolCallResult } from '../mcp';
import type { ToolCallOptions, ToolRuntime } from '../toolLoop';
import * as capture from './capture';
import * as pane from './pane';
import { OWNED_WINDOW_ARG, previewableUrl, READABLE_IMAGES } from './targets';
import {
  look,
  publicVisionDestination,
  type ConfiguredVisionSource,
  type PublicVisionDestination,
} from './vision';
import { canonicalWorkspace, writeWorkspaceBinary } from './workspace';

/**
 * Preview: the model's hands for showing things, and its eyes for seeing them.
 *
 * Everything the conversation could show until now was text. A model that had just written an
 * HTML page could describe it; a model that had just launched a GUI could only re-read its own
 * source. These four tools close both halves of that: `preview_image` and `preview_url` put
 * something in front of the person, `screenshot` takes a picture of what is actually on screen,
 * and `look_at_image` sends a picture to a model that can see and brings back words.
 *
 * They are served by the app rather than by an MCP server for the same reason the agent tools
 * are: they need the window, the desktop capturer and the configured sources, none of which
 * exist in a stdio child. A picture also never enters the transcript — the tools deal in paths
 * and the renderer fetches pixels when it draws them — so carbons stay readable text.
 */

export const SERVER_ID = 'antimatter.preview';
export const SERVER_NAME = 'Preview';
export const PREVIEW_IMAGE = 'preview_image';
export const PREVIEW_URL = 'preview_url';
export const SCREENSHOT = 'screenshot';
export const LOOK_AT_IMAGE = 'look_at_image';
export const PREVIEW_READ = 'preview_read';
export const PREVIEW_CAPTURE = 'preview_capture';

export const PREVIEW_TOOLS = [PREVIEW_IMAGE, PREVIEW_URL, SCREENSHOT, LOOK_AT_IMAGE, PREVIEW_READ, PREVIEW_CAPTURE];

/** Where a screenshot lands when the model does not say. Overwritten, so a loop leaves one file. */
const DEFAULT_SHOT = 'screenshot.png';
const DEFAULT_PANE_SHOT = 'preview.png';

/** What the person is looking at in the Preview section. */
export interface PreviewItem {
  id: string;
  kind: 'image' | 'page';
  /** Workspace-relative path for an image; an absolute http(s) URL for a page. */
  target: string;
  title: string;
  at: number;
  /** Canonical root the image path is relative to. Absent for pages and old transcript rows. */
  workspace?: string;
}

export interface PreviewContext {
  workspace: string;
  /** Whether a person nominated this directory; a screenshot writes a file into it. */
  workspaceConfirmed: boolean;
  /** Puts it in front of the person, live. The list itself is rebuilt from the transcript. */
  show(item: PreviewItem): void;
  /**
   * The source and model that can see, or null when none is configured.
   *
   * Resolved per call rather than held: a source can be added, and a projector loaded, while a
   * conversation is open, and a model told once that nothing can see would go on believing it.
   */
  eyes(): Promise<ConfiguredVisionSource | null>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The part of a preview the transcript keeps, so the section can be rebuilt from the calls. */
const ref = (item: PreviewItem) => ({
  kind: item.kind,
  target: item.target,
  title: item.title,
  ...(item.workspace ? { workspace: item.workspace } : {}),
});

/** How the path reads back to a model that gave it relative to the workspace. */
const shown = (workspace: string, target: string): string => relative(workspace, target) || target;

export function definitions(): McpTool[] {
  return [
    {
      name: PREVIEW_IMAGE,
      description:
        'Show an image from the workspace to the user. It appears in the conversation where you call this, ' +
        'and in the Preview section beside it. Use it whenever you have made or found a picture worth ' +
        'seeing — a chart, a screenshot, a rendered design — instead of only saying that the file exists. ' +
        'This shows it to the user; it does not let you see it. Use look_at_image for that.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: `Path to a ${READABLE_IMAGES} file, relative to the workspace root.` },
          caption: { type: 'string', description: 'One line saying what it is, shown under the image.' },
        },
        required: ['path'],
      },
      enabled: true,
    },
    {
      name: PREVIEW_URL,
      description:
        'Open a web page in the Preview section beside the conversation. Use it to show the user something ' +
        'running — a dev server you have just started, a page you have just written, documentation you are ' +
        'working from. Give the whole URL including the scheme. The page is live and the user can click ' +
        'around in it; you cannot see it, so take a screenshot of it if you need to look.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'An http or https URL, for example http://localhost:5173.' },
          title: { type: 'string', description: 'A short label for the tab, six words or fewer.' },
        },
        required: ['url'],
      },
      enabled: true,
    },
    {
      name: PREVIEW_READ,
      description:
        'Read the page open in Preview: its text as rendered, and anything it printed to the console. Use this ' +
        'after preview_url and after every change to a page you are debugging - the console is where a page says ' +
        'it is broken, and one that looks finished can be failing in it. Asks the user nothing.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      enabled: true,
    },
    {
      name: PREVIEW_CAPTURE,
      description:
        'Photograph the Preview pane and save it in the workspace. That page only, inside this application: not ' +
        'the desktop screenshot tool, never another window or display, and never put to the user for approval. ' +
        'Use it for layout and appearance, which preview_read cannot describe; pass the returned path to ' +
        'look_at_image to be told how it looks.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: `Where to save the PNG, relative to the workspace. Default ${DEFAULT_PANE_SHOT}.` } },
        required: [],
      },
      enabled: true,
    },
    {
      name: SCREENSHOT,
      description:
        'Take a picture of a window that is open on the screen, and save it in the workspace. Name the ' +
        'window and only that window is photographed; leave it out and one display is. Every capture is ' +
        'put to the user for approval because desktop pixels are outside the project. Use this ' +
        'after launch_program to see what a program you started actually drew. The picture is shown to the ' +
        'user, and the call returns its path — pass that to look_at_image to be told what is in it.',
      inputSchema: {
        type: 'object',
        properties: {
          window: {
            type: 'string',
            description:
              "Part of the window's title, for example \"GIMP Clone\". Matched loosely and case-insensitively.",
          },
          path: { type: 'string', description: `Where to save it, relative to the workspace. Default ${DEFAULT_SHOT}.` },
        },
        required: [],
      },
      enabled: true,
    },
    {
      name: LOOK_AT_IMAGE,
      description:
        'Ask a configured model that can see about an image in the workspace, and get its answer as text. This is how ' +
        'you look at a screenshot of a program you have written, a chart you have plotted, or a design you ' +
        'have been given. Ask something specific — "is the toolbar overlapping the canvas?", "what does the ' +
        'error dialog say?" — and you get a specific answer; ask nothing and you get a description. The ' +
        'answer is another model\'s reading of the picture, so treat it as a careful report rather than as ' +
        'something you saw yourself. Loopback analysis is automatic. A non-loopback source requires the ' +
        'user\'s approval for this exact image and destination before the image is read or sent.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the image, relative to the workspace root.' },
          question: {
            type: 'string',
            description: 'What you want to know about it. Leave out for a plain description.',
          },
        },
        required: ['path'],
      },
      enabled: true,
    },
  ];
}

export function withPreview(runtime: ToolRuntime, context: PreviewContext): ToolRuntime {
  // A preview outlives this runtime in the visible transcript. Record its canonical workspace
  // path now, while the turn still knows exactly which live tree its relative paths belong to.
  const workspace = canonicalWorkspace(context.workspace);
  const announce = (kind: PreviewItem['kind'], target: string, title: string): PreviewItem => {
    const item: PreviewItem = {
      id: randomUUID(),
      kind,
      target,
      title,
      at: Date.now(),
      ...(kind === 'image' ? { workspace } : {}),
    };
    context.show(item);
    return item;
  };

  const previewImage = (args: Record<string, unknown>): ToolCallResult => {
    const path = text(args.path);
    if (!path) return { ok: false, text: 'preview_image needs the path of an image in the workspace.', attempted: false };

    const target = insideWorkspace(workspace, path);
    const image = capture.loadImage(target, workspace);
    const where = shown(workspace, target);
    const item = announce('image', where, text(args.caption) || where);
    return {
      ok: true,
      text: `Showing ${where} (${image.width}×${image.height}) to the user.`,
      attempted: true,
      preview: ref(item),
    };
  };

  const previewUrl = (args: Record<string, unknown>): ToolCallResult => {
    const url = previewableUrl(text(args.url));
    const item = announce('page', url, text(args.title) || new URL(url).host);
    return {
      ok: true,
      text:
        `Opened ${url} in Preview. The user can see it and click around in it, and so can you: ` +
        'preview_read gives you its text and console output, preview_capture photographs the pane. ' +
        'Read it before reporting on it - a page that looks finished can be failing in the console.',
      attempted: true,
      preview: ref(item),
    };
  };

  const screenshot = async (args: Record<string, unknown>): Promise<ToolCallResult> => {
    const window = text(args.window);
    const shot = await capture.capture(window ? { window } : {});
    const target = writeWorkspaceBinary(workspace, text(args.path) || DEFAULT_SHOT, shot.bytes);

    const where = shown(workspace, target);
    const item = announce('image', where, `${shot.name} · ${where}`);
    return {
      ok: true,
      text:
        `Photographed "${shot.name}" (${shot.width}×${shot.height}) and saved it to ${where}. ` +
        `It is shown to the user. Call look_at_image with path "${where}" to be told what is in it.`,
      attempted: true,
      preview: ref(item),
    };
  };

  const preparedVision = Symbol('prepared vision destination');
  interface PreparedVision {
    marker: typeof preparedVision;
    source: ConfiguredVisionSource | null;
    destination: PublicVisionDestination | null;
  }
  const asPreparedVision = (value: unknown): PreparedVision | null => {
    if (!value || typeof value !== 'object') return null;
    const prepared = value as Partial<PreparedVision>;
    return prepared.marker === preparedVision ? (prepared as PreparedVision) : null;
  };
  const sameDestination = (args: Record<string, unknown>, expected: PublicVisionDestination): boolean => {
    const supplied = args.vision_destination;
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return false;
    const value = supplied as Record<string, unknown>;
    return (
      value.provider === expected.provider && value.model === expected.model && value.baseUrl === expected.baseUrl
    );
  };

  const lookAtImage = async (args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult> => {
    const path = text(args.path);
    if (!path) return { ok: false, text: 'look_at_image needs the path of an image in the workspace.', attempted: false };

    const prepared = asPreparedVision(options?.prepared);
    if (!prepared) {
      return {
        ok: false,
        attempted: false,
        text: 'The vision destination was not prepared, so no image was sent. Retry the look_at_image call.',
      };
    }
    const { source, destination } = prepared;
    if (!source) {
      return {
        ok: false,
        attempted: false,
        text:
          'No eligible vision model is configured, so no image was sent. The user needs to add an http(s) source ' +
          'whose server reports that its model accepts images. Loopback sources run automatically; a non-loopback ' +
          'source is put to the user for approval on every look. Tell them that, and carry on without the picture.',
      };
    }
    if (!destination || !sameDestination(args, destination)) {
      return {
        ok: false,
        attempted: false,
        text: 'The prepared vision destination no longer matches this call, so no image was sent. Retry look_at_image.',
      };
    }

    const target = insideWorkspace(workspace, path);
    const image = capture.loadImage(target, workspace);
    // Downscaled for the look only: the file on disk keeps every pixel it had.
    const sent = capture.fit(image, capture.LOOK_LONG_EDGE);
    const answer = await look({
      ...source,
      image: sent.bytes,
      mediaType: sent.mediaType,
      question: text(args.question),
      signal: options?.signal,
    });

    const where = shown(workspace, target);
    const scaled = sent.width === image.width ? '' : `, shown to it at ${sent.width}×${sent.height}`;
    return {
      ok: true,
      text: `${source.model} on ${where} (${image.width}×${image.height}${scaled}):\n\n${answer}`,
      attempted: true,
    };
  };

  const previewRead = async (): Promise<ToolCallResult> => {
    const page = await pane.readText();
    if (!page) return { ok: false, text: 'No page is open in Preview. Call preview_url first.', attempted: false };
    const lines = pane.consoleLog();
    const problems = lines.filter((line) => line.level === 'error' || line.level === 'warning');
    const render = (line: pane.ConsoleLine) =>
      `  [${line.level}] ${line.text}${line.source ? ` (${line.source}${line.line ? `:${line.line}` : ''})` : ''}`;
    const printed = problems.length
      ? `Console (${problems.length} error/warning of ${lines.length} messages):\n${problems.slice(-25).map(render).join('\n')}`
      : lines.length
        ? `Console: ${lines.length} messages, none of them errors or warnings.`
        : 'Console: nothing printed.';
    return {
      ok: true,
      attempted: true,
      text: `${page.url}${page.title ? ` - ${page.title}` : ''}\n\n${page.text || '(the page rendered no text)'}${
        page.truncated ? '\n[text truncated]' : ''
      }\n\n${printed}`,
    };
  };

  const previewCapture = async (args: Record<string, unknown>): Promise<ToolCallResult> => {
    const bytes = await pane.capture();
    if (!bytes) return { ok: false, text: 'No page is open in Preview. Call preview_url first.', attempted: false };
    const target = writeWorkspaceBinary(workspace, text(args.path) || DEFAULT_PANE_SHOT, bytes);
    const where = shown(workspace, target);
    const item = announce('image', where, `Preview - ${where}`);
    return {
      ok: true,
      text: `Photographed the Preview pane and saved it to ${where}. Call look_at_image with path "${where}" to be told how it looks.`,
      attempted: true,
      preview: ref(item),
    };
  };

  return {
    enabledTools: () => [
      ...runtime.enabledTools(),
      ...definitions().map((tool) => ({ serverId: SERVER_ID, serverName: SERVER_NAME, tool })),
    ],
    prepareTool: async (serverId, toolName, args, options) => {
      if (serverId !== SERVER_ID) {
        return runtime.prepareTool ? runtime.prepareTool(serverId, toolName, args, options) : { args };
      }
      if (toolName === SCREENSHOT) {
        // Reserved: whatever the model put here is discarded before the real answer replaces it,
        // so naming the argument itself cannot buy a capture the person did not approve.
        const publicArgs = { ...args };
        delete publicArgs[OWNED_WINDOW_ARG];
        if (await capture.capturesOwnWindow(text(args.window))) publicArgs[OWNED_WINDOW_ARG] = true;
        return { args: publicArgs };
      }
      if (toolName !== LOOK_AT_IMAGE) return { args };

      // Ignore a model-supplied destination. The configured source is resolved exactly once here,
      // before policy, and its secret-bearing form travels only in opaque runtime state.
      const publicArgs = { ...args };
      delete publicArgs.vision_destination;
      const source = await context.eyes();
      const destination = source ? publicVisionDestination(source) : null;
      if (destination) publicArgs.vision_destination = destination;
      const prepared: PreparedVision = { marker: preparedVision, source, destination };
      return { args: publicArgs, prepared };
    },
    callTool: async (serverId, toolName, args, options) => {
      if (serverId !== SERVER_ID) return runtime.callTool(serverId, toolName, args, options);
      try {
        if (toolName === PREVIEW_IMAGE) return previewImage(args);
        if (toolName === PREVIEW_URL) return previewUrl(args);
        if (toolName === SCREENSHOT) return await screenshot(args);
        if (toolName === LOOK_AT_IMAGE) return await lookAtImage(args, options);
        if (toolName === PREVIEW_READ) return await previewRead();
        if (toolName === PREVIEW_CAPTURE) return await previewCapture(args);
        return { ok: false, text: `Antimatter has no preview tool named ${toolName}.`, attempted: false };
      } catch (error) {
        // A refused path, an undecodable file, a server that would not answer: all of these are
        // things the model can act on, and none of them should end the turn.
        return { ok: false, text: (error as Error).message, attempted: true };
      }
    },
    connectionErrors: () => runtime.connectionErrors?.() ?? [],
  };
}
