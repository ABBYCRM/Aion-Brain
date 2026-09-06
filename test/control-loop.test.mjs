// test/control-loop.test.mjs
// Required proofs:
//   1. LOOP_DETECTED forces a materially different strategy
//   2. A tool call executes and lands in previous_tool_results
//   3. The completion gate blocks a false COMPLETE
// Plus: ScreenshotOne HMAC (secret never in query), Composio key typing.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlLoop } from '../lib/control_loop.js';
import { SelfState, HEALTH, PHASE_ORDER, EPISTEMIC } from '../lib/self_state.js';
import { ToolRegistry } from '../lib/brain_tools.js';
import { signScreenshotOneQuery, classifyComposioKey } from '../lib/external_tools.js';
import { extractToolCalls, actionFingerprint } from '../lib/tool_calls.js';

test('SELF_STATE exposes every required field', () => {
  const s = new SelfState({ goal: 'demo', availableTools: ['echo'] });
  const snap = s.snapshot();
  for (const field of [
    'active_goal', 'current_plan', 'current_step', 'completed_steps', 'pending_steps',
    'working_memory', 'relevant_long_term_memory', 'assumptions', 'known_facts',
    'unknowns', 'uncertainties', 'current_strategy', 'alternative_strategies',
    'available_tools', 'tool_status', 'previous_tool_results', 'errors', 'warnings',
    'blockers', 'resource_usage', 'remaining_budget', 'progress', 'confidence',
    'expected_outcome', 'observed_outcome',
  ]) {
    assert.ok(field in snap, `missing ${field}`);
  }
  assert.deepEqual(PHASE_ORDER.length, 8);
  s.addFact('maybe', { tag: EPISTEMIC.ASSUMED });
  assert.equal(s.known_facts.length, 0);
  assert.equal(s.assumptions.length, 1);
  assert.ok(s.warnings.some((w) => /assumption_not_fact/.test(w)));
});

test('LOOP_DETECTED forces a materially different strategy', async () => {
  const tools = new ToolRegistry();
  const orig = tools.run.bind(tools);
  tools.run = async (name, args) => {
    if (name === 'echo') return { ok: false, error: 'simulated_fail', tool: 'echo' };
    return orig(name, args);
  };
  const seen = [];
  const planner = async (state, control) => {
    seen.push({
      health: state.health,
      forbidden: control.forbidden_strategies.slice(),
      require_different: control.require_materially_different,
    });
    if (control.require_materially_different || control.forbidden_strategies.includes('retry_echo')) {
      return { type: 'tool', tool: 'datetime', args: {}, strategy: 'use_datetime' };
    }
    return { type: 'tool', tool: 'echo', args: { text: 'same' }, strategy: 'retry_echo' };
  };
  const loop = new ControlLoop({ tools, planner, maxCycles: 6, budgetMs: 10_000 });
  const result = await loop.run({
    goal: 'get a clock reading',
    acceptance: [{ id: 'dt', description: 'datetime tool succeeded', tool: 'datetime' }],
  });
  assert.ok(result.cycles.some((c) => c.health.status === HEALTH.LOOP_DETECTED), 'expected LOOP_DETECTED');
  assert.ok(result.self_state.forbidden_strategies.includes('retry_echo'), 'retry_echo must be forbidden');
  const datetime = result.self_state.previous_tool_results.find((r) => r.tool === 'datetime');
  assert.ok(datetime && datetime.ok, 'must execute a different tool after the loop');
  assert.notEqual(datetime && actionFingerprint(datetime.tool, datetime.args), actionFingerprint('echo', { text: 'same' }));
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.verified, true);
  assert.ok(seen.some((s) => s.require_different === true));
});

test('tool call executes and updates previous_tool_results', async () => {
  const tools = new ToolRegistry();
  const planner = async () => ({
    type: 'tool',
    tool: 'echo',
    args: { text: 'hello-from-loop' },
    strategy: 'echo_once',
  });
  const loop = new ControlLoop({ tools, planner, maxCycles: 3, budgetMs: 8_000 });
  const result = await loop.run({
    goal: 'echo a marker',
    acceptance: [{ id: 'echoed', description: 'echo ran', tool: 'echo' }],
  });
  assert.ok(result.self_state.previous_tool_results.length >= 1);
  const rec = result.self_state.previous_tool_results[0];
  assert.equal(rec.tool, 'echo');
  assert.equal(rec.ok, true);
  assert.equal(rec.epistemic, EPISTEMIC.KNOWN);
  assert.equal(rec.evidence.text, 'hello-from-loop');
  assert.equal(result.self_state.tool_status.echo, 'ok');
  assert.equal(result.status, 'COMPLETE');
  assert.ok(result.self_state.known_facts.length >= 1);
});

test('completion gate blocks false COMPLETE', async () => {
  const tools = new ToolRegistry();
  const planner = async () => ({ type: 'complete', strategy: 'claim_done', confidence: 0.99 });
  const loop = new ControlLoop({ tools, planner, maxCycles: 3, budgetMs: 8_000 });
  const result = await loop.run({
    goal: 'pretend the work is finished',
    acceptance: [{ id: 'must_echo', description: 'echo must have run', tool: 'echo' }],
  });
  assert.notEqual(result.status, 'COMPLETE');
  assert.equal(result.verified, false);
  assert.equal(result.complete, false);
  assert.ok(result.self_state.warnings.some((w) => /completion_gate/i.test(w)));
  assert.equal(result.self_state.previous_tool_results.length, 0);
  assert.ok(result.self_state.confidence <= 0.4 || result.self_state.warnings.includes('confidence_not_proof') || result.self_state.claiming_complete === false);
});

test('native and XML tool_call parsing', () => {
  const native = extractToolCalls({
    tool_calls: [{ id: 'c1', function: { name: 'echo', arguments: '{"text":"x"}' } }],
    content: '',
  });
  assert.equal(native.source, 'native');
  assert.equal(native.calls[0].name, 'echo');
  assert.equal(native.calls[0].args.text, 'x');

  const xml = extractToolCalls({
    content: '<tool_call name="datetime">{}</tool_call>',
  });
  assert.equal(xml.source, 'xml');
  assert.equal(xml.calls[0].name, 'datetime');
});

test('ScreenshotOne HMAC signs the canonical query; secret is never a param', () => {
  const params = { access_key: 'test-access', url: 'https://example.com', full_page: false, format: 'png' };
  const secret = 'test-secret-value';
  const { query, signature } = signScreenshotOneQuery(params, secret);
  assert.ok(signature);
  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.ok(query.includes('signature='));
  assert.ok(!query.includes(secret));
  assert.ok(!query.includes('secret'));
  const unsigned = signScreenshotOneQuery(params, '');
  assert.equal(unsigned.signature, null);
  assert.ok(!unsigned.query.includes('signature='));
});

test('Composio key type: ak_ accepted, oak_ and ck_ fail soft', () => {
  assert.equal(classifyComposioKey('ak_projectexample').ok, true);
  assert.equal(classifyComposioKey('ak_projectexample').type, 'project');
  const oak = classifyComposioKey('oak_orgexample');
  assert.equal(oak.ok, false);
  assert.equal(oak.type, 'oak');
  assert.match(oak.error, /oak_/);
  const ck = classifyComposioKey('ck_consumerexample');
  assert.equal(ck.ok, false);
  assert.equal(ck.type, 'consumer');
  assert.match(ck.error, /ck_/);
  assert.equal(classifyComposioKey('').ok, false);
});
