// lib/brain_tools.js
// The catalog of tools Aion-Brain can run on behalf of AION. Tools here are
// "kernel-level" — fast, deterministic, evidence-producing. Heavy tools
// (TTS, image gen, video gen, notes, gallery, GitHub writes) live in the
// Python AION backend, not here.
//
// Each tool:
//   - has a unique name
//   - accepts an `args` object
//   - returns { evidence: <string or object>, ok: boolean, error?: string }
//
// AION injects tool results as <tool_results> blocks before calling
// /api/chat on Brain.

import { fetchUrl as steelFetchUrl, SteelError } from './steel_browser.js';
import * as skillCatalog from './skill_catalog.js';
import { pickSkills as rerankPickSkills, buildSkillContext as rerankBuildSkillContext } from './skill_router.js';

const TOOL_CATALOG = Object.freeze([
  {
    name: 'web_search',
    description: 'Run a web search via DuckDuckGo and return formatted results (title, url, snippet).',
    args_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', maxLength: 400 },
        count: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
        freshness: { type: 'string', enum: ['pd', 'pw', 'pm', 'py'] },
      },
    },
    cost_estimate: '1 HTTP call (DuckDuckGo)',
    side_effects: false,
  },
  {
    name: 'reddit_search',
    description: 'Search public Reddit posts via reddit.com/search.json and return titles, subreddits, urls, and snippets. Useful for "research on reddit" — first-hand opinions, recent discussion threads, niche community answers.',
    args_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', maxLength: 400 },
        count: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
        subreddit: { type: 'string', maxLength: 100, description: 'Optional: restrict to a single subreddit (without r/)' },
        sort: { type: 'string', enum: ['relevance', 'hot', 'top', 'new', 'comments'], default: 'relevance' },
        time: { type: 'string', enum: ['all', 'year', 'month', 'week', 'day', 'hour'], default: 'all' },
      },
    },
    cost_estimate: '1 HTTP call (reddit.com)',
    side_effects: false,
  },
  {
    name: 'steel_browser',
    description: 'Open a URL in a Steel.dev-hosted browser session and return the page title, status, and text content (truncated to 20KB). Use when the user wants a live page snapshot that a plain web_search snippet cannot provide.',
    args_schema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', maxLength: 2000 },
        sessionTimeoutMs: { type: 'integer', minimum: 5000, maximum: 120000, default: 30000 },
      },
    },
    cost_estimate: '1 Steel session (~30s) + 1 content read',
    side_effects: true,
  },
  {
    name: 'pick_skill',
    description: 'Pick the most relevant skills from the loaded skill pack (ECC bundle) for the given query. Uses a fast NVIDIA reranker; falls back to lexical search when the reranker is unavailable. Returns the chosen skill names.',
    args_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', maxLength: 1000 },
        k: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
      },
    },
    cost_estimate: '1 NVIDIA chat call (reranker)',
    side_effects: false,
  },
  {
    name: 'load_skill',
    description: 'Load the full body of one or more skills by name (from the loaded skill pack) and return their markdown text, suitable for prompt injection. Truncates to keep the total within the configured budget.',
    args_schema: {
      type: 'object',
      required: ['names'],
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 5,
        },
      },
    },
    cost_estimate: 'local file read',
    side_effects: false,
  },
  {
    name: 'echo',
    description: 'Return the input back. Used for testing the tool pipeline.',
    args_schema: { type: 'object', properties: { text: { type: 'string' } } },
    cost_estimate: '0',
    side_effects: false,
  },
  {
    name: 'datetime',
    description: 'Return the current UTC timestamp + ISO string.',
    args_schema: { type: 'object', properties: {} },
    cost_estimate: '0',
    side_effects: false,
  },
  {
    name: 'free_energy',
    description: 'Return a synthetic free-energy snapshot for a topic. Useful for lattice demos.',
    args_schema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
    },
    cost_estimate: '0',
    side_effects: false,
  },
]);

class ToolRegistry {
  constructor({ searcher = null, chain = null } = {}) {
    this._searcher = searcher; // optional async (query, count) => [{title,url,snippet}]
    this._chain = chain || null; // optional AionChain instance for the skill reranker
    this._tools = new Map();
    for (const t of TOOL_CATALOG) this._tools.set(t.name, t);
  }

  catalog() {
    return Array.from(this._tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      args_schema: t.args_schema,
      cost_estimate: t.cost_estimate,
      side_effects: t.side_effects,
    }));
  }

  has(name) { return this._tools.has(name); }
  get(name) { return this._tools.get(name); }

  /**
   * Run a tool. Returns { ok, evidence, tool, error? }.
   *
   * Searcher chain (for web_search): if a searcher was injected at
   * construction time (e.g. DuckDuckGo) we use it; otherwise we surface
   * a clear "unconfigured" error rather than silently pretending to search.
   */
  async run(name, args = {}) {
    if (!this._tools.has(name)) {
      return { ok: false, error: `unknown_tool:${name}`, tool: name };
    }
    if (name === 'echo') {
      return { ok: true, evidence: { text: String(args?.text || '') }, tool: name };
    }
    if (name === 'datetime') {
      const now = Date.now();
      return { ok: true, evidence: { iso: new Date(now).toISOString(), unix_ms: now, utc: new Date(now).toUTCString() }, tool: name };
    }
    if (name === 'free_energy') {
      const topic = String(args?.topic || 'unknown');
      let h = 0;
      for (let i = 0; i < topic.length; i++) h = (h * 31 + topic.charCodeAt(i)) >>> 0;
      const precision = (h % 1000) / 1000;
      const recall = ((h >> 10) % 1000) / 1000;
      const complexity = 1 - Math.abs(precision - recall);
      return {
        ok: true,
        evidence: {
          topic,
          precision_estimate: Number(precision.toFixed(3)),
          recall_estimate: Number(recall.toFixed(3)),
          complexity_estimate: Number(complexity.toFixed(3)),
          free_energy: Number((complexity * 0.7 + (1 - precision) * 0.3).toFixed(3)),
        },
        tool: name,
      };
    }
    if (name === 'web_search') {
      const query = String(args?.query || '').trim();
      if (!query) return { ok: false, error: 'query_required', tool: name };
      const count = Math.max(1, Math.min(10, Number(args?.count) || 5));
      if (!this._searcher) return { ok: false, error: 'web_search_unconfigured', tool: name };
      try {
        const results = await this._searcher(query, count);
        const lines = (results || []).map((r, i) => {
          const title = String(r.title || '').slice(0, 200);
          const url = String(r.url || '').slice(0, 500);
          const snippet = String(r.snippet || '').slice(0, 400);
          return `${i + 1}. [${title}](${url})\n   ${snippet}`;
        }).join('\n');
        return {
          ok: true,
          evidence: { query, count: results?.length || 0, results: results || [], text: lines },
          tool: name,
        };
      } catch (exc) {
        return { ok: false, error: `web_search_failed:${exc?.message || exc}`, tool: name };
      }
    }
    if (name === 'reddit_search') {
      const query = String(args?.query || '').trim();
      if (!query) return { ok: false, error: 'query_required', tool: name };
      const count = Math.max(1, Math.min(25, Number(args?.count) || 10));
      const subreddit = String(args?.subreddit || '').trim();
      const sort = String(args?.sort || 'relevance');
      const time = String(args?.time || 'all');
      try {
        const results = await redditSearch({ query, count, subreddit, sort, time });
        const lines = results.map((r, i) => (
          `${i + 1}. [${r.title}](${r.url})\n   r/${r.subreddit} · ${r.score} pts · ${r.num_comments} comments · ${r.created_utc}\n   ${r.snippet}`
        )).join('\n');
        return {
          ok: true,
          evidence: { query, subreddit: subreddit || null, sort, time, count: results.length, results, text: lines },
          tool: name,
        };
      } catch (exc) {
        return { ok: false, error: `reddit_search_failed:${exc?.message || exc}`, tool: name };
      }
    }
    if (name === 'steel_browser') {
      const url = String(args?.url || '').trim();
      if (!url) return { ok: false, error: 'url_required', tool: name };
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url_must_be_http(s)', tool: name };
      const sessionTimeoutMs = Math.max(5000, Math.min(120_000, Number(args?.sessionTimeoutMs) || 30_000));
      try {
        const result = await steelFetchUrl(url, { sessionTimeoutMs });
        return { ok: !!result.ok, evidence: result, tool: name, error: result.ok ? undefined : (result.error || 'steel_failed') };
      } catch (e) {
        if (e instanceof SteelError) return { ok: false, error: `steel_error:${e.code || 'unknown'}`, tool: name };
        return { ok: false, error: `steel_threw:${e?.message || e}`, tool: name };
      }
    }
    if (name === 'pick_skill') {
      const query = String(args?.query || '').trim();
      if (!query) return { ok: false, error: 'query_required', tool: name };
      const k = Math.max(1, Math.min(10, Number(args?.k) || 3));
      try {
        const out = await rerankPickSkills(query, { chain: this._chain, k });
        return {
          ok: true,
          evidence: {
            query,
            k,
            source: out.source,
            used_reranker: out.used_reranker,
            indices: out.indices || null,
            raw_model_output: out.raw || null,
            skills: out.skills.map((s) => ({ name: s.name, title: s.title, description: s.description, path: s.path })),
            names: out.skills.map((s) => s.name),
          },
          tool: name,
        };
      } catch (e) {
        return { ok: false, error: `pick_skill_failed:${e?.message || e}`, tool: name };
      }
    }
    if (name === 'load_skill') {
      const names = Array.isArray(args?.names) ? args.names : [];
      if (names.length === 0) return { ok: false, error: 'names_required', tool: name };
      try {
        const { context, included } = await rerankBuildSkillContext(names);
        return {
          ok: true,
          evidence: { requested: names, included, context_length: context.length, context },
          tool: name,
        };
      } catch (e) {
        return { ok: false, error: `load_skill_failed:${e?.message || e}`, tool: name };
      }
    }
    return { ok: false, error: `tool_not_implemented:${name}`, tool: name };
  }
}

// Reddit search — hits reddit.com's public search.json. Returns a
// normalized shape that matches the AION tool evidence format.
async function redditSearch({ query, count, subreddit = '', sort = 'relevance', time = 'all' }) {
  const params = new URLSearchParams({ q: query, limit: String(count), sort, t: time, restrict_sr: subreddit ? 'on' : 'off', sr: subreddit || '' });
  const url = `https://www.reddit.com/search.json?${params.toString()}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'user-agent': 'AionBrain/0.1 (kernel-level research tool; operator: ABBYCRM)',
        'accept': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`network:${e.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 429) throw new Error('rate_limited');
    throw new Error(`http_${res.status}:${text.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.data?.children)) return [];
  return json.data.children
    .map((c) => c.data)
    .filter(Boolean)
    .slice(0, count)
    .map((d) => ({
      id: d.id,
      title: String(d.title || '').slice(0, 300),
      subreddit: d.subreddit,
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : (d.url_overridden_by_dest || ''),
      snippet: String(d.selftext || d.url_overridden_by_dest || '').slice(0, 500),
      score: d.score,
      num_comments: d.num_comments,
      author: d.author,
      created_utc: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
      nsfw: !!d.over_18,
    }));
}

export { TOOL_CATALOG, ToolRegistry };
