import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migratePrivateFile, writePrivateFileAtomic } from '../privateState';
import { location } from './store';

/**
 * Who Antimatter is talking to.
 *
 * A model with no idea who it is working for addresses nobody. It cannot greet the person, cannot
 * refer to them in a note it writes about them, and asks again next week what it was told on
 * Monday. This is the smallest thing that fixes it: a name, how to refer to them, and whatever
 * they want to say about themselves.
 *
 * It is deliberately not the same as the notes beside it. Notes are what the model works out as
 * it goes; this is an identity card, filled in on the Settings page in the person's own words —
 * except the name and pronouns, which the model may fill in when it is told them, because being
 * told your name and writing it down is the ordinary way of learning it.
 *
 * Kept in ~/.antimatter/user.json with the rest of the runtime state, readable and private
 * (0600): it is personal, and it is one short file a person can open, edit or delete.
 */

export interface Person {
  /** What Antimatter calls them. Empty until somebody says. */
  name: string;
  /** How to refer to them in the third person. Empty means they/them rather than a guess. */
  pronouns: string;
  /** Their own words about themselves. Written on the Settings page; the model never edits it. */
  about: string;
  /** When any of it last changed, in ms since the epoch; 0 while nothing has been set. */
  updatedAt: number;
}

interface PersonFile extends Person {
  version: 1;
}

export const EMPTY: Person = { name: '', pronouns: '', about: '', updatedAt: 0 };

export const MAX_NAME = 60;
export const MAX_PRONOUNS = 40;
export const MAX_ABOUT = 2_000;

let cache: { path: string; person: Person } | null = null;

const file = (): string => join(location(), 'user.json');

const oneLine = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';

const block = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, limit) : '';

export function normalize(value: unknown, updatedAt = 0): Person {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<Person>;
  return {
    name: oneLine(source.name, MAX_NAME),
    pronouns: oneLine(source.pronouns, MAX_PRONOUNS),
    about: block(source.about, MAX_ABOUT),
    updatedAt: Number.isFinite(source.updatedAt) && source.updatedAt! > 0 ? source.updatedAt! : updatedAt,
  };
}

export function read(): Person {
  const path = file();
  if (cache?.path === path) return cache.person;
  if (!existsSync(path)) {
    cache = { path, person: EMPTY };
    return EMPTY;
  }
  migratePrivateFile(path);
  let person = EMPTY;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersonFile> | null;
    if (parsed?.version === 1) person = normalize(parsed);
  } catch (error) {
    // An unreadable card is one Antimatter knows nothing from, which is where it started.
    console.error('[memory] unreadable user.json, carrying on without it:', error);
  }
  cache = { path, person };
  return person;
}

/**
 * Changes the fields given and leaves the rest alone, so the model recording a name cannot wipe
 * what the person wrote about themselves. An empty string clears a field on purpose.
 */
export function save(patch: unknown, now = Date.now()): Person {
  const source = (patch && typeof patch === 'object' ? patch : {}) as Partial<Person>;
  const current = read();
  const next = normalize(
    {
      name: source.name === undefined ? current.name : source.name,
      pronouns: source.pronouns === undefined ? current.pronouns : source.pronouns,
      about: source.about === undefined ? current.about : source.about,
    },
    now
  );
  const unchanged = next.name === current.name && next.pronouns === current.pronouns && next.about === current.about;
  const person = unchanged ? current : next;
  if (!unchanged) {
    const stored: PersonFile = { version: 1, ...person };
    writePrivateFileAtomic(file(), `${JSON.stringify(stored, null, 2)}\n`);
  }
  cache = { path: file(), person };
  return person;
}

/** True when there is nothing to tell a conversation. */
export const unknown = (person: Person): boolean => !person.name && !person.pronouns && !person.about;

/** Test and shutdown helper; the cache is otherwise keyed on the file it was read from. */
export const forget = (): void => {
  cache = null;
};
