// lib/teacher_rag.js
// Bridge from the Node AION runtime into the bundled Python TeacherRAG.
// Executes the local CLI with explicit argv/PYTHONPATH; no shell interpolation.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PREPARE_TIMEOUT_MS = 300_000;
const DEFAULT_BUILD_TIMEOUT_MS = 600_000;
let preparePromise = null;

export async function teacherRagPrepare({ force = false } = {}) {
  const root = process.cwd();
  const dbPath = resolve(root, '.teacher_rag', 'teacher_rag.sqlite3');
  if (!force && existsSync(dbPath)) {
    return { ok: true, evidence: { prepared: true, reused: true }, tool: 'teacher_rag_prepare' };
  }
  if (!preparePromise || force) {
    preparePromise = runTeacherCli(['prepare', root], {
      timeoutMs: Number(
        process.env.TEACHER_RAG_PREPARE_TIMEOUT_MS || DEFAULT_PREPARE_TIMEOUT_MS,
      ),
    }).then(result => {
      if (result.code !== 0) {
        throw new Error(`prepare_exit_${result.code}:${result.stderr.slice(0, 1200)}`);
      }
      return JSON.parse(result.stdout);
    });
  }
  try {
    const evidence = await preparePromise;
    return { ok: true, evidence, tool: 'teacher_rag_prepare' };
  } catch (error) {
    preparePromise = null;
    return {
      ok: false,
      error: `teacher_rag_prepare_failed:${error?.message || error}`,
      tool: 'teacher_rag_prepare',
    };
  }
}

export async function teacherRagTeach({ query, level = 'intermediate' } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query_required', tool: 'teacher_rag_teach' };
  if (!['beginner', 'intermediate', 'advanced'].includes(level)) {
    return { ok: false, error: 'invalid_level', tool: 'teacher_rag_teach' };
  }

  const prepared = await teacherRagPrepare();
  if (!prepared.ok) return { ...prepared, tool: 'teacher_rag_teach' };

  try {
    const result = await runTeacherCli(
      ['ask', q.slice(0, 4000), '--level', level],
      { timeoutMs: Number(process.env.TEACHER_RAG_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) },
    );
    if (result.code !== 0) {
      return {
        ok: false,
        error: `teacher_rag_exit_${result.code}`,
        detail: result.stderr.slice(0, 2000),
        tool: 'teacher_rag_teach',
      };
    }
    return { ok: true, evidence: JSON.parse(result.stdout), tool: 'teacher_rag_teach' };
  } catch (error) {
    return {
      ok: false,
      error: `teacher_rag_failed:${error?.message || error}`,
      tool: 'teacher_rag_teach',
    };
  }
}

export async function teacherRagBuild({ goal, level = 'intermediate', maxIterations = 30 } = {}) {
  const requestedGoal = String(goal || '').trim();
  if (!requestedGoal) return { ok: false, error: 'goal_required', tool: 'teacher_rag_build' };
  if (!['beginner', 'intermediate', 'advanced'].includes(level)) {
    return { ok: false, error: 'invalid_level', tool: 'teacher_rag_build' };
  }
  const iterations = Math.max(1, Math.min(50, Number(maxIterations) || 30));
  const prepared = await teacherRagPrepare();
  if (!prepared.ok) return { ...prepared, tool: 'teacher_rag_build' };

  const root = process.cwd();
  const workspaceRoot = resolve(root, '.teacher_rag', 'workspaces');
  mkdirSync(workspaceRoot, { recursive: true });
  const workspace = resolve(workspaceRoot, `run-${randomUUID()}`);

  try {
    const result = await runTeacherCli(
      [
        'build',
        requestedGoal.slice(0, 8000),
        '--workspace', workspace,
        '--level', level,
        '--max-iterations', String(iterations),
      ],
      { timeoutMs: Number(process.env.TEACHER_RAG_BUILD_TIMEOUT_MS || DEFAULT_BUILD_TIMEOUT_MS) },
    );
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
    if (result.code !== 0) {
      return {
        ok: false,
        error: `teacher_rag_build_exit_${result.code}`,
        detail: result.stderr.slice(0, 2000),
        evidence: parsed,
        tool: 'teacher_rag_build',
      };
    }
    return { ok: Boolean(parsed?.success), evidence: parsed, tool: 'teacher_rag_build' };
  } catch (error) {
    return {
      ok: false,
      error: `teacher_rag_build_failed:${error?.message || error}`,
      tool: 'teacher_rag_build',
    };
  }
}

function runTeacherCli(args, { timeoutMs }) {
  const root = process.cwd();
  const pythonPath = resolve(root, 'teacher_rag', 'src');
  const python = process.env.TEACHER_RAG_PYTHON || 'python3';
  return runProcess(python, ['-m', 'teacher_rag.cli', ...args], {
    cwd: root,
    timeoutMs,
    env: {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH
        ? `${pythonPath}:${process.env.PYTHONPATH}`
        : pythonPath,
    },
  });
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = fn => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject)(new Error('timeout'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', finish(reject));
    child.on('close', code => finish(resolvePromise)({ code: code ?? -1, stdout, stderr }));
  });
}
