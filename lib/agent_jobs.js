// lib/agent_jobs.js
// Dynamic on-the-spot agent spawn — Grok-Bot style, not prefabricated roles.
// Durable SQLite queue (same data-dir pattern as Store/AgentMemory). Jobs
// survive process restart. Optional Inngest event fan-out when
// INNGEST_EVENT_KEY is set. Local worker is the executor either way.

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentRuntime } from './agent_runtime.js';
import { isBosTopic, getBosRag, formatBosContext } from './bos_omega_rag.js';
import { naturalLanguageAnswer } from './assistant_text.js';

export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETE: 'complete',
  FAILED: 'failed',
  STOPPED: 'stopped',
  CLEANED: 'cleaned',
});

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_POLL_MS = 75;
const DEFAULT_STALE_MS = 120_000;
const MAX_DEPTH = 2;

function now() { return Date.now(); }

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function emitInngestEvent(name, data, { fetchImpl } = {}) {
  const key = String(process.env.INNGEST_EVENT_KEY || '').trim();
  if (!key) return { ok: false, skipped: true, reason: 'INNGEST_EVENT_KEY unset' };
  const base = String(process.env.INNGEST_EVENT_URL || 'https://inn.gs/e').replace(/\/+$/, '');
  const url = `${base}/${key}`;
  try {
    const fetchFn = fetchImpl || globalThis.fetch;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, data }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, skipped: false, error: `inngest_http_${res.status}` };
    return { ok: true, skipped: false };
  } catch (error) {
    return { ok: false, skipped: false, error: `inngest_failed:${error.message}`.slice(0, 180) };
  }
}

export function allowlistTools(baseTools, names) {
  if (!baseTools) return baseTools;
  if (!Array.isArray(names) || names.length === 0) return baseTools;
  const allowed = new Set(names.map((n) => String(n)));
  return {
    catalog() {
      const all = typeof baseTools.catalog === 'function' ? baseTools.catalog() : [];
      return all.filter((t) => allowed.has(t.name));
    },
    has(name) {
      if (!allowed.has(name)) return false;
      if (typeof baseTools.has === 'function') return baseTools.has(name);
      return this.catalog().some((t) => t.name === name);
    },
    run(name, args) {
      if (!allowed.has(name)) {
        return Promise.resolve({ ok: false, error: `tool_not_allowed:${name}`, tool: name });
      }
      return baseTools.run(name, args);
    },
  };
}

export class AgentOrchestrator {
  constructor({
    dbPath,
    tools = null,
    chain = null,
    runJob = null,
    fetchImpl = null,
    concurrency = DEFAULT_CONCURRENCY,
    pollMs = DEFAULT_POLL_MS,
    staleMs = DEFAULT_STALE_MS,
    maxDepth = MAX_DEPTH,
  } = {}) {
    this.dbPath = dbPath || join(process.env.LLM_GATEWAY_DATA_DIR || './data', 'agent-jobs.sqlite');
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
    this.tools = tools;
    this.chain = chain;
    this._runJob = runJob;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.concurrency = Math.max(1, Math.min(16, Number(concurrency) || DEFAULT_CONCURRENCY));
    this.pollMs = Math.max(10, Number(pollMs) || DEFAULT_POLL_MS);
    this.staleMs = Math.max(5_000, Number(staleMs) || DEFAULT_STALE_MS);
    this.maxDepth = Math.max(1, Math.min(4, Number(maxDepth) || MAX_DEPTH));
    this.workerId = `wkr_${randomUUID().slice(0, 10)}`;
    this._inflight = new Map();
    this._timer = null;
    this._stopped = true;
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        status TEXT NOT NULL,
        goal TEXT NOT NULL,
        context_json TEXT,
        tools_json TEXT,
        acceptance_json TEXT,
        callback_url TEXT,
        max_cycles INTEGER NOT NULL DEFAULT 8,
        depth INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        result_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        claimed_at INTEGER,
        worker_id TEXT,
        stop_requested INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_id, created_at);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_msg_job ON messages(job_id, consumed, ts);
    `);
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this.reclaimStale();
    const tick = async () => {
      if (this._stopped) return;
      try { await this.tick(); } catch { /* next tick */ }
      if (!this._stopped) this._timer = setTimeout(tick, this.pollMs);
    };
    this._timer = setTimeout(tick, 0);
  }

  stopWorker() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  close() {
    this.stopWorker();
    this.db.close();
  }

  reclaimStale() {
    const cutoff = now() - this.staleMs;
    const rows = this.db.prepare(`
      UPDATE jobs SET status = @queued, claimed_at = NULL, worker_id = NULL, updated_at = @ts
      WHERE status = @running AND claimed_at IS NOT NULL AND claimed_at < @cutoff
    `).run({
      queued: JOB_STATUS.QUEUED,
      running: JOB_STATUS.RUNNING,
      ts: now(),
      cutoff,
    });
    return rows.changes;
  }

  spawn({
    goal,
    context = null,
    tools = null,
    acceptance = [],
    parent_id = null,
    callback_url = null,
    max_cycles = 8,
    session_id = null,
    depth = 0,
    template = null,
  } = {}) {
    const g = String(goal || '').trim();
    if (!g) {
      const err = new Error('goal_required');
      err.statusCode = 400;
      throw err;
    }
    if (Number(depth) >= this.maxDepth) {
      const err = new Error('spawn_depth_exceeded');
      err.statusCode = 400;
      throw err;
    }
    if (parent_id) {
      const parent = this.db.prepare('SELECT id, depth, status FROM jobs WHERE id = ?').get(parent_id);
      if (!parent) {
        const err = new Error('parent_not_found');
        err.statusCode = 404;
        throw err;
      }
    }
    const id = `agt_${randomUUID().slice(0, 12)}`;
    const ts = now();
    const toolList = Array.isArray(tools) ? tools.map((t) => String(t)).filter(Boolean) : null;
    this.db.prepare(`
      INSERT INTO jobs (
        id, parent_id, status, goal, context_json, tools_json, acceptance_json,
        callback_url, max_cycles, depth, session_id, created_at, updated_at
      ) VALUES (
        @id, @parent_id, @status, @goal, @context_json, @tools_json, @acceptance_json,
        @callback_url, @max_cycles, @depth, @session_id, @created_at, @updated_at
      )
    `).run({
      id,
      parent_id: parent_id || null,
      status: JOB_STATUS.QUEUED,
      goal: g.slice(0, 20_000),
      context_json: context != null ? JSON.stringify(context) : (template ? JSON.stringify({ template }) : null),
      tools_json: toolList ? JSON.stringify(toolList) : null,
      acceptance_json: Array.isArray(acceptance) ? JSON.stringify(acceptance) : '[]',
      callback_url: callback_url ? String(callback_url).slice(0, 2000) : null,
      max_cycles: Math.max(1, Math.min(24, Number(max_cycles) || 8)),
      depth: Math.max(0, Number(depth) || 0),
      session_id: session_id || null,
      created_at: ts,
      updated_at: ts,
    });
    emitInngestEvent('aion/agent.spawned', { job_id: id, parent_id: parent_id || null }).catch(() => {});
    return this.publicJob(id);
  }

  publicJob(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!row) return null;
    return this._present(row, { includeResult: false });
  }

  result(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!row) return null;
    return this._present(row, { includeResult: true });
  }

  list({ parent_id = null, status = null, limit = 50 } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    let rows;
    if (parent_id && status) {
      rows = this.db.prepare('SELECT * FROM jobs WHERE parent_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?').all(parent_id, status, lim);
    } else if (parent_id) {
      rows = this.db.prepare('SELECT * FROM jobs WHERE parent_id = ? ORDER BY created_at DESC LIMIT ?').all(parent_id, lim);
    } else if (status) {
      rows = this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, lim);
    } else {
      rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(lim);
    }
    return rows.map((row) => this._present(row, { includeResult: false }));
  }

  steer(id, message, { goal_override = null } = {}) {
    const row = this.db.prepare('SELECT id, status FROM jobs WHERE id = ?').get(id);
    if (!row) return null;
    if (row.status === JOB_STATUS.CLEANED || row.status === JOB_STATUS.STOPPED) {
      const err = new Error('job_not_steerable');
      err.statusCode = 409;
      throw err;
    }
    const text = String(message || '').trim();
    if (!text) {
      const err = new Error('steer_message_required');
      err.statusCode = 400;
      throw err;
    }
    this.db.prepare(`
      INSERT INTO messages (id, job_id, ts, kind, body, consumed)
      VALUES (@id, @job_id, @ts, 'steer', @body, 0)
    `).run({
      id: `msg_${randomUUID().slice(0, 12)}`,
      job_id: id,
      ts: now(),
      body: JSON.stringify({ message: text.slice(0, 8000), goal_override: goal_override ? String(goal_override).slice(0, 4000) : null }),
    });
    this.db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(now(), id);
    return { ok: true, job_id: id, steered: true };
  }

  stop(id) {
    const row = this.db.prepare('SELECT id, status FROM jobs WHERE id = ?').get(id);
    if (!row) return null;
    if (row.status === JOB_STATUS.COMPLETE || row.status === JOB_STATUS.CLEANED) {
      return this.publicJob(id);
    }
    const ts = now();
    if (row.status === JOB_STATUS.QUEUED) {
      this.db.prepare(`
        UPDATE jobs SET status = @status, stop_requested = 1, finished_at = @ts, updated_at = @ts
        WHERE id = @id
      `).run({ status: JOB_STATUS.STOPPED, ts, id });
    } else {
      this.db.prepare('UPDATE jobs SET stop_requested = 1, updated_at = ? WHERE id = ?').run(ts, id);
    }
    return this.publicJob(id);
  }

  cleanup(id) {
    const row = this.db.prepare('SELECT id, status FROM jobs WHERE id = ?').get(id);
    if (!row) return null;
    if (row.status === JOB_STATUS.RUNNING || row.status === JOB_STATUS.QUEUED) {
      const err = new Error('job_still_active');
      err.statusCode = 409;
      throw err;
    }
    const ts = now();
    this.db.prepare(`
      UPDATE jobs SET status = @status, result_json = NULL, error = NULL, updated_at = @ts
      WHERE id = @id
    `).run({ status: JOB_STATUS.CLEANED, ts, id });
    this.db.prepare('DELETE FROM messages WHERE job_id = ?').run(id);
    return this.publicJob(id);
  }

  isStopRequested(id) {
    const row = this.db.prepare('SELECT stop_requested, status FROM jobs WHERE id = ?').get(id);
    return Boolean(row && (row.stop_requested || row.status === JOB_STATUS.STOPPED));
  }

  pullSteers(id) {
    const rows = this.db.prepare(`
      SELECT id, body FROM messages WHERE job_id = ? AND kind = 'steer' AND consumed = 0 ORDER BY ts ASC
    `).all(id);
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    this.db.prepare(`UPDATE messages SET consumed = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    return rows.map((r) => parseJson(r.body, { message: r.body }));
  }

  claimNext() {
    const queued = this.db.prepare(`
      SELECT id FROM jobs WHERE status = ? ORDER BY created_at ASC LIMIT 1
    `).get(JOB_STATUS.QUEUED);
    if (!queued) return null;
    const ts = now();
    const claimed = this.db.prepare(`
      UPDATE jobs SET status = @running, claimed_at = @ts, started_at = COALESCE(started_at, @ts),
        worker_id = @worker, updated_at = @ts
      WHERE id = @id AND status = @queued
    `).run({
      running: JOB_STATUS.RUNNING,
      ts,
      worker: this.workerId,
      id: queued.id,
      queued: JOB_STATUS.QUEUED,
    });
    if (!claimed.changes) return null;
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(queued.id);
  }

  async tick() {
    this.reclaimStale();
    while (this._inflight.size < this.concurrency) {
      const job = this.claimNext();
      if (!job) break;
      const running = this._execute(job).finally(() => this._inflight.delete(job.id));
      this._inflight.set(job.id, running);
    }
  }

  async _execute(row) {
    if (row.stop_requested) {
      this._finish(row.id, { status: JOB_STATUS.STOPPED, result: { reason: 'stopped_before_start' } });
      return;
    }
    try {
      const result = this._runJob
        ? await this._runJob(this._jobInput(row), this._jobHooks(row.id))
        : await this._defaultRun(row);
      if (this.isStopRequested(row.id) && result?.status !== 'COMPLETE') {
        this._finish(row.id, { status: JOB_STATUS.STOPPED, result });
      } else if (result?.status === 'COMPLETE') {
        this._finish(row.id, { status: JOB_STATUS.COMPLETE, result });
      } else if (result?.status === 'BLOCKED' && result?.reason === 'stopped_by_operator') {
        this._finish(row.id, { status: JOB_STATUS.STOPPED, result });
      } else {
        this._finish(row.id, { status: result?.status === 'FAILED' ? JOB_STATUS.FAILED : JOB_STATUS.COMPLETE, result });
      }
    } catch (error) {
      this._finish(row.id, { status: JOB_STATUS.FAILED, error: String(error.message || error).slice(0, 500) });
    }
  }

  _jobInput(row) {
    return {
      id: row.id,
      goal: row.goal,
      context: parseJson(row.context_json, null),
      tools: parseJson(row.tools_json, null),
      acceptance: parseJson(row.acceptance_json, []),
      parent_id: row.parent_id,
      max_cycles: row.max_cycles,
      depth: row.depth,
      session_id: row.session_id,
    };
  }

  _jobHooks(id) {
    return {
      shouldStop: () => this.isStopRequested(id),
      pullSteers: () => this.pullSteers(id),
    };
  }

  async _defaultRun(row) {
    const input = this._jobInput(row);
    let names = Array.isArray(input.tools) ? input.tools.slice() : null;
    if (input.depth + 1 >= this.maxDepth) {
      names = (names || (this.tools?.catalog?.() || []).map((t) => t.name))
        .filter((n) => n !== 'spawn_agent');
    }
    const tools = names ? allowlistTools(this.tools, names) : this.tools;
    const longTermMemory = [];
    if (isBosTopic(input.goal)) {
      try {
        const hit = getBosRag().retrieve(input.goal);
        if (hit.ok) longTermMemory.push(formatBosContext(hit));
      } catch { /* non-fatal */ }
    }
    if (input.context) longTermMemory.push(typeof input.context === 'string' ? input.context : JSON.stringify(input.context).slice(0, 4000));
    const runtime = new AgentRuntime({
      chain: this.chain,
      tools,
      maxCycles: input.max_cycles,
    });
    return runtime.run({
      goal: input.goal,
      acceptance: input.acceptance,
      sessionId: input.session_id || row.id,
      longTermMemory,
      maxCycles: input.max_cycles,
      hooks: this._jobHooks(row.id),
    });
  }

  _finish(id, { status, result = null, error = null }) {
    const row = this.db.prepare('SELECT parent_id, callback_url FROM jobs WHERE id = ?').get(id);
    const ts = now();
    this.db.prepare(`
      UPDATE jobs SET status = @status, result_json = @result_json, error = @error,
        finished_at = @ts, updated_at = @ts, worker_id = NULL
      WHERE id = @id
    `).run({
      status,
      result_json: result ? JSON.stringify(sanitizeResult(result)) : null,
      error,
      ts,
      id,
    });
    if (row?.parent_id) {
      this.db.prepare(`
        INSERT INTO messages (id, job_id, ts, kind, body, consumed)
        VALUES (@id, @job_id, @ts, 'callback', @body, 0)
      `).run({
        id: `msg_${randomUUID().slice(0, 12)}`,
        job_id: row.parent_id,
        ts,
        body: JSON.stringify({ child_id: id, status, error }),
      });
    }
    if (row?.callback_url) {
      this._postCallback(row.callback_url, { job_id: id, status, error, result: sanitizeResult(result) }).catch(() => {});
    }
    emitInngestEvent('aion/agent.finished', { job_id: id, status }).catch(() => {});
  }

  async _postCallback(url, payload) {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'callback_url_must_be_http(s)' };
    const res = await this.fetchImpl(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'AionBrain/0.1.21 (+agent-callback)' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  }

  _present(row, { includeResult }) {
    const out = {
      ok: true,
      id: row.id,
      parent_id: row.parent_id,
      status: row.status,
      goal: row.goal,
      tools: parseJson(row.tools_json, null),
      acceptance: parseJson(row.acceptance_json, []),
      depth: row.depth,
      session_id: row.session_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      stop_requested: Boolean(row.stop_requested),
      error: row.error || null,
    };
    if (includeResult) {
      out.result = parseJson(row.result_json, null);
      out.context = parseJson(row.context_json, null);
      out.callback_url = row.callback_url || null;
    }
    return out;
  }
}

function sanitizeResult(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    status: result.status,
    reason: result.reason,
    complete: result.complete,
    verified: result.verified,
    answer: result.answer || naturalLanguageAnswer(result, { goal: result.self_state?.active_goal || '' }),
    steers: result.steers || undefined,
    duration_ms: result.duration_ms,
    previous_tool_results: Array.isArray(result.previous_tool_results)
      ? result.previous_tool_results
      : (result.self_state?.previous_tool_results || []).map((t) => ({
        id: t.id, tool: t.tool, ok: t.ok, error: t.error,
      })),
    cycles: Array.isArray(result.cycles)
      ? result.cycles.map((c) => ({
        health: c.health?.status || c.health,
        action: c.action ? { kind: c.action.kind, tool: c.action.tool, ok: c.action.ok } : null,
      }))
      : undefined,
  };
}

export function defaultAgentJobsPath() {
  return join(process.env.LLM_GATEWAY_DATA_DIR || './data', 'agent-jobs.sqlite');
}
