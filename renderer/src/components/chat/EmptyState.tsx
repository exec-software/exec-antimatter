import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';

/**
 * What a new conversation looks like before anyone says anything.
 *
 * The line under the name rotates. It is the only part of the app that is allowed to be funny,
 * and it earns its place by doing a job: two empty chats look identical, so without it clicking
 * "New chat" changes nothing on screen and feels broken. A fresh quip is the receipt.
 *
 * It stops being funny when there is something to fix — with no source configured, the line is
 * the instruction instead, because a joke in front of a blocked user is just noise.
 */

const QUIPS = [
  "I've read your code. I'm not going to bring it up.",
  'Ready to turn electricity into merge conflicts.',
  'Another beautiful morning in the node_modules mines.',
  "I have seventeen tools and very little impulse control.",
  'Local inference: no telemetry, no cloud, just your fans.',
  'git push --force is optimism with consequences.',
  'Your workspace called. It would like its disk space back.',
  'Somewhere a test is failing, and it has always been failing.',
  'I can fix that bug. I can also file it, if you would rather wait.',
  'The orchestrator is awake and has opinions about your Todo column.',
  'Ctrl+` for a shell. I will not watch. Much.',
  'Antimatter: like matter, but it deletes things.',
  'Two models walk into a context window.',
  'The answer is in the logs. The answer is always in the logs.',
  'Temperature zero. Personality: unaffected.',
  'No, I do not know why it works either.',
  'Every codebase is a haunted house. I brought a flashlight.',
  'Ask me anything. Ask me twice for a second opinion.',
  'TODO: write a better tagline.',
];

/**
 * A few that use your name, once Antimatter has been told it (Settings → About you). Kept to a
 * handful: an assistant that says your name in every line is not friendly, it is uncanny.
 */
const personal = (name: string | null): string[] => {
  if (!name) return [];
  return [
    `Hello, ${name}. What are we breaking today?`,
    `${name}. Good. I was starting to talk to myself.`,
    `Ready when you are, ${name}.`,
  ];
};

/** The workspace is the one thing the joke can know about, so a few of them use it. */
const contextual = (directory: string | null): string[] => {
  if (!directory) return [];
  const name = directory.split(/[\\/]/).filter(Boolean).pop() ?? directory;
  return [
    `Welcome to ${name}. I will try not to break anything you would miss.`,
    `${name} looks fine from here. I have not opened it yet.`,
    `Finished reading ${name}. We should talk about some of it.`,
  ];
};

const ROTATE_MS = 9000;

interface Props {
  /** Changes whenever a new conversation opens, so the line restarts on something fresh. */
  seed: number;
  hasSources: boolean;
  workspace: string | null;
  /** What Antimatter calls you, when it has been told. */
  name: string | null;
}

export function EmptyState({ seed, hasSources, workspace, name }: Props) {
  const quips = useMemo(() => [...QUIPS, ...contextual(workspace), ...personal(name)], [workspace, name]);
  const [index, setIndex] = useState(() => Math.floor(Math.random() * quips.length));

  // A new conversation gets a new line rather than continuing the rotation from where it was.
  useEffect(() => {
    setIndex(Math.floor(Math.random() * quips.length));
  }, [seed, quips.length]);

  useEffect(() => {
    if (!hasSources) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % quips.length), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [hasSources, quips.length]);

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <Sparkles size={28} className="mx-auto mb-3 text-primary" />
        <h2 className="wordmark text-2xl text-ink">Antimatter</h2>

        {hasSources ? (
          // Keyed on the index so each line remounts and plays its entrance.
          <p key={index} className="quip mt-2 text-sm italic leading-relaxed text-ink-3">
            {quips[index]}
          </p>
        ) : (
          <p className="mt-2 text-sm leading-relaxed text-ink-3">
            Add an inference source in Settings to get started.
          </p>
        )}
      </div>
    </div>
  );
}
