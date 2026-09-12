// lib/cursor_cloud.js
// Cursor Cloud Agents v1 client. Aion-Brain owns this path.
// VIDEO-Engine-CCFL calls Brain tools / /api/cursor/* — no second stub.
//
// Auth: CURSOR_API_KEY (Bearer). Same env name as the DigitalOcean CCFL
// secret. Values are never logged. Missing key fails soft.

import { bosOperatingRules } from './bos_omega_rag.js';
import { envSecret } from './external_tools.js';

const DEFAULT_BASE = 'https://api.cursor.com';
const DEFAULT_TIMEOUT_MS = 20_000;

export function cursorApiBase() {
  const raw = envSecret('CURSOR_API_BASE_URL') || DEFAULT_BASE;
  return raw.replace(/\/+$/, '');
}

export function cursorConfigured() {
  return Boolean(envSecret('CURSOR_API_KEY'));
}

export function cursorPublicStatus() {
  return {
    configured: cursorConfigured(),
    base_url: cursorApiBase(),
    env: 'CURSOR_API_KEY',
    owner: 'aion-brain',
    launch: '/api/cursor/launch',
    status: '/api/cursor/:id',
    result: '/api/cursor/:id/result',
    reply: '/api/cursor/:id/reply',
    cancel: '/api/cursor/:id/cancel',
  };
}

export function isNonTrivialRepoWork(goal) {
  const g = String(goal || '');
  if (!g.trim()) return false;
  if (/\b(cursor cloud|cloud agent|open a pr|pull request|multi-?file|refactor the|across (the )?repo|repository work)\b/i.test(g)) {
    return true;
  }
  if (/\b(github\.com\/|create a pr|ship (this|the) (change|fix|feature))\b/i.test(g)) return true;
  if (/\b(implement|fix|refactor|add|update|land)\b/i.test(g) && /\b(codebase|monorepo|multiple files|several files|the repo|repository)\b/i.test(g)) {
    return true;
  }
  return false;
}

export function extractRepoUrl(text) {
  const m = String(text || '').match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
  return m ? m[0].replace(/\.git$/, '') : '';
}

export function composeCursorPrompt(goal, { today } = {}) {
  const day = today || new Date().toISOString().slice(0, 10);
  return [
    bosOperatingRules(),
    'Cursor cloud agent rules:',
    '- You are spawned dynamically for this goal. You are not a prefabricated named role.',
    `- Open work on a methodical-notes/${day}-<slug> branch unless the operator named a branch.`,
    '- Evidence loop: retrieve before answer, change, test, self-fix. Trinity GO/HOLD/ABORT. Confidence is not proof.',
    '- Do not implant attack playbooks.',
    '',
    'Operator goal:',
    String(goal || '').trim(),
  ].join('\n');
}

function unconfigured(tool) {
  return { ok: false, error: `${tool}_unconfigured`, env: 'CURSOR_API_KEY', tool };
}

function sanitizeId(raw) {
  const id = String(raw || '').trim();
  if (!id || id.length > 128 || /[/?#]/.test(id)) return '';
  return id;
}

function redact(value, key) {
  if (value == null) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!key) return typeof value === 'string' ? text.slice(0, 400) : value;
  return text.split(key).join('[redacted]').slice(0, 400);
}

function authHeaders(key) {
  return {
    authorization: `Bearer ${key}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

async function cursorHttp(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
  const key = envSecret('CURSOR_API_KEY');
  if (!key) return { ok: false, unconfigured: true };
  const fetchFn = fetchImpl || globalThis.fetch;
  const url = `${cursorApiBase()}${path}`;
  try {
    const res = await fetchFn(url, {
      method,
      headers: authHeaders(key),
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => '');
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { ok: res.ok, status: res.status, json, text: redact(text, key), key };
  } catch (error) {
    return { ok: false, status: 0, error: redact(error?.message || error, key), key };
  }
}

function failHttp(tool, call) {
  if (call.unconfigured) return unconfigured(tool);
  if (call.error && !call.status) {
    return { ok: false, error: `cursor_failed:${call.error}`, tool };
  }
  const detail = call.json && (call.json.message || call.json.error || call.json.code);
  return {
    ok: false,
    error: `cursor_http_${call.status || 'unknown'}`,
    detail: redact(detail || call.text || '', call.key),
    tool,
  };
}

function publicAgent(agent) {
  if (!agent || typeof agent !== 'object') return null;
  return {
    id: agent.id || null,
    name: agent.name || null,
    status: agent.status || null,
    url: agent.url || (agent.id ? `https://cursor.com/agents/${agent.id}` : null),
    latestRunId: agent.latestRunId || agent.latest_run_id || null,
    repos: Array.isArray(agent.repos) ? agent.repos : undefined,
    createdAt: agent.createdAt || null,
    updatedAt: agent.updatedAt || null,
  };
}

function publicRun(run) {
  if (!run || typeof run !== 'object') return null;
  return {
    id: run.id || null,
    agentId: run.agentId || run.agent_id || null,
    status: run.status || null,
    result: typeof run.result === 'string' ? run.result.slice(0, 4000) : run.result ?? null,
    durationMs: run.durationMs ?? run.duration_ms ?? null,
    git: run.git || null,
    createdAt: run.createdAt || null,
    updatedAt: run.updatedAt || null,
  };
}

function buildRepos(args, promptText) {
  if (Array.isArray(args.repos) && args.repos.length) {
    return args.repos.map((r) => ({
      url: String(r.url || r.repository || '').trim(),
      startingRef: r.startingRef || r.branch || undefined,
      prUrl: r.prUrl || undefined,
    })).filter((r) => r.url);
  }
  const url = String(args.repository || args.repo || args.url || extractRepoUrl(promptText) || envSecret('CURSOR_DEFAULT_REPO') || '').trim();
  if (!url) return undefined;
  const startingRef = args.startingRef || args.branch || undefined;
  return [{ url, startingRef, prUrl: args.prUrl || undefined }];
}

export async function cursorLaunch(args = {}, { fetchImpl } = {}) {
  const tool = 'cursor_launch';
  if (!cursorConfigured()) return unconfigured(tool);
  const goal = String(args.prompt || args.goal || args.text || '').trim();
  if (!goal) return { ok: false, error: 'prompt_required', tool };
  const promptText = composeCursorPrompt(goal, { today: args.today });
  const body = {
    prompt: { text: promptText },
    name: args.name ? String(args.name).slice(0, 100) : undefined,
    repos: buildRepos(args, goal),
    autoCreatePR: args.autoCreatePR === true || args.auto_create_pr === true ? true : undefined,
    workOnCurrentBranch: args.workOnCurrentBranch === true || args.work_on_current_branch === true ? true : undefined,
    mode: args.mode === 'plan' ? 'plan' : undefined,
  };
  if (args.model) {
    body.model = typeof args.model === 'string' ? { id: args.model } : args.model;
  }
  const call = await cursorHttp('/v1/agents', { method: 'POST', body, fetchImpl });
  if (call.unconfigured || !call.ok) return failHttp(tool, call);
  const agent = publicAgent(call.json?.agent || call.json);
  const run = publicRun(call.json?.run);
  if (!agent?.id) return { ok: false, error: 'cursor_launch_malformed', tool };
  return { ok: true, evidence: { agent, run }, tool };
}

export async function cursorStatus(args = {}, { fetchImpl } = {}) {
  const tool = 'cursor_status';
  if (!cursorConfigured()) return unconfigured(tool);
  const id = sanitizeId(args.id || args.agentId || args.agent_id);
  if (!id) return { ok: false, error: 'id_required', tool };
  const call = await cursorHttp(`/v1/agents/${encodeURIComponent(id)}`, { fetchImpl });
  if (call.unconfigured || !call.ok) return failHttp(tool, call);
  const agent = publicAgent(call.json);
  let run = null;
  const runId = sanitizeId(args.runId || args.run_id || agent?.latestRunId);
  if (runId) {
    const runCall = await cursorHttp(`/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`, { fetchImpl });
    if (runCall.ok) run = publicRun(runCall.json);
  }
  return { ok: true, evidence: { agent, run }, tool };
}

export async function cursorReply(args = {}, { fetchImpl } = {}) {
  const tool = 'cursor_reply';
  if (!cursorConfigured()) return unconfigured(tool);
  const id = sanitizeId(args.id || args.agentId || args.agent_id);
  const text = String(args.prompt || args.message || args.text || '').trim();
  if (!id) return { ok: false, error: 'id_required', tool };
  if (!text) return { ok: false, error: 'prompt_required', tool };
  const body = { prompt: { text: text.slice(0, 16_000) } };
  if (args.mode === 'plan' || args.mode === 'agent') body.mode = args.mode;
  const call = await cursorHttp(`/v1/agents/${encodeURIComponent(id)}/runs`, { method: 'POST', body, fetchImpl });
  if (call.unconfigured || !call.ok) return failHttp(tool, call);
  return { ok: true, evidence: { agent: { id }, run: publicRun(call.json?.run || call.json) }, tool };
}

export async function cursorCancel(args = {}, { fetchImpl } = {}) {
  const tool = 'cursor_cancel';
  if (!cursorConfigured()) return unconfigured(tool);
  const id = sanitizeId(args.id || args.agentId || args.agent_id);
  if (!id) return { ok: false, error: 'id_required', tool };
  let runId = sanitizeId(args.runId || args.run_id);
  if (!runId) {
    const status = await cursorStatus({ id }, { fetchImpl });
    runId = sanitizeId(status.evidence?.agent?.latestRunId || status.evidence?.run?.id);
    if (!runId) return { ok: false, error: 'run_id_required', tool };
  }
  const call = await cursorHttp(
    `/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST', fetchImpl },
  );
  if (call.unconfigured || !call.ok) return failHttp(tool, call);
  return { ok: true, evidence: { agent: { id }, run: publicRun(call.json?.run || { id: runId, agentId: id, status: call.json?.status || 'CANCELLED' }) }, tool };
}

export async function cursorList(args = {}, { fetchImpl } = {}) {
  const tool = 'cursor_list';
  if (!cursorConfigured()) return unconfigured(tool);
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
  const qs = new URLSearchParams({ limit: String(limit) });
  if (args.cursor) qs.set('cursor', String(args.cursor));
  const call = await cursorHttp(`/v1/agents?${qs}`, { fetchImpl });
  if (call.unconfigured || !call.ok) return failHttp(tool, call);
  const items = Array.isArray(call.json?.items) ? call.json.items.map(publicAgent).filter(Boolean) : [];
  return { ok: true, evidence: { count: items.length, items, nextCursor: call.json?.nextCursor || null }, tool };
}

export function lastCursorAgentId(results) {
  const rows = Array.isArray(results) ? results : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || !row.ok) continue;
    if (row.tool !== 'cursor_launch' && row.tool !== 'cursor_reply' && row.tool !== 'cursor_status') continue;
    const id = row.evidence?.agent?.id || row.evidence?.id;
    if (id) return String(id);
  }
  return '';
}
