import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.log('SKIP: OPENAI_API_KEY is not set');
  process.exitCode = 0;
} else {
  const PORT = 11_999 + Math.floor(Math.random() * 1_000);
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA_DIR = join(process.cwd(), `data-real-${Date.now()}`);
  const REPORTS_DIR = join(DATA_DIR, 'reports');
  const GATEWAY_KEY = 'real-smoke-gateway-key';
  const ADMIN_TOKEN = 'real-smoke-admin-token';
  await mkdir(REPORTS_DIR, { recursive: true });

  const server = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      LLM_GATEWAY_DATA_DIR: DATA_DIR,
      LLM_GATEWAY_REPORTS_DIR: REPORTS_DIR,
      LLM_GATEWAY_API_KEYS: GATEWAY_KEY,
      LLM_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
      LLM_GATEWAY_ALLOW_ECHO: 'false',
      A2E_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', chunk => { serverLog += chunk.toString(); });
  server.stderr.on('data', chunk => { serverLog += chunk.toString(); });

  let failed = false;
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) break;
      } catch {}
      if (attempt === 49) throw new Error('server did not start');
      await wait(200);
    }

    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gateway-key': GATEWAY_KEY },
      body: JSON.stringify({
        model: process.env.OPENAI_SMOKE_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply with exactly PONG.' }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json();
    if (!response.ok || !/PONG/i.test(body.choices?.[0]?.message?.content || '')) {
      throw new Error(`real chat failed: ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
    }

    const auditResponse = await fetch(`${BASE}/audit/run`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      signal: AbortSignal.timeout(30_000),
    });
    const audit = await auditResponse.json();
    if (!auditResponse.ok || audit.phases?.health?.ok !== true) throw new Error('runtime audit health verification failed');
    await writeFile(join(DATA_DIR, 'last-real-report.json'), JSON.stringify(audit, null, 2), { mode: 0o600 });
    console.log('PASS real OpenAI chat and health audit');
  } catch (error) {
    failed = true;
    console.error(error.stack || error.message);
    console.error(serverLog.split('\n').slice(-30).join('\n'));
  } finally {
    server.kill('SIGTERM');
    await wait(300);
    if (server.exitCode === null) server.kill('SIGKILL');
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
}
