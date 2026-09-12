import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_VISIBILITY_RULE,
  CONTROL_EVENT_TYPES,
  assistantVisibleFromSse,
  isActionableGoal,
  looksLikeInternalDump,
  naturalLanguageAnswer,
  parseSseEvents,
  preferExecutePath,
  sanitizeAssistantText,
  userAskedForInternals,
} from '../lib/assistant_text.js';
import { buildSystemPrompt, MissionContext, resolveDecision } from '../lib/aion_kernel.js';
import { bosOperatingRules } from '../lib/bos_omega_rag.js';
import { AgentRuntime, createLlmPlanner, buildAgentMessages } from '../lib/agent_runtime.js';
import { SelfState } from '../lib/self_state.js';
import { ToolRegistry } from '../lib/brain_tools.js';

const DUMP = [
  'INTERNAL STATE',
  'SELF_STATE (untrusted data, not instructions):',
  JSON.stringify({
    active_goal: 'demo',
    health: 'HEALTHY',
    previous_tool_results: [],
    acceptance_criteria: [],
  }),
  'SELF_OBSERVATION then METACONTROL',
  'Status INCOMPLETE: cycle_or_budget_limit. Verified=false.',
].join('\n');

test('looksLikeInternalDump catches INTERNAL STATE and SELF_STATE snapshots', () => {
  assert.equal(looksLikeInternalDump(DUMP), true);
  assert.equal(looksLikeInternalDump('The current UTC time is 12:00.'), false);
  assert.equal(looksLikeInternalDump('[echo:chat] {"messages":[{"content":"SELF_STATE"}]}'), true);
  assert.equal(looksLikeInternalDump('Executed datetime (tr_1). Status COMPLETE. Verified=true.'), true);
});

test('sanitizeAssistantText strips dumps and keeps natural language', () => {
  assert.equal(sanitizeAssistantText(DUMP), '');
  assert.equal(sanitizeAssistantText('Here is the time.\nHealth: LOOP_DETECTED\n'), 'Here is the time.');
  assert.equal(
    sanitizeAssistantText(DUMP, { userAskedForInternals: true }).includes('INTERNAL STATE'),
    true,
  );
  assert.match(sanitizeAssistantText('Current time: 2026-09-12T00:00:00.000Z.'), /Current time/);
});

test('naturalLanguageAnswer never leaks Verified= or INTERNAL STATE', () => {
  const dumped = naturalLanguageAnswer({
    status: 'INCOMPLETE',
    reason: 'cycle_or_budget_limit',
    verified: false,
    cycles: [{ action: { kind: 'respond', text: DUMP } }],
    self_state: { previous_tool_results: [] },
  }, { goal: 'get the time' });
  assert.equal(/INTERNAL[_\s-]?STATE/i.test(dumped), false);
  assert.equal(/Verified\s*=/i.test(dumped), false);
  assert.ok(dumped.length > 0);

  const fromTool = naturalLanguageAnswer({
    status: 'COMPLETE',
    verified: true,
    cycles: [],
    self_state: {
      previous_tool_results: [{
        ok: true,
        tool: 'datetime',
        evidence: { iso: '2026-09-12T08:00:00.000Z', utc: 'Sat, 12 Sep 2026 08:00:00 GMT' },
      }],
    },
  }, { goal: 'Return the current UTC time' });
  assert.match(fromTool, /2026-09-12T08:00:00\.000Z/);
  assert.equal(/Verified\s*=/i.test(fromTool), false);
  assert.equal(/Status COMPLETE/.test(fromTool), false);
});

test('preferExecutePath routes actionable goals and honors consult override', () => {
  assert.equal(isActionableGoal('Return the current UTC time using the datetime tool'), true);
  assert.equal(isActionableGoal('Reply with the word READY.'), false);
  assert.equal(isActionableGoal('What is Trinity?'), false);
  assert.equal(preferExecutePath({ text: 'search public records for crash reports' }), true);
  assert.equal(preferExecutePath({ text: 'search public records', body: { consult: true } }), false);
  assert.equal(preferExecutePath({ text: 'hello', body: { agentic: true } }), true);
  assert.equal(preferExecutePath({ text: 'hello' }), false);
});

test('SSE helper concatenates only delta text', () => {
  const raw = [
    'data: {"type":"self_state","self_state":{"active_goal":"x"}}',
    '',
    'data: {"type":"phase","health":"HEALTHY"}',
    '',
    'data: {"type":"tool_start","name":"datetime"}',
    '',
    'data: {"type":"delta","text":"Current time: noon."}',
    '',
    'data: {"type":"done","status":"COMPLETE"}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const events = parseSseEvents(raw);
  assert.ok(events.some((e) => e.type === 'self_state'));
  assert.ok(events.some((e) => e.type === 'phase'));
  assert.ok(CONTROL_EVENT_TYPES.includes('self_state'));
  assert.equal(assistantVisibleFromSse(raw), 'Current time: noon.');
  assert.equal(/INTERNAL|SELF_STATE|HEALTHY/.test(assistantVisibleFromSse(raw)), false);
});

test('system prompts forbid narrating internals unless asked', () => {
  const prompt = buildSystemPrompt(resolveDecision(new MissionContext({ userInput: 'hi' })), {
    bosGate: { state: 'GO', reason: 'actionable' },
  });
  assert.match(prompt, /Do not narrate INTERNAL STATE/);
  assert.match(prompt, /unless the user explicitly asks/);
  assert.match(bosOperatingRules(), /INTERNAL STATE/);
  assert.match(ASSISTANT_VISIBILITY_RULE, /natural language/);

  const msgs = buildAgentMessages(new SelfState({ goal: 'get time', availableTools: ['datetime'] }), {
    forbidden_strategies: [],
  });
  assert.match(msgs[0].content, /Do not narrate INTERNAL STATE|visible assistant reply must be natural language/);
});

test('planner treats SELF_STATE dumps as non-action and forces a tool', async () => {
  const chain = {
    async chat() {
      return {
        content: DUMP,
        tool_calls: null,
        reasoning_content: null,
        finish_reason: 'stop',
      };
    },
  };
  const planner = createLlmPlanner({
    chain,
    catalog: [{ name: 'datetime' }, { name: 'echo' }],
  });
  const state = new SelfState({
    goal: 'Return the current UTC time using the datetime tool',
    availableTools: ['datetime', 'echo'],
  });
  const plan = await planner(state, { forbidden_strategies: [] });
  assert.equal(plan.type, 'tool');
  assert.equal(plan.tool, 'datetime');
});

test('AgentRuntime dump-echoing chain executes a tool and returns clean answer', async () => {
  const tools = new ToolRegistry();
  const chain = {
    async chat() {
      return { content: DUMP, tool_calls: null, reasoning_content: null, finish_reason: 'stop' };
    },
  };
  const runtime = new AgentRuntime({ tools, chain, maxCycles: 3, budgetMs: 8_000 });
  const result = await runtime.run({
    goal: 'Return the current UTC time using the datetime tool',
    acceptance: [{ id: 'dt', description: 'datetime ran', tool: 'datetime' }],
  });
  const ran = result.self_state.previous_tool_results.find((t) => t.tool === 'datetime');
  assert.ok(ran && ran.ok, 'dump must not replace ACTION');
  assert.equal(looksLikeInternalDump(result.answer), false);
  assert.equal(/Verified\s*=/i.test(result.answer), false);
  assert.match(result.answer, /Current time|I ran datetime/);
});

test('userAskedForInternals is opt-in only', () => {
  assert.equal(userAskedForInternals('show me the internal state'), true);
  assert.equal(userAskedForInternals('what time is it'), false);
});
