// lib/self_state.js
// Canonical SELF_STATE for the agentic control loop. Every field is real
// runtime state — not prompt decoration. Epistemic tags are enforced here:
// assumptions are never promoted to facts; intended tool calls are never
// treated as completed; confidence is never treated as proof.

export const EPISTEMIC = Object.freeze({
  KNOWN: 'KNOWN',
  INFERRED: 'INFERRED',
  ASSUMED: 'ASSUMED',
  UNKNOWN: 'UNKNOWN',
  CONTRADICTED: 'CONTRADICTED',
});

export const HEALTH = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  LOOP_DETECTED: 'LOOP_DETECTED',
  BLOCKED: 'BLOCKED',
  UNSTABLE: 'UNSTABLE',
});

export const PHASE = Object.freeze({
  SELF_OBSERVATION: 'SELF_OBSERVATION',
  SELF_MONITORING: 'SELF_MONITORING',
  INTROSPECTION: 'INTROSPECTION',
  METACOGNITION: 'METACOGNITION',
  SELF_REFLECTION: 'SELF_REFLECTION',
  METACONTROL: 'METACONTROL',
  ACTION: 'ACTION',
  TERMINATION_CHECK: 'TERMINATION_CHECK',
});

export const PHASE_ORDER = Object.freeze([
  PHASE.SELF_OBSERVATION,
  PHASE.SELF_MONITORING,
  PHASE.INTROSPECTION,
  PHASE.METACOGNITION,
  PHASE.SELF_REFLECTION,
  PHASE.METACONTROL,
  PHASE.ACTION,
  PHASE.TERMINATION_CHECK,
]);

const MAX_LIST = 40;
const MAX_MEMORY = 24;
const MAX_TOOL_RESULTS = 32;

function clipList(arr, n = MAX_LIST) {
  return Array.isArray(arr) ? arr.slice(-n) : [];
}

function asString(v, fallback = '') {
  if (v == null) return fallback;
  return String(v);
}

/**
 * Structured fact with a mandatory epistemic tag.
 * Confidence is metadata only — never a substitute for evidence.
 */
export function tagged(value, tag, { source = null, confidence = null } = {}) {
  const epistemic = EPISTEMIC[tag] || EPISTEMIC.UNKNOWN;
  return {
    value: value == null ? null : value,
    epistemic,
    source,
    confidence: Number.isFinite(confidence) ? confidence : null,
    ts: Date.now(),
  };
}

export function isKnown(entry) {
  return entry && entry.epistemic === EPISTEMIC.KNOWN;
}

export class SelfState {
  constructor({
    goal = '',
    acceptance = [],
    availableTools = [],
    remainingBudget = 1,
    sessionId = null,
  } = {}) {
    this.active_goal = asString(goal);
    this.current_plan = [];
    this.current_step = null;
    this.completed_steps = [];
    this.pending_steps = [];
    this.working_memory = [];
    this.relevant_long_term_memory = [];
    this.assumptions = [];
    this.known_facts = [];
    this.unknowns = [];
    this.uncertainties = [];
    this.current_strategy = null;
    this.alternative_strategies = [];
    this.available_tools = Array.isArray(availableTools) ? availableTools.slice() : [];
    this.tool_status = {};
    this.previous_tool_results = [];
    this.errors = [];
    this.warnings = [];
    this.blockers = [];
    this.resource_usage = { cycles: 0, tool_calls: 0, tokens_in: 0, tokens_out: 0, latency_ms: 0 };
    this.remaining_budget = Number.isFinite(remainingBudget) ? remainingBudget : 1;
    this.progress = 0;
    this.confidence = 0;
    this.expected_outcome = null;
    this.observed_outcome = null;
    this.health = HEALTH.HEALTHY;
    this.session_id = sessionId;
    this.acceptance_criteria = normalizeAcceptance(acceptance);
    this.forbidden_strategies = [];
    this.strategy_failures = [];
    this.phase_log = [];
    this.think_without_action = 0;
    this.claiming_complete = false;
    this.started_at = Date.now();
  }

  remember(note, { tag = EPISTEMIC.INFERRED, source = 'working_memory' } = {}) {
    this.working_memory = clipList([...this.working_memory, tagged(note, tag, { source })], MAX_MEMORY);
  }

  addFact(value, { tag = EPISTEMIC.KNOWN, source = null, confidence = null } = {}) {
    const entry = tagged(value, tag, { source, confidence });
    if (entry.epistemic === EPISTEMIC.ASSUMED) {
      this.assumptions = clipList([...this.assumptions, entry]);
      this.warnings.push('assumption_not_fact: never treat this as KNOWN without evidence');
      return entry;
    }
    if (entry.epistemic === EPISTEMIC.UNKNOWN) {
      this.unknowns = clipList([...this.unknowns, entry]);
      return entry;
    }
    if (entry.epistemic === EPISTEMIC.CONTRADICTED) {
      this.uncertainties = clipList([...this.uncertainties, entry]);
      return entry;
    }
    if (entry.epistemic === EPISTEMIC.INFERRED) {
      this.uncertainties = clipList([...this.uncertainties, entry]);
      return entry;
    }
    this.known_facts = clipList([...this.known_facts, entry]);
    return entry;
  }

  /**
   * Record a tool outcome. Intended calls (no result) are rejected.
   * Only executed results with ok true become KNOWN evidence.
   */
  recordToolResult({ tool, args = {}, ok, evidence = null, error = null, latency_ms = 0, intended = false } = {}) {
    if (intended) {
      this.warnings.push(`intended_not_completed:${tool}`);
      this.tool_status[tool] = 'intended';
      return null;
    }
    const result = {
      id: `tr_${this.previous_tool_results.length + 1}`,
      tool: asString(tool),
      args: args && typeof args === 'object' ? args : {},
      ok: ok === true,
      evidence: ok === true ? evidence : null,
      error: ok === true ? null : asString(error || 'tool_failed'),
      epistemic: ok === true ? EPISTEMIC.KNOWN : EPISTEMIC.UNKNOWN,
      latency_ms: Number(latency_ms) || 0,
      ts: Date.now(),
    };
    this.previous_tool_results = clipList([...this.previous_tool_results, result], MAX_TOOL_RESULTS);
    this.tool_status[result.tool] = result.ok ? 'ok' : 'failed';
    this.resource_usage.tool_calls += 1;
    if (result.ok) {
      this.addFact({ tool: result.tool, summary: summarizeEvidence(result.evidence) }, {
        tag: EPISTEMIC.KNOWN,
        source: `tool:${result.tool}`,
        confidence: 0.85,
      });
      this._verifyAcceptanceFromTool(result);
    } else {
      this.errors.push(`${result.tool}:${result.error}`);
    }
    this._recomputeProgress();
    return result;
  }

  setStrategy(name, { alternatives = [] } = {}) {
    this.current_strategy = asString(name) || null;
    this.alternative_strategies = Array.isArray(alternatives) ? alternatives.map(asString).filter(Boolean) : [];
  }

  recordStrategyFailure(strategy, { newEvidence = false } = {}) {
    const name = asString(strategy || this.current_strategy || 'unknown');
    this.strategy_failures.push({ strategy: name, newEvidence: !!newEvidence, ts: Date.now() });
  }

  forbidStrategy(strategy) {
    const name = asString(strategy);
    if (name && !this.forbidden_strategies.includes(name)) this.forbidden_strategies.push(name);
    if (this.current_strategy === name) this.current_strategy = null;
  }

  logPhase(phase, detail) {
    this.phase_log = clipList([...this.phase_log, { phase, detail, ts: Date.now() }], 80);
  }

  consumeBudget(fraction) {
    const n = Number(fraction);
    if (!Number.isFinite(n) || n <= 0) return this.remaining_budget;
    this.remaining_budget = Math.max(0, this.remaining_budget - n);
    return this.remaining_budget;
  }

  _verifyAcceptanceFromTool(result) {
    for (const check of this.acceptance_criteria) {
      if (check.verified) continue;
      if (check.tool && check.tool === result.tool && result.ok) {
        check.verified = true;
        check.evidence_id = result.id;
        check.epistemic = EPISTEMIC.KNOWN;
      }
    }
  }

  _recomputeProgress() {
    const total = this.acceptance_criteria.length;
    if (total > 0) {
      const done = this.acceptance_criteria.filter(c => c.verified).length;
      this.progress = done / total;
      return;
    }
    const steps = this.current_plan.length || (this.completed_steps.length + this.pending_steps.length);
    if (steps > 0) {
      this.progress = this.completed_steps.length / steps;
      return;
    }
    this.progress = this.previous_tool_results.some(r => r.ok) ? 0.25 : 0;
  }

  acceptanceVerified() {
    if (this.acceptance_criteria.length === 0) return false;
    return this.acceptance_criteria.every(c => c.verified === true && c.evidence_id);
  }

  snapshot() {
    return {
      active_goal: this.active_goal,
      current_plan: this.current_plan.slice(),
      current_step: this.current_step,
      completed_steps: this.completed_steps.slice(),
      pending_steps: this.pending_steps.slice(),
      working_memory: this.working_memory.slice(),
      relevant_long_term_memory: this.relevant_long_term_memory.slice(),
      assumptions: this.assumptions.slice(),
      known_facts: this.known_facts.slice(),
      unknowns: this.unknowns.slice(),
      uncertainties: this.uncertainties.slice(),
      current_strategy: this.current_strategy,
      alternative_strategies: this.alternative_strategies.slice(),
      available_tools: this.available_tools.slice(),
      tool_status: { ...this.tool_status },
      previous_tool_results: this.previous_tool_results.slice(),
      errors: this.errors.slice(),
      warnings: this.warnings.slice(),
      blockers: this.blockers.slice(),
      resource_usage: { ...this.resource_usage },
      remaining_budget: this.remaining_budget,
      progress: this.progress,
      confidence: this.confidence,
      expected_outcome: this.expected_outcome,
      observed_outcome: this.observed_outcome,
      health: this.health,
      session_id: this.session_id,
      acceptance_criteria: this.acceptance_criteria.map(c => ({ ...c })),
      forbidden_strategies: this.forbidden_strategies.slice(),
      claiming_complete: this.claiming_complete,
    };
  }
}

function normalizeAcceptance(acceptance) {
  if (!Array.isArray(acceptance)) return [];
  return acceptance.slice(0, 20).map((c, i) => ({
    id: asString(c?.id || `c${i + 1}`),
    description: asString(c?.description || c),
    tool: c?.tool ? asString(c.tool) : null,
    verified: false,
    evidence_id: null,
    epistemic: EPISTEMIC.UNKNOWN,
  }));
}

function summarizeEvidence(evidence) {
  if (evidence == null) return null;
  if (typeof evidence === 'string') return evidence.slice(0, 240);
  try {
    return JSON.stringify(evidence).slice(0, 240);
  } catch {
    return '[unserializable]';
  }
}

export function createSelfState(opts) {
  return new SelfState(opts);
}
