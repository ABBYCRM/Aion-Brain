import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { AgentOrchestrator, JOB_STATUS, emitInngestEvent, allowlistTools } from '../lib/agent_jobs.js';
import { workspaceExec } from '../lib/workspace_exec.js';
import { RoutineStore } from '../lib/routines.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'agt-jobs-'));
}

async function waitFor(fn, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) return value;
    await wait(intervalMs);
  }
  throw new Error('timeout waiting for condition');
}

test('dynamic spawn persists across orchestrator restart', async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'jobs.sqlite');
  const seen = [];
  const first = new AgentOrchestrator({
    dbPath,
    pollMs: 15,
    runJob: async (job) => {
      seen.push(job.goal);
      return { status: 'COMPLETE', complete: true, verified: true, reason: 'injected' };
    },
  });
  try {
    const job = first.spawn({ goal: 'On-the-spot worker: datetime probe', tools: ['datetime'] });
    assert.match(job.id, /^agt_/);
    assert.equal(job.status, JOB_STATUS.QUEUED);
    first.start();
    await waitFor(() => first.publicJob(job.id).status === JOB_STATUS.COMPLETE);
    first.close();

    const reopened = new AgentOrchestrator({ dbPath, runJob: async () => ({ status: 'COMPLETE' }) });
    try {
      const persisted = reopened.result(job.id);
      assert.equal(persisted.status, JOB_STATUS.COMPLETE);
      assert.equal(persisted.result.reason, 'injected');
      assert.deepEqual(seen, ['On-the-spot worker: datetime probe']);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parallel independent workers + steer + stop + cleanup + callback', async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'jobs.sqlite');
  const callbacks = [];
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const orch = new AgentOrchestrator({
    dbPath,
    pollMs: 15,
    concurrency: 3,
    fetchImpl: async (url, init) => {
      callbacks.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
    runJob: async (job, hooks) => {
      if (job.goal === 'slow') {
        await slowGate;
        if (hooks.shouldStop()) return { status: 'BLOCKED', reason: 'stopped_by_operator' };
      }
      let steers = hooks.pullSteers();
      if (job.goal === 'fast-a') {
        for (let i = 0; i < 80 && !steers.length; i += 1) {
          await wait(10);
          steers = hooks.pullSteers();
        }
      }
      return { status: 'COMPLETE', complete: true, verified: true, steers, goal: job.goal };
    },
  });
  try {
    orch.start();
    const a = orch.spawn({ goal: 'fast-a', callback_url: 'https://example.test/hook' });
    const b = orch.spawn({ goal: 'fast-b' });
    const slow = orch.spawn({ goal: 'slow' });
    orch.steer(a.id, 'do it methodically');
    await waitFor(() => orch.publicJob(a.id).status === JOB_STATUS.COMPLETE
      && orch.publicJob(b.id).status === JOB_STATUS.COMPLETE);
    assert.equal(orch.publicJob(slow.id).status, JOB_STATUS.RUNNING);
    orch.stop(slow.id);
    releaseSlow();
    await waitFor(() => orch.publicJob(slow.id).status === JOB_STATUS.STOPPED);
    const resultA = orch.result(a.id);
    assert.equal(resultA.result.steers[0].message, 'do it methodically');
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0].body.job_id, a.id);
    const cleaned = orch.cleanup(a.id);
    assert.equal(cleaned.status, JOB_STATUS.CLEANED);
    assert.equal(orch.result(a.id).result, null);
    const listed = orch.list({ status: JOB_STATUS.COMPLETE });
    assert.ok(listed.some((j) => j.id === b.id));
  } finally {
    orch.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queued job can be stopped before a worker claims it', () => {
  const dir = tempDir();
  const orch = new AgentOrchestrator({
    dbPath: join(dir, 'jobs.sqlite'),
    runJob: async () => { throw new Error('should_not_run'); },
  });
  try {
    const job = orch.spawn({ goal: 'never-run' });
    const stopped = orch.stop(job.id);
    assert.equal(stopped.status, JOB_STATUS.STOPPED);
  } finally {
    orch.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn refuses empty goal and depth overflow; templates are optional', () => {
  const dir = tempDir();
  const orch = new AgentOrchestrator({ dbPath: join(dir, 'jobs.sqlite'), maxDepth: 1 });
  try {
    assert.throws(() => orch.spawn({ goal: '' }), /goal_required/);
    assert.throws(() => orch.spawn({ goal: 'x', depth: 1 }), /spawn_depth_exceeded/);
    const job = orch.spawn({ goal: 'fresh goal only' });
    assert.equal(job.status, JOB_STATUS.QUEUED);
    assert.equal(job.tools, null);
  } finally {
    orch.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allowlistTools blocks names outside the allowlist', async () => {
  const base = {
    catalog: () => [{ name: 'echo' }, { name: 'resend_send' }],
    has: (n) => n === 'echo' || n === 'resend_send',
    run: async (n, args) => ({ ok: true, tool: n, evidence: args }),
  };
  const filtered = allowlistTools(base, ['echo']);
  assert.deepEqual(filtered.catalog().map((t) => t.name), ['echo']);
  const denied = await filtered.run('resend_send', {});
  assert.equal(denied.ok, false);
  assert.match(denied.error, /tool_not_allowed/);
});

test('Inngest emit is skipped without a key and posts when configured', async () => {
  const prevKey = process.env.INNGEST_EVENT_KEY;
  const prevUrl = process.env.INNGEST_EVENT_URL;
  delete process.env.INNGEST_EVENT_KEY;
  const skipped = await emitInngestEvent('aion/agent.spawned', { job_id: 'x' });
  assert.equal(skipped.skipped, true);
  process.env.INNGEST_EVENT_KEY = 'test-event-key';
  process.env.INNGEST_EVENT_URL = 'https://inn.example/e';
  let posted = null;
  const sent = await emitInngestEvent('aion/agent.spawned', { job_id: 'x' }, {
    fetchImpl: async (url, init) => {
      posted = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200 };
    },
  });
  assert.equal(sent.ok, true);
  assert.match(posted.url, /inn\.example\/e\/test-event-key$/);
  assert.equal(posted.body.name, 'aion/agent.spawned');
  if (prevKey === undefined) delete process.env.INNGEST_EVENT_KEY;
  else process.env.INNGEST_EVENT_KEY = prevKey;
  if (prevUrl === undefined) delete process.env.INNGEST_EVENT_URL;
  else process.env.INNGEST_EVENT_URL = prevUrl;
});

test('workspace_exec writes and runs node without a shell', async () => {
  const dir = tempDir();
  const write = await workspaceExec({ action: 'write', root: dir, path: 'hi.js', content: 'console.log("ok")' });
  assert.equal(write.ok, true);
  const run = await workspaceExec({ action: 'run', root: dir, argv: ['node', 'hi.js'] });
  assert.equal(run.ok, true);
  assert.match(run.evidence.stdout, /ok/);
  const blocked = await workspaceExec({ action: 'run', root: dir, argv: ['bash', '-c', 'echo no'] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /bin_not_allowed/);
  rmSync(dir, { recursive: true, force: true });
});

test('routines seed retrieve-before-answer without being required for spawn', () => {
  const dir = tempDir();
  const store = new RoutineStore(join(dir, 'routines.sqlite'));
  try {
    const names = store.list().map((r) => r.name);
    assert.ok(names.includes('retrieve-before-answer'));
    assert.ok(names.includes('trinity-gate'));
    assert.ok(names.includes('cursor-repo-work'));
    assert.ok(store.get('evidence-loop'));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
