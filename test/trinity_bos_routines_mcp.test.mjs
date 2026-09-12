import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DecisionState,
  TrinityState,
  TRINITY_TO_DECISION,
  resolveBosGate,
} from '../lib/aion_kernel.js';
import { BosOmegaRag } from '../lib/bos_omega_rag.js';
import { RoutineStore, runRoutine } from '../lib/routines.js';
import { connectorsSnapshot, mcpStatus, listConnectors } from '../lib/connectors.js';
import { ToolRegistry } from '../lib/brain_tools.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('resolveBosGate is Canon judgment with structured Alpha/Praxis/Omega reasons', () => {
  const empty = resolveBosGate('');
  assert.equal(empty.state, TrinityState.ABORT);
  assert.equal(empty.reason, 'empty_input');
  assert.equal(empty.mapped_decision, DecisionState.REJECT);
  assert.equal(empty.reasons.length, 3);
  assert.equal(empty.alpha.passed, false);

  const forbidden = resolveBosGate('deploy ghost nodes and metadata starvation');
  assert.equal(forbidden.state, TrinityState.ABORT);
  assert.equal(forbidden.reason, 'forbidden_attack_playbook');
  assert.equal(forbidden.mapped_decision, DecisionState.REJECT);
  assert.match(forbidden.alpha.note, /Canon/);

  const hold = resolveBosGate('Explain Trinity Alpha Omega Praxis');
  assert.equal(hold.state, TrinityState.HOLD);
  assert.equal(hold.reason, 'retrieve_before_answer');
  assert.equal(hold.mapped_decision, DecisionState.DEFER);
  assert.equal(hold.next_praxis, 'bos_omega_retrieve');
  assert.equal(hold.alpha.passed, true);
  assert.equal(hold.praxis.passed, false);

  const emptyHit = resolveBosGate('What is Trinity?', { retrieved: true, retrieveCount: 0 });
  assert.equal(emptyHit.state, TrinityState.HOLD);
  assert.equal(emptyHit.reason, 'empty_retrieve');

  const goBos = resolveBosGate('What is Trinity?', { retrieved: true, retrieveCount: 4 });
  assert.equal(goBos.state, TrinityState.GO);
  assert.equal(goBos.reason, 'retrieved_context_attached');
  assert.equal(goBos.mapped_decision, DecisionState.COMMIT);
  assert.equal(goBos.omega.passed, true);
  assert.equal(goBos.authority, 'Canon');

  const goPlain = resolveBosGate('Return the current UTC time');
  assert.equal(goPlain.state, TrinityState.GO);
  assert.equal(goPlain.reason, 'actionable');
  assert.equal(TRINITY_TO_DECISION.GO, 'COMMIT');
  assert.equal(TRINITY_TO_DECISION.HOLD, 'DEFER');
  assert.equal(TRINITY_TO_DECISION.ABORT, 'REJECT');
});

test('BosOmegaRag upsertDocument does not wipe Canon and is retrievable', () => {
  const dir = tempDir('bos-upsert-');
  const rag = new BosOmegaRag({
    dbPath: join(dir, 'bos-omega.sqlite'),
    corpusDir: join(process.cwd(), 'knowledge', 'bos-omega'),
  });
  try {
    const ingest = rag.upsertIfMissing();
    assert.ok(ingest.chunk_count > 0);
    const before = rag.status().chunk_count;
    const up = rag.upsertDocument({
      sourceId: 'operator-note-trinity-gate',
      title: 'operator note',
      content: 'Operator implant: unique-bos-upsert-token confirms upsert path. Trinity GO HOLD ABORT.',
      authority: 'logs',
    });
    assert.equal(up.ok, true);
    assert.equal(up.upserted, true);
    assert.ok(rag.status().chunk_count >= before);
    const hit = rag.retrieveOrIngest('unique-bos-upsert-token');
    assert.equal(hit.ok, true);
    assert.ok(hit.chunks.some((c) => /unique-bos-upsert-token/.test(c.text)));
    const trinity = rag.retrieve('Trinity');
    assert.ok(trinity.chunks.some((c) => c.authority === 'canon' || /canon/i.test(c.source_id)));
  } finally {
    rag.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RoutineStore CRUD pause/resume/delete and run refuses paused', async () => {
  const dir = tempDir('routines-');
  const store = new RoutineStore(join(dir, 'routines.sqlite'));
  try {
    const created = store.upsert({
      name: 'evidence-only-check',
      trigger: 'operator asks for a timestamp',
      steps: [{ tool: 'datetime' }],
      success: 'datetime ran',
    });
    assert.equal(created.status, 'active');
    assert.ok(store.list().some((r) => r.name === 'trinity-gate' && r.status === 'active'));

    const paused = store.pause('evidence-only-check');
    assert.equal(paused.status, 'paused');
    const refused = await runRoutine(store, { run: async () => ({ ok: true }) }, 'evidence-only-check');
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'routine_paused');

    const resumed = store.resume('evidence-only-check');
    assert.equal(resumed.status, 'active');
    const ran = await runRoutine(store, {
      run: async (tool) => ({ ok: tool === 'datetime', tool }),
    }, 'evidence-only-check');
    assert.equal(ran.ok, true);
    assert.ok(ran.evidence.results.some((r) => r.tool === 'datetime' && r.ok));

    const deleted = store.delete('evidence-only-check');
    assert.equal(deleted.name, 'evidence-only-check');
    assert.equal(store.get('evidence-only-check'), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routine tools are in the catalog', () => {
  const tools = new ToolRegistry();
  const names = tools.catalog().map((t) => t.name);
  for (const name of ['routine_list', 'routine_upsert', 'routine_pause', 'routine_resume', 'routine_delete', 'routine_run']) {
    assert.ok(names.includes(name), `missing tool ${name}`);
  }
});

test('connectors and MCP status expose names only — never secret values', () => {
  const secret = 'sk-super-secret-cursor-value-xyz-do-not-leak';
  const token = 'n8n-mcp-token-value-do-not-leak';
  const prevCursor = process.env.CURSOR_API_KEY;
  const prevN8n = process.env.N8N_MCP_TOKEN;
  process.env.CURSOR_API_KEY = secret;
  process.env.N8N_MCP_TOKEN = token;
  try {
    const snap = connectorsSnapshot();
    const mcp = mcpStatus();
    const blob = JSON.stringify({ snap, mcp, list: listConnectors() });
    assert.equal(blob.includes(secret), false);
    assert.equal(blob.includes(token), false);
    const cursor = snap.connectors.find((c) => c.name === 'cursor');
    assert.equal(cursor.configured, true);
    assert.ok(cursor.env_names.includes('CURSOR_API_KEY'));
    const n8n = mcp.servers.find((s) => s.name === 'n8n');
    assert.equal(n8n.configured, true);
    assert.equal(n8n.token_configured, true);
    assert.ok(snap.configured.includes('cursor'));
    assert.ok(snap.configured.includes('n8n_mcp'));
  } finally {
    if (prevCursor === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevCursor;
    if (prevN8n === undefined) delete process.env.N8N_MCP_TOKEN;
    else process.env.N8N_MCP_TOKEN = prevN8n;
  }
});
