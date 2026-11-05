import assert from 'node:assert/strict';
import test from 'node:test';
import { keptReason, lastLines, notKeptReason, partLines, repeatedAtSeam, salvageWrite, startsLike, unnumbered } from '../src/main/salvage';

/** The arguments as a model streams them, stopped after `keep` characters of the content. */
const cutAt = (fields: Record<string, unknown>, content: string, keep: number) => {
  const whole = JSON.stringify({ ...fields, content });
  const start = whole.indexOf('"content":"') + '"content":"'.length;
  return whole.slice(0, start + keep);
};

const editor = ['import tkinter as tk', 'from PIL import Image', '', 'class Editor:', '    def __init__(self):', '        self.title = "GIMP \\"clone\\""'].join('\n');

test('a write cut off inside its content keeps the lines that arrived whole', () => {
  const raw = cutAt({ path: 'gimp_clone.py' }, editor, 80);
  assert.throws(() => JSON.parse(raw));
  const salvaged = salvageWrite(raw);
  assert.deepEqual(salvaged, {
    path: 'gimp_clone.py',
    content: 'import tkinter as tk\nfrom PIL import Image\n\nclass Editor:\n',
    append: null,
    lines: 4,
    complete: false,
  });
});

test('a cut inside an escape does not lose what came before it', () => {
  // After the backslash of \n, and partway through a \u escape.
  const lone = '{"path":"a.py","content":"one\\ntwo\\ntw\\';
  assert.equal(salvageWrite(lone)?.content, 'one\ntwo\n');
  const unicode = '{"path":"a.py","content":"caf\\u00e9\\nna\\u00';
  assert.equal(salvageWrite(unicode)?.content, 'café\n');
  // An escaped backslash at the cut is a whole escape, not a broken one.
  const escaped = '{"path":"a.py","content":"C:\\\\\\\\\\nD:\\\\';
  assert.equal(salvageWrite(escaped)?.content, 'C:\\\\\n');
});

test('the append flag is read only where it was written, and only when it arrived', () => {
  assert.equal(salvageWrite('{"path":"a.py","append":true,"content":"x\\ny')?.append, true);
  assert.equal(salvageWrite('{"path":"a.py","append": false,"content":"x\\ny')?.append, false);
  // Written after the content, it never arrived.
  assert.equal(salvageWrite('{"path":"a.py","content":"x\\ny')?.append, null);
  // The words inside the content are not the flag.
  assert.equal(salvageWrite('{"path":"a.py","content":"opts = {\\"append\\": true}\\nx')?.append, null);
});

test('content that arrived whole is kept whole, though the call was cut after it', () => {
  const salvaged = salvageWrite('{"path":"notes.md","content":"# Notes\\nlast line","append":tr');
  assert.deepEqual(salvaged, { path: 'notes.md', content: '# Notes\nlast line', append: null, lines: 2, complete: true });
});

test('nothing is kept without a whole path and at least one whole line', () => {
  assert.equal(salvageWrite('{"content":"a\\nb\\nc'), null, 'the path would have come after the cut');
  // Written after the content and arrived whole, the path still counts: only the closing brace is missing.
  assert.equal(salvageWrite('{"content":"a\\nb\\nc","path":"x.py"')?.path, 'x.py');
  assert.equal(salvageWrite('{"path":"gimp_clo'), null);
  assert.equal(salvageWrite('{"path":"gimp_clone.py","content":"import tkinter as t'), null);
  assert.equal(salvageWrite('{"path":"  ","content":"a\\nb'), null);
  assert.equal(salvageWrite('not json at all'), null);
});

test('the model is told where the file stops and how big the next parts should be', () => {
  const salvaged = { path: 'gimp_clone.py', content: 'a\nb\nc\nd\n', append: null, lines: 612, complete: false };
  const told = keptReason(salvaged, 8192);
  assert.match(told, /^This write_file call reached the reply's output limit of 8192 tokens, and its content was cut off\./);
  assert.match(told, /the first 612 lines are now in gimp_clone\.py, and the unfinished line after them was dropped/);
  assert.match(
    told,
    /Do not write the file again from the start\. These are its last lines, numbered as read_file numbers them, and they are already written:\n```\n610\tb\n611\tc\n612\td\n```\n/
  );
  assert.match(told, /call write_file with "path": "gimp_clone\.py", then "append": true, then "content" holding the next part, starting at that next line — do not repeat any line shown above/);
  assert.match(told, /about 310 lines/);

  const appended = keptReason({ ...salvaged, append: true, lines: 1 });
  assert.match(appended, /reached the reply's output limit, and its content was cut off\./);
  // Where an appended part sits in the file is not known here, so its lines are not numbered.
  assert.match(appended, /These are its last lines, and they are already written:\n```\nd\n```/);
  assert.match(appended, /the first 1 line was added to the end of gimp_clone\.py, and the unfinished line/);

  const whole = keptReason({ ...salvaged, complete: true, lines: 4 }, 8192);
  assert.match(whole, /cut off just after its content, which had arrived whole, so Antimatter wrote it: all 4 lines are now in gimp_clone\.py\./);
  assert.match(whole, /If the file has more to come, carry on with the line that comes after them/);

  assert.match(notKeptReason(salvaged, 8192), /its content was cut off after 612 lines, so nothing of it was written\. .* parts of about 310 lines/);
  assert.match(notKeptReason({ ...salvaged, complete: true, lines: 2 }), /the call was cut off just after its 2 lines of content, so nothing/);
});

test('part sizes and the tail shown are small enough to be useful', () => {
  assert.equal(partLines(612), 310);
  assert.equal(partLines(30), 20);
  assert.equal(lastLines('one\ntwo\nthree\nfour\n'), 'two\nthree\nfour');
  assert.equal(lastLines(`${'x'.repeat(250)}\n`), `${'x'.repeat(200)}…`);
  assert.equal(lastLines('one\ntwo\nthree\n', 2, 2), '2\ttwo\n3\tthree');
});

test('a next part that starts by repeating the end of the file is recognised', () => {
  // What qwen3-coder-next-80b appended after being shown the last three lines.
  const tail = [
    '            self.display_image()',
    '        ',
    '        elif self.current_tool in ["line", "rect", "ellipse"]:',
    '            # Draw preview on temp image',
  ];
  const next = [
    '        ',
    '        elif self.current_tool in ["line", "rect", "ellipse"]:',
    '            # Draw preview on temp image',
    '            self.temp_draw = self.temp_image.copy()',
  ].join('\n');
  assert.equal(repeatedAtSeam(tail, next), 3);
  // Trailing spaces do not hide a repeat.
  assert.equal(repeatedAtSeam(tail, next.replace('temp image', 'temp image   ')), 3);

  // A real continuation is left alone.
  assert.equal(repeatedAtSeam(tail, '            self.temp_draw = self.temp_image.copy()\n'), 0);
  // One short line alike at both ends is more likely meant: a second closing brace.
  assert.equal(repeatedAtSeam(['  }', '}'], '}\nexport default x;\n'), 0);
  // One long line is a repeat.
  assert.equal(repeatedAtSeam(['            # Draw preview on temp image'], '            # Draw preview on temp image\nx = 1\n'), 1);
  // Blank lines alone are not.
  assert.equal(repeatedAtSeam(['a = 1', '', ''], '\n\nb = 2\n'), 0);
  assert.equal(repeatedAtSeam([], 'anything'), 0);
});

test('a cut-off write that begins the way a file does is a rewrite of it', () => {
  const head = ['#!/usr/bin/env python3', '', '"""', 'GIMP-like editor', '"""'];
  assert.equal(startsLike(head, '#!/usr/bin/env python3\n"""\nA smaller editor\n'), true);
  // Blank lines and trailing spaces do not count.
  assert.equal(startsLike(head, '\n#!/usr/bin/env python3   \n\n"""\n'), true);
  // Another file altogether, or a part from its middle.
  assert.equal(startsLike(head, 'import tkinter as tk\n'), false);
  assert.equal(startsLike(head, '#!/usr/bin/env python3\nimport os\n'), false);
  // One short line alike proves little; one long line alike is enough.
  assert.equal(startsLike(['}'], '}'), false);
  assert.equal(startsLike(['// Generated by the build script'], '// Generated by the build script'), true);
  assert.equal(startsLike([], 'x'), false);

  assert.deepEqual(unnumbered('1\t#!/usr/bin/env python3\n2\t\n3\t"""'), ['#!/usr/bin/env python3', '', '"""']);
  assert.deepEqual(unnumbered('ENOENT: no such file'), []);
});
