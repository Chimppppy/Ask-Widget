/* ============================================================
   Ask — renderer

   Holds the conversation, paints the stream as it lands, and
   asks main for a window tall enough to hold the result. It
   never touches the network or sees the API key.
   ============================================================ */

const $ = (id) => document.getElementById(id);

const card = $('card');
const askRow = $('ask');
const q = $('q');
const snipBtn = $('snip');
const grabBtn = $('grab');
const gearBtn = $('gear');
const shotsEl = $('shots');
const sheet = $('sheet');
const scroll = $('scroll');
const threadEl = $('thread');
const statEl = $('stat');
const stopBtn = $('stop');
const copyBtn = $('copy');
const clearBtn = $('clear');
const stateEl = $('state');
const stateText = $('state-text');
const stateFix = $('state-fix');
const panel = $('panel');
const settingsTabs = [...document.querySelectorAll('[data-settings-tab]')];
const settingsPages = [...document.querySelectorAll('[data-settings-page]')];

let thread = []; // { role, content, images, failed }
let shots = []; // { url, size }
let busy = false;
let turnId = 0;
let started = 0;
let firstAt = 0;
let thoughtAt = 0;
let live = null; // the element being streamed into
let livePaintPending = false;
let settings = null;
let models = [];

function showSettingsPage(name) {
  for (const tab of settingsTabs) {
    const on = tab.dataset.settingsTab === name;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const page of settingsPages) {
    page.hidden = page.dataset.settingsPage !== name;
  }
  const body = panel.querySelector('.panel-body');
  if (body) body.scrollTop = 0;
  fit();
}

for (const tab of settingsTabs) {
  tab.addEventListener('click', () => showSettingsPage(tab.dataset.settingsTab));
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const at = settingsTabs.indexOf(tab);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = settingsTabs[(at + step + settingsTabs.length) % settingsTabs.length];
    showSettingsPage(next.dataset.settingsTab);
    next.focus();
  });
}

/* ───────────────────────── chrome ───────────────────────── */

// Who draws the corners and the shadow: Windows 11 through an acrylic blur,
// or the stylesheet inside a transparent window. The layout differs enough
// that the answer has to arrive before the card is measured.
window.api.chrome().then((mode) => {
  document.documentElement.dataset.chrome = mode;
  fit();
});

/* ───────────────────────── theme ───────────────────────── */

function paintTheme(dark) {
  document.documentElement.classList.toggle('light', !dark);
}

window.api.isDark().then(paintTheme);
window.api.onThemeChange(paintTheme);

/* ───────────────────────── sizing ───────────────────────── */

// The card grows with its content and the window is told to match, so the
// widget is one line until there is a reason to be more.
let lastHeight = 0;
let pending = false;

function fit() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const h = Math.ceil(card.getBoundingClientRect().height);
    if (h && Math.abs(h - lastHeight) >= 1) {
      lastHeight = h;
      window.api.setHeight(h);
    }
  });
}

new ResizeObserver(fit).observe(card);

/* ───────────────────────── text ───────────────────────── */

function esc(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );
}

/* A sentinel standing in for a rescued code span while the rest of the text
   is formatted. It is built from a code point rather than typed in: a raw
   control character in the source would make git call this file binary and
   some editors would quietly strip it. */
const MARK = String.fromCharCode(0xe000);
const MARKED = new RegExp(MARK + '([0-9]+)' + MARK, 'g');
const LONE_MARK = new RegExp('^' + MARK + '[0-9]+' + MARK + '$');

/**
 * Just enough markdown for a chat answer. Code is pulled out first so
 * nothing inside a snippet gets treated as formatting, which is the usual
 * way these small renderers mangle their own output.
 */
function md(src) {
  const vault = [];
  const keep = (html) => {
    vault.push(html);
    return MARK + (vault.length - 1) + MARK;
  };

  let text = String(src);

  // fenced blocks, on their own line so the assembler can spot them
  text = text.replace(/```[\w+-]*\r?\n?([\s\S]*?)```/g, (_m, code) =>
    '\n' + keep('<pre><code>' + esc(code.replace(/\r?\n$/, '')) + '</code></pre>') + '\n'
  );

  // an unterminated fence is the normal state of affairs mid stream
  text = text.replace(/```[\w+-]*\r?\n?([\s\S]*)$/, (_m, code) =>
    '\n' + keep('<pre><code>' + esc(code) + '</code></pre>') + '\n'
  );

  text = text.replace(/`([^`\n]+)`/g, (_m, code) => keep('<code>' + esc(code) + '</code>'));

  text = esc(text);

  text = text.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (url) =>
    keep('<a href="' + url + '">' + url + '</a>')
  );

  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  const out = blockify(text);
  return out.replace(MARKED, (_m, i) => vault[Number(i)] || '');
}

function blockify(text) {
  const lines = text.split('\n');
  let html = '';
  let list = null;
  let para = [];

  const endPara = () => {
    if (para.length) {
      html += '<p>' + para.join('<br>') + '</p>';
      para = [];
    }
  };
  const endList = () => {
    if (list) {
      html += '</' + list + '>';
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) {
      endPara();
      endList();
      continue;
    }

    // a rescued code block stands alone
    if (LONE_MARK.test(line)) {
      endPara();
      endList();
      html += line;
      continue;
    }

    const head = /^(#{1,3})\s+(.*)$/.exec(line);
    if (head) {
      endPara();
      endList();
      html += '<h' + head[1].length + '>' + head[2] + '</h' + head[1].length + '>';
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      endPara();
      if (list !== 'ul') {
        endList();
        html += '<ul>';
        list = 'ul';
      }
      html += '<li>' + bullet[1] + '</li>';
      continue;
    }

    const number = /^\d+[.)]\s+(.*)$/.exec(line);
    if (number) {
      endPara();
      if (list !== 'ol') {
        endList();
        html += '<ol>';
        list = 'ol';
      }
      html += '<li>' + number[1] + '</li>';
      continue;
    }

    endList();
    para.push(line);
  }

  endPara();
  endList();
  return html;
}

/* ───────────────────────── tool runs ───────────────────────── */

const RUN_STATE = {
  running: 'running',
  awaiting: 'waiting in Unsloth',
  asking: 'waiting on you',
  done: 'done',
  failed: 'failed',
  declined: 'declined'
};

// Arguments as one short line. The full set is rarely what you want to read
// and always what wrecks the layout.
function brief(args) {
  if (!args || typeof args !== 'object') return '';
  const bits = [];
  for (const [k, v] of Object.entries(args)) {
    let shown = typeof v === 'string' ? v : JSON.stringify(v);
    if (shown === undefined) shown = '';
    if (shown.length > 60) shown = shown.slice(0, 60) + '…';
    bits.push(k + ': ' + shown);
  }
  const line = bits.join('  ');
  return line.length > 120 ? line.slice(0, 120) + '…' : line;
}

function button(label, className, onClick) {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function answerTool(m, answer) {
  m.state = 'running';
  window.api.toolAnswer(answer);
  render();
}

function toolRow(m) {
  const row = document.createElement('div');
  row.className = 'run ' + m.state;

  const head = document.createElement('div');
  head.className = 'run-head';

  const dot = document.createElement('span');
  dot.className = 'run-dot';

  const name = document.createElement('span');
  name.className = 'run-name';
  name.textContent = m.server ? m.server + ' · ' + m.label : m.tool;

  const args = document.createElement('span');
  args.className = 'run-args';
  args.textContent = brief(m.args);

  const state = document.createElement('span');
  state.className = 'run-state';
  state.textContent = RUN_STATE[m.state] || '';

  head.append(dot, name, args, state);
  row.appendChild(head);

  if (m.state === 'asking') {
    const why = document.createElement('div');
    why.className = 'run-why';
    why.textContent =
      (m.description ? m.description.replace(/\s+$/, '') + ' ' : '') +
      'This one can change something, so it needs your say so.';
    row.appendChild(why);

    const ask = document.createElement('div');
    ask.className = 'run-ask';
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    ask.append(
      spacer,
      button('Don’t', 'ask-btn no', () => {
        m.state = 'declined';
        window.api.toolAnswer({ allow: false });
        render();
      }),
      // The emphasis sits on the narrow choice on purpose. Making the
      // standing grant the easiest button to hit is how people end up
      // approving things they meant to look at.
      button('Always, this session', 'ask-btn', () =>
        answerTool(m, { allow: true, always: true })
      ),
      button('Run once', 'ask-btn yes', () => answerTool(m, { allow: true }))
    );
    row.appendChild(ask);
  }

  if (m.image && m.state === 'done') {
    const shot = document.createElement('img');
    shot.className = 'run-shot';
    shot.src = m.image;
    shot.alt = '';
    row.appendChild(shot);
  }

  if (m.state === 'awaiting') {
    const why = document.createElement('div');
    why.className = 'run-why';
    why.textContent =
      'Unsloth is asking you about this one in its own window. Ask cannot ' +
      'answer that for you.';
    row.appendChild(why);
  }

  if (m.text && (m.state === 'done' || m.state === 'failed')) {
    const out = document.createElement('div');
    out.className = 'run-out';
    out.textContent = m.text.length > 700 ? m.text.slice(0, 700) + '…' : m.text;
    row.appendChild(out);
  }

  return row;
}

function thinkRow(m) {
  const row = document.createElement('div');
  row.className = 'think' + (m.streaming ? ' live' : ' done') + (m.open ? ' open' : '');

  const head = document.createElement('div');
  head.className = 'think-head';

  const caret = document.createElement('svg');
  head.innerHTML =
    '<svg class="caret" viewBox="0 0 12 12"><path d="M4.5 2.5l4 3.5-4 3.5"/></svg>';

  const label = document.createElement('span');
  label.textContent = m.streaming
    ? 'Thinking'
    : 'Thought for ' + (m.seconds ? m.seconds.toFixed(1) + 's' : 'a moment');
  head.appendChild(label);

  head.addEventListener('click', () => {
    m.open = !m.open;
    render();
  });

  const body = document.createElement('div');
  body.className = 'think-body';
  body.textContent = m.content;

  row.append(head, body);
  return row;
}

function findRun(callId) {
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i].role === 'tool' && thread[i].callId === callId) return thread[i];
  }
  return null;
}

/* ───────────────────────── the thread ───────────────────────── */

function atBottom() {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
}

function render() {
  const stick = atBottom();
  threadEl.textContent = '';
  live = null;

  for (const m of thread) {
    if (m.role === 'tool') {
      threadEl.appendChild(toolRow(m));
      continue;
    }

    if (m.role === 'think') {
      const row = thinkRow(m);
      threadEl.appendChild(row);
      // a running thought stays scrolled to its newest line
      if (m.streaming) {
        const body = row.querySelector('.think-body');
        body.scrollTop = body.scrollHeight;
      }
      continue;
    }

    const row = document.createElement('div');
    row.className = 'msg ' + (m.role === 'user' ? 'user' : 'bot') + (m.failed ? ' fail' : '');

    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = m.role === 'user' ? 'You' : m.failed ? 'Trouble' : 'Ask';
    row.appendChild(who);

    const body = document.createElement('div');
    body.className = 'body';

    if (m.role === 'user') {
      const bits = [];
      if (m.images && m.images.length) {
        bits.push(m.images.length === 1 ? '[region]' : '[' + m.images.length + ' regions]');
      }
      if (m.content) bits.push(m.content);
      body.textContent = bits.join('  ');
    } else if (m.failed) {
      body.textContent = m.content;
    } else {
      body.innerHTML = md(m.content) || '';
      if (m.streaming) {
        live = body;
        body.insertAdjacentHTML('beforeend', '<span class="tick"></span>');
      }
    }

    row.appendChild(body);
    threadEl.appendChild(row);
  }

  sheet.hidden = thread.length === 0;
  if (stick) scroll.scrollTop = scroll.scrollHeight;
  fit();
}

/**
 * The message the stream is currently filling. A turn that calls a tool
 * produces several stretches of text with tool rows between them, so each
 * stretch becomes its own message rather than one growing blob.
 */
function liveMessage() {
  const last = thread[thread.length - 1];
  if (last && last.role === 'assistant' && last.streaming) return last;
  const fresh = { role: 'assistant', content: '', streaming: true };
  thread.push(fresh);
  render();
  return fresh;
}

function settle() {
  for (const m of thread) {
    if (!m.streaming) continue;
    m.streaming = false;
    if (m.role === 'think' && m.startedAt) m.seconds = (Date.now() - m.startedAt) / 1000;
  }

  // A tool can be the model's first output. In that case the empty assistant
  // row ask() prepared never receives a token and should not remain above the
  // tool run as a blank message.
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (m.role === 'assistant' && !m.content && !m.failed) thread.splice(i, 1);
  }
}

/**
 * The block the model is thinking into. Kept separate from the answer so the
 * reasoning can be collapsed away once there is a real reply to read.
 */
function thinkingMessage() {
  const last = thread[thread.length - 1];
  if (last && last.role === 'think' && last.streaming) return last;

  // ask() puts down an empty assistant row immediately so an ordinary model
  // has somewhere to stream its first token. A reasoning model speaks here
  // first instead. Remove that untouched placeholder or the real answer ends
  // up as a second assistant row after the thought, leaving a blank message in
  // history and in the DOM.
  if (last && last.role === 'assistant' && last.streaming && !last.content) {
    thread.pop();
  }

  const fresh = { role: 'think', content: '', streaming: true, startedAt: Date.now() };
  thread.push(fresh);
  render();
  return fresh;
}

// Repainting the whole thread on every token is wasteful and loses the
// text selection, so a stream only touches the message it is filling.
function paintLive(m) {
  if (!live) {
    render();
    return;
  }
  const stick = atBottom();
  live.innerHTML = md(m.content) + '<span class="tick"></span>';
  if (stick) scroll.scrollTop = scroll.scrollHeight;
  fit();
}

function queueLivePaint(m) {
  if (livePaintPending) return;
  livePaintPending = true;
  requestAnimationFrame(() => {
    livePaintPending = false;
    paintLive(m);
  });
}

/* ───────────────────────── attached regions ───────────────────────── */

function renderShots() {
  shotsEl.textContent = '';
  shotsEl.hidden = shots.length === 0;

  shots.forEach((shot, i) => {
    const box = document.createElement('div');
    box.className = 'shot';

    const img = document.createElement('img');
    img.src = shot.url;
    img.alt = '';
    box.appendChild(img);

    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = shot.size.width + '×' + shot.size.height;
    box.appendChild(dim);

    const drop = document.createElement('button');
    drop.className = 'drop';
    drop.title = 'Remove';
    drop.innerHTML = '<svg viewBox="0 0 12 12"><path d="M3.4 3.4l5.2 5.2M8.6 3.4l-5.2 5.2"/></svg>';
    drop.addEventListener('click', () => {
      shots.splice(i, 1);
      renderShots();
      q.focus();
    });
    box.appendChild(drop);

    shotsEl.appendChild(box);
  });

  snipBtn.classList.toggle('on', shots.length > 0);
  fit();
}

async function grabScreen() {
  if (busy) return;
  grabBtn.disabled = true;
  try {
    const res = await window.api.captureScreen();
    if (res && res.ok) {
      shots.push({ url: res.url, size: res.size });
      renderShots();
    } else if (res && res.error) {
      note(res.error);
    }
  } finally {
    grabBtn.disabled = false;
    q.focus();
  }
}

async function snip() {
  if (busy) return;
  snipBtn.disabled = true;
  try {
    const res = await window.api.pickRegion();
    if (res && res.ok) {
      shots.push({ url: res.url, size: res.size });
      renderShots();
    } else if (res && res.error) {
      note(res.error);
    }
  } finally {
    snipBtn.disabled = false;
    q.focus();
  }
}

/* ───────────────────────── engine state ───────────────────────── */

function note(text, good) {
  stateEl.hidden = !text;
  stateEl.classList.toggle('good', !!good);
  stateText.textContent = text || '';
  fit();
}

async function checkEngine() {
  const s = await window.api.status();
  models = s.models || [];

  if (!s.hasKey) {
    note('Add your Unsloth API key to get started.');
    return false;
  }
  if (!s.ok) {
    note(s.error || 'The engine is not reachable.');
    return false;
  }
  note('');
  return true;
}

/* ───────────────────────── asking ───────────────────────── */

function setBusy(on) {
  busy = on;
  // the spinner rule is .busy .glyph, and the ask row is the glyph's parent
  askRow.classList.toggle('busy', on);
  stopBtn.hidden = !on;
  snipBtn.disabled = on;
  grabBtn.disabled = on;
}

async function ask() {
  const text = q.value.trim();
  if (busy || (!text && !shots.length)) return;

  const ok = await checkEngine();
  if (!ok) {
    openPanel();
    return;
  }

  const id = ++turnId;
  const images = shots.map((s) => s.url);

  // History goes back as text only; the images belong to their own turn.
  const history = thread
    .filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && !m.failed && m.content
    )
    .map((m) => ({ role: m.role, content: m.content }));

  thread.push({ role: 'user', content: text, images });
  thread.push({ role: 'assistant', content: '', streaming: true });

  q.value = '';
  shots = [];
  renderShots();
  render();

  setBusy(true);
  started = Date.now();
  firstAt = 0;
  thoughtAt = 0;
  statEl.textContent = 'thinking…';

  await window.api.ask({ id, text, images, history });
}

function timing() {
  const total = ((Date.now() - started) / 1000).toFixed(1);
  const first = firstAt ? ((firstAt - started) / 1000).toFixed(1) : null;
  const name = settings && settings.model ? settings.model.split('/').pop() : 'model';
  return first
    ? name + '  ·  first token ' + first + 's  ·  ' + total + 's total'
    : name + '  ·  ' + total + 's';
}

window.api.onThinking((d) => {
  if (d.id !== turnId) return;
  if (!settings || !settings.showThinking) return;
  if (!thoughtAt) {
    thoughtAt = Date.now();
    statEl.textContent = 'thinking…';
  }
  const m = thinkingMessage();
  m.content += d.text;

  // repaint the body in place rather than rebuilding the thread on every
  // fragment, which would be thousands of rebuilds on a long thought
  const row = threadEl.lastElementChild;
  if (row && row.classList.contains('think')) {
    const body = row.querySelector('.think-body');
    body.textContent = m.content;
    body.scrollTop = body.scrollHeight;
    fit();
  } else {
    render();
  }
});

window.api.onDelta((d) => {
  if (d.id !== turnId) return;
  // the answer has started, so the thought is finished
  const last = thread[thread.length - 1];
  if (last && last.role === 'think' && last.streaming) {
    last.streaming = false;
    if (last.startedAt) last.seconds = (Date.now() - last.startedAt) / 1000;
    render();
  }
  if (!firstAt) {
    firstAt = Date.now();
    statEl.textContent = 'answering…';
  }
  const m = liveMessage();
  m.content += d.text;
  queueLivePaint(m);
});

window.api.onDone((d) => {
  if (d.id !== turnId) return;
  settle();
  setBusy(false);
  statEl.textContent = timing();
  render();
});

window.api.onError((d) => {
  if (d.id !== turnId) return;

  const m = thread[thread.length - 1];
  const stopped = /^Stopped\.$/.test(d.error);

  if (stopped && m && m.role === 'assistant' && m.content) {
    // a stopped answer keeps whatever arrived rather than becoming an error
    settle();
  } else if (m && m.role === 'assistant' && !m.content) {
    m.failed = true;
    m.streaming = false;
    m.content = d.error;
  } else {
    settle();
    thread.push({ role: 'assistant', content: d.error, failed: true });
  }

  setBusy(false);
  statEl.textContent = '';
  render();
});

/* ───────────────────────── tool events ───────────────────────── */

window.api.onToolStart((d) => {
  if (d.id !== turnId) return;
  // whatever the model said before reaching for a tool is finished
  settle();
  thread.push({
    role: 'tool',
    callId: d.callId,
    tool: d.tool,
    label: d.tool,
    args: d.args,
    state: 'running'
  });
  statEl.textContent = 'running ' + d.tool + '…';
  render();
});

window.api.onToolAsk((d) => {
  if (d.id !== turnId) return;
  const run = findRun(d.callId);
  if (!run) return;
  run.state = 'asking';
  run.server = d.server;
  run.label = d.label || run.tool;
  run.description = d.description || '';
  statEl.textContent = 'waiting on you…';
  render();
});

/* Something Unsloth is doing at its own end. Unlike an MCP tool it is not
   waiting on us, so these rows report rather than ask — except when Unsloth's
   own permission system is holding it, which it says so about. */
window.api.onToolServer((d) => {
  if (d.id !== turnId) return;

  if (d.kind === 'status') {
    statEl.textContent = d.detail;
    return;
  }
  if (d.kind === 'thought') return;

  if (d.kind === 'start') {
    settle();
    thread.push({
      role: 'tool',
      callId: d.callId || 'server-' + Math.random().toString(36).slice(2),
      tool: d.name,
      label: d.name,
      server: 'unsloth',
      args: d.detail ? { query: d.detail } : null,
      state: d.awaiting ? 'awaiting' : 'running'
    });
    statEl.textContent = d.awaiting
      ? 'waiting for Unsloth…'
      : 'running ' + d.name + '…';
    render();
    return;
  }

  if (d.kind === 'end') {
    const run = findRun(d.callId);
    if (run) {
      run.state = 'done';
      run.text = d.result || '';
    }
    statEl.textContent = 'answering…';
    render();
  }
});

window.api.onToolEnd((d) => {
  if (d.id !== turnId) return;
  const run = findRun(d.callId);
  if (!run) return;
  if (run.state !== 'declined') run.state = d.ok ? 'done' : 'failed';
  run.text = d.text || '';
  if (d.image) run.image = d.image;
  statEl.textContent = 'answering…';
  render();
});

/* ───────────────────────── settings ───────────────────────── */

function fillModels(current) {
  const sel = $('s-model');
  sel.textContent = '';

  const list = models.slice();
  if (current && !list.includes(current)) list.unshift(current);

  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No models found — load one in Unsloth';
    sel.appendChild(opt);
    return;
  }

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Whatever is loaded';
  sel.appendChild(blank);

  for (const id of list) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    sel.appendChild(opt);
  }
  sel.value = current || '';
}


/* Unsloth's own tools, enabled by name. These run at its end rather than
   ours, so the permission gate never sees them — which is why the two that
   execute code carry a warning. */
const SERVER_TOOL_BOXES = [
  ['s-web', 'web_search'],
  ['s-python', 'python'],
  ['s-terminal', 'terminal']
];

function readServerTools() {
  return SERVER_TOOL_BOXES.filter(([id]) => $(id).checked).map(([, name]) => name);
}

function paintServerWarning() {
  $('s-server-warn').hidden = !($('s-python').checked || $('s-terminal').checked);
  fit();
}

function paintImageAvailability() {
  const enabled = $('s-web').checked;
  $('s-imagesearch').disabled = !enabled;
  $('s-image-row').classList.toggle('disabled', !enabled);
}

for (const [id] of SERVER_TOOL_BOXES) {
  $(id).addEventListener('change', () => {
    paintServerWarning();
    paintImageAvailability();
  });
}

/**
 * What the MCP servers are doing. Shown in settings because a server that
 * failed to start is otherwise completely invisible — the tools simply are
 * not offered and nothing says why.
 */
async function paintServers() {
  const el = $('s-servers');
  el.textContent = '';

  let info;
  try {
    info = await window.api.mcpStatus();
  } catch {
    return;
  }

  const servers = info.servers || [];

  if (!servers.length) {
    const none = document.createElement('div');
    none.className = 'server-none';
    none.textContent =
      'No MCP servers yet. mcp.json takes the same shape as Claude Desktop’s ' +
      'config, so an entry copied from there works here. Edit it, then reload.';
    el.appendChild(none);
    return;
  }

  for (const server of servers) {
    const row = document.createElement('div');
    row.className = 'server' + (server.ok ? '' : ' bad');

    const dot = document.createElement('span');
    dot.className = 'run-dot';
    if (server.ok) dot.style.background = 'var(--live)';
    else dot.style.background = 'var(--alert)';

    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = server.name;

    const detail = document.createElement('span');
    detail.className = 'det';
    if (server.ok) {
      const n = server.tools.length;
      const reads = server.tools.filter((t) => t.readOnly).length;
      detail.textContent =
        n + (n === 1 ? ' tool' : ' tools') + (reads ? ', ' + reads + ' read only' : '');
    } else {
      detail.textContent = server.error;
    }

    row.append(dot, name, detail);
    el.appendChild(row);
  }
}

async function openPanel() {
  settings = await window.api.loadSettings();

  $('s-endpoint').value = settings.endpoint || '';
  $('s-key').value = '';
  $('s-key').placeholder = settings.hasKey ? 'saved — type to replace' : 'sk-unsloth-…';
  $('s-tokens').value = settings.maxTokens;
  $('s-temp').value = settings.temperature;
  $('s-system').value = settings.systemPrompt || '';
  $('s-autostart').checked = !!settings.autostart;
  $('s-autoattach').checked = !!settings.autoAttach;
  $('s-usetools').checked = !!settings.useTools;
  $('s-screentool').checked = !!settings.screenTool;
  $('s-imagesearch').checked = settings.imageSearch !== false;
  $('s-appearance').value = settings.appearance || 'system';
  $('s-showthinking').checked = !!settings.showThinking;

  const on = Array.isArray(settings.serverTools) ? settings.serverTools : [];
  for (const [id, name] of SERVER_TOOL_BOXES) $(id).checked = on.includes(name);
  paintServerWarning();
  paintImageAvailability();
  $('s-shortcut').textContent = settings.shortcut;
  $('s-shortcut-warn').hidden = settings.shortcutOk;
  $('s-test-out').textContent = '';

  // Open immediately. The engine probe may need to scan ports when the local
  // server is down, so refresh the model list after the panel is already usable.
  fillModels(settings.model);

  panel.hidden = false;
  sheet.hidden = true;
  gearBtn.classList.add('on');
  showSettingsPage('general');
  fit();

  paintServers();

  window.api.status().then((s) => {
    if (panel.hidden) return;
    models = s.models || [];
    fillModels(settings.model);
  }).catch(() => {});
}

function closePanel() {
  panel.hidden = true;
  gearBtn.classList.remove('on');
  sheet.hidden = thread.length === 0;
  fit();
  q.focus();
}

async function savePanel() {
  const patch = {
    endpoint: $('s-endpoint').value.trim() || undefined,
    model: $('s-model').value,
    maxTokens: Number($('s-tokens').value) || 1024,
    temperature: Number($('s-temp').value),
    systemPrompt: $('s-system').value,
    autoAttach: $('s-autoattach').checked,
    useTools: $('s-usetools').checked,
    screenTool: $('s-screentool').checked,
    imageSearch: $('s-imagesearch').checked,
    appearance: $('s-appearance').value,
    showThinking: $('s-showthinking').checked,
    serverTools: readServerTools(),
    autostart: $('s-autostart').checked
  };

  const key = $('s-key').value.trim();
  if (key) patch.apiKey = key;

  const chord = $('s-shortcut').dataset.next;
  if (chord && chord !== settings.shortcut) patch.shortcut = chord;

  settings = await window.api.saveSettings(patch);
  $('s-shortcut-warn').hidden = settings.shortcutOk;

  if (!settings.shortcutOk) return; // stay open so the clash can be fixed

  closePanel();
  checkEngine();
}

$('s-test').addEventListener('click', async () => {
  const out = $('s-test-out');
  out.textContent = 'checking…';

  // Test the draft values without persisting them. Save remains the only
  // action that changes configuration, so Cancel really means cancel.
  const s = await window.api.testConnection({
    endpoint: $('s-endpoint').value.trim() || undefined,
    apiKey: $('s-key').value.trim()
  });
  models = s.models || [];
  fillModels($('s-model').value);
  out.textContent = s.ok
    ? 'Connected · ' + (models.length || 0) + ' model' + (models.length === 1 ? '' : 's')
    : s.error;
});

/* the shortcut box listens for a chord rather than text */
const keycap = $('s-shortcut');
let listening = false;

function chordFrom(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!mods.length) return null;

  const key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return null;

  const named = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: null,
    Enter: 'Return',
    Backspace: 'Backspace',
    Tab: 'Tab'
  };

  let name;
  if (key in named) name = named[key];
  else if (key.length === 1) name = key.toUpperCase();
  else name = key; // F1..F24 and friends already read correctly

  return name ? mods.join('+') + '+' + name : null;
}

keycap.addEventListener('click', () => {
  listening = true;
  keycap.classList.add('listening');
  keycap.textContent = 'Press a combination…';
});

keycap.addEventListener('blur', () => {
  if (!listening) return;
  listening = false;
  keycap.classList.remove('listening');
  keycap.textContent = keycap.dataset.next || (settings && settings.shortcut) || '';
});

keycap.addEventListener('keydown', (e) => {
  if (!listening) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') {
    listening = false;
    keycap.classList.remove('listening');
    keycap.textContent = keycap.dataset.next || settings.shortcut;
    return;
  }

  const chord = chordFrom(e);
  if (!chord) return;

  listening = false;
  keycap.classList.remove('listening');
  keycap.dataset.next = chord;
  keycap.textContent = chord;
});

$('s-mcp-open').addEventListener('click', () => window.api.mcpReveal());

$('s-mcp-reload').addEventListener('click', async () => {
  const el = $('s-servers');
  el.textContent = '';
  const wait = document.createElement('div');
  wait.className = 'server-none';
  wait.textContent = 'Starting servers…';
  el.appendChild(wait);
  fit();

  await window.api.mcpRestart();
  paintServers();
});

// a server that finishes starting after the panel is already open
window.api.onMcpChanged(() => {
  if (!panel.hidden) paintServers();
});

$('s-save').addEventListener('click', savePanel);
$('s-cancel').addEventListener('click', closePanel);
stateFix.addEventListener('click', openPanel);

gearBtn.addEventListener('click', () => {
  if (panel.hidden) openPanel();
  else closePanel();
});

/* ───────────────────────── wiring ───────────────────────── */

snipBtn.addEventListener('click', snip);
grabBtn.addEventListener('click', grabScreen);

// main grabs the screen as the widget opens when that is switched on, and
// hands the result over once the window is up
window.api.onShotAdd((shot) => {
  if (!shot || !shot.url) return;
  shots.push(shot);
  renderShots();
});
stopBtn.addEventListener('click', () => window.api.stop());

copyBtn.addEventListener('click', () => {
  const last = [...thread].reverse().find((m) => m.role === 'assistant' && !m.failed);
  if (last) {
    window.api.copyText(last.content);
    copyBtn.textContent = 'Copied';
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1100);
  }
});

clearBtn.addEventListener('click', () => {
  window.api.stop();
  thread = [];
  shots = [];
  statEl.textContent = '';
  setBusy(false);
  renderShots();
  render();
  q.focus();
});

// links open in the real browser; the CSP would block them here anyway
threadEl.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  window.api.openExternal(a.href);
});

q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ask();
  }
});

document.addEventListener('keydown', (e) => {
  if (listening) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    if (!panel.hidden) {
      closePanel();
      return;
    }
    window.api.hide();
    return;
  }

  if (e.ctrlKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    if (!panel.hidden) {
      savePanel();
    } else if (e.shiftKey) {
      grabScreen();
    } else {
      snip();
    }
  }
});

/* In the transparent window there is a band of empty space around the card
   holding the shadow. It looks like the desktop, so it should behave like
   the desktop and put the widget away. */
document.addEventListener('mousedown', (e) => {
  if (!card.contains(e.target)) window.api.hide();
});

window.api.onShown(() => {
  // Streaming updates can finish while the native window is hidden. Height
  // requests are intentionally ignored off-screen, so measure again now that
  // the completed thread is visible.
  fit();
  q.focus();
  q.select();
  checkEngine();
});

window.api.onOpenSettings(openPanel);

window.api.onShortcutFailed((accel) => {
  note('Windows would not give up ' + accel + '. Pick another in settings.');
});

/* ───────────────────────── start ───────────────────────── */

window.api.loadSettings().then((s) => {
  settings = s;
  checkEngine();
  fit();
});
