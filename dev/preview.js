/* A throwaway Electron entry that boots the real renderer against a fake
   engine and photographs it. Not shipped: package.json's files list only
   picks up the root scripts, renderer and overlay.

   Run with:  npx electron dev/preview.js  */

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.ASK_SHOT_DIR || __dirname;

// ASK_CHROME=acrylic to preview the Windows 11 blur layout instead
const MODE = process.env.ASK_CHROME === 'acrylic' ? 'acrylic' : 'shadow';
const SCENARIO = process.env.ASK_SCENARIO || 'answer';
const THINKING_SCENARIO = SCENARIO === 'thinking' || SCENARIO === 'thinking-hidden';
const PAUSE_ON_ASK = SCENARIO === 'tools';
const SHADOW = MODE === 'acrylic' ? 0 : 44;
const WIDTH = 640 + SHADOW * 2;

const ANSWER = `A **debounce** waits for the noise to stop before it acts.

\`\`\`js
const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};
\`\`\`

Reach for it when:

- a resize handler is firing dozens of times a second
- a search box would otherwise hit the network on every keystroke

Use \`throttle\` instead when you want a steady rate rather than silence.`;

let win = null;
let permission = null;
let hideRequests = 0;
let stopRequests = 0;

function stubs() {
  ipcMain.handle('chrome:mode', () => MODE);
  ipcMain.handle('theme:isDark', () => nativeTheme.shouldUseDarkColors);
  ipcMain.handle('clip:write', () => true);
  ipcMain.handle('open:external', () => true);
  ipcMain.handle('key:clear', () => true);
  ipcMain.handle('capture:region', () => ({ ok: false, cancelled: true }));
  ipcMain.handle('capture:screen', () => ({ ok: false, cancelled: true }));

  ipcMain.handle('settings:load', () => ({
    shortcut: 'Control+Shift+Space',
    endpoint: 'http://localhost:8000',
    model: 'unsloth/gemma-4-E2B-it-GGUF',
    temperature: 0.7,
    maxTokens: 1024,
    historyTurns: 6,
    autoAttach: false,
    useTools: true,
    screenTool: true,
    imageSearch: true,
    appearance: 'system',
    showThinking: SCENARIO !== 'thinking-hidden',
    serverTools: ['web_search'],
    systemPrompt: 'You are a quick assistant living in a keyboard shortcut.',
    hasKey: true,
    autostart: false,
    shortcutOk: true
  }));

  ipcMain.handle('settings:save', () => ({ hasKey: true, shortcutOk: true }));

  ipcMain.handle('engine:status', () => ({
    ok: true,
    error: '',
    models: ['unsloth/gemma-4-E2B-it-GGUF', 'unsloth/gemma-4-E4B-it-GGUF'],
    endpoint: 'http://localhost:8000',
    hasKey: true
  }));
  ipcMain.handle('engine:test', () => ({
    ok: true,
    error: '',
    models: ['unsloth/gemma-4-E2B-it-GGUF', 'unsloth/gemma-4-E4B-it-GGUF'],
    endpoint: 'http://localhost:8000',
    hasKey: true
  }));

  // the window follows its content, exactly as in the real app
  ipcMain.on('widget:height', (_e, height) => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    win.setBounds({ ...b, width: WIDTH, height: Math.round(height) + SHADOW * 2 }, false);
  });

  ipcMain.on('widget:hide', () => { hideRequests++; });
  ipcMain.on('engine:stop', () => { stopRequests++; });
  ipcMain.handle('mcp:status', () => ({
    servers: [
      { name: 'obsidian', ok: true, tools: [{ id: 'a', tool: 'read_note', readOnly: true }, { id: 'b', tool: 'write_note', readOnly: false }] },
      { name: 'gmail', ok: false, error: 'spawn failed: command not found' }
    ],
    config: 'mcp.json'
  }));
  ipcMain.handle('mcp:restart', () => ({ report: [], servers: [] }));
  ipcMain.handle('mcp:reveal', () => 'mcp.json');

  // the renderer's answer to a permission prompt
  ipcMain.on('tool:answer', (_e, answer) => {
    if (permission) {
      const resolve = permission;
      permission = null;
      resolve(answer);
    }
  });

  const dribble = async (id, text) => {
    for (const bit of text.match(/\s*\S+/g) || []) {
      win.webContents.send('engine:delta', { id, text: bit });
      await new Promise((r) => setTimeout(r, 6));
    }
  };

  // stream the canned answer back in believable little pieces
  ipcMain.handle('engine:ask', async (_e, payload) => {
    const id = payload.id;
    await new Promise((r) => setTimeout(r, 200));

    if (THINKING_SCENARIO) {
      // a reasoning model: a long think, a search, then a short answer
      const thought =
        'The user wants the current Node LTS. I do not know this from training ' +
        'because it changes every few months, so I should search rather than ' +
        'guess. Let me look it up and report just the version number.';
      for (const bit of thought.match(/\s*\S+/g) || []) {
        win.webContents.send('engine:thinking', { id, text: bit });
        await new Promise((r) => setTimeout(r, 4));
      }

      win.webContents.send('tool:server', {
        id, kind: 'status', detail: 'Searching: newest Node.js LTS version'
      });
      win.webContents.send('tool:server', {
        id, kind: 'start', callId: 'x', name: 'web_search',
        detail: 'newest Node.js LTS version', awaiting: false
      });
      await new Promise((r) => setTimeout(r, 150));
      win.webContents.send('tool:server', {
        id, kind: 'end', callId: 'x', name: 'web_search',
        result: 'Title: Node.js Releases — URL: https://nodejs.org/en/about/previous-releases'
      });
      await new Promise((r) => setTimeout(r, 100));
      await dribble(id, 'The newest Node.js LTS is 24.19.0.');
      win.webContents.send('engine:done', { id });
      return { ok: true };
    }

    if (SCENARIO === 'screen') {
      // the model decides it needs to look, then answers from what it saw
      win.webContents.send('tool:server', {
        id,
        kind: 'start',
        callId: 'ws1',
        name: 'web_search',
        detail: 'CVE-2026-76460',
        awaiting: false
      });
      await new Promise((r) => setTimeout(r, 100));
      win.webContents.send('tool:server', {
        id,
        kind: 'end',
        callId: 'ws1',
        name: 'web_search',
        result: 'Found the advisory.'
      });

      win.webContents.send('tool:start', {
        id,
        callId: 's1',
        tool: 'see_screen',
        args: { looking_for: 'the error dialog' }
      });
      await new Promise((r) => setTimeout(r, 150));

      // a tiny stand in for a screenshot
      const png =
        'data:image/png;base64,' +
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAABniMkeAAAAJUlEQVRYw2P8//8/A6' +
        'WBiYFKYNSgUYNGDRo1aNSgUYNGDRoMBgEAvHkD/2FdwVUAAAAASUVORK5CYII=';

      win.webContents.send('tool:end', {
        id,
        callId: 's1',
        ok: true,
        text: 'Looked at the screen.',
        image: png
      });
      await new Promise((r) => setTimeout(r, 120));
      await dribble(id, 'That is a TypeScript error: the value can be undefined.');
      win.webContents.send('engine:done', { id });
      return { ok: true };
    }

    if (SCENARIO === 'tools') {
      // text, then a tool that needs asking about, then the rest — the same
      // shape a real multi round turn takes
      await dribble(id, 'I can send that. Checking the thread first.');

      win.webContents.send('tool:start', {
        id,
        callId: 'c1',
        tool: 'gmail__send_message',
        args: { to: 'sam@example.com', subject: 'Re: Thursday', body: 'Thursday works for me.' }
      });
      await new Promise((r) => setTimeout(r, 120));

      const answer = await new Promise((resolve) => {
        permission = resolve;
        win.webContents.send('tool:ask', {
          id,
          callId: 'c1',
          tool: 'gmail__send_message',
          server: 'gmail',
          label: 'send_message',
          description: 'Send an email.',
          args: { to: 'sam@example.com', subject: 'Re: Thursday' }
        });
        if (PAUSE_ON_ASK) return; // leave it on screen to be photographed
      });

      win.webContents.send('tool:end', {
        id,
        callId: 'c1',
        ok: !!(answer && answer.allow),
        text: answer && answer.allow ? 'Sent to sam@example.com.' : 'Declined'
      });
      await new Promise((r) => setTimeout(r, 120));
      await dribble(id, answer && answer.allow ? 'Sent. Anything else?' : 'Left it alone.');
      win.webContents.send('engine:done', { id });
      return { ok: true };
    }

    await dribble(id, ANSWER);
    win.webContents.send('engine:done', { id });
    return { ok: true };
  });
}

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

// Poll the renderer rather than guessing at a duration; a slow machine
// otherwise photographs a half finished answer.
async function waitFor(expr, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await win.webContents.executeJavaScript(expr)) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error('timed out waiting for ' + expr);
}

async function shoot(name) {
  await new Promise((r) => setTimeout(r, 420));
  const image = await win.webContents.capturePage();
  const file = path.join(OUT, name);
  fs.writeFileSync(file, image.toPNG());
  console.log('wrote', file, image.getSize());
}

app.whenReady().then(async () => {
  stubs();

  // set before the window exists, so the renderer's first isDark() is right
  const theme = process.env.ASK_THEME === 'light' ? 'light' : 'dark';
  nativeTheme.themeSource = theme;

  win = new BrowserWindow({
    width: WIDTH,
    height: 76 + SHADOW * 2,
    frame: false,
    show: true,
    // capturePage comes back empty from a transparent window on Windows, so
    // the preview sits the card on a flat backdrop instead
    transparent: false,
    backgroundColor: process.env.ASK_THEME === 'light' ? '#cfe4e8' : '#101014',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // the real main.js forwards this too; without it a later change is silent
  nativeTheme.on('updated', () =>
    win.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors)
  );

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.show();
  win.focus();

  await new Promise((r) => setTimeout(r, 300));
  await shoot(`shot-1-empty-${theme}-${MODE}.png`);

  // type a question and press Return, through the real input
  await win.webContents.executeJavaScript(`
    (() => {
      const q = document.getElementById('q');
      q.value = 'explain debounce in js';
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })();
  `);

  if (SCENARIO === 'background') {
    await waitFor("document.querySelector('.msg.bot .body').textContent.length > 20");
    await win.webContents.executeJavaScript(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    );
    await waitFor("/total/.test(document.getElementById('stat').textContent)");

    const seen = JSON.parse(
      await win.webContents.executeJavaScript(`JSON.stringify({
        answer: document.querySelector('.msg.bot .body').textContent,
        busy: !document.getElementById('stop').hidden
      })`)
    );

    check('Escape hides instead of stopping an active answer', () => {
      if (hideRequests !== 1) throw new Error('hide requests: ' + hideRequests);
      if (stopRequests !== 0) throw new Error('stop requests: ' + stopRequests);
    });
    check('the hidden answer finishes in the background', () => {
      if (!/Use throttle instead/.test(seen.answer)) throw new Error('answer did not finish');
      if (seen.busy) throw new Error('renderer is still busy');
    });

    console.log('');
    console.log(failures ? failures + ' FAILED' : 'all passed');
    app.exit(failures ? 1 : 0);
    return;
  }

  if (THINKING_SCENARIO) {
    await waitFor("/total/.test(document.getElementById('stat').textContent)");

    const seen = JSON.parse(
      await win.webContents.executeJavaScript(`JSON.stringify({
        thinks: document.querySelectorAll('.think').length,
        live: document.querySelectorAll('.think.live').length,
        done: document.querySelectorAll('.think.done').length,
        label: (document.querySelector('.think-head span') || {}).textContent || '',
        body: (document.querySelector('.think-body') || {}).textContent || '',
        runs: document.querySelectorAll('.run').length,
        bots: document.querySelectorAll('.msg.bot').length,
        answer: (document.querySelector('.msg.bot .body') || {}).textContent || '',
        dump: [...document.getElementById('thread').children].map(c => c.className + ' :: ' + c.textContent.slice(0, 50))
      })`)
    );

    if (SCENARIO === 'thinking-hidden') {
      check('reasoning can be hidden', () => {
        if (seen.thinks !== 0) throw new Error('got ' + seen.thinks + ' thinking blocks');
      });
    } else {
      check('the reasoning is shown, not swallowed', () => {
        if (seen.thinks !== 1) throw new Error('got ' + seen.thinks + ' thinking blocks');
        if (!/should search rather than guess/.test(seen.body)) {
          throw new Error('the reasoning text is missing');
        }
      });
      check('the thought closes once the answer starts', () => {
        if (seen.live !== 0) throw new Error('still marked as thinking');
        if (seen.done !== 1) throw new Error('not marked as finished');
      });
      check('the finished thought reports how long it took', () => {
        if (!/Thought for/.test(seen.label)) throw new Error('reads "' + seen.label + '"');
      });
    }
    check('the search still shows as its own row', () => {
      if (seen.runs !== 1) throw new Error('got ' + seen.runs + ' run rows');
    });
    console.log('  DOM:', JSON.stringify(seen.dump, null, 1));
    check('the answer is there too', () => {
      if (!/24\.19\.0/.test(seen.answer)) throw new Error('reads "' + seen.answer + '"');
    });
    check('reasoning does not leave a blank assistant message', () => {
      if (seen.bots !== 1) throw new Error('got ' + seen.bots + ' assistant messages');
    });

    await shoot(`shot-8-${SCENARIO}-${theme}-${MODE}.png`);
    console.log('');
    console.log(failures ? failures + ' FAILED' : 'all passed');
    app.exit(failures ? 1 : 0);
    return;
  }

  if (SCENARIO === 'screen') {
    await waitFor("/total/.test(document.getElementById('stat').textContent)");

    const seen = JSON.parse(
      await win.webContents.executeJavaScript(`JSON.stringify({
        runs: document.querySelectorAll('.run').length,
        shots: document.querySelectorAll('.run-shot').length,
        asking: document.querySelectorAll('.run.asking').length,
        emptyBots: [...document.querySelectorAll('.msg.bot .body')]
          .filter((body) => !body.textContent.trim()).length,
        names: [...document.querySelectorAll('.run-name')].map(n => n.textContent),
        args: [...document.querySelectorAll('.run-args')].map(n => n.textContent)
      })`)
    );

    check('the search Unsloth ran is shown', () => {
      if (!seen.names.some((n) => /web_search/.test(n))) {
        throw new Error('no search row: ' + seen.names.join(' | '));
      }
      if (!seen.args.some((a) => /CVE-2026-76460/.test(a))) {
        throw new Error('the query is not shown');
      }
    });
    check('looking at the screen appears as a run', () => {
      if (!seen.names.some((n) => /see_screen/.test(n))) {
        throw new Error('no see_screen row: ' + seen.names.join(' | '));
      }
    });
    check('what it saw is shown back', () => {
      if (seen.shots !== 1) throw new Error('expected one thumbnail, got ' + seen.shots);
    });
    check('looking at the screen does not stop to ask', () => {
      if (seen.asking !== 0) throw new Error('it asked permission to look');
    });
    check('a tool-first turn leaves no blank assistant row', () => {
      if (seen.emptyBots !== 0) throw new Error('got ' + seen.emptyBots + ' blank messages');
    });

    await shoot(`shot-7-screen-${theme}-${MODE}.png`);
    console.log('');
    console.log(failures ? failures + ' FAILED' : 'all passed');
    app.exit(failures ? 1 : 0);
    return;
  }

  if (SCENARIO === 'tools') {
    await waitFor("document.querySelectorAll('.run.asking').length === 1");
    const asking = JSON.parse(
      await win.webContents.executeJavaScript(`JSON.stringify({
        name: document.querySelector('.run.asking .run-name').textContent,
        args: document.querySelector('.run.asking .run-args').textContent,
        state: document.querySelector('.run.asking .run-state').textContent,
        buttons: [...document.querySelectorAll('.run.asking .ask-btn')].map(b => b.textContent),
        why: document.querySelector('.run.asking .run-why').textContent
      })`)
    );

    check('a writing tool stops and asks', () => {
      if (!asking.buttons.length) throw new Error('no buttons on the prompt');
    });
    check('the prompt offers decline, once and always', () => {
      if (asking.buttons.length !== 3) {
        throw new Error('got ' + asking.buttons.length + ' buttons: ' + asking.buttons.join(', '));
      }
    });
    check('the prompt names the server and tool', () => {
      if (!/gmail/.test(asking.name) || !/send_message/.test(asking.name)) {
        throw new Error('reads "' + asking.name + '"');
      }
    });
    check('the prompt shows what it would do it with', () => {
      if (!/sam@example\.com/.test(asking.args)) throw new Error('reads "' + asking.args + '"');
    });
    check('the prompt says why it is asking', () => {
      if (!/say so/i.test(asking.why)) throw new Error('reads "' + asking.why + '"');
    });

    await shoot(`shot-4-permission-${theme}-${MODE}.png`);

    // say yes, and let the turn finish
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.run.asking .ask-btn')].find(b => /Run once/.test(b.textContent)).click()`
    );
    await waitFor("/total/.test(document.getElementById('stat').textContent)");

    const after = JSON.parse(
      await win.webContents.executeJavaScript(`JSON.stringify({
        done: document.querySelectorAll('.run.done').length,
        asking: document.querySelectorAll('.run.asking').length,
        msgs: document.querySelectorAll('.msg.bot').length,
        out: (document.querySelector('.run.done .run-out') || {}).textContent || ''
      })`)
    );

    check('allowing it runs the tool', () => {
      if (after.done !== 1) throw new Error('no completed run row');
    });
    check('the prompt goes away once answered', () => {
      if (after.asking !== 0) throw new Error('the prompt is still up');
    });
    check('the result is shown', () => {
      if (!/Sent to sam/.test(after.out)) throw new Error('reads "' + after.out + '"');
    });
    check('the answer continues after the tool', () => {
      if (after.msgs < 2) throw new Error('expected text before and after the tool');
    });

    await shoot(`shot-5-toolrun-${theme}-${MODE}.png`);

    console.log('');
    console.log(failures ? failures + ' FAILED' : 'all passed');
    app.exit(failures ? 1 : 0);
    return;
  }

  try {
    await waitFor("/total/.test(document.getElementById('stat').textContent)");
  } catch (err) {
    console.log('WAIT FAILED:', err.message);
  }
  const diag = JSON.parse(
    await win.webContents.executeJavaScript(`JSON.stringify({
      stat: document.getElementById('stat').textContent,
      sheetHidden: document.getElementById('sheet').hidden,
      msgs: document.querySelectorAll('.msg').length,
      pre: document.querySelectorAll('.msg.bot pre code').length,
      code: document.querySelectorAll('.msg.bot code').length,
      strong: document.querySelectorAll('.msg.bot strong').length,
      li: document.querySelectorAll('.msg.bot li').length,
      html: document.querySelector('.msg.bot .body').innerHTML,
      cardH: Math.round(document.getElementById('card').getBoundingClientRect().height)
    })`)
  );

  // The markdown renderer swaps code out for a sentinel and back again; when
  // that round trip breaks it leaves the marker sitting in the output, which
  // is otherwise easy to miss.
  check('the answer rendered a fenced code block', () => {
    if (!diag.pre) throw new Error('no <pre><code> in the answer');
  });
  check('inline code survived', () => {
    if (diag.code < 2) throw new Error('expected inline code as well as the block');
  });
  check('bold survived', () => {
    if (!diag.strong) throw new Error('no <strong>');
  });
  check('the list rendered', () => {
    if (diag.li !== 2) throw new Error('expected 2 list items, got ' + diag.li);
  });
  check('no sentinel leaked into the output', () => {
    if (diag.html.includes(String.fromCharCode(0xe000)) || diag.html.includes(String.fromCharCode(0))) {
      throw new Error('an unreplaced marker is visible in the answer');
    }
  });
  check('the card grew to hold the answer', () => {
    if (diag.cardH < 300) throw new Error('card is only ' + diag.cardH + 'px');
  });
  check('both messages are in the thread', () => {
    if (diag.msgs !== 2) throw new Error('got ' + diag.msgs + ' messages');
  });
  check('the footer reported a timing', () => {
    if (!/total/.test(diag.stat)) throw new Error('stat reads "' + diag.stat + '"');
  });

  await shoot(`shot-2-answer-${theme}-${MODE}.png`);

  await win.webContents.executeJavaScript(
    `document.getElementById('gear').click();`
  );
  await waitFor("!document.getElementById('panel').hidden");
  await shoot(`shot-3-settings-${theme}-${MODE}.png`);

  const tabs = JSON.parse(
    await win.webContents.executeJavaScript(`JSON.stringify({
      labels: [...document.querySelectorAll('[data-settings-tab]')].map(t => t.textContent.trim()),
      visible: [...document.querySelectorAll('[data-settings-page]')]
        .filter(p => !p.hidden).map(p => p.dataset.settingsPage)
    })`)
  );
  check('settings open on the compact General page', () => {
    if (tabs.labels.join(',') !== 'General,Model,Tools') {
      throw new Error('tabs are ' + tabs.labels.join(', '));
    }
    if (tabs.visible.join(',') !== 'general') {
      throw new Error('visible page is ' + tabs.visible.join(', '));
    }
  });

  await win.webContents.executeJavaScript(
    `document.querySelector('[data-settings-tab="model"]').click()`
  );
  await waitFor("!document.querySelector('[data-settings-page=\"model\"]').hidden");
  await shoot(`shot-3-model-${theme}-${MODE}.png`);

  // the tools section lives at the bottom of a scrolling panel
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-settings-tab="tools"]').click();
     document.querySelector('.panel-body').scrollTop = 0`
  );
  await waitFor("document.querySelectorAll('.server').length === 2");
  await shoot(`shot-3-tools-${theme}-${MODE}.png`);

  await win.webContents.executeJavaScript(
    `document.querySelector('.panel-body').scrollTop = 9999`
  );

  const servers = JSON.parse(
    await win.webContents.executeJavaScript(`JSON.stringify(
      [...document.querySelectorAll('.server')].map(r => ({
        cls: r.className,
        name: r.querySelector('.nm').textContent,
        det: r.querySelector('.det').textContent
      }))
    )`)
  );

  check('a working server shows its tool count', () => {
    const row = servers.find((r) => r.name === 'obsidian');
    if (!/2 tools/.test(row.det)) throw new Error('reads "' + row.det + '"');
    if (!/1 read only/.test(row.det)) throw new Error('read only count missing: ' + row.det);
  });
  check('a failed server shows why', () => {
    const row = servers.find((r) => r.name === 'gmail');
    if (!/bad/.test(row.cls)) throw new Error('not flagged as bad');
    if (!/command not found/.test(row.det)) throw new Error('reads "' + row.det + '"');
  });

  await shoot(`shot-6-tools-${theme}-${MODE}.png`);

  console.log('');
  console.log(failures ? failures + ' FAILED' : 'all passed');
  app.exit(failures ? 1 : 0);
});

app.on('window-all-closed', () => app.quit());
