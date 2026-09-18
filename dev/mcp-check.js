/* Starts a real MCP server over stdio and checks the whole path: spawning,
   the handshake, tool discovery, the read-only annotation the permission gate
   depends on, calling a tool, and flattening the reply.

   Run with:  npx electron dev/mcp-check.js  */

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mcp = require('../mcp');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + name + ' — ' + err.message);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

app.whenReady().then(async () => {
  // mcp.js reads its config out of a userData directory, so the test gets
  // one of its own rather than touching the real settings
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-mcp-'));
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        mock: {
          command: 'node',
          args: [path.join(__dirname, 'mock-mcp-server.mjs')]
        },
        broken: { command: 'definitely-not-a-real-command-xyz', args: [] }
      }
    }),
    'utf8'
  );

  const report = await mcp.start(dir);
  console.log('start report:', JSON.stringify(report));

  check('the working server started', () => {
    const line = report.find((r) => r.name === 'mock');
    assert(line, 'no report line for mock');
    assert(line.ok, 'mock failed: ' + line.error);
  });

  check('a broken server does not take the others down', () => {
    const line = report.find((r) => r.name === 'broken');
    assert(line, 'no report line for broken');
    assert(!line.ok, 'broken somehow started');
  });

  const tools = mcp.allTools();
  check('both tools were discovered', () => {
    assert(tools.length === 2, 'got ' + tools.length + ' tools');
  });

  check('tool ids carry the server name', () => {
    assert(tools.some((t) => t.id === 'mock__read_note'), 'no mock__read_note');
    assert(tools.some((t) => t.id === 'mock__send_mail'), 'no mock__send_mail');
  });

  check('a declared read only tool is marked read only', () => {
    const t = tools.find((t) => t.id === 'mock__read_note');
    assert(t.readOnly === true, 'read_note was not marked read only');
  });

  // this is the one that matters: silence must not be read as permission
  check('a tool that says nothing is NOT treated as read only', () => {
    const t = tools.find((t) => t.id === 'mock__send_mail');
    assert(t.readOnly === false, 'send_mail was wrongly treated as read only');
  });

  const schema = mcp.toolsForModel();
  check('the model sees an OpenAI shaped tool list', () => {
    assert(schema.length === 2, 'expected 2 entries');
    assert(schema[0].type === 'function', 'not a function entry');
    assert(schema[0].function.name && schema[0].function.parameters, 'missing name or parameters');
    assert(/^[A-Za-z0-9_-]{1,64}$/.test(schema[0].function.name), 'name would be rejected by the API');
  });

  const read = await mcp.call('mock__read_note', { title: 'Shopping' });
  check('calling a tool returns its text', () => {
    assert(read.ok, 'call failed: ' + read.text);
    assert(/buy milk/.test(read.text), 'unexpected text: ' + read.text);
  });

  const sent = await mcp.call('mock__send_mail', { to: 'someone@example.com' });
  check('the second tool runs too', () => {
    assert(sent.ok, 'call failed: ' + sent.text);
    assert(/someone@example.com/.test(sent.text), 'unexpected text: ' + sent.text);
  });

  const missing = await mcp.call('mock__nope', {});
  check('an unknown tool fails politely', () => {
    assert(!missing.ok, 'a missing tool reported success');
    assert(/no tool called/i.test(missing.text), 'unexpected text: ' + missing.text);
  });

  const status = mcp.status();
  check('status reports both servers', () => {
    assert(status.length === 2, 'got ' + status.length);
    assert(status.find((s) => s.name === 'mock').ok, 'mock not ok');
    assert(!status.find((s) => s.name === 'broken').ok, 'broken not flagged');
  });

  await mcp.stop();
  check('stopping clears the servers', () => {
    assert(mcp.allTools().length === 0, 'tools survived the shutdown');
  });

  fs.rmSync(dir, { recursive: true, force: true });

  console.log('');
  console.log(failures ? failures + ' FAILED' : 'all passed');
  app.exit(failures ? 1 : 0);
});
