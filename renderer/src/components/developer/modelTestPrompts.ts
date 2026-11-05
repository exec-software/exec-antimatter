export interface ModelTestPrompt {
  id: string;
  category: 'warmup' | 'browser' | 'service' | 'integrated';
  title: string;
  description: string;
  focus: readonly string[];
  prompt: string;
}

export const MODEL_TEST_CATEGORIES = [
  { id: 'warmup', title: '1 · Small tools', description: 'Short projects to check file editing, commands, and honest verification.' },
  { id: 'browser', title: '2 · Browser applications', description: 'Interactive UI, accessibility, state, and local Preview workflows.' },
  { id: 'service', title: '3 · Services and data', description: 'Validation, persistence, failure cases, and useful independent review.' },
  { id: 'integrated', title: '4 · Integrated projects', description: 'Several components with bounded delegation, integration, and end-to-end checks.' },
] as const;

const SAFETY = `Work only in the disposable, user-selected scratch workspace for this test. Inspect the workspace and available toolchain before editing. Preserve existing work: if the directory is not empty, create a clearly named new project subdirectory and do not overwrite unrelated files. Do not delete user data, change system settings, use sudo, read real credentials, or contact production services. Use synthetic fixtures, loopback-only development servers, and local files. Do not deploy, publish, push commits, or install global packages. Prefer installed tools and libraries; if a required dependency needs a download, ask before fetching it. If the environment cannot support a requirement, report the exact limitation rather than claiming it worked.`;

const WORKFLOW = `Build the working project, not just a design or a wall of suggested code. Briefly state your plan, use the tools actually available to inspect and edit files, then run the relevant commands and tests. Use at most two specialist agents, only for genuinely independent work that can proceed alongside your own useful work. Give each a bounded task and separate file ownership; if delegation is unavailable or adds no value, work locally and say so. You remain responsible for integrating and reviewing every change. Do not invent tool names or assume a capability exists. Never treat an agent's success report as a substitute for your own integration checks.`;

const FINISH = `Finish with a concise handoff: what was built, the project path, exact local run/test commands, tests actually run and their results, any limitations or failures, and how to stop any development server you left running. Distinguish automated checks from manual inspection and from checks you could not perform. Do not claim a preview was viewed or a test passed unless you observed it.`;

function completePrompt(project: string, requirements: string): string {
  return `Build this project: ${project}\n\n${requirements}\n\nWorkspace and safety\n${SAFETY}\n\nWorking method\n${WORKFLOW}\n\nHandoff\n${FINISH}`;
}

export const MODEL_TEST_PROMPTS: readonly ModelTestPrompt[] = [
  {
    id: 'tiny-tasks', category: 'warmup', title: 'Tiny tasks CLI',
    description: 'A small persistent command-line app with real validation and tests.',
    focus: ['Shell use', 'File editing', 'Persistence', 'Unit tests'],
    prompt: completePrompt('Tiny tasks — a Python task-list command-line application', `Create a small Python 3 standard-library project named tiny-tasks. Support adding a task, listing tasks, marking one done, reopening it, and deleting a task by a stable numeric ID. Store data in a JSON file inside the new project directory by default; provide an explicit data-file option for isolated tests. A new list should start empty, not with user data.

Requirements:
- Provide clear --help output, useful success messages, and nonzero exit codes for invalid input, unknown IDs, or an unreadable/corrupt data file.
- Reject blank titles, preserve Unicode titles, never recycle deleted IDs, and leave the previous data file intact if a write fails.
- Keep persistence and command parsing separate enough to test without launching the whole application.
- Add standard-library unit tests for the normal lifecycle, invalid IDs, empty titles, corrupt JSON, and persistence across separate invocations.
- Include a README with copyable example commands. Run the automated tests and demonstrate a complete add/list/done cycle using a temporary test data file.

Keep this small project local rather than delegating for the sake of delegation. Review the actual generated files before finishing.`),
  },
  {
    id: 'folder-audit', category: 'warmup', title: 'Folder audit report',
    description: 'Deterministic file analysis, synthetic fixtures, and a useful CLI report.',
    focus: ['Filesystem boundaries', 'Determinism', 'Error handling', 'Tests'],
    prompt: completePrompt('Folder audit — a read-only file inventory and duplicate detector', `Create a Python 3 standard-library CLI named folder-audit. It scans one explicitly supplied directory within this scratch workspace and prints a sorted report of relative file names, byte sizes, extension totals, and duplicate groups identified by SHA-256. Offer both human-readable output and machine-readable JSON. Do not scan the home directory or follow symlinks outside the selected directory.

Requirements:
- Traverse deterministically, distinguish empty files from missing files, and avoid loading a large file entirely into memory just to hash it.
- Ignore symlinks and report that they were skipped. Collect per-file read errors without silently dropping them; return a documented partial-failure exit code.
- Never modify scanned files. Allow a report output path only outside the scanned fixture directory so the report does not become part of its own next scan.
- Generate a synthetic fixture with duplicate contents under different names, unique contents, an empty file, Unicode names, nested folders, and a symlink when the platform permits it.
- Test sorting, extension aggregation, duplicate grouping, ignored links, and failure reporting. Compare two runs over the same fixture to prove stable results.
- Document the command, JSON shape, and limitations. Use one local implementation and review pass; no specialist agent is needed for this size.`),
  },
  {
    id: 'recipe-notebook', category: 'browser', title: 'Offline recipe notebook',
    description: 'A complete small web app with keyboard access, search, and local persistence.',
    focus: ['UI implementation', 'Accessibility', 'Local state', 'Web preview'],
    prompt: completePrompt('Recipe notebook — an offline-first browser application', `Build a polished but compact recipe notebook using HTML, CSS, and JavaScript, or the workspace's existing web toolchain if one is already present. Seed it with six fictional recipes. Users must be able to search by title or ingredient, filter by meal type, mark favorites, and add/edit/delete their own recipes. Persist changes locally in the browser without an account or remote backend.

Requirements:
- Use one coherent responsive layout with a recipe list and detail/editor view. Include useful empty, no-results, and invalid-input states.
- Require a title and at least one ingredient. Make all controls keyboard accessible with visible focus and clear field labels. Confirm destructive deletion.
- Handle malformed or unavailable browser storage without crashing or reporting an unsaved recipe as saved.
- Test the search/filter combination, favorites, form validation, and storage recovery with the tools already available. Do not substitute a passing build for behavior tests.
- Start a development server bound to loopback. If an embedded browser/preview capability is available, open the real running page, inspect a narrow and wide layout, and exercise one full edit flow. Report missing browser access honestly instead of inventing observations.
- Include a README with local run and test commands. If a specialist is useful, assign at most one independent accessibility/test review while you implement; integrate and verify the findings yourself.`),
  },
  {
    id: 'kanban-board', category: 'browser', title: 'Accessible project board',
    description: 'A richer browser state model with undo, import/export, and reliable interactions.',
    focus: ['State modeling', 'Keyboard interactions', 'Import validation', 'Web preview'],
    prompt: completePrompt('Project board — a local Kanban application', `Build a browser-based project board with Backlog, In progress, and Done columns. Cards have a title, description, priority, and optional due date. Support creating/editing/deleting cards, moving them between columns, searching, and filtering by priority. Use synthetic sample cards only. Prefer the existing web toolchain; otherwise choose a minimal local implementation.

Requirements:
- Every move must work with keyboard-accessible controls; drag-and-drop is optional, not the only way to use the board.
- Persist board state locally, offer JSON export/import, validate imported data before replacing anything, and ask for confirmation before replacing a nonempty board.
- Implement undo for the latest card deletion and move. Keep stable card IDs and prevent duplicate IDs after import.
- Separate the state operations from UI rendering. Test moves, undo, combined filters, invalid imports, duplicate IDs, and a browser-storage failure. Include a concise manual keyboard checklist.
- Run a loopback development server and use available preview/browser tools to inspect the actual page, a narrow layout, and one complete create/move/undo flow. Do not claim manual checks you cannot perform.
- You may delegate one independent test or accessibility review with bounded scope while implementing. Review the result, run integration checks, and fix any issues before the handoff.`),
  },
  {
    id: 'inventory-service', category: 'service', title: 'Local inventory service',
    description: 'A small API with SQLite transactions, validation, and a clear contract.',
    focus: ['API design', 'Transactions', 'Integration tests', 'Review'],
    prompt: completePrompt('Inventory service — a loopback-only API with a SQLite database', `Create a small local inventory API using the available language/toolchain, preferably Python 3 and SQLite with no new external dependency. Use a fresh database inside this scratch project. An item has a unique SKU, a name, and a nonnegative quantity. Support listing, creating, renaming, and removing items, plus a stock-adjustment operation that records a timestamped ledger entry with a reason.

Requirements:
- Define and document a concise HTTP/JSON contract with example requests. Bind only to 127.0.0.1; this is a local test service, not a public or authenticated production server.
- Reject duplicate SKUs, blank fields, malformed JSON, oversized request bodies, and adjustments that would make stock negative. Return consistent structured errors and meaningful status codes.
- Apply each stock adjustment and its ledger entry in one transaction. Failed adjustments must change neither the quantity nor the ledger.
- Add unit tests for validation and temporary-database integration tests for normal operations, rollback, persistence after reopen, and two competing adjustments.
- Start the real service on an available loopback port and exercise the documented API with command-line HTTP requests. Stop the test instance after verification.
- A specialist may independently review the API/error contract or write tests in a separately owned test file while you implement. Keep at most two specialists and integrate their work before running the whole suite.`),
  },
  {
    id: 'knowledge-index', category: 'service', title: 'Knowledge-base indexer',
    description: 'A testable data pipeline that produces an inspectable local web report.',
    focus: ['Data pipeline', 'Incremental work', 'Safe HTML', 'Preview'],
    prompt: completePrompt('Knowledge index — a Markdown note indexer and local search report', `Build a local tool that indexes a directory of synthetic Markdown notes and produces a searchable HTML report. Each note has a title from its first heading, relative path, headings, word count, and outgoing Markdown links. Include full-text keyword search with short result snippets and a report of broken relative links. State which subset of Markdown link syntax you support rather than pretending to implement the entire format.

Requirements:
- Create fixture notes with nested directories, spaces and Unicode in names, repeated words, a broken link, an external link, and text containing HTML-like characters.
- Keep source notes read-only. Resolve local links relative to each source note; never traverse outside the chosen note root. External links are cataloged but never fetched.
- Escape all note-derived content before placing it in HTML. Make search and results keyboard accessible and usable on a narrow screen.
- Add an incremental cache keyed by file identity/content so unchanged notes can be reused. A changed or deleted note must not leave stale search results. Keep the generated report and cache outside the note input directory.
- Test link resolution, escaping, ranking/tie ordering, cache invalidation, deletion, and malformed input recovery. Run the tool twice and then after changing one synthetic note to demonstrate the incremental path.
- Serve the report on loopback and inspect it through available browser/preview tools. Delegate only a bounded independent parser/security or UI/test review if it can run alongside useful local work.`),
  },
  {
    id: 'issue-workbench', category: 'integrated', title: 'Local issue workbench',
    description: 'An integrated API, browser UI, and test suite with clear ownership boundaries.',
    focus: ['Planning', 'Specialist delegation', 'Integration', 'End-to-end checks'],
    prompt: completePrompt('Issue workbench — a local full-stack issue tracker', `Build a complete local issue tracker with a small persistent API and a responsive browser UI. An issue has an ID, title, description, status, priority, labels, and an ordered comment history. Seed fictional issues only. Use the installed toolchain and a project-local database; do not connect to GitHub, any real tracker, or a cloud service.

Requirements:
- Support issue creation/editing, status transitions, comments, search, and combined status/priority/label filters. Include validation, empty/loading/error states, and a retry path after the API is temporarily unavailable.
- Preserve stable IDs and timestamps across server restarts. Prevent a stale edit from silently overwriting a newer edit by using an explicit revision/conflict check.
- First write a short API/data contract and divide ownership. If specialist delegation is available, use at most two independent specialists, such as UI implementation and API test/review, while you own the service and integration. Do not delegate mutually blocking work or let multiple agents rewrite the same files.
- Test validation, persistence, filtering, comment ordering, and edit conflicts. Add at least one automated API-level full lifecycle test, plus a browser lifecycle test if the environment supports it.
- Start loopback-only services and open the real UI in the available preview/browser. Inspect desktop and narrow layouts, keyboard navigation, and a create/edit/comment/filter flow. Clearly label manual versus automated checks.
- Review every component together, fix integration failures, rerun the relevant tests, and document exact setup/run/test/stop commands and remaining limitations.`),
  },
  {
    id: 'csv-lab', category: 'integrated', title: 'CSV exploration studio',
    description: 'A more demanding import, analysis, export, and browser workflow with failure recovery.',
    focus: ['Bounded parallel work', 'Data correctness', 'Failure recovery', 'Web preview'],
    prompt: completePrompt('CSV studio — a local data exploration application', `Build a local application for exploring synthetic CSV datasets. Provide a loopback API and browser UI for importing a CSV file, viewing a paginated table, sorting/filtering rows, inspecting column statistics, and exporting the current filtered result. Store imported datasets in a project-local database or documented local format. Include generated fixture data rather than real personal or business data.

Requirements:
- Handle quoted commas, escaped quotes, embedded newlines, Unicode, empty cells, and duplicate or missing headers with a documented policy. Do not use naive line splitting as the CSV parser.
- Validate file size and row limits before an unbounded import; report progress and useful row-level errors. A rejected or cancelled import must not leave a partially active dataset. Keep a previously successful dataset usable after failure.
- Define stable row identity, consistent numeric-versus-text sorting, filtering semantics, and statistics for empty or mixed-type columns. Export exactly the filtered rows, and mitigate spreadsheet formula injection when exporting user-derived cells.
- Begin with an architecture and data contract. Use at most two specialists for independent importer/test and UI/accessibility work when available, with separate file ownership; retain one owner for integration and resolve any contract disagreement before merging work.
- Test CSV edge cases, cancellation/rollback, sorting, statistics, pagination boundaries, and export correctness. Exercise one complete import/filter/export/reload cycle against the real local service, not only mocked components.
- Open the running UI through available browser/preview tools, inspect narrow/wide layouts and failure recovery, and review the final code for resource bounds and accidental external requests. Document unsupported file types and scaling limits instead of advertising production readiness.`),
  },
];

/** A missing/denied clipboard is a visible manual-copy path, never a send or execution path. */
export async function copyModelTestPrompt(prompt: ModelTestPrompt, clipboard?: Pick<Clipboard, 'writeText'>): Promise<boolean> {
  try {
    if (!clipboard) return false;
    await clipboard.writeText(prompt.prompt);
    return true;
  } catch {
    return false;
  }
}
