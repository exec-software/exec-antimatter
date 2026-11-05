import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { foldService, indentUnit, LanguageSupport, StreamLanguage, syntaxTree, type StringStream } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

// Matches the canonical Ny grammar and snippets in exec-lang-ny/ext/vscode. Ny uses
// end-delimited blocks; treating it as Rust or Python breaks both comments and indentation.
const CONTROL = new Set('if then elseif else end while where for in break continue loop do match when attempt fault recover raise return asm test example property generate'.split(' '));
const DECLARATIONS = new Set('fn function fun struct enum trait class type impl module package namespace import using use let const'.split(' '));
const MODIFIERS = new Set('pub mut abstract virtual override inherits'.split(' '));
const TYPES = new Set('any array bool char f32 f64 i8 i16 i32 i64 isize map option Option result Result text tuple u8 u16 u32 u64 usize vec void'.split(' '));
const BUILTINS = new Set('println assert hotreload allocate deallocate'.split(' '));
const OPENERS = new Set('fn function fun struct enum trait impl class if while for loop match attempt test example property'.split(' '));
const BRANCH = /^(?:else|elseif|fault|recover)\b/;

interface NyState {
  comment: '###' | '*/' | null;
  quote: string | null;
  blocks: string[];
  brackets: number;
  leading: boolean;
  declaration: string | null;
}

function quoted(stream: StringStream, state: NyState): string {
  let escaped = false;
  while (!stream.eol()) {
    const character = stream.next();
    if (character === state.quote && !escaped) { state.quote = null; break; }
    escaped = character === '\\' && !escaped;
  }
  return 'string';
}

function comment(stream: StringStream, state: NyState): string {
  while (!stream.eol()) {
    if (stream.match(state.comment!)) { state.comment = null; break; }
    stream.next();
  }
  return 'blockComment';
}

export const nyLanguage = StreamLanguage.define<NyState>({
  name: 'ny',
  startState: () => ({ comment: null, quote: null, blocks: [], brackets: 0, leading: true, declaration: null }),
  token(stream, state) {
    if (stream.sol()) { state.leading = true; state.declaration = null; }
    if (state.comment) return comment(stream, state);
    if (state.quote) return quoted(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match('###')) { state.comment = '###'; return comment(stream, state); }
    if (stream.match('/*')) { state.comment = '*/'; return comment(stream, state); }
    if (stream.match('//') || stream.match('#')) { stream.skipToEnd(); return 'lineComment'; }
    if (stream.match(/@[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/)) return 'annotation';
    if (stream.peek() === '"' || stream.peek() === "'") {
      state.leading = false;
      state.quote = stream.next()!;
      return quoted(stream, state);
    }
    if (stream.match(/(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)/)) { state.leading = false; return 'number'; }
    const word = stream.match(/[A-Za-z_][A-Za-z0-9_]*/);
    if (Array.isArray(word)) {
      const name = word[0];
      if (state.leading && MODIFIERS.has(name)) return 'modifier';
      if (state.leading && name === 'end') {
        const ending = stream.match(/^\s+(\w+)/, false);
        const index = Array.isArray(ending) ? state.blocks.lastIndexOf(ending[1]) : state.blocks.length - 1;
        if (index >= 0) state.blocks.length = index;
      } else if (state.leading && OPENERS.has(name) && !(state.blocks[state.blocks.length - 1] === 'trait' && /^(?:fn|fun|function)$/.test(name))) {
        state.blocks.push(name);
      }
      state.leading = false;
      if (DECLARATIONS.has(name)) { state.declaration = name; return 'definitionKeyword'; }
      if (CONTROL.has(name)) return 'controlKeyword';
      if (MODIFIERS.has(name)) return 'modifier';
      if (name === 'true' || name === 'false') return 'bool';
      if (name === 'self' || name === 'Self') return 'self';
      if (/^(?:not|mod|as|ref)$/.test(name)) return 'operatorKeyword';
      if (TYPES.has(name)) return 'typeName';
      if (state.declaration) {
        const declaration = state.declaration;
        state.declaration = null;
        if (/^(?:fn|function|fun)$/.test(declaration)) return 'variableName.function';
        if (/^(?:module|package|namespace|import|using|use)$/.test(declaration)) return 'namespace';
        if (/^(?:struct|enum|trait|class|type|impl)$/.test(declaration)) return 'typeName';
        return 'variableName.definition';
      }
      if (BUILTINS.has(name) || stream.match(/^\s*\(/, false)) return 'variableName.function';
      return 'variableName';
    }
    state.leading = false;
    if (stream.match(/[([{]/)) { state.brackets++; return 'bracket'; }
    if (stream.match(/[)\]}]/)) { state.brackets = Math.max(0, state.brackets - 1); return 'bracket'; }
    if (stream.match(/[,;]/)) return 'separator';
    if (stream.match(/\.\.|::|->|=>|==|!=|<=|>=|<<|>>|&&|\|\||[+\-*/%=<>&|^~?:.]/)) return 'operator';
    stream.next();
    return null;
  },
  indent(state, textAfter, context) {
    if (state.quote || state.comment) return null;
    const after = textAfter.trimStart();
    const closingBlock = /^end\b/.test(after) || BRANCH.test(after) ? 1 : 0;
    const closingBracket = /^[)\]}]/.test(after) ? 1 : 0;
    return Math.max(0, state.blocks.length + state.brackets - closingBlock - closingBracket) * context.unit;
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"', "'"] },
    indentOnInput: /^\s*(?:end\b|else\b|elseif\b|when\b|fault\b|recover\b|[)\]}])$/,
    wordChars: '_',
  },
});

export const nySnippets: Completion[] = [
  ['fn', 'Function', 'fn ${1:name}(${2}) -> ${3:void}\n\t${0}\nend fn'],
  ['pubfn', 'Public function', 'pub fn ${1:name}(${2}) -> ${3:void}\n\t${0}\nend fn'],
  ['main', 'Program entry point', 'fn main() -> i32\n\t${0}\n\treturn 0\nend fn'],
  ['struct', 'Struct', 'struct ${1:Name}\n\t${2:field}: ${3:type}\nend struct'],
  ['enum', 'Enum', 'enum ${1:Name}\n\t${2:Variant}\nend enum'],
  ['trait', 'Trait', 'pub trait ${1:Name}\n\tfn ${2:method}(self) -> ${3:void}\nend trait'],
  ['impl', 'Trait implementation', 'impl ${1:Trait} for ${2:Type}\n\tfn ${3:method}(self) -> ${4:void}\n\t\t${0}\n\tend fn\nend impl'],
  ['class', 'Class', 'class ${1:Name}\n\t${0}\nend class'],
  ['let', 'Binding', 'let ${1:name}: ${2:type} = ${0:value}'],
  ['letmut', 'Mutable binding', 'let mut ${1:name}: ${2:type} = ${0:value}'],
  ['const', 'Constant', 'const ${1:NAME}: ${2:type} = ${0:value}'],
  ['if', 'If block', 'if ${1:condition} then\n\t${0}\nend if'],
  ['ifelse', 'If / else block', 'if ${1:condition} then\n\t${2}\nelse\n\t${0}\nend if'],
  ['while', 'While loop', 'while ${1:condition} do\n\t${0}\nend while'],
  ['for', 'For loop', 'for ${1:item} in ${2:items} do\n\t${0}\nend for'],
  ['loop', 'Loop', 'loop\n\t${0}\nend loop'],
  ['match', 'Pattern matching', 'match ${1:value}\n\twhen ${2:pattern} => ${0}\nend match'],
  ['attempt', 'Fault handling', 'attempt\n\t${1}\nfault ${2:FaultType} as ${3:error}\n\t${4}\nrecover\n\t${0}\nend attempt'],
  ['test', 'Unit test', 'test "${1:description}"\n\t${0}\nend test'],
  ['example', 'Executable example', 'example "${1:description}"\n\t${0}\nend example'],
  ['property', 'Property test', 'property "${1:description}"\n\t${0}\nend property'],
  ['module', 'Module declaration', 'module ${1:ny.app}'],
  ['import', 'Import', 'import ${1:ny.lang.core}'],
  ['@doc', 'Documentation', '@doc(\n\tsummary="${1:summary}",\n\tdescription="${2:description}"\n)'],
  ['@ai_context', 'AI context', '@ai_context(\n\tintent="${1:intent}",\n\tconstraints=["${2:constraint}"]\n)'],
  ['@include', 'Preprocessor include', '@include "${1:path.ny}"'],
].map(([label, detail, template]) => snippetCompletion(template, { label, detail, type: 'keyword', boost: 5 }));

/** Preserve offsets while removing text that cannot introduce a declaration or block. */
const codeCache = new WeakMap<EditorState, { tree: ReturnType<typeof syntaxTree>; text: string }>();
export function nyCodeText(state: EditorState): string {
  const tree = syntaxTree(state);
  const cached = codeCache.get(state);
  if (cached?.tree === tree) return cached.text;
  const text = state.doc.toString();
  const ranges: { from: number; to: number }[] = [];
  tree.iterate({ enter(node) {
    if (/comment|string/i.test(node.name)) ranges.push({ from: node.from, to: node.to });
  } });
  let result = '', offset = 0;
  for (const range of ranges) {
    if (range.from < offset) continue;
    result += text.slice(offset, range.from) + text.slice(range.from, range.to).replace(/[^\n]/g, ' ');
    offset = range.to;
  }
  result += text.slice(offset);
  codeCache.set(state, { tree, text: result });
  return result;
}

export function nyLocalCompletions(context: CompletionContext): CompletionResult | null {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1);
  if (/comment|string/i.test(node.name)) return null;
  const word = context.matchBefore(/@?[A-Za-z_][A-Za-z0-9_]*/);
  const from = word?.from ?? context.pos;
  const member = /(?:\.|::)$/.test(context.state.sliceDoc(Math.max(0, from - 2), from));
  if (!word && !context.explicit && !member) return null;
  // Request semantic members even immediately after '.' / '::'. Whole-file declarations
  // and language keywords are not useful receiver-member guesses when the SDK is absent.
  if (member) return { from, options: [], validFor: /^[A-Za-z_][A-Za-z0-9_]*$/ };
  const options = new Map<string, Completion>();
  for (const label of [...CONTROL, ...DECLARATIONS, ...MODIFIERS]) options.set(label, { label, type: 'keyword' });
  for (const label of TYPES) options.set(label, { label, type: 'type' });
  for (const label of BUILTINS) options.set(label, { label, type: 'function' });
  for (const label of ['true', 'false', 'self', 'Self', 'not', 'mod', 'as', 'ref']) options.set(label, { label, type: 'keyword' });
  const declarations = /\b(fn|function|fun|let|const|struct|enum|class|trait|type)[ \t]+(?:mut[ \t]+)?([A-Za-z_]\w*)/g;
  for (const match of nyCodeText(context.state).slice(0, 256 * 1024).matchAll(declarations)) {
    const type = /^(?:fn|function|fun)$/.test(match[1]) ? 'function' : /^(?:let|const)$/.test(match[1]) ? 'variable' : 'type';
    options.set(match[2], { label: match[2], type, detail: 'This file', boost: 10 });
    if (options.size > 2000) break;
  }
  for (const snippet of nySnippets) options.set(snippet.label, snippet);
  return { from, options: [...options.values()], validFor: /^@?[A-Za-z_][A-Za-z0-9_]*$/ };
}

export function nyFold(state: EditorState, lineStart: number, lineEnd: number): { from: number; to: number } | null {
  const code = nyCodeText(state);
  const opening = /^\s*(?:(?:pub|abstract|virtual|override)\s+)*(\w+)\b/.exec(code.slice(lineStart, lineEnd));
  if (!opening || !OPENERS.has(opening[1])) return null;
  const blocks = [opening[1]];
  for (let number = state.doc.lineAt(lineStart).number + 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const token = /^\s*(?:(?:pub|abstract|virtual|override)\s+)*(\w+)\b/.exec(code.slice(line.from, line.to));
    if (!token) continue;
    if (token[1] === 'end') {
      const ending = /^\s*end\s+(\w+)/.exec(code.slice(line.from, line.to));
      const index = ending ? blocks.lastIndexOf(ending[1]) : blocks.length - 1;
      if (index >= 0) blocks.length = index;
    } else if (OPENERS.has(token[1]) && !(blocks[blocks.length - 1] === 'trait' && /^(?:fn|fun|function)$/.test(token[1]))) blocks.push(token[1]);
    if (blocks.length === 0) return { from: lineEnd, to: line.from - 1 };
  }
  return null;
}

export function ny(): LanguageSupport {
  return new LanguageSupport(nyLanguage, [
    indentUnit.of('    '),
    nyLanguage.data.of({ autocomplete: nyLocalCompletions }),
    foldService.of(nyFold),
  ]);
}
