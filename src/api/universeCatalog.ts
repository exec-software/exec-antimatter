/**
 * The universes and generators this release knows about.
 *
 * Data, not code: everything here is a manifest that `normalizeManifest` has to accept like any
 * other, which is what keeps the built-in universes honest. If Code or Movie needed a field that
 * an expansion could not express, the expansion format would be a fiction and the first
 * third-party universe would discover it the hard way.
 *
 * Movie's panels and stages are its own answer to the problem, and the reasoning behind that
 * shape is in `movie.ts`. In short: the units are intents that may not have media yet, so the
 * workbench puts the brief and the shot list in front of the footage rather than behind it.
 */

import type { GeneratorSpec } from './generators';
import type { UniverseManifest } from './universes';

/**
 * Code: the universe Antimatter has always been.
 *
 * Declared rather than special-cased so the switcher has something to switch away *from*, and so
 * that the day Code's workbench gains a panel, it gains it the same way Movie would. Its panels
 * are currently drawn by the existing pages — the manifest describes the universe, and the Code
 * universe's workbench is the chat and environment that were already there.
 */
const CODE: UniverseManifest = {
  version: 1,
  id: 'code',
  name: 'Code',
  tagline: 'Projects, language tools, and an agent that can run them.',
  description:
    'The universe Antimatter started as: a workspace, a file tree, language tools, a terminal, ' +
    'and a conversation that can use all of them.',
  publisher: 'Execute',
  release: '1',
  entitlement: 'built-in',
  icon: 'Code2',
  documentNoun: 'project',
  stages: [],
  panels: [{ id: 'workspace', kind: 'library', title: 'Workspace', region: 'main', open: true }],
  generators: [],
};

/**
 * Movie: the first expansion.
 *
 * Five stages, and they are not a pipeline — see `movie.ts`. The order they are listed in is the
 * order most work starts in, but the panels of any stage stay reachable from any other, because
 * the actual loop is cut-then-generate-then-cut and a workbench that forbids going backwards
 * would be wrong about the work.
 */
const MOVIE: UniverseManifest = {
  version: 1,
  id: 'movie',
  name: 'Movie',
  tagline: 'Write it, board it, generate it, cut it — on one surface.',
  description:
    'A hybrid film workbench. Shots are intents that may or may not have footage yet, so the cut ' +
    'is real before anything is rendered and survives every re-generation. Bring your own ' +
    'footage, generate what is missing, or both.',
  publisher: 'Execute',
  release: '1',
  // Included for now. The licence machinery is in place so this can become `licensed` without
  // anything else in the application changing.
  entitlement: 'included',
  icon: 'Clapperboard',
  documentNoun: 'production',
  stages: [
    {
      id: 'premise',
      name: 'Premise',
      intent: 'What the film is, in your own words. Everything downstream is an attempt at this.',
      panels: ['brief', 'notes'],
    },
    {
      id: 'boards',
      name: 'Boards',
      intent: 'Beats, as cards you can shuffle before any of them costs a render.',
      panels: ['boards', 'viewer'],
    },
    {
      id: 'shots',
      name: 'Shots',
      intent: 'Turn beats into shots. A shot with no footage is still a shot.',
      panels: ['shots', 'inspector', 'viewer'],
    },
    {
      id: 'cut',
      name: 'Cut',
      intent: 'Lay out the film. Slugs play as slugs; re-generating never moves anything.',
      panels: ['timeline', 'viewer', 'shots'],
    },
    {
      id: 'finish',
      name: 'Finish',
      intent: 'Render what survived, watch the queue, and take it out.',
      panels: ['queue', 'timeline', 'viewer'],
    },
  ],
  panels: [
    { id: 'brief', kind: 'brief', title: 'Brief', region: 'left', open: true },
    { id: 'boards', kind: 'boards', title: 'Storyboard', region: 'left', open: false },
    { id: 'shots', kind: 'shots', title: 'Shots', region: 'left', open: true },
    { id: 'viewer', kind: 'viewer', title: 'Viewer', region: 'main', open: true },
    { id: 'inspector', kind: 'inspector', title: 'Shot', region: 'right', open: true },
    { id: 'queue', kind: 'queue', title: 'Renders', region: 'right', open: false },
    { id: 'notes', kind: 'notes', title: 'Notes', region: 'right', open: false },
    { id: 'timeline', kind: 'timeline', title: 'Timeline', region: 'bottom', open: true },
  ],
  generators: ['wan-2-2-comfy', 'video-endpoint', 'wan-2-2-unit'],
};

export const BUILT_IN_UNIVERSES: readonly UniverseManifest[] = Object.freeze([CODE, MOVIE]);

/** The universe Antimatter opens in, and the one that can never be unlicensed. */
export const DEFAULT_UNIVERSE_ID = 'code';

/**
 * The generators Movie knows how to talk to.
 *
 * Wan 2.2 is the default on licence grounds as much as technical ones. It is Apache-2.0, which
 * means weights that can be redistributed inside a paid expansion without negotiating terms —
 * and of the current open video models it is the only one where that is true. The alternatives
 * are better on paper and worse on paper's terms: MiniMax H3 does 2K with native audio but only
 * its base model is open, reportedly with territory and revenue restrictions, and LTX's licence
 * carries conditions of its own. Both are perfectly usable through the endpoint adapter by
 * someone who has accepted those terms themselves; neither is something we can ship.
 *
 * Capability numbers are conservative. The cost of understating them is a control that is
 * enabled when it could have been better; the cost of overstating them is a twenty-minute render
 * that returns mush.
 */
export const GENERATOR_SPECS: readonly GeneratorSpec[] = Object.freeze([
  {
    id: 'wan-2-2-comfy',
    name: 'Wan 2.2 (ComfyUI)',
    kind: 'video',
    adapter: 'comfy',
    note: 'Wan 2.2 through a ComfyUI you already run. Silent output — audio is a separate pass.',
    capabilities: {
      maxWidth: 1280,
      maxHeight: 720,
      maxSeconds: 5,
      fps: 24,
      audio: false,
      imageToVideo: true,
      vramGibEstimate: 16,
    },
    weights: {
      repoId: 'Wan-AI/Wan2.2-TI2V-5B',
      revision: 'main',
      licence: 'Apache-2.0',
      licenceNote:
        'Apache-2.0: use, modify and redistribute commercially, including inside a paid expansion, ' +
        'keeping the notice.',
      sizeBytes: 11_000_000_000,
    },
  },
  {
    id: 'wan-2-2-unit',
    name: 'Wan 2.2 (packaged)',
    kind: 'video',
    adapter: 'unit',
    note: 'The packaged runtime, started on demand and stopped when the queue drains.',
    capabilities: {
      maxWidth: 1280,
      maxHeight: 720,
      maxSeconds: 5,
      fps: 24,
      audio: false,
      imageToVideo: true,
      vramGibEstimate: 16,
    },
    weights: {
      repoId: 'Wan-AI/Wan2.2-TI2V-5B',
      revision: 'main',
      licence: 'Apache-2.0',
      licenceNote:
        'Apache-2.0: use, modify and redistribute commercially, including inside a paid expansion, ' +
        'keeping the notice.',
      sizeBytes: 11_000_000_000,
    },
  },
  {
    /**
     * The escape hatch, and deliberately unbranded.
     *
     * Anything speaking the OpenAI video shape goes here: a hosted service, someone's own server,
     * a model whose licence we cannot ship but they can accept. Its capabilities are edited by
     * whoever configures it, because we have no way to know what is on the other end.
     */
    id: 'video-endpoint',
    name: 'Video endpoint',
    kind: 'video',
    adapter: 'openai-video',
    note: 'Any OpenAI-shaped video endpoint — hosted or your own. You accept its terms, not us.',
    capabilities: {
      maxWidth: 2048,
      maxHeight: 1152,
      maxSeconds: 15,
      fps: 25,
      audio: true,
      imageToVideo: true,
      vramGibEstimate: 0,
    },
  },
]);

export const generatorSpec = (id: string): GeneratorSpec | undefined =>
  GENERATOR_SPECS.find((spec) => spec.id === id);
