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
  {
    name: 'cursor-repo-work',
    trigger: 'Non-trivial repository / PR work when CURSOR_API_KEY is set',
    steps: [
      { tool: 'bos_omega_retrieve', optional: true },
      { tool: 'cursor_launch' },
      { tool: 'cursor_status' },
    ],
    success: 'Cursor agent id exists; COMPLETE only after run evidence',
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
    const cols = this.db.prepare('PRAGMA table_info(routines)').all();
    if (!cols.some((c) => c.name === 'status')) {
      this.db.exec("ALTER TABLE routines ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    }
  }

  _row(r) {
    if (!r) return null;
    return {
      name: r.name,
      trigger: r.trigger_text,
      steps: JSON.parse(r.steps_json),
      success: r.success,
      status: r.status || 'active',
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  seedDefaults() {
    const ts = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO routines (name, trigger_text, steps_json, success, created_at, updated_at, status)
      VALUES (@name, @trigger_text, @steps_json, @success, @created_at, @updated_at, 'active')
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
    return this.db.prepare('SELECT * FROM routines ORDER BY name').all().map((r) => this._row(r));
  }

  get(name) {
    const r = this.db.prepare('SELECT * FROM routines WHERE name = ?').get(String(name || ''));
    return this._row(r);
  }

  upsert({ name, trigger, steps, success, status } = {}) {
    const n = String(name || '').trim();
    if (!n) throw new Error('routine_name_required');
    const existing = this.get(n);
    const st = status === 'paused' || status === 'active'
      ? status
      : (existing?.status || 'active');
    const ts = Date.now();
    this.db.prepare(`
      INSERT INTO routines (name, trigger_text, steps_json, success, created_at, updated_at, status)
      VALUES (@name, @trigger_text, @steps_json, @success, @ts, @ts, @status)
      ON CONFLICT(name) DO UPDATE SET
        trigger_text = excluded.trigger_text,
        steps_json = excluded.steps_json,
        success = excluded.success,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run({
      name: n.slice(0, 80),
      trigger_text: String(trigger || existing?.trigger || '').slice(0, 400),
      steps_json: JSON.stringify(Array.isArray(steps) ? steps : (existing?.steps || [])),
      success: String(success || existing?.success || '').slice(0, 400),
      status: st,
      ts,
    });
    return this.get(n);
  }

  setStatus(name, status) {
    if (status !== 'active' && status !== 'paused') throw new Error('routine_status_invalid');
    const n = String(name || '').trim();
    const existing = this.get(n);
    if (!existing) return null;
    this.db.prepare('UPDATE routines SET status = ?, updated_at = ? WHERE name = ?')
      .run(status, Date.now(), n);
    return this.get(n);
  }

  pause(name) { return this.setStatus(name, 'paused'); }
  resume(name) { return this.setStatus(name, 'active'); }

  delete(name) {
    const n = String(name || '').trim();
    const existing = this.get(n);
    if (!existing) return null;
    this.db.prepare('DELETE FROM routines WHERE name = ?').run(n);
    return existing;
  }

  close() { this.db.close(); }
}

export async function runRoutine(store, tools, name) {
  const routine = store.get(name);
  if (!routine) return { ok: false, error: 'routine_not_found', tool: 'routine_run' };
  if (routine.status === 'paused') {
    return { ok: false, error: 'routine_paused', tool: 'routine_run', evidence: { name: routine.name, status: 'paused' } };
  }
  const results = [];
  for (const step of routine.steps) {
    if (!step.tool || typeof tools?.run !== 'function') {
      results.push({ note: step.note || null, skipped: !step.tool });
      continue;
    }
    const args = step.tool === 'datetime' ? {}
      : step.tool === 'bos_omega_retrieve' ? { query: routine.trigger }
        : step.tool === 'web_search' ? { query: routine.trigger, count: 3 }
          : step.tool === 'cursor_launch' ? { prompt: routine.trigger }
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
