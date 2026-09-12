// lib/routines.js
// Named operator routines (Grok-like saved workflows). Optional templates —
// spawn does not require them. Durable SQLite next to other brain stores.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SEED = Object.freeze([
  {
    name: 'retrieve-before-answer',
    trigger: 'BOS topic or operator says retrieve first',
    steps: [
      { tool: 'bos_omega_retrieve', args_from: 'goal' },
      { tool: 'web_search', optional: true },
    ],
    success: 'Retrieved chunks or search hits exist before a prose answer',
  },
  {
    name: 'trinity-gate',
    trigger: 'Any material action',
    steps: [
      { note: 'Alpha: name goal and constraints' },
      { note: 'Praxis: call a real tool' },
      { note: 'Omega: verify against acceptance' },
    ],
    success: 'GO/HOLD/ABORT stated; COMPLETE only with tool evidence',
  },
  {
    name: 'evidence-loop',
    trigger: 'Research or verify a claim',
    steps: [
      { tool: 'bos_omega_retrieve' },
      { tool: 'web_search' },
      { tool: 'datetime', note: 'timestamp the evidence pack' },
    ],
    success: 'At least one ok tool result; inference tagged separately',
  },
]);

export class RoutineStore {
  constructor(dbPath) {
    this.dbPath = dbPath || join(process.env.LLM_GATEWAY_DATA_DIR || './data', 'routines.sqlite');
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
    this.seedDefaults();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routines (
        name TEXT PRIMARY KEY,
        trigger_text TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        success TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  seedDefaults() {
    const ts = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO routines (name, trigger_text, steps_json, success, created_at, updated_at)
      VALUES (@name, @trigger_text, @steps_json, @success, @created_at, @updated_at)
      ON CONFLICT(name) DO NOTHING
    `);
    const tx = this.db.transaction(() => {
      for (const r of SEED) {
        insert.run({
          name: r.name,
          trigger_text: r.trigger,
          steps_json: JSON.stringify(r.steps),
          success: r.success,
          created_at: ts,
          updated_at: ts,
        });
      }
    });
    tx();
  }

  list() {
    return this.db.prepare('SELECT name, trigger_text, steps_json, success FROM routines ORDER BY name').all()
      .map((r) => ({
        name: r.name,
        trigger: r.trigger_text,
        steps: JSON.parse(r.steps_json),
        success: r.success,
      }));
  }

  get(name) {
    const r = this.db.prepare('SELECT * FROM routines WHERE name = ?').get(String(name || ''));
    if (!r) return null;
    return { name: r.name, trigger: r.trigger_text, steps: JSON.parse(r.steps_json), success: r.success };
  }

  upsert({ name, trigger, steps, success }) {
    const n = String(name || '').trim();
    if (!n) throw new Error('routine_name_required');
    const ts = Date.now();
    this.db.prepare(`
      INSERT INTO routines (name, trigger_text, steps_json, success, created_at, updated_at)
      VALUES (@name, @trigger_text, @steps_json, @success, @ts, @ts)
      ON CONFLICT(name) DO UPDATE SET
        trigger_text = excluded.trigger_text,
        steps_json = excluded.steps_json,
        success = excluded.success,
        updated_at = excluded.updated_at
    `).run({
      name: n.slice(0, 80),
      trigger_text: String(trigger || '').slice(0, 400),
      steps_json: JSON.stringify(Array.isArray(steps) ? steps : []),
      success: String(success || '').slice(0, 400),
      ts,
    });
    return this.get(n);
  }

  close() { this.db.close(); }
}

export async function runRoutine(store, tools, name) {
  const routine = store.get(name);
  if (!routine) return { ok: false, error: 'routine_not_found', tool: 'routine_run' };
  const results = [];
  for (const step of routine.steps) {
    if (!step.tool || typeof tools?.run !== 'function') {
      results.push({ note: step.note || null, skipped: !step.tool });
      continue;
    }
    const args = step.tool === 'datetime' ? {}
      : step.tool === 'bos_omega_retrieve' ? { query: routine.trigger }
        : step.tool === 'web_search' ? { query: routine.trigger, count: 3 }
          : {};
    const out = await tools.run(step.tool, args);
    results.push({ tool: step.tool, ok: out.ok, error: out.error || null });
    if (!out.ok && !step.optional) break;
  }
  return {
    ok: results.some((r) => r.ok),
    evidence: { name: routine.name, success: routine.success, results },
    tool: 'routine_run',
  };
}
