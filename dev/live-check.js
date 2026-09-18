/* Talks to the Unsloth server actually running on this machine, through the
   same engine.js the app uses. This is the only check here that proves the
   real request shape is accepted — the others use a mock.

   Skips politely when Unsloth is not running.

   Run with:  node dev/live-check.js  */

const fs = require('fs');
const path = require('path');
const engine = require('../engine');

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

function apiKey() {
  try {
    const file = path.join(process.env.APPDATA, 'Ask', 'engine.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).apiKey || '';
  } catch {
    return '';
  }
}

(async () => {
  const key = apiKey();
  const found = await engine.discover(engine.DEFAULT_ENDPOINT, key);

  if (!found.ok) {
    console.log('Unsloth is not answering — skipping.');
    console.log('  ' + found.error);
    process.exit(0);
  }

  console.log('endpoint: ' + found.endpoint);
  console.log('models:   ' + found.models.length + ' loaded');

  /* ---------- the plain path still works ---------- */

  const plain = await engine.chat(
    {
      endpoint: found.endpoint,
      key,
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
      maxTokens: 400
    },
    () => {}
  );
  check('an ordinary answer comes back', () => {
    assert(typeof plain.text === 'string', 'no text field');
  });

  /* ---------- the one that used to fail with 400 ---------- */

  const thinking = [];
  const events = [];
  let answer = '';

  const res = await engine.chat(
    {
      endpoint: found.endpoint,
      key,
      messages: [
        {
          role: 'user',
          content: 'Search the web: what is the newest Node.js LTS version? One short line.'
        }
      ],
      serverTools: ['web_search'],
      sessionId: 'ask-live-check',
      maxTokens: 900
    },
    (bit) => {
      answer += bit;
    },
    (event) => events.push(event),
    (bit) => thinking.push(bit)
  );

  check('enabling web search no longer returns 400', () => {
    assert(res && typeof res.text === 'string', 'the request failed');
  });

  check('the search actually ran', () => {
    const start = events.find((e) => e.kind === 'start');
    assert(start, 'no tool_start event: ' + JSON.stringify(events.map((e) => e.kind)));
    assert(/search/i.test(start.name), 'unexpected tool: ' + start.name);
  });

  check('the search query is reported', () => {
    const start = events.find((e) => e.kind === 'start');
    assert(start.detail && start.detail.length > 3, 'no query on the start event');
  });

  check('the search results come back', () => {
    const end = events.find((e) => e.kind === 'end');
    assert(end, 'no tool_end event');
    assert(end.result && end.result.length > 20, 'the result was empty');
  });

  check('reasoning is captured rather than dropped', () => {
    assert(thinking.length > 0, 'no reasoning_content arrived');
    assert(thinking.join('').length > 50, 'the reasoning was suspiciously short');
  });

  check('an answer survives the reasoning', () => {
    assert(answer.trim().length > 0, 'the whole budget went on thinking');
  });

  console.log('');
  console.log('  thought ' + thinking.join('').length + ' chars, answered ' + answer.length);
  console.log('  answer: ' + JSON.stringify(answer.trim().slice(0, 160)));
  console.log('  events: ' + events.map((e) => e.kind).join(' → '));

  /* ---------- Unsloth's image-query extension ---------- */

  const imageSetting = await engine.configureImageSearch(found.endpoint, key, true);
  check('image search can be enabled', () => {
    assert(imageSetting.ok, 'the chat setting was rejected');
  });

  const imageEvents = [];
  const imageRes = await engine.chat(
    {
      endpoint: found.endpoint,
      key,
      messages: [
        {
          role: 'system',
          content:
            'Use image queries within web search for visual reference requests. ' +
            'Do not print [[img:...]] tokens.'
        },
        {
          role: 'user',
          content: 'Find a reference image of a Ferrari 308 side profile, then name the car.'
        }
      ],
      serverTools: ['web_search'],
      sessionId: 'ask-live-image-check',
      maxTokens: 900
    },
    () => {},
    (event) => imageEvents.push(event),
    () => {}
  );

  check('a visual-reference request uses image queries', () => {
    const start = imageEvents.find((event) => event.kind === 'start');
    assert(start && /images:/i.test(start.detail), 'tool detail: ' + JSON.stringify(start));
  });
  check('image metadata does not leak into the visible tool result', () => {
    const end = imageEvents.find((event) => event.kind === 'end');
    assert(end && !/__WEB_IMAGES__/.test(end.result), 'raw image envelope remained');
    assert(!/\[\[img:/.test(imageRes.text), 'raw image token remained in the answer');
  });

  console.log('');
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
