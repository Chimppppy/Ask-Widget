/* Does engine.chat reassemble a stream that arrives in awkward pieces?
   Pure node, no Electron:  node dev/engine-check.js

   The server here deliberately splits frames mid-line, which is the case
   a naive split('\n') parser drops tokens on. */

const http = require('http');
const assert = require('assert');
const engine = require('../engine');
const builtin = require('../builtin');

let lastBody = null;
let lastSettingsBody = null;

const WANT = 'Hello, world! This is a streamed answer with **bold** and `code`.';

function frame(text) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/chat/settings') {
    assert.strictEqual(req.headers.authorization, 'Bearer sk-unsloth-test');
    const body = await new Promise((resolve) => {
      let value = '';
      req.on('data', (chunk) => (value += chunk));
      req.on('end', () => resolve(value));
    });
    lastSettingsBody = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ settings: lastSettingsBody }));
    return;
  }

  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'unsloth/gemma-4-E2B-it-GGUF' }] }));
    return;
  }

  if (req.url === '/tools/v1/chat/completions') {
    // a tool call, with the name in one frame and the arguments dribbled out
    // a few characters at a time across the rest
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frames = [
      { choices: [{ delta: { content: 'Let me look.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'mock__read_note', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"tit' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'le":"Sho' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'pping"}' } }] } }] },
      // a second call arriving interleaved, which is what breaks naive parsers
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'mock__send_mail', arguments: '{"to":"a@b.c"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ];
    let wire = '';
    for (const f of frames) wire += 'data: ' + JSON.stringify(f) + '\n\n';
    wire += 'data: [DONE]' + '\n\n';
    for (let i = 0; i < wire.length; i += 5) {
      res.write(wire.slice(i, i + 5));
      await new Promise((r) => setTimeout(r, 1));
    }
    res.end();
    return;
  }

  if (req.url === '/v1/chat/completions') {
    assert.strictEqual(req.headers.authorization, 'Bearer sk-unsloth-test');

    const body = await new Promise((r) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => r(b));
    });
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.stream, true, 'must ask for a stream');
    lastBody = parsed;

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });

    if (parsed.enable_tools) {
      assert.strictEqual(
        req.headers['x-unsloth-events'],
        '1',
        'server tools require the Unsloth events header'
      );
      const frames = [
        { choices: [{ delta: { reasoning_content: 'I should search.' } }] },
        {
          type: 'tool_start',
          tool_name: 'web_search',
          tool_call_id: 'search_1',
          arguments: {
            query: 'current release',
            image_queries: ['release logo']
          },
          awaiting_confirmation: false
        },
        {
          type: 'tool_end',
          tool_name: 'web_search',
          tool_call_id: 'search_1',
          result:
            'A current result\n__WEB_IMAGES__:' +
            JSON.stringify([{ id: '123456789abc', title: 'Release logo' }])
        },
        { choices: [{ delta: { content: 'Found it.' } }] }
      ];
      for (const item of frames) res.write('data: ' + JSON.stringify(item) + '\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }

    // build the whole SSE body, then dribble it out in 7 byte slices so
    // almost every frame straddles a chunk boundary
    let wire = '';
    for (const word of WANT.match(/\s*\S+/g)) wire += frame(word);
    wire += ': a stray comment line\n\n';
    wire += 'data: [DONE]\n\n';

    for (let i = 0; i < wire.length; i += 7) {
      res.write(wire.slice(i, i + 7));
      await new Promise((r) => setTimeout(r, 1));
    }
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(0, async () => {
  const endpoint = 'http://localhost:' + server.address().port;
  const key = 'sk-unsloth-test';
  let failures = 0;
  const check = (name, fn) => {
    try {
      fn();
      console.log('  ok   ' + name);
    } catch (err) {
      failures++;
      console.log('  FAIL ' + name + ' — ' + err.message);
    }
  };

  // 1. discovery
  const found = await engine.discover(endpoint, key);
  check('discover finds the endpoint', () => assert.strictEqual(found.ok, true));
  check('discover lists models', () =>
    assert.deepStrictEqual(found.models, ['unsloth/gemma-4-E2B-it-GGUF']));

  // 2. streaming reassembly
  const pieces = [];
  const plainRes = await engine.chat(
    { endpoint, key, model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    (bit) => pieces.push(bit)
  );
  check('stream reassembles exactly', () => assert.strictEqual(plainRes.text, WANT));
  check('deltas concatenate to the same text', () =>
    assert.strictEqual(pieces.join(''), WANT));
  check('more than one delta arrived', () => assert.ok(pieces.length > 5));

  // 3. tool calls assembled out of a stream
  const tool = await engine.chat(
    {
      endpoint: endpoint + '/tools',
      key,
      model: 'm',
      messages: [{ role: 'user', content: 'what is on my list' }],
      tools: [{ type: 'function', function: { name: 'mock__read_note', parameters: {} } }]
    },
    () => {}
  );

  check('text alongside a tool call survives', () =>
    assert.strictEqual(tool.text, 'Let me look.'));
  check('both tool calls were assembled', () =>
    assert.strictEqual(tool.toolCalls.length, 2));
  check('the call name is whole', () =>
    assert.strictEqual(tool.toolCalls[0].function.name, 'mock__read_note'));
  check('arguments split across frames rejoin', () =>
    assert.strictEqual(tool.toolCalls[0].function.arguments, '{"title":"Shopping"}'));
  check('the assembled arguments parse', () =>
    assert.deepStrictEqual(JSON.parse(tool.toolCalls[0].function.arguments), { title: 'Shopping' }));
  check('the interleaved second call is intact', () =>
    assert.strictEqual(tool.toolCalls[1].function.name, 'mock__send_mail'));
  check('the finish reason is reported', () =>
    assert.strictEqual(tool.finish, 'tool_calls'));

  // an ordinary answer must still report no tool calls
  check('a plain answer has no tool calls', () =>
    assert.strictEqual(plainRes.toolCalls.length, 0));

  // 4. the vision message shape
  const img = engine.userMessage('what is this', ['data:image/png;base64,AAAA']);
  check('image turns the content into parts', () =>
    assert.ok(Array.isArray(img.content)));
  check('image part is an image_url', () =>
    assert.strictEqual(img.content[0].type, 'image_url'));
  check('text rides along with the image', () =>
    assert.strictEqual(img.content[1].text, 'what is this'));

  const plain = engine.userMessage('just text', []);
  check('text only stays a plain string', () =>
    assert.strictEqual(plain.content, 'just text'));

  // 5. obvious references to shared visual context are routed to vision
  check('a reply to this email uses the screen', () =>
    assert.strictEqual(
      builtin.shouldSeeScreen('Create me a reply to this email', []),
      true
    ));
  check('an unexplained visible error uses the screen', () =>
    assert.strictEqual(builtin.shouldSeeScreen('What does this error mean?', []), true));
  check('a generic email request does not use the screen', () =>
    assert.strictEqual(
      builtin.shouldSeeScreen('Write a generic email asking for vacation', []),
      false
    ));
  check('pasted email text does not use the screen', () =>
    assert.strictEqual(
      builtin.shouldSeeScreen(
        'Reply to this email: Hi Sam, Thursday works for me. Can you confirm?',
        []
      ),
      false
    ));
  check('an attached image avoids a second screen capture', () =>
    assert.strictEqual(
      builtin.shouldSeeScreen('Please explain this error', ['data:image/png;base64,AAAA']),
      false
    ));
  check('an explicit request not to look is respected', () =>
    assert.strictEqual(
      builtin.shouldSeeScreen('Reply to this email without looking at my screen', []),
      false
    ));

  await engine.configureImageSearch(endpoint, key, true);
  check('image lookup is enabled through Unsloth chat settings', () =>
    assert.deepStrictEqual(lastSettingsBody, { searchImages: true }));

  // 6. Unsloth's own tools are opted into by name
  await engine.chat(
    { endpoint, key, model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    () => {}
  );
  check('no server tool fields when none are asked for', () => {
    assert.ok(!('enable_tools' in lastBody), 'enable_tools was sent anyway');
    assert.ok(!('enabled_tools' in lastBody), 'enabled_tools was sent anyway');
  });

  const serverEvents = [];
  const thoughts = [];
  const serverToolRes = await engine.chat(
    {
      endpoint,
      key,
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      serverTools: ['web_search'],
      sessionId: 'ask-test'
    },
    () => {},
    (event) => serverEvents.push(event),
    (bit) => thoughts.push(bit)
  );
  check('web search is opted into by name', () => {
    assert.strictEqual(lastBody.enable_tools, true);
    assert.deepStrictEqual(lastBody.enabled_tools, ['web_search']);
    assert.strictEqual(lastBody.session_id, 'ask-test');
    assert.strictEqual(lastBody.nudge_tool_calls, true);
  });
  check('reasoning deltas are preserved', () => {
    assert.strictEqual(thoughts.join(''), 'I should search.');
    assert.strictEqual(serverToolRes.thought, 'I should search.');
  });
  check('server tool events retain their call id', () => {
    assert.deepStrictEqual(
      serverEvents.map((event) => [event.kind, event.callId]),
      [['start', 'search_1'], ['end', 'search_1']]
    );
  });
  check('image queries are visible without leaking the image envelope', () => {
    assert.match(serverEvents[0].detail, /images: release logo/);
    assert.strictEqual(serverEvents[1].result, 'A current result');
  });
  check('the answer after a server tool survives', () =>
    assert.strictEqual(serverToolRes.text, 'Found it.'));

  // 7. a dead endpoint explains itself
  const dead = await engine.discover('http://localhost:1', key, { fallback: false });
  check('a closed port gives a readable error', () =>
    assert.match(dead.error, /Is Unsloth running/));

  server.close();
  console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
  process.exit(failures ? 1 : 0);
});
