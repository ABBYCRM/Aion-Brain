// SQLite persistence for call telemetry and audit history.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_MAX_CALL_ROWS = 100_000;
const DEFAULT_MAX_AUDIT_ROWS = 1_000;

export class Store {
  constructor(dbPath, {
    maxCallRows = envPositiveInt('LLM_GATEWAY_MAX_CALL_ROWS', DEFAULT_MAX_CALL_ROWS),
    maxAuditRows = envPositiveInt('LLM_GATEWAY_MAX_AUDIT_ROWS', DEFAULT_MAX_AUDIT_ROWS),
  } = {}) {
    if (!dbPath) throw new TypeError('dbPath is required');
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.closed = false;
    this.maxCallRows = maxCallRows;
    this.maxAuditRows = maxAuditRows;
    this.writeCount = 0;

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
    this._prepare();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app_id TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        operation TEXT NOT NULL,
        status INTEGER,
        latency_ms INTEGER,
        tokens_in INTEGER,
        tokens_out INTEGER,
        cost_usd REAL,
        request_id TEXT,
        error_code TEXT,
        error_message TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);
      CREATE INDEX IF NOT EXISTS idx_calls_app_ts ON calls(app_id, ts);
      CREATE INDEX IF NOT EXISTS idx_calls_provider_ts ON calls(provider, ts);

      CREATE TABLE IF NOT EXISTS audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        inventory_files INTEGER,
        p0_count INTEGER,
        p1_count INTEGER,
        p2_count INTEGER,
        verified_fixes INTEGER,
        unverified_fixes INTEGER,
        duration_ms INTEGER,
        report_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audits_ts ON audits(ts);
    `);
  }

  _prepare() {
    this.insertCall = this.db.prepare(`
      INSERT INTO calls
        (ts, app_id, provider, model, operation, status, latency_ms,
         tokens_in, tokens_out, cost_usd, request_id, error_code, error_message, meta)
      VALUES
        (@ts, @app_id, @provider, @model, @operation, @status, @latency_ms,
         @tokens_in, @tokens_out, @cost_usd, @request_id, @error_code, @error_message, @meta)
    `);
    this.insertAudit = this.db.prepare(`
      INSERT INTO audits
        (ts, mode, status, inventory_files, p0_count, p1_count, p2_count,
         verified_fixes, unverified_fixes, duration_ms, report_json)
      VALUES
        (@ts, @mode, @status, @inventory_files, @p0_count, @p1_count, @p2_count,
         @verified_fixes, @unverified_fixes, @duration_ms, @report_json)
    `);
    this.selectLastAudit = this.db.prepare('SELECT * FROM audits ORDER BY ts DESC, id DESC LIMIT 1');
    this.selectRecentCalls = this.db.prepare('SELECT * FROM calls ORDER BY ts DESC, id DESC LIMIT ?');
    this.deleteOldCalls = this.db.prepare(`
      DELETE FROM calls WHERE id NOT IN (SELECT id FROM calls ORDER BY id DESC LIMIT ?)
    `);
    this.deleteOldAudits = this.db.prepare(`
      DELETE FROM audits WHERE id NOT IN (SELECT id FROM audits ORDER BY id DESC LIMIT ?)
    `);
    this.pingStatement = this.db.prepare('SELECT 1 AS ok');
  }

  recordCall(call) {
    this._assertOpen();
    const result = this.insertCall.run({
      ts: finiteInteger(call.ts, Date.now()),
      app_id: nullableString(call.app_id, 128),
      provider: requiredString(call.provider, 'provider', 64),
      model: nullableString(call.model, 128),
      operation: requiredString(call.operation, 'operation', 64),
      status: nullableInteger(call.status),
      latency_ms: nullableInteger(call.latency_ms),
      tokens_in: nullableInteger(call.tokens_in),
      tokens_out: nullableInteger(call.tokens_out),
      cost_usd: nullableNumber(call.cost_usd),
      request_id: nullableString(call.request_id, 128),
      error_code: nullableString(call.error_code, 128),
      error_message: nullableString(call.error_message, 500),
      meta: call.meta ? JSON.stringify(call.meta) : null,
    });
    this._maybePrune();
    return result;
  }

  recordAudit(audit) {
    this._assertOpen();
    const result = this.insertAudit.run({
      ts: finiteInteger(audit.ts, Date.now()),
      mode: requiredString(audit.mode, 'mode', 32),
      status: requiredString(audit.status, 'status', 64),
      inventory_files: finiteInteger(audit.inventory_files, 0),
      p0_count: finiteInteger(audit.p0_count, 0),
      p1_count: finiteInteger(audit.p1_count, 0),
      p2_count: finiteInteger(audit.p2_count, 0),
      verified_fixes: finiteInteger(audit.verified_fixes, 0),
      unverified_fixes: finiteInteger(audit.unverified_fixes, 0),
      duration_ms: finiteInteger(audit.duration_ms, 0),
      report_json: JSON.stringify(audit),
    });
    this.deleteOldAudits.run(this.maxAuditRows);
    return result;
  }

  lastAudit() {
    this._assertOpen();
    const row = this.selectLastAudit.get();
    if (!row) return null;
    try {
      return { ...row, report: JSON.parse(row.report_json) };
    } catch {
      return { ...row, report: null, corrupt: true };
    }
  }

  recentCalls(limit = 50) {
    this._assertOpen();
    return this.selectRecentCalls.all(clampInteger(limit, 1, 500, 50));
  }

  callStats(sinceMs = 24 * 60 * 60 * 1000) {
    this._assertOpen();
    const duration = clampInteger(sinceMs, 60_000, 365 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
    const since = Date.now() - duration;
    return this.db.prepare(`
      SELECT
        provider,
        operation,
        COUNT(*) AS n,
        ROUND(AVG(latency_ms), 2) AS avg_latency,
        MIN(latency_ms) AS min_latency,
        MAX(latency_ms) AS max_latency,
        SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN status >= 400 OR error_code IS NOT NULL THEN 1 ELSE 0 END) AS err,
        SUM(COALESCE(tokens_in, 0)) AS sum_in,
        SUM(COALESCE(tokens_out, 0)) AS sum_out,
        ROUND(SUM(COALESCE(cost_usd, 0)), 8) AS sum_cost
      FROM calls
      WHERE ts >= ?
      GROUP BY provider, operation
      ORDER BY n DESC
    `).all(since);
  }

  ping() {
    this._assertOpen();
    return this.pingStatement.get()?.ok === 1;
  }

  checkpoint() {
    this._assertOpen();
    return this.db.pragma('wal_checkpoint(PASSIVE)');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  _maybePrune() {
    this.writeCount += 1;
    if (this.writeCount % 1_000 === 0) this.deleteOldCalls.run(this.maxCallRows);
  }

  _assertOpen() {
    if (this.closed) throw new Error('store is closed');
  }
}

export function defaultStorePath() {
  return join(process.env.LLM_GATEWAY_DATA_DIR || './data', 'gateway.db');
}

function envPositiveInt(name, fallback) {
  return clampInteger(process.env[name], 1, Number.MAX_SAFE_INTEGER, fallback);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function finiteInteger(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

function nullableInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function nullableNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function requiredString(value, name, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized.slice(0, maxLength);
}

function nullableString(value, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, maxLength);
}
