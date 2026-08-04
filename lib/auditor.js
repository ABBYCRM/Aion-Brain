// Static-and-health auditor. It deliberately does not claim test, dependency,
// provider, deployment, or end-to-end verification.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { auditFile } from './rules.js';

const AUDITABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.html', '.yaml', '.yml', '.md',
]);
const SKIP_NAMES = new Set([
  'node_modules', '.git', 'data', 'reports', 'dist', 'build', '.cache', '.npm', 'coverage',
]);
const SKIP_PREFIXES = ['data-', 'reports-', '.data-'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

export class Auditor {
  constructor({ root, mode = 'full', selfFetch, fetchImpl = globalThis.fetch } = {}) {
    if (!root) throw new TypeError('root is required');
    if (!['quick', 'full'].includes(mode)) throw new TypeError('mode must be quick or full');
    this.root = resolve(root);
    this.mode = mode;
    this.selfFetch = selfFetch;
    this.fetchImpl = fetchImpl;
  }

  async run() {
    const startedAt = Date.now();
    const phases = {};

    const inventoryStarted = Date.now();
    const inventory = this._inventory();
    phases.inventory = {
      duration_ms: Date.now() - inventoryStarted,
      files: inventory.length,
      digest: manifestDigest(inventory),
      manifest: inventory,
    };

    const healthStarted = Date.now();
    const health = await this._health(this.mode === 'quick' ? 1 : 5);
    phases.health = { duration_ms: Date.now() - healthStarted, ...health };

    if (this.mode === 'full') {
      const staticStarted = Date.now();
      const findings = this._static(inventory);
      phases.static = {
        duration_ms: Date.now() - staticStarted,
        count: findings.length,
        findings,
      };

      const verifyStarted = Date.now();
      phases.claims = {
        duration_ms: Date.now() - verifyStarted,
        ...this._verifyClaims(),
      };
    }

    return this._report(phases, startedAt);
  }

  _inventory() {
    const manifest = [];
    this._walk(this.root, filePath => {
      const extension = ext(filePath);
      if (!AUDITABLE_EXTENSIONS.has(extension)) return;
      let content;
      try { content = readFileSync(filePath, 'utf8'); }
      catch { return; }
      manifest.push({
        path: relative(this.root, filePath).replaceAll('\\', '/'),
        sha256: createHash('sha256').update(content).digest('hex'),
        lines: content.split('\n').length,
        bytes: Buffer.byteLength(content),
      });
    });
    return manifest.sort((a, b) => a.path.localeCompare(b.path));
  }

  async _health(sampleCount) {
    if (!this.selfFetch) {
      return {
        attempted: false,
        ok: false,
        samples: [],
        reason: 'No selfFetch/base URL was configured; runtime health was not tested.',
      };
    }
    if (typeof this.fetchImpl !== 'function') {
      return { attempted: true, ok: false, samples: [], reason: 'No fetch implementation available.' };
    }

    const base = typeof this.selfFetch === 'function' ? this.selfFetch() : this.selfFetch;
    const url = `${String(base).replace(/\/$/, '')}/healthz`;
    const samples = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const startedAt = Date.now();
      try {
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
        samples.push({ status: response.status, ok: response.ok, latency_ms: Date.now() - startedAt });
      } catch (error) {
        samples.push({ ok: false, latency_ms: Date.now() - startedAt, error: error.message });
      }
    }
    const successful = samples.filter(sample => sample.ok);
    const latencies = successful.map(sample => sample.latency_ms).sort((a, b) => a - b);
    return {
      attempted: true,
      ok: successful.length === sampleCount,
      url,
      samples,
      successful_samples: successful.length,
      required_samples: sampleCount,
      p50_ms: percentile(latencies, 0.5),
      p95_ms: percentile(latencies, 0.95),
      memory: process.memoryUsage(),
    };
  }

  _static(inventory) {
    const findings = [];
    for (const item of inventory) {
      if (!SOURCE_EXTENSIONS.has(ext(item.path))) continue;
      const fullPath = join(this.root, item.path);
      let content;
      try { content = readFileSync(fullPath, 'utf8'); }
      catch { continue; }
      findings.push(...auditFile({ filePath: item.path, content }));
    }
    const severityOrder = { P0: 0, P1: 1, P2: 2 };
    return findings.sort((a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity]
      || a.file.localeCompare(b.file)
      || a.line - b.line);
  }

  _verifyClaims() {
    const changelogPath = join(this.root, 'CHANGELOG.md');
    if (!existsSync(changelogPath)) {
      return { claimed: 0, verified: 0, unverified: [], reason: 'CHANGELOG.md is absent.' };
    }

    const lines = readFileSync(changelogPath, 'utf8').split('\n');
    const claims = [];
    let fixSection = false;
    for (const line of lines) {
      if (/^##\s+/.test(line)) {
        fixSection = /\b(?:fix|security|hardening)\b/i.test(line);
        continue;
      }
      if (!fixSection) continue;
      const tokens = [...line.matchAll(/`([^`]+)`/g)].map(match => match[1].trim()).filter(Boolean);
      for (const token of tokens) claims.push(this._verifyToken(token));
    }

    return {
      claimed: claims.length,
      verified: claims.filter(item => item.present).length,
      unverified: claims.filter(item => !item.present),
      claims,
      method: 'Exact path existence or exact source-token search; no behavioral claim is made.',
    };
  }

  _verifyToken(token) {
    const candidatePath = join(this.root, token);
    if (/^[\w./-]+\.(?:js|mjs|cjs|ts|tsx|json|yaml|yml|md)$/.test(token) && existsSync(candidatePath)) {
      return { token, kind: 'path', present: true, locations: [{ file: token }] };
    }

    const locations = [];
    this._walk(this.root, filePath => {
      if (locations.length >= 5 || !SOURCE_EXTENSIONS.has(ext(filePath))) return;
      let content;
      try { content = readFileSync(filePath, 'utf8'); }
      catch { return; }
      const lines = content.split('\n');
      for (let index = 0; index < lines.length && locations.length < 5; index += 1) {
        if (lines[index].includes(token)) {
          locations.push({
            file: relative(this.root, filePath).replaceAll('\\', '/'),
            line: index + 1,
          });
        }
      }
    });
    return { token, kind: 'symbol', present: locations.length > 0, locations };
  }

  _walk(directory, onFile) {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (shouldSkip(entry.name)) continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) this._walk(fullPath, onFile);
      else if (entry.isFile()) onFile(fullPath);
    }
  }

  _report(phases, startedAt) {
    const findings = phases.static?.findings || [];
    const p0 = findings.filter(item => item.severity === 'P0').length;
    const p1 = findings.filter(item => item.severity === 'P1').length;
    const p2 = findings.filter(item => item.severity === 'P2').length;
    const unverified = phases.claims?.unverified?.length || 0;

    let status;
    if (!phases.health.attempted) status = 'PARTIAL';
    else if (!phases.health.ok) status = 'BLOCKED';
    else if (p0 > 0 || unverified > 0) status = 'FAILED';
    else if (p1 > 0) status = 'PARTIAL';
    else status = this.mode === 'quick' ? 'HEALTH_VERIFIED' : 'STATIC_HEALTH_VERIFIED';

    return {
      schema_version: 2,
      ts: Date.now(),
      duration_ms: Date.now() - startedAt,
      mode: this.mode,
      status,
      assurance: this.mode === 'quick' ? 'runtime-health-only' : 'static-and-runtime-health-only',
      limitations: [
        'This report does not install dependencies.',
        'This report does not execute unit, integration, provider, deployment, load, or security tests.',
        'Changelog verification proves only path/token presence, not behavior.',
      ],
      inventory_files: phases.inventory.files,
      inventory_digest: phases.inventory.digest,
      p0_count: p0,
      p1_count: p1,
      p2_count: p2,
      verified_fixes: phases.claims?.verified || 0,
      unverified_fixes: unverified,
      phases,
    };
  }
}

function shouldSkip(name) {
  return SKIP_NAMES.has(name) || SKIP_PREFIXES.some(prefix => name.startsWith(prefix));
}

function ext(path) {
  const index = path.lastIndexOf('.');
  return index < 0 ? '' : path.slice(index).toLowerCase();
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
}

function manifestDigest(manifest) {
  const hash = createHash('sha256');
  for (const item of manifest) hash.update(`${item.path}\0${item.sha256}\n`);
  return hash.digest('hex');
}
