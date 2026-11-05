import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { foldService, indentUnit, LanguageSupport, StreamLanguage, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

// Matrix is an end-delimited prose language, not a Ny spelling mode. These spellings
// follow exec-nil-framework/matrix and its canonical VS Code grammar/snippets.
const CONTROL = new Set('begin end when then otherwise provided consider holding repeat while for in forever stop continue repeating attempt caught anything always give raise again evaluate apply across now sleep'.split(' '));
const DECLARATIONS = new Set('library book chapter read cite paragraph record choice class contract implementation extension test field means receives returns anonymous value variable constant'.split(' '));
const MODIFIERS = new Set('public abstract virtual replaces inherits provides meeting requires mutable without reference more defaulting own borrow exclusively move into owned shared exclusive view override'.split(' '));
const TYPES = new Set('number floating boolean text nothing pointer array tuple integer long byte double'.split(' '));
const OPERATORS = new Set('everything from as of type on the is set to append allocate release sized build with being assembly using giving note context and or not plus minus negative times over remainder at bitwise shifted equals does xor becomes'.split(' '));
const BUILTINS = new Set('say quote newline tab'.split(' '));
const WORD = /[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*(?:-[A-Za-z\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)*/;
const PREFIX = /[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff-]*$/;
const BLOCK_KIND = 'paragraph|record|choice|class|contract|implementation|extension|test|text';
const BEGIN = new RegExp(`^begin[ \\t]+(${BLOCK_KIND})(?![\\w\\u0080-\\uffff-])`, 'i');
const END = /^end(?:[ \t]+([A-Za-z]+))?(?![\w\u0080-\uffff-])/i;
const foldWord = (word: string) => word.replace(/[_-]/g, '').replace(/[A-Z]/g, (character) => character.toLowerCase());
interface MatrixState { rawText: boolean; blocks: string[]; brackets: number; leading: boolean; declaration: string | null }

export const matrixLanguage = StreamLanguage.define<MatrixState>({
  name: 'matrix',
  startState: () => ({ rawText: false, blocks: [], brackets: 0, leading: true, declaration: null }),
  token(stream, state) {
    if (stream.sol()) { state.leading = true; state.declaration = null; }
    if (state.rawText) {
      if (stream.sol() && /^\s*end\s+text\s*$/i.test(stream.string)) {
        stream.skipToEnd(); state.rawText = false; state.blocks.pop(); return 'controlKeyword';
      }
      stream.skipToEnd(); return 'string';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('!!!')) { stream.skipToEnd(); return 'lineComment'; }
    if (stream.peek() === '"') {
      stream.next(); stream.eatWhile(/[^"\r\n]/); stream.eat('"'); state.leading = false;
      // Quoted Matrix text is raw: backslashes do not escape the closing quote.
      return 'string';
    }
    if (stream.match(/`[^`\r\n]*`?/)) { state.leading = false; return 'variableName'; }
    const ending = stream.match(END);
    if (Array.isArray(ending)) {
      const index = ending[1] ? state.blocks.lastIndexOf(ending[1].toLowerCase()) : state.blocks.length - 1;
      if (index >= 0) state.blocks.length = index;
      state.leading = false; return 'controlKeyword';
    }
    const begin = stream.match(BEGIN);
    if (Array.isArray(begin)) {
      const kind = begin[1].toLowerCase(); state.blocks.push(kind);
      if (kind === 'text' && /^\s*$/.test(stream.string.slice(stream.pos))) state.rawText = true;
      state.leading = false; return 'controlKeyword';
    }
    if (stream.match(/-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)) { state.leading = false; return 'number'; }
    const word = stream.match(WORD);
    if (Array.isArray(word)) {
      const name = foldWord(word[0]), leading = state.leading;
      if (leading && MODIFIERS.has(name)) return 'modifier';
      if (/^(?:repeat|consider|attempt)$/.test(name) || (/^(?:when|provided)$/.test(name) && state.blocks[state.blocks.length - 1] !== 'consider' && !/\botherwise\s*$/i.test(stream.string.slice(0, stream.start)) && /\b(?:then|give)\b/i.test(stream.string.slice(stream.pos).replace(/"[^"\r\n]*"|`[^`\r\n]*`|!!!.*$/g, '')))) state.blocks.push(name);
      state.leading = false;
      if (name === 'true' || name === 'false') return 'bool';
      if (name === 'my') return 'self';
      if (CONTROL.has(name)) return 'controlKeyword';
      if (DECLARATIONS.has(name)) { state.declaration = name; return 'definitionKeyword'; }
      if (MODIFIERS.has(name)) return 'modifier';
      if (TYPES.has(name)) return 'typeName';
      if (OPERATORS.has(name)) return 'operatorKeyword';
      if (BUILTINS.has(name)) return name === 'say' ? 'variableName.function' : 'atom';
      if (state.declaration) {
        const declaration = state.declaration; state.declaration = null;
        return /^(?:book|library|chapter|read|cite)$/.test(declaration) ? 'namespace' : 'variableName.definition';
      }
      if (leading && /^\s+(?:receives|returns|on|without|begin\s+paragraph)\b/i.test(stream.string.slice(stream.pos))) return 'variableName.function';
      if (leading && /^\s+(?:means|[^!";]*\bbegin\s+(?:record|choice|class|contract|implementation|extension))\b/i.test(stream.string.slice(stream.pos))) return 'typeName';
      if (/^\s+with\b/i.test(stream.string.slice(stream.pos))) return 'variableName.function';
      return 'variableName';
    }
    state.leading = false;
    if (stream.match(/[([]/)) { state.brackets++; return 'bracket'; }
    if (stream.match(/[)\]]/)) { state.brackets = Math.max(0, state.brackets - 1); return 'bracket'; }
    if (stream.match(/[,;.]/)) return 'separator';
    stream.next(); return 'invalid';
  },
  indent(state, textAfter, context) {
    if (state.rawText) return null;
    const after = textAfter.trimStart();
    const closing = /^end\b/i.test(after) || (/^(?:otherwise|caught|always)\b/i.test(after) && state.blocks[state.blocks.length - 1] !== 'consider') ? 1 : 0;
    return Math.max(0, state.blocks.length + state.brackets - closing - (/^[)\]]/.test(after) ? 1 : 0)) * context.unit;
  },
  languageData: {
    commentTokens: { line: '!!!' },
    closeBrackets: { brackets: ['(', '[', '"', '`'] },
    indentOnInput: /^\s*(?:end\b.*|otherwise\b.*|caught\b.*|always\b.*|[)\]])$/i,
    wordChars: '_-',
  },
});

export const matrixSnippets: Completion[] = [
  ['book', 'Book declaration', 'book ${1:app}'],
  ['read', 'Read a book', 'read ${1:ny.lang.core}'],
  ['main', 'Program entry point', 'main returns number begin paragraph\n\t${0}\n\tgive 0\nend paragraph'],
  ['paragraph', 'Paragraph', '${1:compute} receives ${2:value} as ${3:number} returns ${4:number} begin paragraph\n\t${0}\n\tgive ${2:value}\nend paragraph'],
  ['record', 'Record', '${1:Item} begin record\n\tfield ${2:item-value} as ${3:number}\nend record'],
  ['choice', 'Choice', '${1:State} begin choice\n\twhen ${2:Ready}\nend choice'],
  ['class', 'Class', '${1:Widget} begin class\n\t${0}\nend class'],
  ['contract', 'Contract', '${1:Readable} begin contract\n\t${2:describe} returns ${3:text}\nend contract'],
  ['implementation', 'Contract implementation', '${1:Widget} provides ${2:Readable} begin implementation\n\t${0}\nend implementation'],
  ['value', 'Immutable value', 'value ${1:item-value} as ${2:number} is ${0:0}'],
  ['variable', 'Mutable value', 'variable ${1:total} as ${2:number} is ${0:0}'],
  ['when', 'Conditional', 'when ${1:condition} then\n\t${0}\nend when'],
  ['repeat', 'Repeat while', 'repeat while ${1:condition}\n\t${0}\nend repeat'],
  ['attempt', 'Fault handling', 'attempt\n\t${1}\ncaught ${2:anything}\n\t${3}\nalways\n\t${0}\nend attempt'],
  ['text', 'Raw text block', 'begin text\n${0}\nend text'],
].map(([label, detail, template]) => snippetCompletion(template, { label, detail, type: 'keyword', boost: 5 }));

/** Keep source positions stable while excluding prose literals and comments from navigation. */
export function matrixCodeText(state: EditorState): string {
  const text = state.doc.toString().split('');
  syntaxTree(state).iterate({ enter(node) {
    if (!/comment|string/i.test(node.name) && state.sliceDoc(node.from, node.from + 1) !== '`') return;
    for (let index = node.from; index < node.to; index++) if (text[index] !== '\n' && text[index] !== '\r') text[index] = ' ';
  } });
  return text.join('');
}

export function matrixLocalCompletions(context: CompletionContext): CompletionResult | null {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1);
  if (/comment|string/i.test(node.name)) return null;
  const word = context.matchBefore(PREFIX);
  const from = word?.from ?? context.pos;
  const member = /\.[ \t]*$/.test(context.state.sliceDoc(Math.max(0, from - 200), from));
  if (!word && !context.explicit && !member) return null;
  if (member) return { from, options: [], validFor: PREFIX };
  const options = new Map<string, Completion>();
  for (const label of [...CONTROL, ...DECLARATIONS, ...MODIFIERS, ...OPERATORS, 'true', 'false', 'my']) options.set(label, { label, type: 'keyword' });
  for (const label of TYPES) options.set(label, { label, type: 'type' });
  for (const label of BUILTINS) options.set(label, { label, type: label === 'say' ? 'function' : 'constant' });
  for (const item of matrixSnippets) options.set(item.label, item);
  // Semantic names come from nillsp/the compiler. Guessing whole-file Matrix scopes gives
  // misleading members, especially with folded names and named paragraph arguments.
  return { from, options: [...options.values()], validFor: PREFIX };
}

function blockEvents(code: string): Array<{ kind: string; close: boolean }> {
  const events: Array<{ kind: string; close: boolean }> = [];
  const controls = new RegExp(`\\bbegin\\s+(${BLOCK_KIND})\\b|\\bend\\s+([A-Za-z]+)\\b|\\b(repeat|consider|attempt)\\b|\\b(when|provided)\\b(?=.*\\b(?:then|give)\\b)`, 'gi');
  for (const match of code.matchAll(controls)) {
    if (match[4] && /\botherwise\s*$/i.test(code.slice(0, match.index))) continue;
    events.push({ kind: (match[1] ?? match[2] ?? match[3] ?? match[4]).toLowerCase(), close: !!match[2] });
  }
  return events;
}
export function matrixFold(state: EditorState, lineStart: number, lineEnd: number): { from: number; to: number } | null {
  const code = matrixCodeText(state), stack: string[] = [];
  const update = (line: string) => {
    for (const event of blockEvents(line)) {
      if (!event.close) { if (!(/^(?:when|provided)$/.test(event.kind) && stack[stack.length - 1] === 'consider')) stack.push(event.kind); }
      else { const index = stack.lastIndexOf(event.kind); if (index >= 0) stack.length = index; }
    }
  };
  update(code.slice(lineStart, lineEnd));
  if (!stack.length) return null;
  for (let number = state.doc.lineAt(lineStart).number + 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number); update(code.slice(line.from, line.to));
    if (!stack.length) return { from: lineEnd, to: line.from - 1 };
  }
  return null;
}
export function matrix(): LanguageSupport {
  return new LanguageSupport(matrixLanguage, [indentUnit.of('    '), matrixLanguage.data.of({ autocomplete: matrixLocalCompletions }), foldService.of(matrixFold)]);
}
