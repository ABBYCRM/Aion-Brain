// test/contract-aion-modules.mjs
// Verifies the new AION modules are importable and the kernel decision
// shape matches the AION v2 FastAPI backend contract.
//
// The last 5 tests exercise live HTTP routes. They spawn their own server
// instance in `before()` (same self-contained pattern as test/smoke*.mjs) so
// this file is runnable standalone via `node test/contract-aion-modules.mjs`
// with no external server required. Set BRAIN_URL / BRAIN_KEY to point the
// HTTP tests at an already-running server instead (e.g. for manual poking).

import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { AION_CONTINUITY_PACK, MissionContext, buildSystemPrompt, resolveDecision, DecisionState } from '../lib/aion_kernel.js';
import { assistantVisibleFromSse, looksLikeInternalDump, parseSseEvents } from '../lib/assistant_text.js';
import { AionChain } from '../lib/aion_chain.js';
import { aionSettings } from '../lib/aion_settings.js';

const EXTERNAL_BRAIN = process.env.BRAIN_URL; // if set, skip spawning our own server
const PORT = 10001;
const BRAIN = EXTERNAL_BRAIN || `http://localhost:${PORT}`;
const BRAIN_KEY = process.env.BRAIN_KEY || 'test-brain-key';
const DATA_DIR = join(process.cwd(), 'data-contract-' + Date.now());

let server = null;
let serverLog = '';

before(async () => {
  if (EXTERNAL_BRAIN) return; // caller supplied a live server; nothing to spawn
  mkdirSync(DATA_DIR, { recursive: true });
  const env = {
    ...process.env,
    PORT: String(PORT),
    LLM_GATEWAY_DATA_DIR: DATA_DIR,
    OPENAI_API_KEY: '',
    AION_ECHO_ONLY: '1',
    AION_API_KEYS: BRAIN_KEY,
    AION_ADMIN_KEYS: 'admin-key',
    ENVIRONMENT: 'test',
  };
  server = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { serverLog += d.toString(); });
  server.stderr.on('data', d => { serverLog += d.toString(); });

  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BRAIN}/healthz`);
      if (r.ok) return;
    } catch { /* retry */ }
    await wait(200);
  }
  throw new Error('contract test server did not start within 10s\n' + serverLog);
});

after(async () => {
  if (EXTERNAL_BRAIN) return;
  server?.kill('SIGTERM');
  await wait(200);
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('AION continuity pack has 7 laws + 3 decision states', () => {
  assert.equal(AION_CONTINUITY_PACK.system_name, 'AION');
  assert.equal(AION_CONTINUITY_PACK.core_laws.length, 7);
  assert.deepEqual(AION_CONTINUITY_PACK.decision_states, ['COMMIT', 'DEFER', 'REJECT']);
  assert.ok(AION_CONTINUITY_PACK.core_laws.includes('Reality'));
  assert.ok(AION_CONTINUITY_PACK.core_laws.includes('Decision'));
});

test('DecisionState enum matches the AION v2 backend', () => {
  assert.equal(DecisionState.COMMIT, 'COMMIT');
  assert.equal(DecisionState.DEFER, 'DEFER');
  assert.equal(DecisionState.REJECT, 'REJECT');
});

test('resolveDecision returns 7 checks + score + state', () => {
  const ctx = new MissionContext({ userInput: 'hello' });
  const d = resolveDecision(ctx);
  assert.equal(d.state, 'COMMIT');
  assert.equal(d.checks.length, 7);
  assert.ok(d.score >= 0 && d.score <= 1);
  assert.match(d.id, /^dec_/);
  assert.equal(typeof d.protocol, 'object');
  assert.equal(d.protocol.reversibility_check, true);
});

test('resolveDecision DEFERs when tool requested but no evidence', () => {
  const ctx = new MissionContext({ userInput: 'x', metadata: { webSearch: true } });
  const d = resolveDecision(ctx);
  assert.equal(d.state, 'DEFER');
  assert.equal(d.score, 0.25);
});

test('buildSystemPrompt injects law checks + tool/notes contexts', () => {
  const ctx = new MissionContext({ userInput: 'x' });
  const d = resolveDecision(ctx);
  const prompt = buildSystemPrompt(d, {
    toolContext: '<tool_results type="web_search">fake</tool_results>',
    notesContext: '<operator_notes>fake</operator_notes>',
  });
  assert.match(prompt, /AION/);
  assert.match(prompt, /REALITY/);
  assert.match(prompt, /tool_results/);
  assert.match(prompt, /operator_notes/);
  assert.match(prompt, /never.*higher-priority/i);
});

test('MissionContext.fingerprint is stable for same input', () => {
  const a = new MissionContext({ userInput: 'hello', history: [{ role: 'user', content: 'hi' }] });
  const b = new MissionContext({ userInput: 'hello', history: [{ role: 'user', content: 'hi' }] });
  assert.equal(a.fingerprint(), b.fingerprint());
});

test('AionChain.fromEnv honors AION_ECHO_ONLY', () => {
  const prev = process.env.AION_ECHO_ONLY;
  process.env.AION_ECHO_ONLY = '1';
  const chain = AionChain.fromEnv({ appId: 'test' });
  assert.equal(chain.providers.length, 1);
  assert.equal(chain.providers[0].name, 'echo');
  process.env.AION_ECHO_ONLY = prev;
});

test('aionSettings is frozen-ish and exposes AION keys', () => {
  assert.ok(Array.isArray(aionSettings.apiKeys));
  assert.ok(Array.isArray(aionSettings.adminKeys));
  assert.match(aionSettings.primaryModel, /^[A-Za-z0-9./-]+$/);
});

test('Aion-Brain exposes /api/state for AION integration', async () => {
  const r = await fetch(`${BRAIN}/api/state`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.app, 'aion-brain');
  assert.ok(Array.isArray(body.providers));
  assert.equal(body.continuity_pack.laws.length, 7);
  assert.deepEqual(body.continuity_pack.states, ['COMMIT', 'DEFER', 'REJECT']);
});

test('Aion-Brain exposes /api/tools catalog', async () => {
  const r = await fetch(`${BRAIN}/api/tools`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  const names = body.tools.map(t => t.name);
  assert.ok(names.includes('echo'));
  assert.ok(names.includes('datetime'));
  assert.ok(names.includes('free_energy'));
  assert.ok(names.includes('gdy_search'));
  assert.ok(names.includes('gdy_rag_context'));
  assert.ok(names.includes('gdy_categories'));
  assert.ok(names.includes('gdy_tools'));
  assert.ok(names.includes('arxiv_search'));
  assert.ok(names.includes('bos_omega_retrieve'));
  assert.ok(names.includes('spawn_agent'));
  assert.ok(names.includes('workspace_exec'));
  assert.ok(names.includes('cursor_launch'));
  assert.ok(names.includes('cursor_status'));
  assert.ok(names.includes('cursor_reply'));
  assert.ok(names.includes('cursor_cancel'));
});

test('Aion-Brain runs tools via POST /api/tools/:name', async () => {
  // echo
  let r = await fetch(`${BRAIN}/api/tools/echo`, {
    method: 'POST',
    headers: { 'X-AION-Key': BRAIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hello from aion' }),
  });
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.evidence.text, 'hello from aion');
  // datetime
  r = await fetch(`${BRAIN}/api/tools/datetime`, { method: 'POST', headers: { 'X-AION-Key': BRAIN_KEY } });
  body = await r.json();
  assert.equal(body.ok, true);
  assert.match(body.evidence.iso, /^\d{4}-\d{2}-\d{2}T/);
  // unknown tool
  r = await fetch(`${BRAIN}/api/tools/nope`, { method: 'POST', headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(r.status, 404);
});

test('Aion-Brain /api/tools requires auth', async () => {
  const r = await fetch(`${BRAIN}/api/tools`);
  assert.equal(r.status, 401);
});

test('Aion-Brain /api/state requires auth', async () => {
  const r = await fetch(`${BRAIN}/api/state`);
  assert.equal(r.status, 401);
});

test('Aion-Brain /api/state advertises the control loop', async () => {
  const r = await fetch(`${BRAIN}/api/state`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.control_loop.phases));
  assert.equal(body.control_loop.phases[0], 'SELF_OBSERVATION');
  assert.equal(body.control_loop.phases.at(-1), 'TERMINATION_CHECK');
  assert.equal(typeof body.agent_model, 'string');
  assert.equal(typeof body.control_loop.tools_configured.GDY, 'boolean');
  assert.equal(typeof body.control_loop.tools_configured.CURSOR_API_KEY, 'boolean');
  assert.equal(typeof body.cursor.configured, 'boolean');
  assert.equal(body.cursor.launch, '/api/cursor/launch');
  assert.equal(JSON.stringify(body).includes('gdy_live_'), false);
});

test('healthz and claw tools catalog expose GDY boolean and new tools', async () => {
  const health = await fetch(`${BRAIN}/healthz`);
  assert.equal(health.status, 200);
  const hz = await health.json();
  assert.equal(typeof hz.secrets.gdy, 'boolean');
  assert.equal(typeof hz.secrets.cursor, 'boolean');
  assert.equal(JSON.stringify(hz).includes('gdy_live_'), false);

  const r = await fetch(`${BRAIN}/api/claw/tools`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(r.status, 200);
  const body = await r.json();
  const names = body.tools.map((t) => t.name);
  assert.ok(names.includes('gdy_search'));
  assert.ok(names.includes('arxiv_search'));
  assert.ok(names.includes('cursor_launch'));
});

test('Aion-Brain /api/claw/contract and execute', async () => {
  const contract = await fetch(`${BRAIN}/api/claw/contract`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(contract.status, 200);
  const c = await contract.json();
  assert.equal(c.ok, true);
  assert.ok(c.contract.endpoints.execute.path.includes('/api/claw/execute'));

  const r = await fetch(`${BRAIN}/api/claw/execute`, {
    method: 'POST',
    headers: { 'X-AION-Key': BRAIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: 'Return the current UTC time using the datetime tool if you can; otherwise reply.',
      acceptance: [{ id: 'dt', description: 'datetime ran', tool: 'datetime' }],
      max_cycles: 2,
    }),
  });
  assert.ok(r.status === 200 || r.status === 202);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.source, 'aion-brain');
  assert.ok(body.self_state);
  assert.ok(Array.isArray(body.self_state.previous_tool_results));
  assert.ok(['COMPLETE', 'INCOMPLETE', 'BLOCKED'].includes(body.status));
  // Echo-only cannot invent a verified COMPLETE.
  if (body.status === 'COMPLETE') {
    assert.equal(body.verified, true);
    assert.ok(body.previous_tool_results.some((t) => t.tool === 'datetime' && t.ok));
  } else {
    assert.equal(body.verified, false);
  }
  assert.equal(typeof body.answer, 'string');
  assert.equal(looksLikeInternalDump(body.answer), false);
  assert.equal(/INTERNAL[_\s-]?STATE/i.test(body.answer), false);
  assert.equal(/Verified\s*=/i.test(body.answer), false);
});

test('claw execute SSE keeps internals off the assistant delta', async () => {
  const r = await fetch(`${BRAIN}/api/claw/execute`, {
    method: 'POST',
    headers: {
      'X-AION-Key': BRAIN_KEY,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      goal: 'Return the current UTC time using the datetime tool if you can; otherwise reply.',
      acceptance: [{ id: 'dt', description: 'datetime ran', tool: 'datetime' }],
      max_cycles: 2,
      stream: true,
    }),
  });
  assert.equal(r.status, 200);
  const raw = await r.text();
  const events = parseSseEvents(raw);
  assert.ok(events.some((e) => e.type === 'self_state'));
  assert.ok(events.some((e) => e.type === 'phase' || e.type === 'tool_start'));
  assert.ok(events.some((e) => e.type === 'delta'));
  const visible = assistantVisibleFromSse(raw);
  assert.equal(looksLikeInternalDump(visible), false);
  assert.equal(/INTERNAL[_\s-]?STATE/i.test(visible), false);
  assert.equal(/Verified\s*=/i.test(visible), false);
  const deltaEvents = events.filter((e) => e.type === 'delta');
  for (const ev of deltaEvents) {
    assert.equal(typeof ev.self_state, 'undefined');
    assert.equal(typeof ev.phase, 'undefined');
  }
});

test('chat actionable goals use execute path; consult-only stays consult', async () => {
  const headers = { 'X-AION-Key': BRAIN_KEY, 'Content-Type': 'application/json' };

  const consult = await fetch(`${BRAIN}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Reply with the word READY.' }],
      max_tokens: 64,
    }),
  });
  assert.equal(consult.status, 200);
  assert.equal(consult.headers.get('x-aion-path'), 'consult');
  const consultRaw = await consult.text();
  assert.match(consultRaw, /"type":"delta"/);
  assert.equal(looksLikeInternalDump(assistantVisibleFromSse(consultRaw)), false);

  const forcedConsult = await fetch(`${BRAIN}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Return the current UTC time using the datetime tool' }],
      consult: true,
      max_tokens: 64,
    }),
  });
  assert.equal(forcedConsult.status, 200);
  assert.equal(forcedConsult.headers.get('x-aion-path'), 'consult');

  const exec = await fetch(`${BRAIN}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Return the current UTC time using the datetime tool' }],
      acceptance: [{ id: 'dt', description: 'datetime ran', tool: 'datetime' }],
      max_cycles: 2,
    }),
  });
  assert.equal(exec.status, 200);
  assert.equal(exec.headers.get('x-aion-path'), 'execute');
  const execRaw = await exec.text();
  const events = parseSseEvents(execRaw);
  assert.ok(events.some((e) => e.type === 'decision'));
  assert.ok(events.some((e) => e.type === 'self_state'));
  assert.ok(events.some((e) => e.type === 'delta'));
  const visible = assistantVisibleFromSse(execRaw);
  assert.equal(looksLikeInternalDump(visible), false);
  assert.equal(/INTERNAL[_\s-]?STATE/i.test(visible), false);
  assert.equal(/Verified\s*=/i.test(visible), false);
});

test('BOS RAG HTTP retrieve returns Trinity chunks', async () => {
  const r = await fetch(`${BRAIN}/api/memory/bos?q=Trinity`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.ok(body.count >= 1);
  assert.match(body.chunks.map((c) => c.text).join('\n'), /Trinity/i);
});

test('BOS memory POST ingests if missing and upserts a document', async () => {
  const ingest = await fetch(`${BRAIN}/api/memory/bos`, {
    method: 'POST',
    headers: { 'X-AION-Key': BRAIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ingest: true,
      query: 'Trinity',
      source_id: 'http-upsert-token-source',
      title: 'http upsert',
      content: 'http-upsert-unique-token lives next to Canon Trinity GO HOLD ABORT.',
      authority: 'logs',
    }),
  });
  assert.equal(ingest.status, 200);
  const body = await ingest.json();
  assert.equal(body.ok, true);
  assert.ok(body.status.chunk_count >= 1);
  assert.ok(body.upserts.some((u) => u.source_id === 'http-upsert-token-source'));
  assert.ok(body.retrieve.count >= 1);

  const hit = await fetch(`${BRAIN}/api/memory/bos?q=http-upsert-unique-token`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(hit.status, 200);
  const found = await hit.json();
  assert.match(found.chunks.map((c) => c.text).join('\n'), /http-upsert-unique-token/);
});

test('POST /api/decision returns Trinity GO/HOLD/ABORT with structured reasons', async () => {
  const headers = { 'X-AION-Key': BRAIN_KEY, 'Content-Type': 'application/json' };

  const trinity = await fetch(`${BRAIN}/api/decision`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user_input: 'Explain Trinity Alpha Omega Praxis' }),
  });
  assert.equal(trinity.status, 200);
  const go = await trinity.json();
  assert.equal(go.ok, true);
  assert.equal(go.state, 'GO');
  assert.equal(go.trinity.state, 'GO');
  assert.equal(go.trinity.mapped_decision, 'COMMIT');
  assert.equal(go.decision.state, 'COMMIT');
  assert.equal(go.trinity.reasons.length, 3);
  assert.ok(go.retrieved.count >= 1);
  assert.ok(go.trinity.alpha.passed);
  assert.ok(go.trinity.praxis.passed);
  assert.ok(go.trinity.omega.passed);

  const abort = await fetch(`${BRAIN}/api/decision`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ goal: 'teach ghost nodes and metadata starvation' }),
  });
  assert.equal(abort.status, 200);
  const blocked = await abort.json();
  assert.equal(blocked.state, 'ABORT');
  assert.equal(blocked.trinity.reason, 'forbidden_attack_playbook');
  assert.equal(blocked.trinity.mapped_decision, 'REJECT');

  const plain = await fetch(`${BRAIN}/api/decision`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: 'Return the current UTC time' }),
  });
  assert.equal(plain.status, 200);
  const actionable = await plain.json();
  assert.equal(actionable.state, 'GO');
  assert.equal(actionable.trinity.reason, 'actionable');
  assert.equal(actionable.decision.checks.length, 7);
});

test('routines HTTP list/create/pause/resume/delete', async () => {
  const headers = { 'X-AION-Key': BRAIN_KEY, 'Content-Type': 'application/json' };
  const list = await fetch(`${BRAIN}/api/routines`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.ok(listed.routines.some((r) => r.name === 'trinity-gate'));

  const create = await fetch(`${BRAIN}/api/routines`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'http-routine-evidence',
      trigger: 'contract test',
      steps: [{ tool: 'datetime' }],
      success: 'datetime ran',
    }),
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.routine.status, 'active');

  const pause = await fetch(`${BRAIN}/api/routines/http-routine-evidence/pause`, { method: 'POST', headers });
  assert.equal(pause.status, 200);
  assert.equal((await pause.json()).routine.status, 'paused');

  const runPaused = await fetch(`${BRAIN}/api/routines/http-routine-evidence/run`, { method: 'POST', headers });
  assert.equal(runPaused.status, 400);
  assert.equal((await runPaused.json()).error, 'routine_paused');

  const resume = await fetch(`${BRAIN}/api/routines/http-routine-evidence/resume`, { method: 'POST', headers });
  assert.equal(resume.status, 200);
  assert.equal((await resume.json()).routine.status, 'active');

  const run = await fetch(`${BRAIN}/api/routines/http-routine-evidence/run`, { method: 'POST', headers });
  assert.equal(run.status, 200);
  const ran = await run.json();
  assert.equal(ran.ok, true);

  const del = await fetch(`${BRAIN}/api/routines/http-routine-evidence`, { method: 'DELETE', headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(del.status, 200);
  const gone = await fetch(`${BRAIN}/api/routines/http-routine-evidence`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(gone.status, 404);
});

test('connectors and MCP status HTTP never leak secret values', async () => {
  const r = await fetch(`${BRAIN}/api/connectors`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.connectors));
  assert.ok(body.connectors.some((c) => c.name === 'n8n_mcp' && Array.isArray(c.env_names)));
  const blob = JSON.stringify(body);
  for (const c of body.connectors) {
    assert.equal(typeof c.configured, 'boolean');
    assert.equal(Object.prototype.hasOwnProperty.call(c, 'value'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(c, 'token'), false);
  }
  assert.equal(/sk-|nvapi-|Bearer /i.test(blob), false);

  const mcp = await fetch(`${BRAIN}/api/mcp/status`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(mcp.status, 200);
  const status = await mcp.json();
  assert.ok(status.servers.some((s) => s.name === 'n8n' && s.kind === 'mcp'));
  assert.equal(JSON.stringify(status).includes(BRAIN_KEY), false);

  const contract = await fetch(`${BRAIN}/api/claw/contract`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  const c = await contract.json();
  assert.equal(c.contract.endpoints.decision.path, '/api/decision');
  assert.equal(c.contract.endpoints.routines.path, '/api/routines');
  assert.equal(c.contract.endpoints.connectors.path, '/api/connectors');
  assert.equal(c.contract.endpoints.mcp_status.path, '/api/mcp/status');
  assert.equal(c.contract.endpoints.memory_bos_ingest.path, '/api/memory/bos');
});

test('dynamic agent spawn/status/result/stop endpoints', async () => {
  const spawn = await fetch(`${BRAIN}/api/agents/spawn`, {
    method: 'POST',
    headers: { 'X-AION-Key': BRAIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: 'Return the current UTC time using datetime if you can',
      tools: ['datetime', 'echo'],
      acceptance: [{ id: 'dt', description: 'datetime ran', tool: 'datetime' }],
      max_cycles: 2,
    }),
  });
  assert.equal(spawn.status, 202);
  const spawned = await spawn.json();
  assert.equal(spawned.ok, true);
  assert.match(spawned.job.id, /^agt_/);
  assert.ok(['queued', 'running', 'complete', 'failed', 'stopped'].includes(spawned.job.status));

  const status = await fetch(`${BRAIN}/api/agents/${spawned.job.id}`, { headers: { 'X-AION-Key': BRAIN_KEY } });
  assert.equal(status.status, 200);
  const st = await status.json();
  assert.equal(st.job.id, spawned.job.id);

  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${BRAIN}/api/agents/${spawned.job.id}/result`, { headers: { 'X-AION-Key': BRAIN_KEY } });
    const body = await res.json();
    if (['complete', 'failed', 'stopped'].includes(body.job.status)) {
      assert.equal(body.ok, true);
      return;
    }
    await wait(50);
  }
  const stop = await fetch(`${BRAIN}/api/agents/${spawned.job.id}/stop`, {
    method: 'POST',
    headers: { 'X-AION-Key': BRAIN_KEY },
  });
  assert.ok(stop.status === 200);
});

test('cursor launch HTTP fails soft without CURSOR_API_KEY', async () => {
  const r = await fetch(`${BRAIN}/api/cursor/launch`, {
    method: 'POST',
    headers: { 'X-AION-Key': BRAIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Open a PR that implements login across the repo' }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'cursor_launch_unconfigured');
  assert.equal(body.env, 'CURSOR_API_KEY');
});
