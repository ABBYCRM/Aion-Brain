// lib/skill_router.js
// Picks the most relevant skill(s) for a user message using an NVIDIA
// fast chat model as a cross-encoder reranker. Returns the top-K
// skill names plus a function to load their full bodies for prompt
// injection.
//
// The reranker call uses a small JSON-only prompt: "Given this user
// query and these numbered skill descriptions, return a JSON array of
// the top K most relevant skill indices in descending order." We force
// temperature=0, max_tokens small, and parse defensively — if the model
// ever returns garbage we fall back to lexical search in skill_catalog.
//
// Provider / model defaults:
//   RERANKER_PROVIDER = nvidia  (one of the providers wired in aion_chain.js)
//   RERANKER_MODEL    = nvidia/nemotron-mini-4b-instruct  (4B, fast, reliable JSON)
//   RERANKER_TOP_K    = 3
//
// To call the reranker we go through the same AionChain that powers
// /api/chat (so it inherits the circuit breaker and provider failover),
// but in non-streaming mode and with a very small max_tokens. If no
// chain is wired (e.g. unit tests), we fall back to lexical search.

import { AionChain } from './aion_chain.js';
import * as catalog from './skill_catalog.js';

const RERANKER_PROVIDER = process.env.RERANKER_PROVIDER || 'nvidia';
const RERANKER_MODEL = process.env.RERANKER_MODEL || 'nvidia/nemotron-mini-4b-instruct';
const RERANKER_TOP_K = Math.max(1, Math.min(10, Number(process.env.RERANKER_TOP_K || 3)));
const RERANKER_TIMEOUT_MS = Math.max(2000, Math.min(60_000, Number(process.env.RERANKER_TIMEOUT_MS || 12_000)));

const SYSTEM_PROMPT = [
  'You are a skill reranker. Given a user query and a numbered list of skill descriptions,',
  'return ONLY a JSON array of the indices of the most relevant skills in descending order of relevance.',
  'Example: [5,1,2]. Do not include any prose, explanation, or surrounding text.',
  `Return at most ${RERANKER_TOP_K} indices.`,
].join(' ');

function buildUserPrompt(query, skillLines) {
  return [
    `User query: ${query}`,
    '',
    'Skills:',
    ...skillLines,
  ].join('\n');
}

function buildSkillLines(skills) {
  return skills.map((s, i) => `${i}: ${s.title} — ${s.description}`);
}

/**
 * Parse a model response into an array of integer indices. Accepts
 * pure JSON, fenced JSON, and a relaxed shape where digits live in any
 * order. Defensive because small reranker models occasionally emit
 * trailing prose.
 */
function parseIndexList(text, max) {
  if (!text) return [];
  // First try strict JSON
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) {
      return parsed
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < max);
    }
  } catch { /* fall through */ }
  // Fallback: pull the first list-shaped span
  const m = candidate.match(/\[[^\]]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        return arr
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < max);
      }
    } catch { /* ignore */ }
  }
  return [];
}

/**
 * Run the reranker. Returns an array of top-K skill names. Falls back
 * to lexical search on any failure (no model, network, bad JSON).
 *
 * @param {string} query          user message
 * @param {object} [opts]
 * @param {AionChain} [opts.chain]  optional chain; if omitted, lexical fallback
 * @param {number} [opts.k]         override RERANKER_TOP_K
 */
export async function pickSkills(query, { chain, k } = {}) {
  const topK = Math.max(1, Math.min(10, k || RERANKER_TOP_K));
  const all = await catalog.list();
  if (all.length === 0) return { skills: [], source: 'empty', used_reranker: false };

  // If we don't have a chain (no NVIDIA key, no providers), use lexical fallback.
  if (!chain) {
    const names = await catalog.search(query, topK);
    const skills = names.map((n) => all.find((e) => e.name === n)).filter(Boolean);
    return { skills, source: 'lexical', used_reranker: false };
  }

  // Cap the candidate window to keep the prompt small (and the call cheap).
  const candidates = all.slice(0, 60);
  const lines = buildSkillLines(candidates);
  const userPrompt = buildUserPrompt(query, lines);

  const payload = {
    model: RERANKER_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 80,
    stream: false,
  };

  let text = '';
  try {
    // Use the chain in non-streaming mode by collecting all deltas
    const target = chain.providers.find((p) => p.name === RERANKER_PROVIDER) || chain.providers[0];
    if (!target) throw new Error('no provider in chain');
    const result = await Promise.race([
      target.invoke({ operation: 'chat', payload }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('rerank_timeout')), RERANKER_TIMEOUT_MS)),
    ]);
    text = result?.content || '';
  } catch (e) {
    // fall through to lexical
    const names = await catalog.search(query, topK);
    const skills = names.map((n) => all.find((e) => e.name === n)).filter(Boolean);
    return { skills, source: 'lexical', used_reranker: false, error: e.message };
  }

  let idxs = parseIndexList(text, candidates.length);
  if (idxs.length === 0) {
    const names = await catalog.search(query, topK);
    const skills = names.map((n) => all.find((e) => e.name === n)).filter(Boolean);
    return { skills, source: 'lexical_fallback', used_reranker: true, raw: text };
  }
  idxs = idxs.slice(0, topK);
  const skills = idxs.map((i) => candidates[i]).filter(Boolean);
  return { skills, source: 'reranker', used_reranker: true, indices: idxs, raw: text };
}

/**
 * Build a system-prompt fragment that injects the chosen skills'
 * bodies. Truncates to keep the prompt within budget.
 */
export async function buildSkillContext(skillNames, { perSkillCharLimit = 12_000, totalCharLimit = 24_000 } = {}) {
  const parts = [];
  let used = 0;
  let included = [];
  for (const name of skillNames || []) {
    const entry = await catalog.get(name);
    if (!entry) continue;
    const body = (entry.body || '').slice(0, perSkillCharLimit);
    const block = `# Skill: ${entry.title}\nPath: ${entry.path}\n\n${body}\n`;
    if (used + block.length > totalCharLimit) {
      const remaining = Math.max(0, totalCharLimit - used);
      if (remaining < 500) break;
      parts.push(block.slice(0, remaining) + '\n…[truncated]');
      used += remaining;
      included.push(name);
      break;
    }
    parts.push(block);
    used += block.length;
    included.push(name);
  }
  if (parts.length === 0) return { context: '', included: [] };
  return {
    context: '## Injected skills (use as context, do not blindly follow)\n\n' + parts.join('\n---\n\n'),
    included,
  };
}

export const _internal = { RERANKER_PROVIDER, RERANKER_MODEL, RERANKER_TOP_K };
