/* ============================================================
   Ask — a keybind widget in front of a local model

   The shape of this app is the opposite of a normal window: it
   lives in the tray, it is hidden most of the time, and closing
   it means hiding it. Quitting happens from the tray menu only.
   ============================================================ */

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const engine = require('./engine');
const capture = require('./capture');
const mcp = require('./mcp');
const builtin = require('./builtin');

const APP_ID = 'io.github.chimppppy.ask';

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
// The API key is a credential, so it lives apart from ordinary settings
// and is never handed to the renderer.
const ENGINE_FILE = path.join(app.getPath('userData'), 'engine.json');

const ICON = path.join(__dirname, 'build', 'icon.ico');

/* Windows 11 22H2 and later can blur whatever is behind a window, and when
   it does that it also draws the corners and the drop shadow itself. That
   mode needs no padding at all and cannot clip its own shadow, which is what
   a hand rolled CSS shadow inside a transparent window does the moment the
   blur is wider than the padding around it.

   Everywhere else the renderer draws the shadow and the window carries PAD
   of empty space on every side to hold it. Every height sum uses PAD. */
function acrylicAvailable() {
  if (process.platform !== 'win32') return false;
  return Number(os.release().split('.')[2] || 0) >= 22621;
}

const ACRYLIC = acrylicAvailable();

// The CSS shadow is 28px of blur pushed 10px down, so it reaches 38px below
// the card. Anything less than that here and the corners get sliced off.
const PAD = ACRYLIC ? 0 : 44;
const WIDTH = 640 + PAD * 2;
const COMPACT = 76 + PAD * 2;

const DEFAULTS = {
  shortcut: 'Control+Shift+Space',
  endpoint: engine.DEFAULT_ENDPOINT,
  model: '',
  temperature: 0.7,
  maxTokens: 2048,
  historyTurns: 6,
  // grab whatever is on screen the moment the widget is summoned, so asking
  // about what you were just looking at takes one keypress rather than three
  autoAttach: false,
  // offering tools costs nothing until an MCP server is configured, because
  // with none running the list is empty and the field is left off the request
  useTools: true,
  // the model may take its own look at the screen when a question needs it
  screenTool: true,
  // Unsloth adds image_queries to web_search while this is on. It is useful
  // for identification and reference-image tasks, not just decorating replies.
  imageSearch: true,
  // Follow Windows unless the user explicitly wants the widget light or dark.
  appearance: 'system',
  // Reasoning still streams through the engine, but the compact widget keeps
  // it out of the conversation unless the user asks to see it.
  showThinking: false,
  // Unsloth runs these at its end. Search is on because the alternative is a
  // model confidently describing a CVE that came out after it was trained.
  serverTools: ['web_search'],
  systemPrompt: [
    'You are a quick assistant living in a keyboard shortcut. Answer the ' +
      'question asked, then stop.',
    '',
    'Never invent specifics. If you do not know something — a version, a CVE, ' +
      'an API, anything recent — look it up or say plainly that you do not ' +
      'know. Never write a placeholder like "[affected product]" and never ' +
      'present a guess as a fact.',
    '',
    'Reach for a tool whenever the answer depends on something training alone ' +
      'cannot tell you: what is on the screen, what is in a file or an inbox, ' +
      'or anything current. Search first for recent events, versions, prices ' +
      'and security advisories.',
    '',
    'For code, give the whole thing in a fenced block with its language, and ' +
      'one line saying what it does. No "rest of your code here".'
  ].join('\n')
};

/* A prompt from an earlier version, still sitting in settings.json of anyone
   who installed before. It asked for brevity above all, which is part of why
   a question about a CVE came back as a filled in template. Anyone still on
   it never chose it, so it is quietly replaced. */
const SUPERSEDED = [
  'You are a quick assistant living in a keyboard shortcut. Answer in as ' +
    'few words as the question allows. Reach for a short list or a snippet ' +
    'when it genuinely helps, and skip the preamble entirely.'
];

let widget = null;
let overlay = null;
let tray = null;
let quitting = false;
let pendingPick = null;
let capturing = false;
let turn = null; // the AbortController for the answer being streamed

/* ---------- persistence ---------- */

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to write', file, err);
    return false;
  }
}

function settings() {
  const saved = readJSON(SETTINGS_FILE, {});
  const merged = { ...DEFAULTS, ...saved };

  if (SUPERSEDED.includes(merged.systemPrompt)) {
    merged.systemPrompt = DEFAULTS.systemPrompt;
    // an untouched old config also carries the old reply cap, which is short
    // enough to cut a code answer in half
    if (merged.maxTokens === 1024) merged.maxTokens = DEFAULTS.maxTokens;
  }

  if (!['system', 'light', 'dark'].includes(merged.appearance)) {
    merged.appearance = DEFAULTS.appearance;
  }

  return merged;
}

const KEEP = [
  'shortcut',
  'endpoint',
  'model',
  'temperature',
  'maxTokens',
  'historyTurns',
  'autoAttach',
  'useTools',
  'screenTool',
  'imageSearch',
  'appearance',
  'showThinking',
  'serverTools',
  'systemPrompt'
];

function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  const out = {};
  for (const key of KEEP) out[key] = next[key];
  writeJSON(SETTINGS_FILE, out);
  return next;
}

function applyAppearance(value) {
  nativeTheme.themeSource = ['light', 'dark'].includes(value) ? value : 'system';
}

function apiKey() {
  return readJSON(ENGINE_FILE, {}).apiKey || '';
}

/* ---------- the widget ---------- */

function send(channel, payload) {
  if (widget && !widget.isDestroyed()) widget.webContents.send(channel, payload);
}

function createWidget() {
  widget = new BrowserWindow({
    width: WIDTH,
    height: COMPACT,
    show: false,
    frame: false,
    // backgroundMaterial needs a see through backgroundColor and refuses to
    // work at all alongside transparent: true
    backgroundColor: '#00000000',
    ...(ACRYLIC
      ? { transparent: false, backgroundMaterial: 'acrylic', roundedCorners: true, hasShadow: true }
      : { transparent: true, hasShadow: false }),
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false
    }
  });

  // 'floating' is not enough to clear a maximised window on Windows
  widget.setAlwaysOnTop(true, 'screen-saver');
  widget.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Closing is hiding. The only way out is the tray menu.
  widget.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideWidget();
  });

  // Clicking away should put it back, the same as Esc. A region pick
  // legitimately takes the focus, so it suspends this.
  widget.on('blur', () => {
    if (overlay || capturing || !widget || widget.isDestroyed()) return;
    if (widget.isVisible()) hideWidget();
  });

  widget.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  nativeTheme.on('updated', () =>
    send('theme:changed', nativeTheme.shouldUseDarkColors)
  );
}

// Put the widget on whichever screen the pointer is on, a fifth of the way
// down, which is where the eye already is on a launcher.
function placeWidget(height) {
  const display = capture.displayUnderCursor();
  const area = display.workArea;
  const h = Math.min(height || COMPACT, Math.round(area.height * 0.8));

  widget.setBounds({
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: Math.round(area.y + area.height * 0.18),
    width: WIDTH,
    height: h
  });
}

function showWidget() {
  if (!widget || widget.isDestroyed()) createWidget();
  placeWidget(widget.getBounds().height);
  widget.show();
  // Windows will not always hand focus to a window raised from a hotkey
  // unless the app asks for it outright
  app.focus({ steal: true });
  widget.focus();
  send('widget:shown');
}

function hideWidget() {
  if (!widget || widget.isDestroyed()) return;
  widget.hide();
  send('widget:hidden');
}

/**
 * The whole screen, scaled down to something a small model can read. Used by
 * the screen button and, when it is switched on, automatically as the widget
 * opens — which is the point of the thing: look at something, press the key,
 * ask about what you were looking at.
 */
async function grabWholeScreen() {
  const display = capture.displayUnderCursor();
  const frame = await capture.grabDisplay(display);
  const shot = capture.cropAndShrink(
    frame,
    { x: 0, y: 0, width: display.size.width, height: display.size.height },
    display.scaleFactor
  );
  return { url: capture.toDataURL(shot), size: shot.getSize() };
}

async function toggleWidget() {
  if (widget && !widget.isDestroyed() && widget.isVisible()) {
    hideWidget();
    return;
  }

  // Capture before the window is on screen, otherwise the widget appears in
  // its own screenshot and the model spends its attention on that.
  let shot = null;
  // Reopening an answer that is still running should be a pure reveal. Do not
  // capture a new screen or alter the next prompt while the hidden turn works.
  if (!turn && settings().autoAttach) {
    try {
      shot = await grabWholeScreen();
    } catch (err) {
      console.error('Could not grab the screen', err);
    }
  }

  showWidget();
  if (shot) send('shot:add', shot);
}

/* ---------- the shortcut ---------- */

let boundShortcut = '';

// Windows hands a combination to whoever asked first, so a clash here is
// silent unless it is checked. The answer surfaces in settings.
function bindShortcut(accel) {
  if (boundShortcut) {
    globalShortcut.unregister(boundShortcut);
    boundShortcut = '';
  }
  if (!accel) return false;
  try {
    const ok = globalShortcut.register(accel, toggleWidget);
    if (ok) boundShortcut = accel;
    updateTray(ok ? accel : null);
    return ok;
  } catch {
    updateTray(null);
    return false;
  }
}

/* ---------- tray ---------- */

function updateTray(accel) {
  if (!tray) return;
  tray.setToolTip(accel ? 'Ask  ·  ' + accel : 'Ask  ·  shortcut unavailable');
}

function buildTray() {
  const image = nativeImage.createFromPath(ICON);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);

  const menu = Menu.buildFromTemplate([
    { label: 'Ask', click: showWidget },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        showWidget();
        send('open:settings');
      }
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) =>
        app.setLoginItemSettings({ openAtLogin: item.checked, args: [] })
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.on('click', toggleWidget);
  updateTray(settings().shortcut);
}

/* ---------- picking a region ---------- */

function closeOverlay() {
  if (overlay && !overlay.isDestroyed()) overlay.close();
  overlay = null;
}

function finishPick(value) {
  const resolve = pendingPick;
  pendingPick = null;
  closeOverlay();
  if (resolve) resolve(value);
}

/**
 * Hide the widget, freeze the screen it was covering, and let the user cut
 * a rectangle out of it. Resolves with a data URL, or null if they backed
 * out.
 */
async function pickRegion() {
  if (pendingPick) return null;

  const display = capture.displayUnderCursor();
  const wasVisible = widget && !widget.isDestroyed() && widget.isVisible();
  if (wasVisible) widget.hide();

  // the window is gone from the compositor a frame or two after hide(),
  // and capturing too eagerly catches the widget in its own screenshot
  await new Promise((r) => setTimeout(r, 140));

  let frame;
  try {
    frame = await capture.grabDisplay(display);
  } catch (err) {
    if (wasVisible) showWidget();
    throw err;
  }

  overlay = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));

  overlay.webContents.once('did-finish-load', () => {
    if (overlay && !overlay.isDestroyed()) {
      overlay.webContents.send('overlay:frame', capture.toDataURL(frame));
      overlay.focus();
    }
  });

  const rect = await new Promise((resolve) => {
    pendingPick = resolve;
  });

  if (wasVisible) showWidget();
  if (!rect) return null;

  const shot = capture.cropAndShrink(frame, rect, display.scaleFactor);
  return { url: capture.toDataURL(shot), size: shot.getSize() };
}

ipcMain.on('overlay:done', (_e, rect) => finishPick(rect));
ipcMain.on('overlay:cancel', () => finishPick(null));

/* ---------- ipc: window ---------- */

ipcMain.on('widget:hide', hideWidget);

// The renderer owns its own height: it measures the card and asks for a
// window to match, so the widget starts as one line and grows into an answer.
ipcMain.on('widget:height', (_e, height) => {
  if (!widget || widget.isDestroyed() || !widget.isVisible()) return;
  const area = capture.displayUnderCursor().workArea;
  const want = Math.round(height) + PAD * 2;
  const next = Math.max(COMPACT, Math.min(want, Math.round(area.height * 0.8)));
  const now = widget.getBounds();
  if (Math.abs(now.height - next) < 2) return;
  widget.setBounds({ x: now.x, y: now.y, width: WIDTH, height: next }, false);
});

// The renderer lays itself out differently depending on who is drawing the
// corners and the shadow, so it has to know before it paints.
ipcMain.handle('chrome:mode', () => (ACRYLIC ? 'acrylic' : 'shadow'));

ipcMain.handle('theme:isDark', () => nativeTheme.shouldUseDarkColors);
ipcMain.handle('clip:write', (_e, text) => clipboard.writeText(String(text || '')));
ipcMain.handle('open:external', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

/* ---------- ipc: settings ---------- */

ipcMain.handle('settings:load', () => ({
  ...settings(),
  hasKey: !!apiKey(),
  autostart: app.getLoginItemSettings().openAtLogin,
  shortcutOk: !!boundShortcut
}));

ipcMain.handle('settings:save', (_e, patch) => {
  const { apiKey: key, autostart, shortcut, ...rest } = patch || {};

  if (typeof key === 'string' && key.trim()) {
    writeJSON(ENGINE_FILE, { apiKey: key.trim() });
    clearEngineStatus();
  }
  if (typeof autostart === 'boolean') {
    app.setLoginItemSettings({ openAtLogin: autostart, args: [] });
  }

  const next = saveSettings({ ...rest, ...(shortcut ? { shortcut } : {}) });
  applyAppearance(next.appearance);
  if (rest.endpoint) clearEngineStatus();

  let shortcutOk = !!boundShortcut;
  if (shortcut && shortcut !== boundShortcut) shortcutOk = bindShortcut(shortcut);

  return {
    ...next,
    hasKey: !!apiKey(),
    shortcutOk,
    autostart: app.getLoginItemSettings().openAtLogin
  };
});

ipcMain.handle('key:clear', () => {
  writeJSON(ENGINE_FILE, {});
  return true;
});

/* ---------- ipc: engine ---------- */

const ENGINE_STATUS_TTL = 15_000;
let engineStatusCache = null;
let engineStatusPending = null;

function clearEngineStatus() {
  engineStatusCache = null;
  engineStatusPending = null;
}

async function getEngineStatus(force = false) {
  const cfg = settings();
  const key = apiKey();
  const signature = cfg.endpoint + '\u0000' + key;
  const now = Date.now();

  if (
    !force &&
    engineStatusCache &&
    engineStatusCache.signature === signature &&
    now - engineStatusCache.at < ENGINE_STATUS_TTL
  ) {
    return engineStatusCache.value;
  }
  if (!force && engineStatusPending && engineStatusPending.signature === signature) {
    return engineStatusPending.promise;
  }

  const promise = engine.discover(cfg.endpoint, key).then((found) => {
    // Unsloth takes whichever port was free, so quietly follow it rather
    // than telling the user their endpoint is wrong.
    if (found.ok && found.moved) saveSettings({ endpoint: found.endpoint });

    const value = {
      ok: found.ok,
      error: found.error || '',
      models: found.models || [],
      endpoint: found.endpoint,
      hasKey: !!key
    };
    engineStatusCache = {
      signature: (found.endpoint || cfg.endpoint) + '\u0000' + key,
      at: Date.now(),
      value
    };
    if (
      found.ok &&
      Array.isArray(cfg.serverTools) &&
      cfg.serverTools.includes('web_search')
    ) {
      engine
        .configureImageSearch(found.endpoint, key, cfg.imageSearch)
        .catch(() => {});
    }
    return value;
  }).finally(() => {
    if (engineStatusPending && engineStatusPending.promise === promise) {
      engineStatusPending = null;
    }
  });

  engineStatusPending = { signature, promise };
  return promise;
}

ipcMain.handle('engine:status', (_e, force) => getEngineStatus(!!force));

ipcMain.handle('engine:test', async (_e, candidate) => {
  const cfg = settings();
  const endpoint =
    candidate && typeof candidate.endpoint === 'string' && candidate.endpoint.trim()
      ? candidate.endpoint.trim()
      : cfg.endpoint;
  const key =
    candidate && typeof candidate.apiKey === 'string' && candidate.apiKey.trim()
      ? candidate.apiKey.trim()
      : apiKey();
  const found = await engine.discover(endpoint, key);
  return {
    ok: found.ok,
    error: found.error || '',
    models: found.models || [],
    endpoint: found.endpoint,
    hasKey: !!key
  };
});

ipcMain.handle('capture:region', async () => {
  try {
    const shot = await pickRegion();
    return shot ? { ok: true, ...shot } : { ok: false, cancelled: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Take the widget out of the picture, photograph the screen, put it back.
 * Used by the screen button and by the model's own see_screen tool, so both
 * get the same result and the same brief blink.
 */
async function screenshotBehindWidget() {
  const wasVisible = widget && !widget.isDestroyed() && widget.isVisible();

  capturing = true;
  try {
    if (wasVisible) widget.hide();
    // the compositor needs a frame or two to let go of the window
    await new Promise((r) => setTimeout(r, 140));
    return await grabWholeScreen();
  } finally {
    if (wasVisible) showWidget();
    capturing = false;
  }
}

ipcMain.handle('capture:screen', async () => {
  try {
    return { ok: true, ...(await screenshotBehindWidget()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Only the current turn carries images. A small model's context fills up
 * fast and a stale screenshot is worse than no screenshot, so history goes
 * back as text alone.
 */
function buildMessages(cfg, payload) {
  const messages = [];
  if (cfg.systemPrompt) {
    // the hint only appears while the tool is actually on offer
    messages.push({
      role: 'system',
      content:
        cfg.systemPrompt +
        builtin.promptHint({
          screen: cfg.screenTool,
          web: Array.isArray(cfg.serverTools) && cfg.serverTools.includes('web_search'),
          images:
            !!cfg.imageSearch &&
            Array.isArray(cfg.serverTools) &&
            cfg.serverTools.includes('web_search')
        })
    });
  }

  const past = Array.isArray(payload.history) ? payload.history : [];
  for (const m of past.slice(-cfg.historyTurns * 2)) {
    if (!m || !m.content) continue;
    // the thread also holds rows describing tool runs, which are there for
    // the reader rather than the model
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    messages.push({ role: m.role, content: String(m.content) });
  }

  messages.push(engine.userMessage(payload.text || '', payload.images || []));
  return messages;
}

/* ---------- running tools ---------- */

// A model that keeps calling tools without ever answering would otherwise
// loop until the context ran out.
const MAX_ROUNDS = 5;

// Permission granted for the rest of this run, per tool. Deliberately not
// written to disk: a standing grant to send mail should not outlive the
// session that gave it.
const allowedThisSession = new Set();

let pendingAsk = null;

ipcMain.on('tool:answer', (_e, answer) => {
  const resolve = pendingAsk;
  pendingAsk = null;
  if (resolve) resolve(answer || { allow: false });
});

/**
 * Anything that only reads runs without interrupting. Anything that might
 * change something asks first, every time, unless it was allowed for the
 * session. A server that says nothing about a tool is treated as if it
 * changes something — guessing wrong that way costs a click, and guessing
 * wrong the other way sends the email.
 */
function needsPermission(id) {
  // a built in declares its own answer rather than going through mcp
  if (builtin.has(id)) {
    return !builtin.get(id).readOnly && !allowedThisSession.has(id);
  }

  const hit = mcp.find(id);
  if (!hit) return false; // it will fail on its own and say so
  if (hit.tool.readOnly) return false;
  return !allowedThisSession.has(id);
}

function askPermission(turnId, call, args) {
  const hit = mcp.find(call.function.name);
  return new Promise((resolve) => {
    pendingAsk = resolve;
    send('tool:ask', {
      id: turnId,
      callId: call.id,
      tool: call.function.name,
      server: hit ? hit.tool.server : '',
      label: hit ? hit.tool.tool : call.function.name,
      description: hit ? hit.tool.description : '',
      args
    });
  });
}

/**
 * Run whichever kind of tool this is, and write the result into the
 * transcript the model will see next.
 *
 * A picture cannot travel inside a tool result. The OpenAI shape says that
 * field is a string, and Unsloth documents no extension to it. So the result
 * says a screenshot was taken and the image follows immediately as a user
 * message, which every OpenAI compatible server understands.
 */
async function runTool(name, args, call, messages) {
  if (builtin.has(name)) {
    if (name !== builtin.SEE_SCREEN) {
      const miss = { ok: false, text: 'There is no tool called ' + name + '.' };
      messages.push({ role: 'tool', tool_call_id: call.id, content: miss.text });
      return miss;
    }

    const shot = await screenshotBehindWidget();

    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content:
        'Screenshot taken, ' + shot.size.width + ' by ' + shot.size.height +
        ' pixels. It is the image in the next message.'
    });
    // an image with no text beside it is accepted unevenly, so it gets a
    // line of its own saying what it is
    messages.push({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: shot.url } },
        { type: 'text', text: 'This is the screen you asked to see. Answer the original question from it.' }
      ]
    });

    return { ok: true, text: 'Looked at the screen.', image: shot.url };
  }

  const out = await mcp.call(name, args);
  messages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
  return out;
}

/* Unsloth keeps state for its own tools against a session id. A fresh
   conversation gets a fresh one so a new question does not inherit the last
   one's search results. */
let sessionId = '';

function sessionFor(payload) {
  const fresh = !Array.isArray(payload.history) || payload.history.length === 0;
  if (fresh || !sessionId) {
    sessionId = 'ask-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  return sessionId;
}

ipcMain.handle('engine:ask', async (_e, payload) => {
  const cfg = settings();
  const id = payload && payload.id;

  if (turn) turn.abort();
  turn = new AbortController();
  const mine = turn;

  const messages = buildMessages(cfg, payload || {});
  const tools = [
    ...builtin.forModel(cfg.screenTool),
    ...(cfg.useTools ? mcp.toolsForModel() : [])
  ];
  const serverTools = Array.isArray(cfg.serverTools) ? cfg.serverTools : [];
  const session = sessionFor(payload || {});

  try {
    if (serverTools.includes('web_search')) {
      // A failed preference sync should not take ordinary web search down with
      // it. The model simply receives the text-only web_search schema.
      await engine.configureImageSearch(cfg.endpoint, apiKey(), cfg.imageSearch);
    }

    // Resolve obvious shared-screen references before asking the model. Small
    // models routinely ignore an optional tool even when "this email" is in
    // its description; this narrow route makes the common case reliable while
    // leaving ambiguous visual questions to normal tool choice.
    if (
      cfg.screenTool &&
      builtin.shouldSeeScreen(payload && payload.text, payload && payload.images)
    ) {
      const callId = 'screen-context-' + Date.now().toString(36);
      const lookingFor = builtin.screenSubject(payload && payload.text);

      send('tool:start', {
        id,
        callId,
        tool: builtin.SEE_SCREEN,
        args: { looking_for: lookingFor }
      });

      try {
        const shot = await screenshotBehindWidget();
        messages.push({
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: shot.url } },
            {
              type: 'text',
              text:
                'This is the screen context the user referred to. Use it to ' +
                'answer their most recent request.'
            }
          ]
        });
        send('tool:end', {
          id,
          callId,
          ok: true,
          text: 'Looked at the screen.',
          image: shot.url
        });
      } catch (err) {
        send('tool:end', {
          id,
          callId,
          ok: false,
          text: 'Could not look at the screen: ' + err.message
        });
      }
    }

    let rounds = 0;

    for (;;) {
      const res = await engine.chat(
        {
          endpoint: cfg.endpoint,
          key: apiKey(),
          model: cfg.model || undefined,
          messages,
          tools,
          serverTools,
          sessionId: session,
          temperature: cfg.temperature,
          maxTokens: cfg.maxTokens,
          signal: mine.signal
        },
        (bit) => {
          // a turn the user already replaced should stop painting
          if (turn === mine) send('engine:delta', { id, text: bit });
        },
        (event) => {
          // something Unsloth did at its own end: a search, or a note that it
          // is waiting on its own confirmation dialog
          if (turn === mine) send('tool:server', { id, ...event });
        },
        (bit) => {
          // the model thinking out loud; without this the widget looks hung
          // while a reasoning model works
          if (turn === mine) send('engine:thinking', { id, text: bit });
        }
      );

      // the user asked something else, or pressed stop, while this ran
      if (turn !== mine) return { ok: true };
      if (!res.toolCalls.length) break;

      if (++rounds > MAX_ROUNDS) {
        send('engine:delta', {
          id,
          text: '\n\n_Stopped after ' + MAX_ROUNDS + ' rounds of tool calls._'
        });
        break;
      }

      // the model's own turn has to go back in the transcript before the
      // results, or the server cannot match them up
      messages.push({
        role: 'assistant',
        content: res.text || null,
        tool_calls: res.toolCalls
      });

      for (const call of res.toolCalls) {
        const name = call.function.name;

        let args = {};
        let argsBroken = false;
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          argsBroken = true;
        }

        if (argsBroken) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Those arguments were not valid JSON. Try again.'
          });
          send('tool:end', { id, callId: call.id, ok: false, text: 'Malformed arguments' });
          continue;
        }

        send('tool:start', { id, callId: call.id, tool: name, args });

        if (needsPermission(name)) {
          const answer = await askPermission(id, call, args);
          if (turn !== mine) return { ok: true };

          if (!answer.allow) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: 'The user declined to run this. Do not try it again.'
            });
            send('tool:end', { id, callId: call.id, ok: false, text: 'Declined' });
            continue;
          }
          if (answer.always) allowedThisSession.add(name);
        }

        let out;
        try {
          out = await runTool(name, args, call, messages);
        } catch (err) {
          out = { ok: false, text: 'The tool failed: ' + err.message };
          messages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
        }
        if (turn !== mine) return { ok: true };

        send('tool:end', {
          id,
          callId: call.id,
          ok: out.ok,
          text: out.text,
          image: out.image || null
        });
      }
    }

    if (turn === mine) {
      send('engine:done', { id });
      turn = null;
    }
    return { ok: true };
  } catch (err) {
    if (turn === mine) {
      send('engine:error', { id, error: err.message });
      turn = null;
    }
    return { ok: false, error: err.message };
  }
});

ipcMain.on('engine:stop', () => {
  // a turn waiting on a permission answer is parked on a promise, so it has
  // to be released or the loop never unwinds
  if (pendingAsk) {
    const resolve = pendingAsk;
    pendingAsk = null;
    resolve({ allow: false });
  }
  if (turn) {
    turn.abort();
    turn = null;
  }
});

/* ---------- ipc: mcp ---------- */

ipcMain.handle('mcp:status', () => ({
  servers: mcp.status(),
  config: mcp.configPath(app.getPath('userData'))
}));

ipcMain.handle('mcp:restart', async () => {
  allowedThisSession.clear();
  const report = await mcp.restart(app.getPath('userData'));
  return { report, servers: mcp.status() };
});

ipcMain.handle('mcp:reveal', () => {
  const file = mcp.configPath(app.getPath('userData'));
  shell.showItemInFolder(file);
  return file;
});

/* ---------- lifecycle ---------- */

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWidget);

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);

    // Write the merged settings back once, so a config carried over from an
    // older version stops disagreeing with what the app is actually using.
    saveSettings({});
    applyAppearance(settings().appearance);

    createWidget();
    buildTray();

    // Wake the local server and populate the short status cache before the
    // user summons the widget. The first probe can take a couple of seconds
    // on a cold Unsloth process; doing it here keeps that delay off Enter.
    getEngineStatus().catch((err) => console.error('engine preflight failed', err));

    const ok = bindShortcut(settings().shortcut);
    if (!ok) {
      // nothing is broken, but the one way in is gone, so say so rather
      // than leaving the user pressing a dead combination
      widget.webContents.once('did-finish-load', () =>
        send('shortcut:failed', settings().shortcut)
      );
    }

    // Servers are started in the background: a slow one should delay the
    // tools being available, not the widget itself.
    mcp
      .start(app.getPath('userData'))
      .then((report) => {
        for (const line of report) {
          if (line.ok) console.log('mcp: ' + line.name + ' ready, ' + line.tools + ' tools');
          else console.error('mcp: ' + line.name + ' failed — ' + line.error);
        }
        send('mcp:changed', mcp.status());
      })
      .catch((err) => console.error('mcp failed to start', err));

    // There is no window on screen at launch, so 'activate' is the only
    // way back in on a platform that keeps the app alive without one.
    app.on('activate', showWidget);
  });

  // The defining difference from an ordinary app: no window means hidden,
  // not finished.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    // the servers are child processes and would otherwise outlive the app
    mcp.stop().catch(() => {});
  });
}
