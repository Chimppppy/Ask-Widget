/* ============================================================
   engine — talking to Unsloth Desktop's local server

   Everything here runs in the main process. The API key never
   crosses into the renderer, which is also why the renderer's
   CSP can stay at default-src 'none' with no connect-src hole.
   ============================================================ */

// Unsloth takes whichever of these is free, so an unconfigured
// install is worth probing rather than making the user find out.
const PORTS = [8000, 8888];

const DEFAULT_ENDPOINT = `http://localhost:${PORTS[0]}`;

function headers(key, events) {
  const h = { 'Content-Type': 'application/json' };
  if (key) h.Authorization = `Bearer ${key}`;
  // Unsloth refuses a request that enables its own tools unless this is set,
  // and in return it streams what those tools are doing. Any other server
  // ignores a header it does not know.
  if (events) h['X-Unsloth-Events'] = '1';
  return h;
}

// fetch rejects with a terse TypeError when nothing is listening, which
// is the single most likely thing to go wrong here, so it gets a real
// sentence instead.
function readable(err, endpoint) {
  const msg = String((err && err.message) || err);
  if (/fetch failed|ECONNREFUSED|other side closed/i.test(msg)) {
    return `Nothing is answering at ${endpoint}. Is Unsloth running with a model loaded?`;
  }
  if (err && err.name === 'AbortError') return 'Stopped.';
  return msg;
}

function statusText(status) {
  if (status === 401 || status === 403) {
    return 'The engine refused the API key. Check it in settings.';
  }
  if (status === 404) {
    return 'The engine answered but has no chat endpoint. Is a model loaded?';
  }
  return `The engine returned ${status}.`;
}

/* ---------- discovery ---------- */

// Ask an endpoint what it has. Doubles as the health check: if this
// comes back ok the widget can talk, and the model list populates
// settings without the user copying a name across by hand.
async function probe(endpoint, key, timeout = 2500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`${endpoint}/v1/models`, {
      headers: headers(key, false),
      signal: ctl.signal
    });
    if (!res.ok) return { ok: false, error: statusText(res.status), status: res.status };
    const body = await res.json();
    const models = (body && body.data ? body.data : [])
      .map((m) => m && m.id)
      .filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: readable(err, endpoint) };
  } finally {
    clearTimeout(timer);
  }
}

// Probe the configured address and Unsloth's usual ports concurrently. A cold
// local server can take a couple of seconds to answer /models; a short,
// sequential fallback both felt slow and occasionally declared port 8888
// offline when it was merely waking up.
async function discover(endpoint, key, options = {}) {
  const primary = endpoint || DEFAULT_ENDPOINT;
  const candidates = [
    primary,
    ...PORTS.map((port) => `http://localhost:${port}`).filter((item) => item !== primary)
  ];

  if (options.fallback === false) {
    const result = await probe(primary, key);
    return { ...result, endpoint: primary };
  }

  const results = await Promise.all(candidates.map((item) => probe(item, key)));
  if (results[0].ok) return { ...results[0], endpoint: primary };

  const alternate = results.findIndex((result, index) => index > 0 && result.ok);
  if (alternate !== -1) {
    return { ...results[alternate], endpoint: candidates[alternate], moved: true };
  }

  return { ...results[0], endpoint: primary };
}

/* Unsloth folds image lookup into web_search rather than exposing a separate
   enabled_tools name. Its own UI stores that capability as a chat preference,
   so Ask keeps the preference in step with its local setting. */
let imageSearchState = null;

async function configureImageSearch(endpoint, key, enabled) {
  const next = { endpoint, enabled: !!enabled };
  if (
    imageSearchState &&
    imageSearchState.endpoint === next.endpoint &&
    imageSearchState.enabled === next.enabled
  ) {
    return { ok: true, cached: true };
  }

  try {
    const res = await fetch(`${endpoint}/api/chat/settings`, {
      method: 'PUT',
      headers: headers(key, false),
      body: JSON.stringify({ searchImages: next.enabled })
    });
    if (!res.ok) return { ok: false, status: res.status };
    imageSearchState = next;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: readable(err, endpoint) };
  }
}

/* ---------- messages ---------- */

// OpenAI's shape: a plain string when there is only text, a parts array
// when an image rides along. Sending the array form for text-only work
// upsets some servers, so only reach for it when there is an image.
function userMessage(text, images) {
  if (!images || !images.length) return { role: 'user', content: text };
  const parts = images.map((url) => ({ type: 'image_url', image_url: { url } }));
  if (text) parts.push({ type: 'text', text });
  return { role: 'user', content: parts };
}

/* ---------- streaming ---------- */

// Server sent events arrive in arbitrary chunks, so a partial line at the
// end of one read has to wait for the next. Splitting eagerly here is the
// classic way to drop a token in the middle of a word.
function makeSSEReader(onEvent) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          onEvent(null, true);
          continue;
        }
        try {
          onEvent(JSON.parse(data), false);
        } catch {
          // a half written frame is not worth tearing the stream down for
        }
      }
    }
  };
}

/**
 * A tool call arrives spread across many deltas: the name in one, the
 * arguments a few characters at a time in the rest, tied together only by
 * an index. This collects them back into whole calls.
 */
function collectCalls(into, deltas) {
  for (const piece of deltas) {
    const i = piece.index || 0;
    if (!into[i]) into[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    const call = into[i];
    if (piece.id) call.id = piece.id;
    if (piece.type) call.type = piece.type;
    if (piece.function) {
      if (piece.function.name) call.function.name += piece.function.name;
      if (piece.function.arguments) call.function.arguments += piece.function.arguments;
    }
  }
}

/**
 * Frames describing what the server did at its own end. These shapes are not
 * in the documentation; they were read off the wire:
 *
 *   {type:'tool_start', tool_name, tool_call_id, arguments, arguments_text,
 *    provenance:{source}, approval_id, awaiting_confirmation}
 *   {type:'tool_end',   tool_name, tool_call_id, result}
 *   {type:'tool_status', content}
 *   {type:'reasoning_summary', duration_ms}
 *
 * Anything else is passed over rather than guessed at.
 */
function serverEvent(frame) {
  switch (frame.type) {
    case 'tool_start': {
      let detail = '';
      if (frame.arguments && typeof frame.arguments === 'object') {
        const query = frame.arguments.query || '';
        const images = Array.isArray(frame.arguments.image_queries)
          ? frame.arguments.image_queries.filter(Boolean)
          : [];
        detail = [query, images.length ? 'images: ' + images.join(', ') : '']
          .filter(Boolean)
          .join(' · ');
        if (!detail) detail = JSON.stringify(frame.arguments);
      } else if (frame.arguments_text) {
        detail = frame.arguments_text;
      }
      return {
        kind: 'start',
        callId: frame.tool_call_id || '',
        name: frame.tool_name || 'tool',
        detail: String(detail || '').slice(0, 200),
        // Unsloth keeps its own permission system. When it is waiting, it
        // waits in its own window: there is no documented way to answer from
        // here, so the most Ask can honestly do is say so.
        awaiting: !!frame.awaiting_confirmation,
        approvalId: frame.approval_id || ''
      };
    }
    case 'tool_end':
      return {
        kind: 'end',
        callId: frame.tool_call_id || '',
        name: frame.tool_name || 'tool',
        // The image envelope contains private thumbnail registry metadata for
        // Unsloth's frontend. The model already consumed it; Ask's activity
        // row should show the human-readable evidence, not raw sentinel JSON.
        result: String(frame.result || '').split('\n__WEB_IMAGES__:')[0].slice(0, 1200)
      };
    case 'tool_status':
      return frame.content
        ? { kind: 'status', detail: String(frame.content).slice(0, 200) }
        : null;
    case 'reasoning_summary':
      return { kind: 'thought', ms: Number(frame.duration_ms) || 0 };
    default:
      return null;
  }
}

/**
 * Stream a completion. onDelta gets each fragment of the answer, onThinking
 * each fragment of the model's reasoning, and onServerTool anything the
 * server ran at its own end. Resolves with { text, thought, toolCalls }:
 * toolCalls is empty on an ordinary answer and populated when the model wants
 * something run before it can reply.
 */
async function chat(opts, onDelta, onServerTool, onThinking) {
  const {
    endpoint = DEFAULT_ENDPOINT,
    key,
    model,
    messages,
    tools,
    serverTools,
    sessionId,
    temperature = 0.7,
    maxTokens = 1024,
    signal
  } = opts;

  let res;
  try {
    res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(key, true),
      signal,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        // an empty array reads as "you may call nothing" to some servers,
        // so the field is left out entirely when there is nothing to offer
        ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
        // Unsloth's own tools, which it runs at its end rather than handing
        // back to us. Search is the one that matters: a small model has no
        // idea what happened after it was trained and will invent something
        // rather than say so.
        // permission_mode is deliberately not set: leaving it alone keeps
        // Unsloth's own confirmation for the tools that execute things
        ...(serverTools && serverTools.length
          ? {
              enable_tools: true,
              enabled_tools: serverTools,
              session_id: sessionId,
              // Small local models sometimes narrate the plan and stop before
              // emitting the tool call. Unsloth can retry those stalls with a
              // focused nudge while leaving ordinary answers alone.
              nudge_tool_calls: true
            }
          : {})
      })
    });
  } catch (err) {
    throw new Error(readable(err, endpoint));
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      /* the status alone will have to do */
    }
    const err = new Error(statusText(res.status) + (detail ? ` ${detail}` : ''));
    err.status = res.status;
    throw err;
  }

  let full = '';
  let thought = '';
  let finish = '';
  const calls = [];

  const reader = makeSSEReader((frame) => {
    if (!frame) return;

    const event = serverEvent(frame);
    if (event && onServerTool) onServerTool(event);

    if (!frame.choices) return;
    const piece = frame.choices[0];
    if (!piece) return;

    if (piece.finish_reason) finish = piece.finish_reason;

    const delta = piece.delta || {};

    // A reasoning model spends most of its budget here and says nothing in
    // content until it is done. Dropping this is what makes the widget look
    // like it has hung.
    const thinking = delta.reasoning_content;
    if (typeof thinking === 'string' && thinking) {
      thought += thinking;
      if (onThinking) onThinking(thinking);
    }

    const bit = delta.content;
    if (typeof bit === 'string' && bit) {
      full += bit;
      onDelta(bit);
    }
    if (Array.isArray(delta.tool_calls)) collectCalls(calls, delta.tool_calls);
  });

  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body) {
      reader.push(decoder.decode(chunk, { stream: true }));
    }
  } catch (err) {
    // an abort mid stream is the stop button doing its job, and whatever
    // arrived before it is still worth keeping
    if (err && err.name === 'AbortError') {
      return { text: full, thought, toolCalls: [], finish: 'stopped' };
    }
    throw new Error(readable(err, endpoint));
  }

  // a call with no name never finished arriving and cannot be run
  const toolCalls = calls.filter((c) => c && c.function && c.function.name);

  return { text: full, thought, toolCalls, finish };
}

module.exports = {
  DEFAULT_ENDPOINT,
  PORTS,
  discover,
  probe,
  configureImageSearch,
  chat,
  userMessage
};
