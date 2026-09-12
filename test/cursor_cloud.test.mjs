// test/cursor_cloud.test.mjs
// Mocked fetch only. Never a live CURSOR_API_KEY.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeCursorPrompt,
  isNonTrivialRepoWork,
  extractRepoUrl,
  cursorConfigured,
  cursorLaunch,
  cursorStatus,
  cursorReply,
  cursorCancel,
  lastCursorAgentId,
} from '../lib/cursor_cloud.js';
import { configuredSecrets } from '../lib/external_tools.js';
import { ToolRegistry } from '../lib/brain_tools.js';
import { pickForcedTool } from '../lib/agent_runtime.js';
import { buildSystemPrompt, MissionContext, resolveDecision } from '../lib/aion_kernel.js';

const originalFetch = globalThis.fetch;
const savedKey = process.env.CURSOR_API_KEY;
const savedBase = process.env.CURSOR_API_BASE_URL;

function restore() {
  globalThis.fetch = originalFetch;
  if (savedKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = savedKey;
  if (savedBase === undefined) delete process.env.CURSOR_API_BASE_URL;
  else process.env.CURSOR_API_BASE_URL = savedBase;
}

test.afterEach(restore);

const KEY = 'cursor_test_key_not_real';
const AGENT = {
  id: 'bc-00000000-0000-0000-0000-000000000001',
  name: 'Add README',
  status: 'ACTIVE',
  url: 'https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001',
  latestRunId: 'run-00000000-0000-0000-0000-000000000001',
};
const RUN = {
  id: 'run-00000000-0000-0000-0000-000000000001',
  agentId: AGENT.id,
  status: 'CREATING',
};

test('isNonTrivialRepoWork matches PR/repo work and ignores chat', () => {
  assert.equal(isNonTrivialRepoWork('Open a PR that implements login across the repo'), true);
  assert.equal(isNonTrivialRepoWork('refactor the codebase in multiple files'), true);
  assert.equal(isNonTrivialRepoWork('What is Trinity?'), false);
  assert.equal(isNonTrivialRepoWork('echo datetime'), false);
});

test('composeCursorPrompt injects BOS rules, methodical-notes, and the goal', () => {
  const text = composeCursorPrompt('Ship the auth fix', { today: '2026-09-12' });
  assert.match(text, /BOS-OMEGA/);
  assert.match(text, /methodical-notes\/2026-09-12-/);
  assert.match(text, /not a prefabricated named role/i);
  assert.match(text, /Operator goal:\nShip the auth fix/);
  assert.match(text, /GO \(execute\), HOLD \(need evidence\), ABORT/);
});

test('configuredSecrets.CURSOR_API_KEY is a boolean and never the value', () => {
  delete process.env.CURSOR_API_KEY;
  assert.equal(cursorConfigured(), false);
  assert.equal(configuredSecrets().CURSOR_API_KEY, false);
  process.env.CURSOR_API_KEY = KEY;
  const on = configuredSecrets();
  assert.equal(on.CURSOR_API_KEY, true);
  assert.equal(JSON.stringify(on).includes(KEY), false);
});

test('cursor_launch fails soft when unconfigured and does not fetch', async () => {
  delete process.env.CURSOR_API_KEY;
  let called = 0;
  globalThis.fetch = async () => { called += 1; throw new Error('must not call'); };
  const result = await cursorLaunch({ prompt: 'Open a PR' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cursor_launch_unconfigured');
  assert.equal(result.env, 'CURSOR_API_KEY');
  assert.equal(called, 0);
});

test('cursor_launch posts /v1/agents with Bearer auth, BOS prompt, and repo', async () => {
  process.env.CURSOR_API_KEY = KEY;
  process.env.CURSOR_API_BASE_URL = 'https://api.cursor.test';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ agent: AGENT, run: RUN }),
    };
  };
  const result = await cursorLaunch({
    prompt: 'Open a PR that implements login',
    repository: 'https://github.com/ABBYCRM/Aion-Brain',
    branch: 'main',
    today: '2026-09-12',
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.agent.id, AGENT.id);
  assert.equal(result.evidence.run.id, RUN.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.cursor.test/v1/agents');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.prompt.text, /methodical-notes\/2026-09-12-/);
  assert.match(body.prompt.text, /Open a PR that implements login/);
  assert.deepEqual(body.repos, [{ url: 'https://github.com/ABBYCRM/Aion-Brain', startingRef: 'main' }]);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('cursor_status then reply then cancel hit the documented v1 paths', async () => {
  process.env.CURSOR_API_KEY = KEY;
  process.env.CURSOR_API_BASE_URL = 'https://api.cursor.test';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: init.method || 'GET', url: String(url), auth: init.headers.authorization });
    if (String(url).endsWith(`/v1/agents/${AGENT.id}`)) {
      return { ok: true, status: 200, text: async () => JSON.stringify(AGENT) };
    }
    if (String(url).includes('/runs/') && String(url).endsWith('/cancel')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'CANCELLED' }) };
    }
    if (String(url).includes('/runs/') && !String(url).endsWith('/runs')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ...RUN, status: 'FINISHED', result: 'done' }) };
    }
    if (String(url).endsWith(`/v1/agents/${AGENT.id}/runs`)) {
      return { ok: true, status: 201, text: async () => JSON.stringify({ run: { ...RUN, id: 'run-2' } }) };
    }
    return { ok: false, status: 404, text: async () => '{"error":"missing"}' };
  };

  const status = await cursorStatus({ id: AGENT.id });
  assert.equal(status.ok, true);
  assert.equal(status.evidence.agent.id, AGENT.id);
  assert.equal(status.evidence.run.status, 'FINISHED');

  const reply = await cursorReply({ id: AGENT.id, prompt: 'also add tests' });
  assert.equal(reply.ok, true);
  assert.equal(reply.evidence.run.id, 'run-2');

  const cancel = await cursorCancel({ id: AGENT.id });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.evidence.run.status, 'CANCELLED');

  assert.ok(calls.some((c) => c.method === 'GET' && c.url.endsWith(`/v1/agents/${AGENT.id}`)));
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/v1/agents/${AGENT.id}/runs`)));
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/runs/${RUN.id}/cancel`)));
  assert.ok(calls.every((c) => c.auth === `Bearer ${KEY}`));
  assert.equal(JSON.stringify({ status, reply, cancel }).includes(KEY), false);
});

test('ToolRegistry exposes cursor_* and lastCursorAgentId reads launch evidence', async () => {
  process.env.CURSOR_API_KEY = KEY;
  globalThis.fetch = async () => ({
    ok: true,
    status: 201,
    text: async () => JSON.stringify({ agent: AGENT, run: RUN }),
  });
  const tools = new ToolRegistry();
  const names = tools.catalog().map((t) => t.name);
  assert.ok(names.includes('cursor_launch'));
  assert.ok(names.includes('cursor_status'));
  assert.ok(names.includes('cursor_reply'));
  assert.ok(names.includes('cursor_cancel'));
  const launched = await tools.run('cursor_launch', { prompt: 'Open a PR in https://github.com/ABBYCRM/Aion-Brain' });
  assert.equal(launched.ok, true);
  assert.equal(lastCursorAgentId([launched]), AGENT.id);
});

test('planner prefers cursor_launch for non-trivial repo work', () => {
  const tool = pickForcedTool(
    { active_goal: 'Open a PR that implements login across the repo', available_tools: ['datetime', 'workspace_exec', 'cursor_launch'], previous_tool_results: [] },
    { forbidden_strategies: [] },
  );
  assert.equal(tool, 'cursor_launch');
});

test('system prompt teaches cursor_launch for repo work', () => {
  const decision = resolveDecision(new MissionContext({ userInput: 'Open a PR' }));
  const prompt = buildSystemPrompt(decision);
  assert.match(prompt, /cursor_launch/);
  assert.match(prompt, /Cursor cloud agent/);
});

test('extractRepoUrl pulls a GitHub URL from free text', () => {
  assert.equal(
    extractRepoUrl('please work on https://github.com/ABBYCRM/Aion-Brain.git now'),
    'https://github.com/ABBYCRM/Aion-Brain',
  );
});
