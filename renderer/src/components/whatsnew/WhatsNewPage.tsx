import { useEffect, useState } from 'react';
import { X, Sparkles } from 'lucide-react';

interface ChangeLogEntry {
  version: string;
  date: string;
  changes: string[];
}

export const changeLog: ChangeLogEntry[] = [
  {
    version: 'v23',
    date: '2026-11-13',
    changes: [
      'Rust and C++ projects with build, test, run, language services, LLDB debugging, and a visual source board',
      'Cluster vitals and engine controls, a security findings dashboard, and feature flags with a native C and Matrix SDK',
      'Comms and Email plugins for Discord, Slack, Teams, Outlook, Google, and Yahoo, using your app registrations and project-specific agent permissions',
      'Private chat notes, optional idle compaction, one-click Carbon copying, and compact transcript controls',
      'Nested project groups, private import sections, chat ordering, and consolidated settings',
      'Custom window chrome, configurable shortcuts and send controls, complete themes, and an optional saved-reply pad',
      'Playable Doom with Freedoom data and persistent saves; all required runtime files and notices ship in the package',
    ],
  },
  {
    version: 'v22',
    date: '2026-11-05',
    changes: [
      'Execute Software core-team credits and community contribution guidance',
      'Enterprise licensing and support contact in the project README',
    ],
  },
  {
    version: 'v21',
    date: '2026-11-04',
    changes: [
      'Public source repositories, standalone documentation, and the MIT license for Antimatter',
      'Updates require an explicitly selected trusted release folder; discovering a network share never authorizes installation',
      'Updated Electron and provider dependencies, with release inventories for the packaged runtimes and JavaScript licenses',
      'Desktop releases can ship independently while Android remains an unsigned build artifact that cannot be installed on a phone',
    ],
  },
  {
    version: 'v3',
    date: '2026-09-26',
    changes: [
      'Native spell checking in the message composer, with right-click corrections, Add to dictionary, and standard editing actions',
      'Corrections update the unsent draft without sending, preserving attachments, undo, and ongoing-agent steering',
      'Spell checking follows the system/session language; words stay local, although language dictionaries may download on Linux or Windows',
    ],
  },
  {
    version: 'v2',
    date: '2026-09-26',
    changes: [
      'Dark and light themes with one customizable accent for actions, focus, highlights, and companion windows; appearance is saved across restarts',
      'Live appearance updates across the workspace, About window, desktop companion, code editor, and terminal without restarting shells or discarding editor state',
      'Drag the desktop companion, its name, or status area to move it; compact icon controls stay clickable and the position is remembered',
      'Eight complete Model test prompts in Developer, from small command-line tools to full local applications, with exact-text copy and a manual selection fallback',
      'Review and import Claude exports, Claude Code sessions, Codex rollout files, and official OpenCode v1 session JSON exports into new Antimatter conversations',
      'Foldable Claude chats, Codex chats, and OpenCode chats sidebar groups with search, saved expansion state, and the existing pin, rename, and delete controls',
      'Imported text and tool history stay historical: no command replay, attachment fetching, or inherited permissions; review private content before continuing with a provider',
      'The Linux runtime baseline remains native Beholdd CPU plus llama.cpp Vulkan compatibility, with the pinned 30B coder installer default; Android remains a separate testing/signing track',
    ],
  },
  {
    version: 'v1.0.0',
    date: '2026-09-26',
    changes: [
      'A unified Model Library for local engines, OpenAI, Anthropic, OpenCode Zen, and compatible sources, with source-scoped models and prompts',
      'Live permissions: changes apply to pending and future chat and child-agent tool calls; privileged actions still require confirmation',
      'One inline or floating terminal for manual shells and approved built-in commands, with private interactive input for sudo',
      'A dockable Preview panel with embedded Web and Images browsers, navigation, reload, and agent-selected content beside the chat',
      'Chronological child-agent transcripts, restored history, live guidance, stop controls, and parent permission limits',
      'Local skills and reviewed plugins, persistent schedules, read-only GitHub pull request browsing, and editable follow-up suggestions',
      'Optional desktop avatars and explicit microphone sessions for voice pair programming; this first voice version is utterance-based and half-duplex',
      'Settings grouped into General, Models & providers, Voice, Remote devices, and Updates & about',
      'Android companion improvements: QR pairing, real host projects and conversations, approvals, reconnect, and encrypted unsent drafts; mobile distribution remains a separate testing/signing track',
      'Verified managed updates install in the background and restart only when active work, voice, and unsaved edits are clear',
    ],
  },
  {
    version: 'v0.1.0-alpha.2',
    date: '2026-09-19',
    changes: [
      'Interleaved assistant text and tool activity in true transcript order',
      'Durable conversations, partial responses, Carbons, and orchestrator recovery',
      'Accurate context budgeting and protocol-safe rolling compaction',
      'Tool execution checkpoints that prevent unsafe blind retries after interruption',
      'Strict OpenAI-compatible stream validation and repaired persisted tool arguments',
      'Tray-backed desktop lifetime, automatic bundled Beholdd startup, and managed updates',
      'Preserved source vision capabilities and an explicit native Beholdd vision boundary',
    ],
  },
  {
    version: 'v0.1.0-alpha.1',
    date: '2026-09-13',
    changes: [
      'First Linux alpha release of Antimatter',
      'Multi-source inference with local tools and permissions',
      'Persistent conversations and Codex-style orchestration',
      'Snitch issue tracking, system vitals, terminal, previews, and the Model Hub',
      'User-local installer with a pinned Qwen3-Coder 30B model',
    ],
  },
];

export function WhatsNewPage({ onClose }: { onClose: () => void }) {
  const [currentVersion, setCurrentVersion] = useState<string>('');

  useEffect(() => {
    const savedVersion = localStorage.getItem('antimatter.lastSeenVersion') || '';
    setCurrentVersion(savedVersion);
  }, []);

  const handleVersionChange = (newVersion: string) => {
    localStorage.setItem('antimatter.lastSeenVersion', newVersion);
    setCurrentVersion(newVersion);
  };

  const packagedVersion = window.electronAPI.about.info.releaseVersion ?? `v${window.electronAPI.about.info.version}`;
  const latestVersion = changeLog.find((entry) => entry.version === packagedVersion)?.version ?? changeLog[0]?.version ?? '';

  return (
    <div className="absolute inset-0 overflow-y-auto bg-surface">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
        <Sparkles size={16} className="text-primary" />
        <h1 className="text-sm font-semibold text-ink">What's New</h1>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink"
        >
          <X size={12} />
          Close
        </button>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 py-5">
        <div className="mb-6 rounded-lg border border-line bg-surface-2 p-4">
          <div className="flex items-start gap-3">
            <Sparkles size={24} className="mt-0.5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold text-ink">Welcome to Antimatter</h2>
              <p className="mt-1 text-ink-2">
                You're viewing the latest updates to Antimatter. This changelog keeps you informed about what's new in each release.
              </p>
            </div>
          </div>
        </div>

        <div className="mb-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-3">Release Notes</h2>
          <p className="mt-1 text-xs text-ink-2">
            View the changes in each release to understand what's new and improved.
          </p>
        </div>

        <div className="space-y-4">
          {changeLog.map((entry) => (
            <div key={entry.version} className="rounded-lg border border-line bg-surface-2 p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-ink">
                  {entry.version} <span className="text-xs text-ink-3">({entry.date})</span>
                </h3>
                {entry.version === latestVersion && (
                  <span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">Latest</span>
                )}
              </div>
              
              <ul className="mt-2 space-y-1">
                {entry.changes.map((change, index) => (
                  <li key={index} className="flex items-start gap-2 text-sm text-ink-2">
                    <span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary/60"></span>
                    <span>{change}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-lg border border-line bg-surface-2 p-4">
          <h3 className="font-medium text-ink">Stay Updated</h3>
          <p className="mt-2 text-sm text-ink-2">
            With automatic updates enabled, an installed Antimatter checks the configured release share,
            installs verified updates in the background, and restarts when active work, voice, and unsaved
            edits are clear. You can also choose Restart now or disable automatic updates in Settings.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button 
              onClick={() => handleVersionChange(latestVersion)}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-on-primary transition hover:bg-primary-strong"
            >
              Mark as Read
            </button>
            <span className="text-xs text-ink-3">
              {currentVersion ? `Last viewed: ${currentVersion}` : 'Not yet viewed'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
