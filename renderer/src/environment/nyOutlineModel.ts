import type { NyPosition, NyRange } from '../../../src/api/ny';

export interface NyOutlineItem {
  id: string;
  parentId: string | null;
  name: string;
  container: string;
  detail: string;
  kind: string;
  depth: number;
  /** One-based editor positions. */
  line: number;
  column: number;
}

const kinds: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class', 6: 'Method',
  7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum', 11: 'Interface',
  12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String', 16: 'Number',
  17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key', 21: 'Null',
  22: 'Enum member', 23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'Type parameter',
};
const MAX_SYMBOLS = 2000;
const MAX_DEPTH = 32;
const before = (left: NyPosition, right: NyPosition) => left.line < right.line || (left.line === right.line && left.character <= right.character);

/** Validate server positions against the exact unsaved buffer before making navigation targets. */
export function nyOutlineItems(value: unknown, text: string): NyOutlineItem[] {
  if (!Array.isArray(value)) return [];
  const lines = text.split(/\r?\n/);
  const position = (value: unknown): value is NyPosition => {
    if (!value || typeof value !== 'object') return false;
    const item = value as NyPosition;
    return Number.isSafeInteger(item.line) && Number.isSafeInteger(item.character) && item.line >= 0 &&
      item.line < lines.length && item.character >= 0 && item.character <= lines[item.line].length;
  };
  const range = (value: unknown): value is NyRange => {
    if (!value || typeof value !== 'object') return false;
    const item = value as NyRange;
    return position(item.start) && position(item.end) && before(item.start, item.end);
  };
  const result: NyOutlineItem[] = [];
  let examined = 0;
  const visit = (symbols: unknown[], depth: number, parentId: string | null, container: string, prefix: string) => {
    if (depth > MAX_DEPTH) return;
    for (let index = 0; index < symbols.length && examined < MAX_SYMBOLS; index++) {
      examined++;
      const value = symbols[index];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const symbol = value as Record<string, unknown>;
      const id = `${prefix}${index}`;
      const valid = typeof symbol.name === 'string' && symbol.name.trim().length > 0 &&
        range(symbol.range) && range(symbol.selectionRange) &&
        before(symbol.range.start, symbol.selectionRange.start) && before(symbol.selectionRange.end, symbol.range.end);
      if (valid) {
        const selection = symbol.selectionRange as NyRange;
        result.push({
          id, parentId, name: (symbol.name as string).slice(0, 256), container,
          detail: typeof symbol.detail === 'string' ? symbol.detail.slice(0, 1000) : '',
          kind: kinds[Number(symbol.kind)] ?? 'Symbol', depth,
          line: selection.start.line + 1, column: selection.start.character + 1,
        });
      }
      if (Array.isArray(symbol.children)) {
        const parent = valid ? result[result.length - 1] : null;
        visit(symbol.children, depth + 1, parent?.id ?? parentId,
          parent ? [container, parent.name].filter(Boolean).join(' › ') : container, `${id}.`);
      }
    }
  };
  visit(value, 0, null, '', '');
  return result;
}

/** Keep a matched member's ancestors so identically named methods retain their context. */
export function filterNyOutline(items: NyOutlineItem[], query: string): NyOutlineItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const visible = new Set<string>();
  for (const item of items) {
    if (!`${item.name}\n${item.container}\n${item.detail}`.toLocaleLowerCase().includes(needle)) continue;
    let current: NyOutlineItem | undefined = item;
    while (current && !visible.has(current.id)) {
      visible.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return items.filter((item) => visible.has(item.id));
}
