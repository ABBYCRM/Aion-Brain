// lib/assistant_text.js
// Operator-visible assistant text vs control-loop internals.
// SSE may emit phase / tool_start / tool_end / self_state as their own
// event types. Those must never be concatenated into delta / answer.

export const CONTROL_LOOP_PHASES = Object.freeze([
  'SELF_OBSERVATION',
  'SELF_MONITORING',
  'INTROSPECTION',
  'METACOGNITION',
  'SELF_REFLECTION',
  'METACONTROL',
  'TERMINATION_CHECK',
]);

export const ASSISTANT_EVENT_TYPES = Object.freeze(['delta']);

export const CONTROL_EVENT_TYPES = Object.freeze([
  'phase',
  'tool_start',
  'tool_end',
  'self_state',
  'decision',
  'lattice',
  'skills',
  'bos_omega',
  'attempt',
  'open',
  'done',
  'reasoning',
  'tool_call_delta',
]);

export const ASSISTANT_VISIBILITY_RULE = [
  'Do not narrate INTERNAL STATE, SELF_STATE, control-loop phases, Trinity/Alpha/Praxis/Omega gates, health tags, or completion-gate internals unless the user explicitly asks to inspect internals.',
  'The visible assistant reply must be natural language for the operator only. Never dump JSON state, phase logs, or Verified=/Status COMPLETE lines into the message the user reads.',
].join(' ');

const DUMP_FIELD_RE = /"(active_goal|previous_tool_results|acceptance_criteria|forbidden_strategies|claiming_complete|phase_log|working_memory)"/;

export function userAskedForInternals(text) {
  return /\b(internal[_\s-]?state|self[_\s-]?state|control loop|show (?:me )?(?:the )?(?:phases|gates|health|internals)|debug (?:the )?loop|inspect (?:internal|state|the loop))\b/i.test(String(text || ''));
}

export function looksLikeInternalDump(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/INTERNAL[_\s-]?STATE/i.test(t)) return true;
  if (/You are AION-Brain executing the AGENTIC/i.test(t)) return true;
  if (/\[echo:/i.test(t) && /SELF[_\s-]?STATE|AGENTIC SELF-STATE|INTERNAL[_\s-]?STATE/i.test(t)) return true;
  if (/\bSELF[_\s-]?STATE\b/i.test(t) && (DUMP_FIELD_RE.test(t) || /untrusted data/i.test(t))) return true;
  if (/^\s*\{/.test(t) && DUMP_FIELD_RE.test(t)) return true;
  const phaseHits = CONTROL_LOOP_PHASES.filter((p) => t.includes(p)).length;
  if (phaseHits >= 2) return true;
  if (/Status\s+(COMPLETE|INCOMPLETE|BLOCKED)\b/i.test(t) && /Verified\s*=/i.test(t)) return true;
  if (/Executed \w+ \(tr_\d+\)\./i.test(t) && /Verified\s*=/i.test(t)) return true;
  return false;
}

export function sanitizeAssistantText(text, { userAskedForInternals: asked = false } = {}) {
  const raw = String(text || '');
  if (asked) return raw.trim();
  if (!raw.trim()) return '';
  if (looksLikeInternalDump(raw)) return '';
  let t = raw;
  t = t.replace(/```(?:json)?\s*\{[\s\S]*?"(?:active_goal|previous_tool_results|self_state|acceptance_criteria)"[\s\S]*?\}\s*```/gi, '');
  t = t.replace(/INTERNAL[_\s-]?STATE[\s\S]*?(?:\n\n|$)/gi, '');
  t = t.replace(/SELF[_\s-]?STATE\s*(?:\(untrusted[^)]*\))?:?\s*\{[\s\S]*?\n\}/gi, '');
  t = t.replace(/^\s*Status\s+(COMPLETE|INCOMPLETE|BLOCKED):[^\n]*Verified[^\n]*$/gim, '');
  t = t.replace(/^\s*Executed \w+ \(tr_\d+\)\.[^\n]*Verified[^\n]*$/gim, '');
  t = t.replace(/^\s*(?:SELF-?OBSERVATION|SELF-?MONITORING|INTROSPECTION|METACOGNITION|SELF-?REFLECTION|METACONTROL|TERMINATION[_\s-]?CHECK|ACTION)\b[^\n]*$/gim, '');
  t = t.replace(/^\s*Trinity (?:decision )?gate:\s*(GO|HOLD|ABORT)[^\n]*$/gim, '');
  t = t.replace(/^\s*Health:\s*(HEALTHY|DEGRADED|LOOP_DETECTED|BLOCKED|UNSTABLE)[^\n]*$/gim, '');
  t = t.replace(/^\s*completion_gate:[^\n]*$/gim, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

export function isActionableGoal(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\b(datetime tool|web_search|public records|utc time|current (?:utc )?time|what time is it)\b/i.test(t)) return true;
  return /\b(please )?(search|look\s*up|scrape|crawl|fetch|retrieve|run the|execute the|use the (?:datetime|web_search|tool)|get the (?:current )?time|return the current|find (?:me )|launch|spawn|open a pr|implement|create a|send|screenshot|browse)\b/i.test(t);
}

export function preferExecutePath({ text = '', body = {} } = {}) {
  if (body.consult === true || body.agentic === false || body.mode === 'consult') return false;
  if (body.agentic === true || body.mode === 'execute' || body.mode === 'agentic') return true;
  return isActionableGoal(text);
}

export function summarizeToolEvidence(row) {
  const ev = row?.evidence;
  if (ev == null) return '';
  if (typeof ev === 'string') return ev.slice(0, 800);
  if (typeof ev !== 'object') return '';
  if (ev.iso) {
    const zone = ev.utc ? ` (${ev.utc})` : '';
    return `Current time: ${ev.iso}${zone}.`;
  }
  if (row.tool === 'echo' && ev.text) return String(ev.text).slice(0, 400);
  const results = ev.results || ev.evidence?.results;
  if (Array.isArray(results)) {
    const urls = results.filter((r) => r && r.url).slice(0, 8)
      .map((r) => `- ${r.title || 'source'}: ${r.url}`);
    if (urls.length) return `Here is what I found:\n${urls.join('\n')}`;
  }
  if (Array.isArray(ev.papers) && ev.papers.length) {
    const lines = ev.papers.slice(0, 5).map((p) => `- ${p.title || 'paper'}${p.id ? ` (${p.id})` : ''}`);
    return `Papers:\n${lines.join('\n')}`;
  }
  if (Array.isArray(ev.chunks) && ev.chunks.length) {
    const first = ev.chunks[0]?.text || ev.text;
    if (first) return String(first).slice(0, 800);
  }
  if (typeof ev.text === 'string' && ev.text.trim()) return ev.text.slice(0, 800);
  return '';
}

export function naturalLanguageAnswer(result, { goal = '', fallback = '' } = {}) {
  const asked = userAskedForInternals(goal);
  const responds = (result?.cycles || [])
    .map((c) => c.action)
    .filter((a) => a && a.kind === 'respond' && a.text)
    .map((a) => sanitizeAssistantText(a.text, { userAskedForInternals: asked }))
    .filter(Boolean);
  if (responds.length) return responds.at(-1);

  const tools = result?.self_state?.previous_tool_results || [];
  const okTools = tools.filter((t) => t && t.ok);
  if (okTools.length) {
    const last = okTools.at(-1);
    const summary = summarizeToolEvidence(last);
    if (summary && !looksLikeInternalDump(summary)) return summary;
    const names = [...new Set(okTools.map((t) => t.tool))];
    return names.length === 1
      ? `I ran ${names[0]} and got a result.`
      : `I ran ${names.join(', ')} and gathered results.`;
  }

  const cleanedFallback = sanitizeAssistantText(fallback, { userAskedForInternals: asked });
  if (cleanedFallback) return cleanedFallback;
  if (result?.status === 'BLOCKED') return 'I could not complete that with the available tools.';
  return 'I could not finish that yet.';
}

export function parseSseEvents(raw) {
  const events = [];
  const chunks = String(raw || '').split(/\n\n/);
  for (const chunk of chunks) {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') {
      events.push({ type: 'done_marker' });
      continue;
    }
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch { /* ignore */ }
  }
  return events;
}

export function assistantVisibleFromSse(raw) {
  return parseSseEvents(raw)
    .filter((e) => e && e.type === 'delta' && typeof e.text === 'string')
    .map((e) => e.text)
    .join('');
}

export function assertNoInternalLeak(text) {
  const t = String(text || '');
  return !/INTERNAL[_\s-]?STATE/i.test(t)
    && !/\bSELF[_\s-]?STATE\b/i.test(t)
    && !/Verified\s*=/i.test(t)
    && !CONTROL_LOOP_PHASES.some((p) => t.includes(p));
}
