// lib/control_loop.js
// AGENTIC SELF-STATE CONTROL LOOP — enforced in code, not prompts.
//
// Each cycle, in order:
//   SELF-OBSERVATION → SELF-MONITORING → INTROSPECTION → METACOGNITION
//   → SELF-REFLECTION → METACONTROL → ACTION → TERMINATION CHECK
//
// Anti-loop: same strategy failing ≥2 times with no new evidence forbids
// an identical retry and forces a materially different action.
// Completion: COMPLETE is refused unless acceptance criteria are verified.

import { SelfState, HEALTH, PHASE, EPISTEMIC } from './self_state.js';
import { actionFingerprint } from './tool_calls.js';

export const ISSUE = Object.freeze({
  NO_PROGRESS: 'NO_PROGRESS',
  REPEATED_FAILURE: 'REPEATED_FAILURE',
  THINKING_WITHOUT_ACTION: 'THINKING_WITHOUT_ACTION',
  UNVERIFIED_ASSUMPTION: 'UNVERIFIED_ASSUMPTION',
  MISSING_EVIDENCE: 'MISSING_EVIDENCE',
  TOOL_ERROR: 'TOOL_ERROR',
  BUDGET_LOW: 'BUDGET_LOW',
  BLOCKER: 'BLOCKER',
  FALSE_COMPLETION: 'FALSE_COMPLETION',
});

const LOOP_FAIL_THRESHOLD = 2;
const DEFAULT_MAX_CYCLES = 8;
const DEFAULT_BUDGET_MS = 90_000;

export class ControlLoop {
  constructor({
    tools = null,
    planner = null,
    maxCycles = DEFAULT_MAX_CYCLES,
    budgetMs = DEFAULT_BUDGET_MS,
    now = () => Date.now(),
  } = {}) {
    this.tools = tools;
    this.planner = planner;
    this.maxCycles = Math.max(1, Math.min(24, Number(maxCycles) || DEFAULT_MAX_CYCLES));
    this.budgetMs = Math.max(1_000, Number(budgetMs) || DEFAULT_BUDGET_MS);
    this.now = now;
  }

  /**
   * Run the loop until COMPLETE, BLOCKED, or budget/cycle exhaustion.
   * Planner is async (state, control) => planned action.
   */
  async run({
    goal,
    acceptance = [],
    availableTools = [],
    sessionId = null,
    longTermMemory = [],
  } = {}) {
    const started = this.now();
    const catalog = availableTools.length
      ? availableTools
      : (this.tools?.catalog?.() || []).map((t) => t.name);
    const state = new SelfState({
      goal,
      acceptance,
      availableTools: catalog,
      remainingBudget: 1,
      sessionId,
    });
    if (Array.isArray(longTermMemory) && longTermMemory.length) {
      state.relevant_long_term_memory = longTermMemory.slice(0, 16).map((m) => ({
        value: m,
        epistemic: EPISTEMIC.INFERRED,
        source: 'long_term_memory',
      }));
    }
    if (!state.active_goal) {
      state.blockers.push('empty_goal');
      state.health = HEALTH.BLOCKED;
      return finish(state, 'BLOCKED', 'empty_goal', [], started, this.now());
    }

    const cycles = [];
    let i = 0;
    const step = async () => {
      if (i >= this.maxCycles) return;
      const elapsed = this.now() - started;
      if (elapsed >= this.budgetMs) {
        state.blockers.push('budget_exhausted');
        return;
      }
      state.remaining_budget = Math.max(0, 1 - elapsed / this.budgetMs);
      i += 1;
      const cycle = await this.runCycle(state);
      cycles.push(cycle);
      if (cycle.termination?.halt) return;
      return step();
    };
    await step();

    if (!cycles.some((c) => c.termination?.halt)) {
      if (state.acceptanceVerified()) {
        return finish(state, 'COMPLETE', 'acceptance_verified', cycles, started, this.now());
      }
      const reason = state.blockers.length ? 'blocked' : 'cycle_or_budget_limit';
      return finish(state, reason === 'blocked' ? 'BLOCKED' : 'INCOMPLETE', reason, cycles, started, this.now());
    }
    const last = cycles[cycles.length - 1];
    return finish(state, last.termination.status, last.termination.reason, cycles, started, this.now());
  }

  async runCycle(state) {
    state.resource_usage.cycles += 1;
    const observation = this.selfObservation(state);
    const health = this.selfMonitoring(state);
    state.health = health.status;
    const issues = this.introspection(state, health);
    const meta = this.metacognition(state, issues);
    const reflection = this.selfReflection(state, meta, issues);
    const control = this.metacontrol(state, health, reflection, issues);
    const action = await this.action(state, control);
    const termination = this.terminationCheck(state, action);
    return { observation, health, issues, meta, reflection, control, action, termination };
  }

  selfObservation(state) {
    const obs = {
      phase: PHASE.SELF_OBSERVATION,
      active_goal: state.active_goal,
      current_strategy: state.current_strategy,
      current_step: state.current_step,
      completed_steps: state.completed_steps.length,
      pending_steps: state.pending_steps.length,
      known_facts: state.known_facts.length,
      assumptions: state.assumptions.length,
      unknowns: state.unknowns.length,
      previous_tool_results: state.previous_tool_results.length,
      last_tool: state.previous_tool_results.at(-1) || null,
      errors: state.errors.slice(-5),
      blockers: state.blockers.slice(),
      progress: state.progress,
      confidence: state.confidence,
      remaining_budget: state.remaining_budget,
      available_tools: state.available_tools.slice(),
    };
    state.logPhase(PHASE.SELF_OBSERVATION, {
      progress: obs.progress,
      tools: obs.previous_tool_results,
      errors: obs.errors.length,
    });
    return obs;
  }

  selfMonitoring(state) {
    const failures = state.strategy_failures;
    const last = failures.at(-1);
    let sameFails = 0;
    if (last) {
      for (let i = failures.length - 1; i >= 0; i -= 1) {
        if (failures[i].strategy !== last.strategy) break;
        if (failures[i].newEvidence) break;
        sameFails += 1;
      }
    }
    let status = HEALTH.HEALTHY;
    const reasons = [];
    if (sameFails >= LOOP_FAIL_THRESHOLD) {
      status = HEALTH.LOOP_DETECTED;
      reasons.push(`strategy_failed_${sameFails}_times_no_new_evidence:${last.strategy}`);
    } else if (state.blockers.length > 0) {
      status = HEALTH.BLOCKED;
      reasons.push(...state.blockers.slice(-3));
    } else if (state.think_without_action >= 2) {
      status = HEALTH.UNSTABLE;
      reasons.push('think_without_action');
    } else if (state.errors.length >= 2 || state.remaining_budget < 0.25) {
      status = HEALTH.DEGRADED;
      if (state.errors.length >= 2) reasons.push('repeated_errors');
      if (state.remaining_budget < 0.25) reasons.push('low_budget');
    }
    const report = { phase: PHASE.SELF_MONITORING, status, reasons, same_strategy_failures: sameFails };
    state.logPhase(PHASE.SELF_MONITORING, report);
    return report;
  }

  introspection(state, health) {
    const issues = [];
    if (health.status === HEALTH.LOOP_DETECTED) issues.push(ISSUE.REPEATED_FAILURE);
    if (state.progress === 0 && state.resource_usage.cycles > 1) issues.push(ISSUE.NO_PROGRESS);
    if (state.think_without_action > 0) issues.push(ISSUE.THINKING_WITHOUT_ACTION);
    if (state.assumptions.length && !state.known_facts.length) issues.push(ISSUE.UNVERIFIED_ASSUMPTION);
    if (state.claiming_complete && !state.acceptanceVerified()) issues.push(ISSUE.FALSE_COMPLETION);
    if (state.errors.length) issues.push(ISSUE.TOOL_ERROR);
    if (state.acceptance_criteria.length && !state.acceptanceVerified()) issues.push(ISSUE.MISSING_EVIDENCE);
    if (state.remaining_budget < 0.2) issues.push(ISSUE.BUDGET_LOW);
    if (state.blockers.length) issues.push(ISSUE.BLOCKER);
    const unique = [...new Set(issues)];
    state.logPhase(PHASE.INTROSPECTION, { issues: unique });
    return { phase: PHASE.INTROSPECTION, issues: unique };
  }

  metacognition(state, issues) {
    const forceDifferent = issues.issues.includes(ISSUE.REPEATED_FAILURE);
    const mustAct = issues.issues.includes(ISSUE.THINKING_WITHOUT_ACTION)
      || issues.issues.includes(ISSUE.NO_PROGRESS);
    const neverAssume = issues.issues.includes(ISSUE.UNVERIFIED_ASSUMPTION);
    const plan = {
      phase: PHASE.METACOGNITION,
      force_strategy_change: forceDifferent,
      require_action: mustAct,
      forbid_assumption_as_fact: true,
      gather_evidence: issues.issues.includes(ISSUE.MISSING_EVIDENCE),
      refuse_false_complete: issues.issues.includes(ISSUE.FALSE_COMPLETION),
    };
    if (forceDifferent && state.current_strategy) {
      state.forbidStrategy(state.current_strategy);
      const alt = state.alternative_strategies.find((s) => !state.forbidden_strategies.includes(s));
      if (alt) state.setStrategy(alt, { alternatives: state.alternative_strategies });
      else state.current_strategy = null;
    }
    if (neverAssume) {
      state.warnings.push('metacognition: assumptions remain ASSUMED, not KNOWN');
    }
    state.logPhase(PHASE.METACOGNITION, plan);
    return plan;
  }

  selfReflection(state, meta, issues) {
    const expected = state.expected_outcome;
    const observed = state.previous_tool_results.at(-1) || null;
    state.observed_outcome = observed
      ? { tool: observed.tool, ok: observed.ok, epistemic: observed.epistemic }
      : null;
    const gap = [];
    if (expected && observed && observed.ok === false) gap.push('expected_outcome_missed');
    if (state.confidence > 0.8 && !state.acceptanceVerified()) {
      gap.push('confidence_is_not_proof');
      state.confidence = Math.min(state.confidence, 0.4);
      state.warnings.push('confidence_not_proof');
    }
    const reflection = {
      phase: PHASE.SELF_REFLECTION,
      expected_outcome: expected,
      observed_outcome: state.observed_outcome,
      gap,
      lessons: issues.issues.slice(),
      next: meta.force_strategy_change ? 'change_strategy' : (meta.require_action ? 'act' : 'continue'),
    };
    state.logPhase(PHASE.SELF_REFLECTION, reflection);
    return reflection;
  }

  metacontrol(state, health, reflection, issues) {
    const forbidden = state.forbidden_strategies.slice();
    const control = {
      phase: PHASE.METACONTROL,
      allow_action: true,
      require_materially_different: health.status === HEALTH.LOOP_DETECTED,
      forbidden_strategies: forbidden,
      forbidden_fingerprints: lastFailedFingerprints(state),
      anti_duplicate: true,
      anti_unverified_assumption: true,
      reject_intended_as_done: true,
    };
    if (health.status === HEALTH.BLOCKED && !this.tools) {
      control.allow_action = false;
    }
    if (issues.issues.includes(ISSUE.FALSE_COMPLETION)) {
      state.claiming_complete = false;
      state.warnings.push('completion_gate: COMPLETE blocked; acceptance criteria not verified');
    }
    state.logPhase(PHASE.METACONTROL, control);
    return control;
  }

  async action(state, control) {
    state.logPhase(PHASE.ACTION, { allow: control.allow_action });
    if (!control.allow_action) {
      return { phase: PHASE.ACTION, skipped: true, reason: 'metacontrol_blocked' };
    }
    let planned;
    try {
      planned = this.planner
        ? await this.planner(state, control)
        : { type: 'halt', reason: 'no_planner' };
    } catch (e) {
      state.errors.push(`planner:${e.message || e}`);
      return { phase: PHASE.ACTION, ok: false, error: e.message || String(e) };
    }

    const gated = this._gatePlan(state, control, planned);
    if (gated.reject) {
      state.warnings.push(gated.reason);
      if (gated.reason.startsWith('duplicate_or_forbidden')) {
        state.recordStrategyFailure(planned?.strategy || state.current_strategy, { newEvidence: false });
      }
      return { phase: PHASE.ACTION, rejected: true, reason: gated.reason, planned };
    }

    if (planned?.strategy) {
      state.setStrategy(planned.strategy, { alternatives: planned.alternatives || state.alternative_strategies });
    }

    if (planned?.type === 'think') {
      state.think_without_action += 1;
      state.warnings.push('think_without_action_forbidden_as_progress');
      return { phase: PHASE.ACTION, kind: 'think', ok: false, reason: 'thinking_is_not_action' };
    }

    if (planned?.type === 'complete') {
      state.claiming_complete = true;
      state.confidence = Number(planned.confidence);
      if (!Number.isFinite(state.confidence)) state.confidence = 0.5;
      return { phase: PHASE.ACTION, kind: 'complete', claimed: true };
    }

    if (planned?.type === 'halt') {
      state.blockers.push(planned.reason || 'planner_halt');
      return { phase: PHASE.ACTION, kind: 'halt', reason: planned.reason || 'halt' };
    }

    if (planned?.type === 'tool') {
      return this._executeTool(state, planned, control);
    }

    if (planned?.type === 'respond') {
      state.remember(planned.text || '', { tag: EPISTEMIC.INFERRED, source: 'planner_respond' });
      return { phase: PHASE.ACTION, kind: 'respond', text: planned.text || '' };
    }

    state.warnings.push(`unknown_plan_type:${planned?.type}`);
    return { phase: PHASE.ACTION, rejected: true, reason: 'unknown_plan_type' };
  }

  async _executeTool(state, planned, control) {
    const name = String(planned.tool || '');
    const args = planned.args && typeof planned.args === 'object' ? planned.args : {};
    const fp = actionFingerprint(name, args);
    if (control.forbidden_fingerprints.includes(fp)) {
      state.warnings.push(`anti_duplicate:${name}`);
      state.recordStrategyFailure(planned.strategy || name, { newEvidence: false });
      return { phase: PHASE.ACTION, rejected: true, reason: `duplicate_or_forbidden:${fp}` };
    }
    if (!this.tools || typeof this.tools.run !== 'function') {
      state.blockers.push(`tools_unavailable:${name}`);
      return { phase: PHASE.ACTION, ok: false, error: 'tools_unavailable' };
    }
    if (this.tools.has && !this.tools.has(name)) {
      state.errors.push(`unknown_tool:${name}`);
      state.recordStrategyFailure(planned.strategy || name, { newEvidence: false });
      return { phase: PHASE.ACTION, ok: false, error: `unknown_tool:${name}` };
    }
    const started = this.now();
    let raw;
    try {
      raw = await this.tools.run(name, args);
    } catch (e) {
      raw = { ok: false, error: e.message || String(e), tool: name };
    }
    const latency = this.now() - started;
    const beforeFacts = state.known_facts.length;
    const recorded = state.recordToolResult({
      tool: name,
      args,
      ok: raw?.ok === true,
      evidence: raw?.evidence !== undefined ? raw.evidence : raw,
      error: raw?.error,
      latency_ms: latency,
    });
    const newEvidence = recorded?.ok === true && state.known_facts.length > beforeFacts;
    if (!recorded?.ok) {
      state.recordStrategyFailure(planned.strategy || name, { newEvidence: false });
    } else if (!newEvidence) {
      state.recordStrategyFailure(planned.strategy || name, { newEvidence: false });
    }
    state.expected_outcome = planned.expected_outcome || `tool ${name} succeeds`;
    return {
      phase: PHASE.ACTION,
      kind: 'tool',
      tool: name,
      ok: recorded?.ok === true,
      result_id: recorded?.id || null,
      new_evidence: newEvidence,
      fingerprint: fp,
    };
  }

  _gatePlan(state, control, planned) {
    if (!planned || typeof planned !== 'object') {
      return { reject: true, reason: 'empty_plan' };
    }
    if (planned.strategy && control.forbidden_strategies.includes(planned.strategy)) {
      return { reject: true, reason: `duplicate_or_forbidden_strategy:${planned.strategy}` };
    }
    if (planned.type === 'tool') {
      const fp = actionFingerprint(planned.tool, planned.args || {});
      if (control.require_materially_different && control.forbidden_fingerprints.includes(fp)) {
        return { reject: true, reason: `duplicate_or_forbidden:${fp}` };
      }
      if (control.anti_duplicate && control.forbidden_fingerprints.includes(fp)) {
        return { reject: true, reason: `duplicate_or_forbidden:${fp}` };
      }
    }
    if (planned.type === 'complete' && !state.acceptanceVerified()) {
      return { reject: false, reason: null };
    }
    if (planned.treat_assumption_as_fact) {
      return { reject: true, reason: 'anti_unverified_assumption' };
    }
    return { reject: false, reason: null };
  }

  terminationCheck(state, action) {
    let status = 'CONTINUE';
    let reason = 'in_progress';
    let halt = false;

    if (state.claiming_complete) {
      if (state.acceptanceVerified()) {
        status = 'COMPLETE';
        reason = 'acceptance_verified';
        halt = true;
      } else {
        state.warnings.push('completion_gate: COMPLETE blocked; acceptance criteria not verified');
        state.claiming_complete = false;
        status = 'CONTINUE';
        reason = 'unverified_acceptance';
        halt = false;
      }
    } else if (state.acceptanceVerified()) {
      status = 'COMPLETE';
      reason = 'acceptance_verified';
      halt = true;
    } else if (state.health === HEALTH.BLOCKED && state.alternative_strategies.length === 0) {
      status = 'BLOCKED';
      reason = state.blockers.at(-1) || 'blocked';
      halt = true;
    } else if (state.remaining_budget <= 0) {
      status = 'INCOMPLETE';
      reason = 'budget_exhausted';
      halt = true;
    }

    if (action?.kind === 'halt') {
      status = 'BLOCKED';
      reason = action.reason || 'halt';
      halt = true;
    }

    const term = { phase: PHASE.TERMINATION_CHECK, status, reason, halt, verified: state.acceptanceVerified() };
    state.logPhase(PHASE.TERMINATION_CHECK, term);
    return term;
  }
}

function lastFailedFingerprints(state) {
  const out = [];
  for (const r of state.previous_tool_results) {
    if (r.ok) continue;
    out.push(actionFingerprint(r.tool, r.args));
  }
  return out;
}

function finish(state, status, reason, cycles, started, now) {
  return {
    ok: status === 'COMPLETE',
    status,
    reason,
    complete: status === 'COMPLETE',
    verified: state.acceptanceVerified(),
    cycles,
    self_state: state.snapshot(),
    duration_ms: now - started,
  };
}

export function createControlLoop(opts) {
  return new ControlLoop(opts);
}
