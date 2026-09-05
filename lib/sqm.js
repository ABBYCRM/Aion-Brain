import { readFile } from 'node:fs/promises';
import * as catalog from './skill_catalog.js';

export const TOPICS = JSON.parse(await readFile(new URL('./sqm-topics.json', import.meta.url), 'utf8'));
const objectives = {
  OSINT: 'Perform lawful public-source research and verify findings without exposing private information.',
  OPSEC: 'Reduce unnecessary information exposure using threat modeling and privacy practices.',
  DigitalOcean: 'Deploy, operate, secure, and monitor applications using DigitalOcean infrastructure.',
  'Command Line': 'Perform development and administration tasks in the correct terminal environment.'
};

export function selectTopics(requested) {
  if (requested === undefined) return TOPICS;
  if (!Array.isArray(requested) || !requested.length || requested.length > TOPICS.length || requested.some(t => typeof t !== 'string')) {
    throw new TypeError('topics must be a nonempty array of topic names');
  }
  const selected = [];
  for (const name of requested) {
    const topic = TOPICS.find(t => t.name.toLowerCase() === name.trim().toLowerCase());
    if (!topic) throw new TypeError(`Unknown topic: ${name.slice(0, 100)}`);
    if (!selected.includes(topic)) selected.push(topic);
  }
  return selected;
}

export async function devSearch({ query, category = 'education', limit = 6 } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new TypeError('query must contain 1–2000 characters');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new TypeError('limit must be an integer from 1 to 10');
  if (category !== 'education') throw new TypeError('Supported category: education');
  // Search the bundled corpus locally: no placeholder results and no paid model calls.
  const names = await catalog.search(query, limit);
  const matches = [];
  for (const name of names) {
    const entry = await catalog.get(name);
    if (!entry?.body?.trim()) continue;
    matches.push({ title: entry.title, summary: entry.description, body: entry.body,
      category, source: entry.path + '/SKILL.md', score: null });
  }
  return { query, retrieval: 'lexical', corpus: 'ECC skill pack', count: matches.length, matches };
}

export async function buildSQM({ topics, limit = 6 } = {}, search = devSearch) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new TypeError('limit must be an integer from 1 to 10');
  const selected = selectTopics(topics);
  const sections = [];
  for (const topic of selected) {
    const result = await search({ query: topic.query, category: topic.category, limit });
    sections.push({ topic: topic.name, objective: objectives[topic.name] || `Develop practical competency in ${topic.name}.`,
      results: result.matches, coverage: result.matches.length ? 'matches_found' : 'no_matches' });
  }
  return { title: 'Comprehensive Software & Technology SQM', retrieval: 'lexical',
    note: 'Retrieved skill material, not a completeness certification. Review relevance and gaps for each topic.',
    sections };
}

export function renderMarkdown(document) {
  const lines = [`# ${document.title}`, '', document.note, ''];
  document.sections.forEach((section, i) => {
    lines.push(`## ${i + 1}. ${section.topic}`, '', `**Objective:** ${section.objective}`, '');
    if (!section.results.length) lines.push('_No corpus results found._', '');
    section.results.forEach((result, j) => {
      lines.push(`### ${i + 1}.${j + 1} ${result.title}`, '', result.summary, '', result.body, '', `Source: ${result.source}`, '');
    });
  });
  return lines.join('\n');
}

export function registerSQMRoutes(app, requireAuth) {
  const route = handler => async (req, res) => {
    try { requireAuth(req); } catch (error) {
      return res.status(error.statusCode || 401).json({ ok: false, error: 'unauthorized' });
    }
    try { await handler(req, res); } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({ ok: false,
        error: error instanceof TypeError ? error.message : 'Curriculum corpus could not be loaded' });
    }
  };
  app.get('/api/sqm/topics', route(async (_req, res) => res.json({ topics: TOPICS })));
  app.post('/api/dev/search', route(async (req, res) => res.json(await devSearch(req.body))));
  app.post('/api/sqm', route(async (req, res) => {
    const format = req.body?.format ?? 'json';
    if (!['json', 'markdown'].includes(format)) throw new TypeError('format must be json or markdown');
    const result = await buildSQM(req.body);
    if (format === 'markdown') res.type('text/markdown').send(renderMarkdown(result));
    else res.json(result);
  }));
}
