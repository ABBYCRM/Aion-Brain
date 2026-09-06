// lib/tool_calls.js
// Parse native OpenAI/NIM tool_calls and Claw-compatible <tool_call> XML.
// Intended calls (malformed / incomplete) are never treated as executed.

const XML_RE = /<tool_call\s+name="([a-zA-Z0-9_]+)">([\s\S]*?)<\/tool_call>/gi;

/**
 * Normalize a provider tool_calls array into { name, args, id }[].
 * Invalid JSON arguments become an empty object plus a parse error flag.
 */
export function normalizeNativeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  const out = [];
  for (const call of toolCalls) {
    const fn = call?.function || call;
    const name = String(fn?.name || call?.name || '').trim();
    if (!name) continue;
    let args = {};
    let parseError = null;
    const raw = fn?.arguments != null ? fn.arguments : call?.arguments;
    if (typeof raw === 'string' && raw.trim()) {
      try { args = JSON.parse(raw); }
      catch (e) { parseError = e.message; args = {}; }
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      args = raw;
    }
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      out.push({
        name,
        args,
        id: call?.id || null,
        parse_error: parseError,
      });
    }
  }
  return out;
}

/**
 * Parse Claw-style XML tool blocks from model text.
 * Incomplete / malformed blocks throw so the caller can refuse execution.
 */
export function parseXmlToolCalls(text) {
  const src = String(text || '');
  const calls = [];
  const re = new RegExp(XML_RE.source, 'gi');
  let match;
  while ((match = re.exec(src))) {
    let args;
    try { args = JSON.parse(match[2]); }
    catch (e) { throw new Error(`tool_call_invalid_json:${match[1]}:${e.message}`); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error(`tool_call_args_not_object:${match[1]}`);
    }
    calls.push({ name: match[1], args, id: null, parse_error: null });
  }
  const stripped = src.replace(re, '');
  if (stripped.toLowerCase().includes('<tool_call')) {
    throw new Error('tool_call_incomplete');
  }
  return calls;
}

/**
 * Collect actionable tool calls from a model turn.
 * Native tool_calls win; XML is a fallback for Claw-compatible models.
 */
export function extractToolCalls({ tool_calls, content } = {}) {
  const native = normalizeNativeToolCalls(tool_calls);
  if (native.length > 0) return { source: 'native', calls: native };
  try {
    const xml = parseXmlToolCalls(content);
    if (xml.length > 0) return { source: 'xml', calls: xml };
  } catch (e) {
    return { source: 'xml_error', calls: [], error: e.message };
  }
  return { source: 'none', calls: [] };
}

/** Stable fingerprint for anti-duplicate / anti-loop gates. */
export function actionFingerprint(name, args = {}) {
  const tool = String(name || '');
  let canon = '';
  try { canon = JSON.stringify(sortKeys(args)); }
  catch { canon = String(args); }
  return `${tool}|${canon}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/** Incremental OpenAI-style streamed tool_call delta accumulator. */
export function accumulateToolCallDeltas(acc, deltas) {
  const next = Array.isArray(acc) ? acc.slice() : [];
  if (!Array.isArray(deltas)) return next;
  for (const d of deltas) {
    const idx = Number.isInteger(d.index) ? d.index : next.length;
    while (next.length <= idx) next.push({ id: null, type: 'function', function: { name: '', arguments: '' } });
    const slot = next[idx];
    if (d.id) slot.id = d.id;
    if (d.type) slot.type = d.type;
    const fn = d.function || {};
    if (fn.name) slot.function.name += fn.name;
    if (typeof fn.arguments === 'string') slot.function.arguments += fn.arguments;
  }
  return next;
}

export function toOpenAITools(catalog) {
  if (!Array.isArray(catalog)) return [];
  return catalog.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters: t.args_schema || { type: 'object', properties: {} },
    },
  }));
}
