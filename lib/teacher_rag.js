// lib/teacher_rag.js
// Bridge from the Node AION runtime into the bundled Python TeacherRAG.
// Executes the local CLI with an explicit PYTHONPATH; no shell interpolation.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;

export async function teacherRagTeach({ query, level = 'intermediate' } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query_required', tool: 'teacher_rag_teach' };
  if (!['beginner', 'intermediate', 'advanced'].includes(level)) {
    return { ok: false, error: 'invalid_level', tool: 'teacher_rag_teach' };
  }

  const root = process.cwd();
  const pythonPath = resolve(root, 'teacher_rag', 'src');
  const python = process.env.TEACHER_RAG_PYTHON || 'python3';
  const args = ['-m', 'teacher_rag.cli', 'ask', q.slice(0, 4000), '--level', level];

  try {
    const result = await runProcess(python, args, {
      cwd: root,
      timeoutMs: Number(process.env.TEACHER_RAG_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
      env: {
        ...process.env,
        PYTHONPATH: process.env.PYTHONPATH
          ? `${pythonPath}:${process.env.PYTHONPATH}`
          : pythonPath,
      },
    });
    if (result.code !== 0) {
      return {
        ok: false,
        error: `teacher_rag_exit_${result.code}`,
        detail: result.stderr.slice(0, 2000),
        tool: 'teacher_rag_teach',
      };
    }
    const parsed = JSON.parse(result.stdout);
    return { ok: true, evidence: parsed, tool: 'teacher_rag_teach' };
  } catch (error) {
    return {
      ok: false,
      error: `teacher_rag_failed:${error?.message || error}`,
      tool: 'teacher_rag_teach',
    };
  }
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
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timeout'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}
