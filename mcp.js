/* ============================================================
   mcp — the servers that give the model something to do

   Runs entirely in the main process. Reads the same shape of
   config file as Claude Desktop, starts each server over stdio,
   and flattens every server's tools into one list the model can
   be handed.

   Nothing in here decides whether a tool is allowed to run. That
   judgement lives in main.js, where there is a window to ask in.
   ============================================================ */

const fs = require('fs');
const path = require('path');

// The SDK is ESM only and this file is CommonJS, so it comes in through a
// dynamic import the first time it is wanted.
let sdk = null;

async function loadSDK() {
  if (sdk) return sdk;
  const [client, stdio] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js')
  ]);
  sdk = { Client: client.Client, StdioClientTransport: stdio.StdioClientTransport };
  return sdk;
}

/* name -> { client, transport, tools, error } */
const servers = new Map();

const EXAMPLE = {
  mcpServers: {
    '//': 'One entry per server. Delete this line and add your own. Example:',
    '// filesystem': {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\you\\Notes']
    }
  }
};

function configPath(userData) {
  return path.join(userData, 'mcp.json');
}

function readConfig(userData) {
  const file = configPath(userData);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const [name, spec] of Object.entries(parsed.mcpServers || {})) {
      // the commented out example entries are not servers
      if (name.startsWith('//') || typeof spec !== 'object' || !spec.command) continue;
      out[name] = spec;
    }
    return out;
  } catch {
    // write a starting point the first time, so there is something to edit
    try {
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(EXAMPLE, null, 2), 'utf8');
      }
    } catch {
      /* not being able to write the example is not worth failing over */
    }
    return {};
  }
}

/**
 * Windows does not execute npx, npm or yarn directly — they are .cmd shims,
 * and spawn without a shell cannot see them. Wrapping in cmd /c means a
 * config copied from anywhere else works unchanged.
 */
function spawnable(spec) {
  const command = String(spec.command);
  if (process.platform !== 'win32') return { command, args: spec.args || [] };
  if (/[\\/]/.test(command) || /\.(exe|cmd|bat)$/i.test(command)) {
    return { command, args: spec.args || [] };
  }
  if (['npx', 'npm', 'yarn', 'pnpm', 'bunx'].includes(command.toLowerCase())) {
    return { command: 'cmd', args: ['/c', command, ...(spec.args || [])] };
  }
  return { command, args: spec.args || [] };
}

/* ---------- names ---------- */

// The model addresses a tool by a single string, so the server it came from
// has to be part of that string. OpenAI only accepts [A-Za-z0-9_-] up to 64.
function clean(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '_');
}

function qualify(server, tool) {
  return (clean(server) + '__' + clean(tool)).slice(0, 64);
}

/* ---------- lifecycle ---------- */

async function connectOne(name, spec) {
  const { Client, StdioClientTransport } = await loadSDK();
  const { command, args } = spawnable(spec);

  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...(spec.env || {}) },
    stderr: 'pipe'
  });

  const client = new Client(
    { name: 'ask', version: '0.2.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

  const listed = await client.listTools();
  const tools = (listed.tools || []).map((t) => ({
    id: qualify(name, t.name),
    server: name,
    tool: t.name,
    description: t.description || '',
    schema: t.inputSchema || { type: 'object', properties: {} },
    // A server may say a tool only reads. When it says nothing, assume the
    // tool can change something: the wrong guess in that direction only
    // costs a confirmation, the other way round costs data.
    readOnly: !!(t.annotations && t.annotations.readOnlyHint)
  }));

  servers.set(name, { client, transport, tools, error: '' });
  return tools.length;
}

/**
 * Start every configured server. One that fails to start is recorded and
 * skipped rather than stopping the rest — a broken entry in the config
 * should not cost you the servers that do work.
 */
async function start(userData) {
  const config = readConfig(userData);
  const report = [];

  await Promise.all(
    Object.entries(config).map(async ([name, spec]) => {
      if (servers.has(name)) return;
      try {
        const count = await connectOne(name, spec);
        report.push({ name, ok: true, tools: count });
      } catch (err) {
        servers.set(name, { client: null, transport: null, tools: [], error: err.message });
        report.push({ name, ok: false, error: err.message });
      }
    })
  );

  return report;
}

async function stop() {
  for (const [name, entry] of servers) {
    try {
      if (entry.client) await entry.client.close();
    } catch {
      /* it is going away regardless */
    }
    servers.delete(name);
  }
}

async function restart(userData) {
  await stop();
  return start(userData);
}

/* ---------- what the model sees ---------- */

function allTools() {
  const out = [];
  for (const entry of servers.values()) out.push(...entry.tools);
  return out;
}

function find(id) {
  for (const entry of servers.values()) {
    const hit = entry.tools.find((t) => t.id === id);
    if (hit) return { entry, tool: hit };
  }
  return null;
}

// The OpenAI tools array. A small model does better with fewer, shorter
// descriptions, so this trims anything unreasonably long rather than
// spending the context window on prose.
function toolsForModel() {
  return allTools().map((t) => ({
    type: 'function',
    function: {
      name: t.id,
      description: (t.description || t.tool).slice(0, 320),
      parameters: t.schema
    }
  }));
}

function status() {
  const out = [];
  for (const [name, entry] of servers) {
    out.push({
      name,
      ok: !entry.error,
      error: entry.error,
      tools: entry.tools.map((t) => ({ id: t.id, tool: t.tool, readOnly: t.readOnly }))
    });
  }
  return out;
}

/* ---------- running one ---------- */

// MCP hands back a list of content blocks. The model wants a string, and it
// wants a short one, so images are named rather than inlined and the whole
// thing is capped.
function flatten(result, limit = 6000) {
  const parts = [];
  for (const block of result.content || []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image') parts.push('[an image was returned]');
    else if (block.type === 'resource') {
      parts.push(block.resource && block.resource.text ? block.resource.text : '[a resource was returned]');
    } else parts.push('[' + block.type + ']');
  }

  let text = parts.join('\n').trim() || '(the tool returned nothing)';
  if (text.length > limit) {
    text = text.slice(0, limit) + '\n… truncated, ' + (text.length - limit) + ' more characters';
  }
  if (result.isError) text = 'The tool reported a problem: ' + text;
  return text;
}

async function call(id, args) {
  const hit = find(id);
  if (!hit) return { ok: false, text: 'There is no tool called ' + id + '.' };

  try {
    const result = await hit.entry.client.callTool({
      name: hit.tool.tool,
      arguments: args && typeof args === 'object' ? args : {}
    });
    return { ok: !result.isError, text: flatten(result) };
  } catch (err) {
    return { ok: false, text: 'The tool failed: ' + err.message };
  }
}

module.exports = {
  configPath,
  start,
  stop,
  restart,
  status,
  allTools,
  toolsForModel,
  find,
  call
};
