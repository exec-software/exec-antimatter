import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { BoardCard, BoardEdge, ProjectBoard, SaveProjectBoard, SaveProjectBoardResult } from '../../api/nativeProject';
import { nativeSourcePath } from './nativeProjects';
import * as files from './files';

const BOARD_PATH = '.antimatter/project-board.json';
const EMPTY_REVISION = createHash('sha256').update('').digest('hex');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function validate(root: string, cards: BoardCard[], edges: BoardEdge[]): void {
  if (!Array.isArray(cards) || cards.length > 500 || !Array.isArray(edges) || edges.length > 2000) throw new Error('The board supports up to 500 cards and 2000 connections.');
  const ids = new Set<string>(), paths = new Set<string>();
  for (const card of cards) {
    if (!card || typeof card.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(card.id) || ids.has(card.id) ||
        typeof card.path !== 'string' || !card.path || card.path.length > 2048 ||
        typeof card.label !== 'string' || card.label.length > 160 || !Number.isFinite(card.x) || !Number.isFinite(card.y) ||
        card.x < 0 || card.y < 0 || card.x > 20000 || card.y > 20000) throw new Error('Invalid project card.');
    const absolute = nativeSourcePath(root, card.path);
    if (absolute === resolve(root) || paths.has(absolute)) throw new Error('Each source file can appear once on the board.');
    ids.add(card.id); paths.add(absolute);
  }
  const seen = new Set<string>();
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string' || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || seen.has(`${edge.from}:${edge.to}`)) throw new Error('Invalid project connection.');
    seen.add(`${edge.from}:${edge.to}`);
    graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge.to]);
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('A source dependency cannot form a cycle.');
    if (visited.has(id)) return;
    visiting.add(id); for (const child of graph.get(id) ?? []) visit(child); visiting.delete(id); visited.add(id);
  };
  ids.forEach(visit);
}

export function readProjectBoard(root: string): ProjectBoard {
  const path = nativeSourcePath(root, BOARD_PATH);
  if (!existsSync(path)) return { root, revision: EMPTY_REVISION, cards: [], edges: [] };
  if (!statSync(path).isFile() || statSync(path).size > 1024 * 1024) throw new Error('The project board is too large or invalid.');
  const text = readFileSync(path, 'utf8');
  const value = JSON.parse(text);
  if (!value || value.version !== 1) throw new Error('Unsupported project board format.');
  validate(root, value.cards, value.edges);
  return { root, revision: hash(text), cards: value.cards, edges: value.edges };
}

export function saveProjectBoard(root: string, input: SaveProjectBoard): SaveProjectBoardResult {
  if (!input || resolve(input.root) !== resolve(root) || typeof input.expectedRevision !== 'string') throw new Error('The Code folder changed. Reopen its board.');
  validate(root, input.cards, input.edges);
  const current = readProjectBoard(root);
  if (current.revision !== input.expectedRevision) return { saved: false, board: current };
  const text = JSON.stringify({ version: 1, cards: input.cards, edges: input.edges }, null, 2) + '\n';
  const path = nativeSourcePath(root, BOARD_PATH);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    try { writeFileSync(path, text, { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { saved: false, board: readProjectBoard(root) };
      throw error;
    }
  } else {
    if (files.location() !== root) throw new Error('The Code folder changed. Reopen its board.');
    files.write(BOARD_PATH, text, { root, revision: current.revision });
  }
  return { saved: true, board: { root, revision: hash(text), cards: input.cards, edges: input.edges } };
}

/** Connections add a real Rust module declaration or a C++ include, using the editor's revision. */
export function connectProjectCards(root: string, input: SaveProjectBoard & { edge: BoardEdge; sourceRevision: string }): SaveProjectBoardResult {
  if (!input || !input.edge || typeof input.sourceRevision !== 'string') throw new Error('Invalid source connection.');
  const current = readProjectBoard(root);
  if (current.revision !== input.expectedRevision) return { saved: false, board: current };
  const nextEdges = [...input.edges.filter((edge) => edge.from !== input.edge.from || edge.to !== input.edge.to), input.edge];
  validate(root, input.cards, nextEdges);
  const source = input.cards.find((card) => card.id === input.edge.from)!;
  const dependency = input.cards.find((card) => card.id === input.edge.to)!;
  const from = nativeSourcePath(root, source.path), to = nativeSourcePath(root, dependency.path);
  if (!existsSync(to) || !statSync(to).isFile()) throw new Error('The dependency source file does not exist.');
  if (files.location() !== root || resolve(input.root) !== resolve(root)) throw new Error('The Code folder changed. Reopen its board.');
  const content = files.read(source.path);
  if (content.binary || content.revision !== input.sourceRevision) throw new Error('The source changed. Save or reopen it before connecting cards.');
  let text = content.text;
  if (extname(from) === '.rs' && extname(to) === '.rs') {
    const stem = basename(from, '.rs');
    const moduleDirectory = ['main', 'lib', 'mod'].includes(stem) ? dirname(from) : join(dirname(from), stem);
    const module = basename(to, '.rs');
    if (dirname(to) !== moduleDirectory || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(module) || module === 'mod') {
      throw new Error('Rust module files must be in the parent module’s directory. Use src/helper.rs from src/main.rs, or src/helper/child.rs from src/helper.rs.');
    }
    if (!new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+${module}\\s*;`, 'm').test(text)) text += `${text.endsWith('\n') ? '' : '\n'}\nmod ${module};\n`;
  } else if (/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(from) && /\.(?:h|hh|hpp|hxx)$/i.test(to)) {
    const include = relative(dirname(from), to).split(sep).join('/');
    if (/["\r\n<>]/.test(include)) throw new Error('This filename cannot be used in a C++ include.');
    const declaration = `#include "${include}"`;
    if (!text.split(/\r?\n/).some((line) => line.trim() === declaration)) text = declaration + '\n' + text;
  } else throw new Error('Connect a Rust source to a Rust module, or a C++ source to a C++ header.');
  if (text !== content.text) files.write(source.path, text, { root, revision: input.sourceRevision });
  // If another window updates the board now, retain the valid source declaration and return
  // its board conflict. Retrying is idempotent and never removes hand-written source.
  return saveProjectBoard(root, { ...input, edges: nextEdges });
}
