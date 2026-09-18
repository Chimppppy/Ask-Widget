/* ============================================================
   builtin — tools the app itself provides

   MCP covers things outside the app. This covers the one thing
   only the app can do: look at the screen it is sitting on.

   Offering it as a tool rather than a button means the model
   decides when it needs to look, so "what does this error mean"
   works without you first telling it to take a picture.
   ============================================================ */

const SEE_SCREEN = 'see_screen';

const TOOLS = {
  [SEE_SCREEN]: {
    // Nothing on the machine changes, so this does not stop to ask. It is
    // still drawn in the thread with the picture it took, because a model
    // quietly photographing the screen would be a bad thing to hide.
    readOnly: true,
    describe: {
      type: 'function',
      function: {
        name: SEE_SCREEN,
        description:
          'Take a picture of the screen and look at it. Use this whenever the ' +
          'question is about something the user can see but has not described: ' +
          'an error message, a page they are reading, a design, a chart, an ' +
          'email they want a reply to. Do not use it for general questions that ' +
          'have nothing to do with the screen.',
        parameters: {
          type: 'object',
          properties: {
            looking_for: {
              type: 'string',
              description: 'In a few words, what you expect to find. Shown to the user.'
            }
          }
        }
      }
    }
  }
};

function has(name) {
  return Object.prototype.hasOwnProperty.call(TOOLS, name);
}

function get(name) {
  return TOOLS[name];
}

function forModel(enabled) {
  if (!enabled) return [];
  return Object.values(TOOLS).map((t) => t.describe);
}

/**
 * A line appended to the system prompt while the tool is available. Without
 * it a small model tends to answer "I cannot see your screen" rather than
 * using the tool sitting right in front of it.
 */
function promptHint(options) {
  const opts = typeof options === 'boolean' ? { screen: options } : options || {};
  const guidance = [
    'Treat tools as ordinary capabilities, not a last resort. Before answering, ' +
      'decide whether the request depends on visible context, current facts, ' +
      'connected data, calculation, code execution, or external evidence. Use ' +
      'the relevant available tool when it does; answer directly when it does not.'
  ];

  if (opts.screen) {
    guidance.push(
      'Call ' + SEE_SCREEN + ' before answering when words such as "this email", ' +
        '"this error", or "this page" refer to something visible that was not ' +
        'included in the message.'
    );
  }
  if (opts.web) {
    guidance.push(
      'Use web search for recent, changing, obscure, or source-dependent facts. ' +
        'Do not guess details that a search can verify.'
    );
  }
  if (opts.images) {
    guidance.push(
      'Use image queries within web search for visual identification, comparison, ' +
        'or reference-image requests. For identification, inspect the user\'s image ' +
        'first, search plausible candidates, and verify with distinguishing features. ' +
        'Use image results as evidence; do not print [[img:...]] tokens in the answer.'
    );
  }

  return ' ' + guidance.join(' ');
}

/*
 * A small model does not always connect "this email" with the screen tool,
 * even when the tool description says exactly that. These are deliberately
 * narrow shared-context cues: they only fire when the user points at content
 * that was not included in the request. Broader judgement still belongs to
 * the model and its ordinary see_screen tool.
 */
const VISIBLE_THING =
  '(?:email|message|thread|conversation|error|dialog|page|website|site|' +
  'document|article|chart|graph|image|photo|design|screen|window|form|' +
  'code|snippet|post|comment)';

const SHARED_CONTEXT = [
  new RegExp('\\b(?:this|that|the (?:open|current|visible))\\s+' + VISIBLE_THING + '\\b', 'i'),
  /\b(?:reply|respond|answer)\s+to\s+(?:this|that|the one|the open one)\b/i,
  /\b(?:summari[sz]e|explain|translate|rewrite|review|fix|read)\s+(?:this|that)\b/i,
  /\bwhat\s+(?:am i looking at|does this (?:say|mean)|is (?:on|in) (?:my|the) screen)\b/i,
  /\bcan you\s+(?:see|read|look at)\s+(?:this|that|my screen|the screen)\b/i
];

function suppliedAfterReference(text) {
  // "Reply to this email: <body>" already contains what is needed. A colon
  // with a real payload, a fenced block, or a multi-line pasted body is a
  // stronger signal than the deictic wording above.
  if (/```[\s\S]*```/.test(text)) return true;
  if (/:[ \t]*\S[\s\S]{19,}$/.test(text)) return true;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 1 && lines.slice(1).join(' ').length >= 20;
}

function shouldSeeScreen(text, images) {
  if (Array.isArray(images) && images.length) return false;

  const request = String(text || '').trim();
  if (!request || suppliedAfterReference(request)) return false;
  if (/\b(?:do not|don't|without)\s+(?:look(?:ing)? at|use|check)\s+(?:my |the )?screen\b/i.test(request)) {
    return false;
  }

  return SHARED_CONTEXT.some((pattern) => pattern.test(request));
}

function screenSubject(text) {
  const request = String(text || '').replace(/\s+/g, ' ').trim();
  return request.length > 120 ? request.slice(0, 117) + '…' : request;
}

module.exports = {
  SEE_SCREEN,
  has,
  get,
  forModel,
  promptHint,
  shouldSeeScreen,
  screenSubject
};
