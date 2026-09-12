import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUTHORITY_ORDER,
  BosOmegaRag,
  bosOperatingRules,
  isBosTopic,
  resetBosRagForTests,
  seedBosFacts,
} from '../lib/bos_omega_rag.js';
import { AgentMemory } from '../lib/memory.js';
import { buildSystemPrompt, MissionContext, resolveDecision } from '../lib/aion_kernel.js';
import { ToolRegistry } from '../lib/brain_tools.js';

function tempRag() {
  const dir = mkdtempSync(join(tmpdir(), 'bos-omega-'));
  const rag = new BosOmegaRag({
    dbPath: join(dir, 'bos-omega.sqlite'),
    corpusDir: join(process.cwd(), 'knowledge', 'bos-omega'),
  });
  return { dir, rag };
}

test('BOS topic detector matches Trinity and Weldon, not unrelated chat', () => {
  assert.equal(isBosTopic('Explain the Trinity Alpha Omega Praxis gate'), true);
  assert.equal(isBosTopic('Who is Weldon Angelos and 924(c) stacking?'), true);
  assert.equal(isBosTopic('Return the current UTC time'), false);
});

test('local hash ingest + retrieve returns Trinity Canon and Weldon Continuity', () => {
  const { dir, rag } = tempRag();
  try {
    const ingest = rag.ensureIngested();
    assert.equal(ingest.chunk_count > 0, true, 'corpus must produce chunks');
    assert.equal(rag.status().chunk_count, ingest.chunk_count);

    const trinity = rag.retrieve('Trinity');
    assert.equal(trinity.ok, true);
    assert.ok(trinity.chunks.length >= 1, 'Trinity must return at least one chunk');
    const trinityText = trinity.chunks.map((c) => c.text).join('\n');
    assert.match(trinityText, /Trinity/i);
    assert.match(trinityText, /Alpha|Omega|Praxis/i);
    assert.ok(
      trinity.chunks.some((c) => c.authority === 'canon' || /canon/i.test(c.source_id)),
      'Trinity should hit Canon',
    );

    const weldon = rag.retrieve('Weldon Angelos');
    assert.equal(weldon.ok, true);
    assert.ok(weldon.chunks.length >= 1, 'Weldon Angelos must return at least one chunk');
    const weldonText = weldon.chunks.map((c) => c.text).join('\n');
    assert.match(weldonText, /Weldon Angelos/);
    assert.match(weldonText, /924|Weldon Project|pardon|commute/i);
    assert.ok(
      weldon.chunks.some((c) => c.authority === 'continuity' || /continuity/i.test(c.source_id)),
      'Weldon should hit Continuity',
    );
  } finally {
    rag.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PCOS patch retrieve returns ANS states', () => {
  const { dir, rag } = tempRag();
  try {
    rag.ensureIngested();
    const hit = rag.retrieve('PCOS Functional Sympathetic Hyper Sympathetic Freeze');
    assert.ok(hit.chunks.length >= 1);
    const text = hit.chunks.map((c) => c.text).join('\n');
    assert.match(text, /Parasympathetic|Functional Sympathetic|Freeze/);
  } finally {
    rag.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('system prompt includes BOS operating rules and retrieved memory', () => {
  const ctx = new MissionContext({ userInput: 'What is Trinity?' });
  const decision = resolveDecision(ctx);
  const prompt = buildSystemPrompt(decision, {
    notesContext: '<operator_notes>prior</operator_notes>',
    bosContext: '<bos_omega_memory>Canon Trinity Alpha</bos_omega_memory>',
    lattice: { consensus: 'COMMIT', rationale: 'test', votes: { researcher: 'COMMIT' } },
  });
  assert.match(prompt, /BOS-OMEGA/);
  assert.match(prompt, /Canon > Patch > Continuity/);
  assert.match(prompt, /bos_omega_memory/);
  assert.match(prompt, /Lattice consensus: COMMIT/);
  assert.match(bosOperatingRules(), /GO \(execute\), HOLD \(need evidence\), ABORT/);
  assert.deepEqual(AUTHORITY_ORDER[0], 'Canon');
});

test('brain tool catalog and runner expose bos_omega_retrieve with live chunks', async () => {
  const { dir, rag } = tempRag();
  rag.ensureIngested();
  rag.close();
  resetBosRagForTests();
  const prev = process.env.LLM_GATEWAY_DATA_DIR;
  process.env.LLM_GATEWAY_DATA_DIR = dir;
  try {
    const tools = new ToolRegistry();
    const names = tools.catalog().map((t) => t.name);
    assert.ok(names.includes('bos_omega_retrieve'));
    assert.ok(names.includes('teacher_rag_teach'));
    const result = await tools.run('bos_omega_retrieve', { query: 'Trinity' });
    assert.equal(result.ok, true);
    assert.ok(result.evidence.count >= 1);
    assert.match(result.evidence.chunks.map((c) => c.text).join('\n'), /Trinity/i);
  } finally {
    if (prev === undefined) delete process.env.LLM_GATEWAY_DATA_DIR;
    else process.env.LLM_GATEWAY_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgentMemory seed writes Weldon and Trinity facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bos-mem-'));
  const memory = new AgentMemory(join(dir, 'memory.db'));
  try {
    const n = seedBosFacts(memory);
    assert.ok(n >= 8);
    const facts = memory.factsFor('bos-omega', 20).concat(memory.factsFor('weldon-angelos', 20));
    const blob = facts.map((f) => `${f.predicate} ${f.object}`).join('\n');
    assert.match(blob, /Trinity/);
    assert.match(blob, /Weldon|924/);
    assert.match(blob, /Canon > Patch > Continuity/);
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
