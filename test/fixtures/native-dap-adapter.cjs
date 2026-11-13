#!/usr/bin/env node
// Deliberately delays launch until configurationDone, unlike many simplistic DAP mocks.
const fs = require('node:fs');
const path = require('node:path');
let buffer = Buffer.alloc(0), launch = null, index = 0;
const send = message => { const body = Buffer.from(JSON.stringify(message)); process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`); process.stdout.write(body); };
const reply = (request, body = {}) => send({ seq: ++index, type: 'response', request_seq: request.seq, command: request.command, success: true, body });
const event = (name, body = {}) => send({ seq: ++index, type: 'event', event: name, body });
const paused = () => event('stopped', { threadId: 73, reason: 'breakpoint' });
function request(message) {
  fs.appendFileSync(path.join(process.cwd(), 'protocol.jsonl'), JSON.stringify(message) + '\n');
  if (process.argv.length !== 2) throw Error('Unexpected adapter argument (LLDB must not receive --dap)');
  const arg = message.arguments || {};
  if (message.command === 'initialize') reply(message, { supportsConfigurationDoneRequest: true });
  else if (message.command === 'launch') { launch = message; setTimeout(() => event('initialized'), 5); }
  else if (message.command === 'setBreakpoints') reply(message, { breakpoints: arg.breakpoints.map(b => ({ ...b, id: b.line, verified: true })) });
  else if (message.command === 'configurationDone') { reply(message); reply(launch); paused(); }
  else if (message.command === 'threads') reply(message, { threads: [{ id: 73, name: 'worker' }] });
  else if (message.command === 'stackTrace') { if (arg.threadId !== 73) throw Error('Wrong stopped thread'); reply(message, { stackFrames: [{ id: 42, name: 'helper', source: { path: path.join(process.cwd(), 'main.cpp') }, line: 3, column: 1 }, { id: 43, name: 'main', source: { path: path.join(process.cwd(), 'main.cpp') }, line: 6, column: 1 }] }); }
  else if (message.command === 'scopes') reply(message, { scopes: [{ name: 'Locals', variablesReference: arg.frameId, expensive: false }] });
  else if (message.command === 'variables') reply(message, { variables: [{ name: arg.variablesReference === 43 ? 'caller' : 'value', value: '42', type: 'int' }] });
  else if (message.command === 'evaluate') reply(message, { result: String(arg.frameId) });
  else if (['next','stepIn','stepOut','continue','pause'].includes(message.command)) { if (arg.threadId !== 73) throw Error('Wrong execution thread'); reply(message); if (message.command !== 'pause') event('continued'); if (message.command !== 'continue') setTimeout(paused, 5); }
  else if (message.command === 'disconnect') { if (arg.terminateDebuggee !== true) throw Error('Debuggee not terminated'); reply(message); process.exit(0); }
  else reply(message);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const size = Number(buffer.subarray(0, end).toString().split(':')[1]); if (buffer.length < end + 4 + size) return;
    const value = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString()); buffer = buffer.subarray(end + 4 + size); request(value);
  }
});
