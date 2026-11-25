/**
 * Universes: the workbench changes, the application does not.
 *
 * Antimatter has always been a coding tool with a chat down one side. That is one universe —
 * Code — and it is only the default because it was the first. Someone cutting a film, mixing a
 * record or grading photographs needs a different surface, different tools and a different
 * vocabulary, but the same conversation, the same models, the same workspace and the same
 * machine underneath. A universe is that surface: a declared workbench Antimatter assembles,
 * rather than a second application you alt-tab to.
 *
 * Three things make it a *concept* rather than another page.
 *
 * 1. It is declared, not coded. A universe is a manifest — stages, panels, generators — and the
 *    workbench is built from it. Adding one is writing a manifest and, where it needs a surface
 *    nothing else has, one panel implementation. It is not a fork of the shell.
 * 2. It is self-contained. Everything a universe owns — its documents, its assets, its licence,
 *    the weights it was packaged with — lives under that universe's own root and goes when it
 *    goes. That is what makes an expansion shippable separately from the application, and what
 *    keeps uninstalling one from being an archaeology exercise.
 * 3. It is entitled. Some universes are built in and always there; others are expansions that
 *    may one day be bought. The entitlement is a property of the manifest and is checked in one
 *    place, so "is this licensed" is never a question each panel answers for itself.
 *
 * Panel *implementations* are compiled into the application and selected by kind. A manifest
 * cannot ship executable code, which is deliberate: an expansion is data the app renders, not a
 * plugin with the run of the process. When a universe genuinely needs a surface nothing else
 * has, the surface lands here under a new kind and every universe can then ask for it.
 */

/** Bounds, because a manifest is a file on disk that something else may have written. */
export const UNIVERSE_ID_LIMIT = 64;
export const UNIVERSE_TEXT_LIMIT = 2_000;
export const UNIVERSE_NAME_LIMIT = 80;
export const UNIVERSE_PANEL_LIMIT = 32;
export const UNIVERSE_STAGE_LIMIT = 16;
export const UNIVERSE_GENERATOR_LIMIT = 16;

/**
 * The panels a workbench can be assembled from.
 *
 * Deliberately a closed set. An open one would mean a manifest naming a component that may not
 * exist, which is a blank region at the worst moment — on someone else's machine, after an
 * update. An unknown kind is dropped at parse time instead, and the rest of the workbench opens.
 */
export type UniversePanelKind =
  /** The things you have: footage, stills, takes, stems. */
  | 'library'
  /** The thing you are looking at right now, at size. */
  | 'viewer'
  /** Ordered beats — boards, scenes, chapters — as cards you can shuffle. */
  | 'boards'
  /** The units of work, each carrying its intent as well as its media. */
  | 'shots'
  /** Time. The cut, the arrangement, the sequence. */
  | 'timeline'
  /** Everything about the current selection, in fields. */
  | 'inspector'
  /** What has been asked of the generators, and how far along it is. */
  | 'queue'
  /** The brief, in prose, that the rest of the universe is an attempt at. */
  | 'brief'
  /** Free notes that belong to the production rather than to any one chat. */
  | 'notes';

export const UNIVERSE_PANEL_KINDS: readonly UniversePanelKind[] = Object.freeze([
  'library', 'viewer', 'boards', 'shots', 'timeline', 'inspector', 'queue', 'brief', 'notes',
]);

/** Where a panel can be docked. `main` is the one region that is always filled. */
export type UniverseRegion = 'left' | 'main' | 'right' | 'bottom';

export const UNIVERSE_REGIONS: readonly UniverseRegion[] = Object.freeze(['left', 'main', 'right', 'bottom']);

export interface UniversePanel {
  id: string;
  kind: UniversePanelKind;
  /** What this panel is called in *this* universe. A `boards` panel is "Storyboard" in Movie. */
  title: string;
  /** Where the manifest would like it. The person's own layout overrides this. */
  region: UniverseRegion;
  /** A panel the workbench opens without being asked. */
  open: boolean;
}

/**
 * A stage of the universe's workflow.
 *
 * Stages are not a wizard and the workbench does not lock you into one. They name the shape of
 * the work and decide which panels come forward when you say you are in that part of it — which
 * is the difference between a workbench that reconfigures around what you are doing and a
 * screen with everything on it at once.
 */
export interface UniverseStage {
  id: string;
  name: string;
  /** One line: what this stage is for. Shown under the stage, so it reads as guidance. */
  intent: string;
  /** Panel ids to bring forward. Panels not named here stay as the person left them. */
  panels: string[];
}

/** What it costs, and therefore whether it opens. */
export type UniverseEntitlementKind =
  /** Part of the application. Code is this, and always will be. */
  | 'built-in'
  /** An expansion that ships with the application for now; no licence to check. */
  | 'included'
  /** An expansion that needs a grant before its workbench opens. */
  | 'licensed';

export interface UniverseManifest {
  version: 1;
  id: string;
  name: string;
  /** One line, for the switcher. */
  tagline: string;
  /** Longer, for the expansion's own page. */
  description: string;
  publisher: string;
  /** The expansion's own version, which moves independently of the application's. */
  release: string;
  entitlement: UniverseEntitlementKind;
  /** The lucide icon name the switcher draws. Unknown names fall back rather than throw. */
  icon: string;
  /** What the document in this universe is called: a "production", a "session", a "roll". */
  documentNoun: string;
  stages: UniverseStage[];
  panels: UniversePanel[];
  /** Generator ids this universe offers. Defined in `generators.ts`; named here. */
  generators: string[];
}

/**
 * The person's own arrangement of a universe's workbench, which outranks the manifest.
 *
 * Stored per universe rather than per document: you arrange a workbench once and then work in
 * it, the same way nobody re-arranges their desk per project. Panel ids that no longer exist are
 * dropped on read, so an expansion update that retires a panel does not strand a dead region.
 */
export interface UniverseLayout {
  version: 1;
  universeId: string;
  /** Panel id → where the person put it. Absent means "wherever the manifest said". */
  regions: Record<string, UniverseRegion>;
  /** Panel id → whether it is open. Absent means "whatever the manifest said". */
  open: Record<string, boolean>;
  /** Region → pixels. Absent means the default for that region. */
  sizes: Partial<Record<UniverseRegion, number>>;
  /** The stage last worked in, so re-entering a universe resumes rather than resets. */
  stageId: string | null;
  /**
   * The document open in this universe — a production, for Movie.
   *
   * Here rather than in the renderer's own state for two reasons. Re-entering a universe should
   * resume the thing you were working on, and the model's tools need to know which document a
   * turn is about. Making it a tool argument instead would mean a model that could name one
   * production could name any of them.
   */
  documentId: string | null;
  /** Whether the floating chat is up, and where it was left. */
  atoma: { open: boolean; x: number; y: number; width: number; height: number } | null;
  updatedAt: string;
}

export const DEFAULT_REGION_SIZES: Record<UniverseRegion, number> = {
  left: 260,
  main: 0,
  right: 320,
  bottom: 220,
};

/** The floating chat's resting size, and the bounds past which it is being resized by accident. */
export const ATOMA_MIN_WIDTH = 280;
export const ATOMA_MIN_HEIGHT = 240;
export const ATOMA_DEFAULT_WIDTH = 380;
export const ATOMA_DEFAULT_HEIGHT = 460;

const str = (value: unknown, limit: number): string => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

/** An id reaches a file name and a React key, so it is strict about what it accepts. */
export const UNIVERSE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isUniverseId(value: unknown): value is string {
  return typeof value === 'string' && UNIVERSE_ID_PATTERN.test(value);
}

/**
 * The id of something inside a universe — a panel, a stage, a shot.
 *
 * Looser than a universe id because these never reach a path, and stricter than free text
 * because they are referenced by name from manifests and from tool calls.
 */
export const UNIVERSE_MEMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isMemberId(value: unknown): value is string {
  return typeof value === 'string' && UNIVERSE_MEMBER_PATTERN.test(value);
}

function normalizePanel(value: unknown): UniversePanel | null {
  const source = (value && typeof value === 'object' ? value : null) as Partial<UniversePanel> | null;
  if (!source) return null;
  const id = str(source.id, UNIVERSE_ID_LIMIT);
  if (!isMemberId(id)) return null;
  if (!UNIVERSE_PANEL_KINDS.includes(source.kind as UniversePanelKind)) return null;
  const region = UNIVERSE_REGIONS.includes(source.region as UniverseRegion)
    ? (source.region as UniverseRegion)
    : 'right';
  return {
    id,
    kind: source.kind as UniversePanelKind,
    title: str(source.title, UNIVERSE_NAME_LIMIT) || id,
    region,
    open: source.open !== false,
  };
}

function normalizeStage(value: unknown, panelIds: ReadonlySet<string>): UniverseStage | null {
  const source = (value && typeof value === 'object' ? value : null) as Partial<UniverseStage> | null;
  if (!source) return null;
  const id = str(source.id, UNIVERSE_ID_LIMIT);
  if (!isMemberId(id)) return null;
  // A stage naming a panel that is not in the manifest would bring forward nothing; the
  // reference is dropped rather than the stage, so the rest of it still works.
  const panels = (Array.isArray(source.panels) ? source.panels : [])
    .map((entry) => str(entry, UNIVERSE_ID_LIMIT))
    .filter((entry) => panelIds.has(entry))
    .slice(0, UNIVERSE_PANEL_LIMIT);
  return {
    id,
    name: str(source.name, UNIVERSE_NAME_LIMIT) || id,
    intent: str(source.intent, UNIVERSE_TEXT_LIMIT),
    panels,
  };
}

/**
 * Read a manifest, or reject it.
 *
 * Whole-manifest rejection rather than per-field repair: a universe whose id or panels could not
 * be read is not a universe with a missing field, it is something that should not appear in the
 * switcher at all. Everything past that point is bounded and defaulted, so a manifest that
 * passes here opens a workbench rather than a half-built one.
 */
export function normalizeManifest(value: unknown): UniverseManifest | null {
  const source = (value && typeof value === 'object' ? value : null) as Partial<UniverseManifest> | null;
  if (!source) return null;
  const id = str(source.id, UNIVERSE_ID_LIMIT);
  if (!isUniverseId(id)) return null;

  const seen = new Set<string>();
  const panels: UniversePanel[] = [];
  for (const entry of Array.isArray(source.panels) ? source.panels : []) {
    const panel = normalizePanel(entry);
    if (!panel || seen.has(panel.id)) continue;
    seen.add(panel.id);
    panels.push(panel);
    if (panels.length >= UNIVERSE_PANEL_LIMIT) break;
  }
  // A workbench with no panels is a blank page with a name on it.
  if (!panels.length) return null;

  const stageIds = new Set<string>();
  const stages: UniverseStage[] = [];
  for (const entry of Array.isArray(source.stages) ? source.stages : []) {
    const stage = normalizeStage(entry, seen);
    if (!stage || stageIds.has(stage.id)) continue;
    stageIds.add(stage.id);
    stages.push(stage);
    if (stages.length >= UNIVERSE_STAGE_LIMIT) break;
  }

  const generators = (Array.isArray(source.generators) ? source.generators : [])
    .map((entry) => str(entry, UNIVERSE_ID_LIMIT))
    .filter(isMemberId)
    .slice(0, UNIVERSE_GENERATOR_LIMIT);

  const entitlement: UniverseEntitlementKind =
    source.entitlement === 'built-in' || source.entitlement === 'licensed' ? source.entitlement : 'included';

  return {
    version: 1,
    id,
    name: str(source.name, UNIVERSE_NAME_LIMIT) || id,
    tagline: str(source.tagline, UNIVERSE_TEXT_LIMIT),
    description: str(source.description, UNIVERSE_TEXT_LIMIT),
    publisher: str(source.publisher, UNIVERSE_NAME_LIMIT) || 'Execute',
    release: str(source.release, 32) || '0',
    entitlement,
    icon: str(source.icon, 32) || 'Atom',
    documentNoun: str(source.documentNoun, 32) || 'project',
    stages,
    panels,
    generators: [...new Set(generators)],
  };
}

export function emptyLayout(universeId: string): UniverseLayout {
  return {
    version: 1,
    universeId,
    regions: {},
    open: {},
    sizes: {},
    stageId: null,
    documentId: null,
    atoma: null,
    updatedAt: new Date().toISOString(),
  };
}

const size = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(Math.max(value, 120), 1200));
};

export function normalizeLayout(value: unknown, universeId: string): UniverseLayout {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<UniverseLayout>;
  const regions: Record<string, UniverseRegion> = {};
  for (const [key, where] of Object.entries(
    (source.regions && typeof source.regions === 'object' ? source.regions : {}) as Record<string, unknown>
  )) {
    if (!isMemberId(key)) continue;
    if (UNIVERSE_REGIONS.includes(where as UniverseRegion)) regions[key] = where as UniverseRegion;
  }
  const open: Record<string, boolean> = {};
  for (const [key, shown] of Object.entries(
    (source.open && typeof source.open === 'object' ? source.open : {}) as Record<string, unknown>
  )) {
    if (isMemberId(key) && typeof shown === 'boolean') open[key] = shown;
  }
  const sizes: Partial<Record<UniverseRegion, number>> = {};
  for (const region of UNIVERSE_REGIONS) {
    const stored = (source.sizes as Record<string, unknown> | undefined)?.[region];
    if (typeof stored === 'number' && Number.isFinite(stored)) sizes[region] = size(stored, DEFAULT_REGION_SIZES[region]);
  }
  const atomaSource = (source.atoma && typeof source.atoma === 'object' ? source.atoma : null) as
    | Partial<NonNullable<UniverseLayout['atoma']>>
    | null;
  const stageId = str(source.stageId, UNIVERSE_ID_LIMIT);
  const documentId = str(source.documentId, UNIVERSE_ID_LIMIT);
  return {
    version: 1,
    universeId,
    regions,
    open,
    sizes,
    stageId: isMemberId(stageId) ? stageId : null,
    documentId: isMemberId(documentId) ? documentId : null,
    atoma: atomaSource
      ? {
          open: atomaSource.open === true,
          // Positions are clamped on display against the real window, so only sanity is enforced.
          x: typeof atomaSource.x === 'number' && Number.isFinite(atomaSource.x) ? Math.round(atomaSource.x) : 0,
          y: typeof atomaSource.y === 'number' && Number.isFinite(atomaSource.y) ? Math.round(atomaSource.y) : 0,
          width: Math.max(ATOMA_MIN_WIDTH, size(atomaSource.width, ATOMA_DEFAULT_WIDTH)),
          height: Math.max(ATOMA_MIN_HEIGHT, size(atomaSource.height, ATOMA_DEFAULT_HEIGHT)),
        }
      : null,
    updatedAt: str(source.updatedAt, 64) || new Date().toISOString(),
  };
}

/**
 * The manifest as the workbench should actually draw it: the person's layout applied over the
 * manifest's own arrangement.
 *
 * Resolved here rather than in the component so that main, the renderer and a test all agree on
 * what "open" means for a panel nobody has touched yet.
 */
export function resolvePanels(manifest: UniverseManifest, layout: UniverseLayout): UniversePanel[] {
  return manifest.panels.map((panel) => ({
    ...panel,
    region: layout.regions[panel.id] ?? panel.region,
    open: layout.open[panel.id] ?? panel.open,
  }));
}

/** The panels of one region, in manifest order, with the closed ones left out. */
export function panelsInRegion(panels: readonly UniversePanel[], region: UniverseRegion): UniversePanel[] {
  return panels.filter((panel) => panel.region === region && panel.open);
}

/**
 * Entering a stage: the panels it names are brought forward, and nothing else is touched.
 *
 * Opening what a stage asks for without closing what it does not is the whole difference between
 * a workbench and a wizard. Someone who keeps the queue open through every stage keeps it.
 */
export function enterStage(layout: UniverseLayout, stage: UniverseStage): UniverseLayout {
  const open = { ...layout.open };
  for (const id of stage.panels) open[id] = true;
  return { ...layout, open, stageId: stage.id, updatedAt: new Date().toISOString() };
}

/**
 * What the renderer is given for one universe: what it is, how it is arranged, and whether it
 * opens. Carried together because a workbench cannot be drawn without all three, and fetching
 * them separately would mean a frame in which a universe is open but unlicensed.
 */
export interface UniverseView {
  manifest: UniverseManifest;
  layout: UniverseLayout;
  entitlement: import('./universeLicences').Entitlement;
  /** The expansion's directory on disk, or null for a built-in. */
  root: string | null;
}

/** A layout change. Only the fields present are merged; the rest are left as they were. */
export interface UniverseLayoutPatch {
  regions?: Record<string, UniverseRegion>;
  open?: Record<string, boolean>;
  sizes?: Partial<Record<UniverseRegion, number>>;
  stageId?: string | null;
  documentId?: string | null;
  atoma?: UniverseLayout['atoma'];
}

export interface UniverseGeneratorView {
  spec: import('./generators').GeneratorSpec;
  binding: import('./generators').GeneratorBinding;
  problem: string | null;
}

export interface UniversesAPI {
  list(): Promise<UniverseView[]>;
  /** Merge a layout change for one universe and get the settled layout back. */
  layout(universeId: string, patch: UniverseLayoutPatch): Promise<UniverseLayout>;
  /** Every universe's entitlement, for the licence manager. */
  entitlements(): Promise<import('./universeLicences').Entitlement[]>;
  /** Install a licence from pasted text. Throws with a readable reason when it does not verify. */
  installLicence(text: string): Promise<import('./universeLicences').Entitlement>;
  removeLicence(universeId: string): Promise<import('./universeLicences').Entitlement>;
  generators(): Promise<UniverseGeneratorView[]>;
  bindGenerator(generatorId: string, patch: Partial<import('./generators').GeneratorBinding>):
    Promise<UniverseGeneratorView[]>;
}

/** The Movie universe's own surface. Separate because a universe's documents are its own. */
export interface MovieAPI {
  list(): Promise<import('./movie').ProductionSummary[]>;
  create(title: string): Promise<import('./movie').Production>;
  read(productionId: string): Promise<import('./movie').Production>;
  edit(productionId: string, edits: import('./movie').ProductionEdit[]): Promise<import('./movie').Production>;
  remove(productionId: string): Promise<import('./movie').ProductionSummary[]>;
}
