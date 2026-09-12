// lib/workspace_exec.js
// Constrained computer/shell surface for Grok-like code tasks.
// argv only (no shell interpolation). Bin allowlist. Scrubbed env so
// provider keys are not inherited. Paths confined to a workspace root.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const ALLOWED_BINS = new Set(['node', 'python3', 'python']);
const SAFE_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP',
  'TERM', 'NO_COLOR', 'CI', 'NODE_PATH',
]);

export function workspaceRoot(explicit) {
  if (explicit) return resolve(explicit);
  return resolve(process.env.LLM_GATEWAY_DATA_DIR || './data', 'workspaces', `ws_${randomUUID().slice(0, 10)}`);
}

function confined(root, rel = '') {
  const base = resolve(root);
  const target = resolve(base, rel || '.');
  const relToBase = relative(base, target);
  if (relToBase.startsWith('..') || relToBase.includes(`..${sep}`)) {
    throw new Error('path_escapes_workspace');
  }
  return target;
}

function safeEnv() {
  const out = {};
  for (const name of SAFE_ENV) {
    if (process.env[name] != null) out[name] = process.env[name];
  }
  return out;
}

export function ensureWorkspace(root) {
  const dir = resolve(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function workspaceWrite({ root, path, content }) {
  const dir = ensureWorkspace(root);
  const target = confined(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, String(content ?? ''), 'utf8');
  return { ok: true, path: relative(dir, target), bytes: Buffer.byteLength(String(content ?? '')) };
}

export function workspaceRead({ root, path, maxBytes = 40_000 }) {
  const dir = ensureWorkspace(root);
  const target = confined(dir, path);
  const text = readFileSync(target, 'utf8');
  const limit = Math.max(1, Math.min(200_000, Number(maxBytes) || 40_000));
  return {
    ok: true,
    path: relative(dir, target),
    text: text.slice(0, limit),
    truncated: text.length > limit,
  };
}

export function workspaceList({ root }) {
  const dir = ensureWorkspace(root);
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else files.push(relative(dir, full));
    }
  };
  walk(dir);
  return { ok: true, root: dir, files: files.sort() };
}

export function workspaceRun({ root, argv, timeoutMs = 15_000 }) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string' && a.length)) {
    return { ok: false, error: 'argv_required' };
  }
  const bin = argv[0];
  if (!ALLOWED_BINS.has(bin)) {
    return { ok: false, error: `bin_not_allowed:${bin}`, allowed: [...ALLOWED_BINS] };
  }
  const dir = ensureWorkspace(root);
  const timeout = Math.max(500, Math.min(60_000, Number(timeoutMs) || 15_000));
  return new Promise((resolvePromise) => {
    const child = spawn(bin, argv.slice(1), {
      cwd: dir,
      env: safeEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: `spawn_failed:${error.message}`, argv });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0,
        argv,
        code,
        signal,
        stdout: stdout.slice(0, 20_000),
        stderr: stderr.slice(0, 8_000),
        timed_out: signal === 'SIGKILL',
      });
    });
  });
}

export async function workspaceExec(args = {}) {
  const action = String(args.action || '').trim();
  const root = args.root || workspaceRoot();
  try {
    if (action === 'write') return { ok: true, evidence: workspaceWrite({ root, path: args.path, content: args.content }), tool: 'workspace_exec' };
    if (action === 'read') return { ok: true, evidence: workspaceRead({ root, path: args.path, maxBytes: args.maxBytes }), tool: 'workspace_exec' };
    if (action === 'list') return { ok: true, evidence: workspaceList({ root }), tool: 'workspace_exec' };
    if (action === 'run') {
      const evidence = await workspaceRun({ root, argv: args.argv, timeoutMs: args.timeoutMs });
      return { ok: evidence.ok, evidence: { ...evidence, root }, tool: 'workspace_exec', error: evidence.ok ? undefined : evidence.error };
    }
    return { ok: false, error: 'action_must_be_write_read_list_run', tool: 'workspace_exec' };
  } catch (error) {
    return { ok: false, error: error.message, tool: 'workspace_exec' };
  }
}
