// lib/brain.js
// BOS-OMEGA brain layer: autonomous audit → research → propose → validate.
// Fact-rooted. No hallucination of fixes. External research required for patches.
// intentionally-sync for deterministic inventory walk when needed.

import { Auditor } from './auditor.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const RESEARCH_TIMEOUT_MS = 12_000;

/**
 * Brain: closed-loop self-improvement runtime.
 * 1. Run full Auditor
 * 2. For each P0/P1 finding, attempt external research (caller supplies researchFn)
 * 3. Produce structured proposals only (never auto-apply by default)
 * 4. Re-audit after optional apply
 */
export class Brain {
  constructor({ root, store, researchFn } = {}) {
    this.root = root || process.cwd();
    this.store = store || null;
    this.researchFn = researchFn || defaultResearchStub;
  }

  /**
   * Full cycle: audit → research → proposals
   * @param {object} opts
   * @param {boolean} opts.apply  if true, write accepted patches (default false)
   * @param {string[]} opts.severities  which severities to act on (default ['P0','P1'])
   */
  async runCycle({ apply = false, severities = ['P0', 'P1'] } = {}) {
    const start = Date.now();
    const auditor = new Auditor({ root: this.root, mode: 'full' });
    const report = await auditor.run();

    const findings = (report.phases?.phase2_static?.findings || [])
      .filter(f => severities.includes(f.severity));

    const proposals = [];
    for (const finding of findings.slice(0, 12)) { // hard cap to stay safe
      const research = await this._researchFinding(finding);
      const proposal = this._buildProposal(finding, research);
      proposals.push(proposal);
    }

    let applied = [];
    if (apply) {
      for (const p of proposals) {
        if (p.safe_to_apply && p.patch) {
          try {
            this._applyPatch(p);
            applied.push({ file: p.file, rule: p.rule, status: 'applied' });
          } catch (e) {
            applied.push({ file: p.file, rule: p.rule, status: 'failed', error: e.message });
          }
        }
      }
    }

    // Re-audit if anything was applied
    let postReport = null;
    if (applied.length > 0) {
      const postAuditor = new Auditor({ root: this.root, mode: 'full' });
      postReport = await postAuditor.run();
    }

    const result = {
      ts: Date.now(),
      duration_ms: Date.now() - start,
      pre_audit: {
        status: report.status,
        p0: report.p0_count,
        p1: report.p1_count,
        p2: report.p2_count,
      },
      findings_examined: findings.length,
      proposals,
      applied,
      post_audit: postReport ? {
        status: postReport.status,
        p0: postReport.p0_count,
        p1: postReport.p1_count,
      } : null,
      mode: apply ? 'apply' : 'propose_only',
    };

    // Persist if store available
    if (this.store?.recordAudit) {
      try {
        this.store.recordAudit({
          ...result,
          mode: 'brain_cycle',
          status: result.post_audit?.status || result.pre_audit.status,
          inventory_files: report.inventory_files,
          p0_count: result.post_audit?.p0 ?? result.pre_audit.p0,
          p1_count: result.post_audit?.p1 ?? result.pre_audit.p1,
          p2_count: report.p2_count,
          verified_fixes: report.verified_fixes,
          unverified_fixes: report.unverified_fixes,
          duration_ms: result.duration_ms,
        });
      } catch { /* non-fatal */ }
    }

    return result;
  }

  async _researchFinding(finding) {
    const query = `${finding.rule} ${finding.message} node.js express fix site:github.com OR site:stackoverflow.com`;
    try {
      const results = await this.researchFn(query, { timeout: RESEARCH_TIMEOUT_MS });
      return {
        query,
        hits: Array.isArray(results) ? results.slice(0, 5) : [],
        researched_at: Date.now(),
      };
    } catch (e) {
      return { query, error: e.message, hits: [] };
    }
  }

  _buildProposal(finding, research) {
    // Never invent a patch. Only emit structured proposal.
    // Safe-to-apply is false unless a concrete, minimal patch is known from prior verified work.
    const knownSafe = this._knownSafePatch(finding);

    return {
      rule: finding.rule,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      message: finding.message,
      snippet: finding.snippet || '',
      suggested_fix: finding.fix || '',
      research,
      safe_to_apply: !!knownSafe,
      patch: knownSafe || null,
      rationale: knownSafe
        ? 'Patch derived from previously verified local improvement (0.1.5 hardening).'
        : 'No verified local patch available. Research hits provided for human review.',
    };
  }

  _knownSafePatch(finding) {
    // Only return patches that were already implemented and verified in 0.1.5.
    // This prevents hallucination of new code.
    if (finding.rule === 'P1-json-parse-no-try' && finding.file === 'lib/router.js') {
      return {
        description: 'Wrap JSON.parse in try/catch → typed invalid_json error',
        // Actual patch already present in local 0.1.5; this is a no-op marker
        already_applied: true,
      };
    }
    if (finding.rule === 'P1-json-parse-no-try' && finding.file === 'lib/store.js') {
      return {
        description: 'Guard lastAudit JSON.parse against corrupt report_json',
        already_applied: true,
      };
    }
    if (finding.rule === 'P1-process-exit') {
      return {
        description: 'Rule updated to ignore bin/, test/, and graceful shutdown contexts',
        already_applied: true,
      };
    }
    return null;
  }

  _applyPatch(proposal) {
    // Intentionally minimal: only allow re-application of already-verified local patches.
    // Full auto-edit of arbitrary files is disabled to prevent hallucinated code.
    if (!proposal.patch?.already_applied) {
      throw new Error('Refusing to apply unverified patch');
    }
    // Nothing to write — already present in the tree.
  }
}

/** Default research stub — returns empty. Real researchFn should call web_search / browse. */
async function defaultResearchStub(query) {
  return [{ title: 'research disabled in stub', url: '', snippet: 'Supply researchFn that calls external search.' }];
}

export function createBrain(opts) {
  return new Brain(opts);
}
