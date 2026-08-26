// lib/skill_catalog.js
// Loads a skill pack (a markdown bundle of SKILL.md files with a
// `## Skill catalog` index) and exposes:
//   - list(): [{name, description, section}]
//   - get(name): {name, description, body, section} | null
//   - names(): string[]
//   - search(query, k): name[]  (lexical fallback, used when no reranker)
//
// The bundle we ship with is the ECC Complete AI Skill Pack
// (see ECC_COMPLETE_AI_SKILL_PACK.md, 286 skills). At startup we
// materialize a parsed index in-memory. The full skill bodies are
// lazy-loaded on first .get(name) call.
//
// Skill pack source path is `SKILL_PACK_PATH` (default:
// `skills/ECC_COMPLETE_AI_SKILL_PACK.md`). The pack file MUST contain
// a section that starts with `## Skill catalog` followed by entries of
// the form:
//   ### `<path/to/skill>`
//   # <Skill Title>
//   <one-paragraph description...>
//
// Each skill body then follows under a sub-heading like:
//   # <Skill Title>
//   <body until the next # heading or end of file>

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const PACK_PATH = process.env.SKILL_PACK_PATH || 'skills/ECC_COMPLETE_AI_SKILL_PACK.md';

let _index = null;     // [{name, description, section, bodyStart, bodyEnd}]
let _nameToIdx = null; // Map<name, index>
let _bodyCache = null; // Map<name, string>

async function loadIndex() {
  if (_index) return _index;
  if (!existsSync(PACK_PATH)) {
    _index = [];
    _nameToIdx = new Map();
    _bodyCache = new Map();
    return _index;
  }
  const text = await readFile(PACK_PATH, 'utf8');

  // The ECC pack ships the catalog as a Markdown table:
  //   ## Skill catalog
  //   | # | Skill | Canonical directory | Trigger description |
  //   | 1 | [`accessibility`](#skill-001) | `skills/accessibility` | ... |
  // We parse rows of the form | N | `[name](#anchor)` | `path` | description... |
  // and treat `path` as the canonical name (matching the on-disk folder).
  const entries = [];
  const rowRe = /^\|\s*\d+\s*\|\s*\[`([a-z0-9][a-z0-9-]*)`\]\([^)]+\)\s*\|\s*`([^`]+)`\s*\|\s*([\s\S]*?)\s*\|\s*$/gm;
  let m;
  while ((m = rowRe.exec(text))) {
    const slug = m[1];
    const path = m[2].trim();
    const cell = m[3].replace(/\s+/g, ' ').trim();
    // Take the first sentence as description; treat the rest as just appended prose
    const firstSentence = cell.split(/(?<=\.)\s+(?=[A-Z])/)[0] || cell;
    entries.push({ path, name: path, title: slug, description: firstSentence });
  }

  // Fallback: if the table format isn't found, try the older `### \`<path>\`` block format.
  if (entries.length === 0) {
    const catIdx = text.indexOf('\n## Skill catalog\n');
    const after = catIdx >= 0 ? text.slice(catIdx) : text;
    const entryRe = /### `([^`]+)`\n# ([^\n]+)\n([\s\S]*?)(?=\n### `|\n# Shared linked references|$)/g;
    while ((m = entryRe.exec(after))) {
      const path = m[1].trim();
      const title = m[2].trim();
      const descBlock = m[3].trim();
      const desc = descBlock.split(/\n\n/)[0].replace(/\s+/g, ' ').trim();
      entries.push({ path, name: path, title, description: desc });
    }
  }

  _index = entries;
  _nameToIdx = new Map(entries.map((e, i) => [e.name, i]));
  _bodyCache = new Map();
  return _index;
}

export async function list() {
  const idx = await loadIndex();
  return idx.map((e) => ({ name: e.name, title: e.title, description: e.description, path: e.path }));
}

export async function names() {
  const idx = await loadIndex();
  return idx.map((e) => e.name);
}

export async function get(name) {
  const idx = await loadIndex();
  const i = _nameToIdx.get(name);
  if (i === undefined) return null;
  if (_bodyCache.has(name)) {
    const meta = idx[i];
    return { ...meta, body: _bodyCache.get(name) };
  }
  // Lazy-load body: re-parse the file to find the section under `# <title>`
  const text = await readFile(PACK_PATH, 'utf8');
  // Heading: # <title>\nBody... until next line starting with "# " or end
  const escaped = idx[i].title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`# ${escaped}\\n([\\s\\S]*?)(?=\\n# |\\n## |$)`);
  const m = re.exec(text);
  const body = m ? m[1].trim() : '';
  _bodyCache.set(name, body);
  return { ...idx[i], body };
}

/**
 * Lightweight lexical search across name + title + description. Used as
 * a fallback when no reranker is configured. Returns the top-k names
 * by simple word overlap (case-insensitive). Stable order.
 */
export async function search(query, k = 5) {
  if (!query) return [];
  const idx = await loadIndex();
  const q = String(query).toLowerCase().split(/\W+/).filter(Boolean);
  if (q.length === 0) return [];
  const scored = idx.map((e) => {
    const hay = `${e.name}\n${e.title}\n${e.description}`.toLowerCase();
    let s = 0;
    for (const tok of q) if (hay.includes(tok)) s += 1;
    return { name: e.name, s };
  });
  scored.sort((a, b) => b.s - a.s || a.name.localeCompare(b.name));
  return scored.filter((x) => x.s > 0).slice(0, k).map((x) => x.name);
}

export function _reset() { _index = null; _nameToIdx = null; _bodyCache = null; }
