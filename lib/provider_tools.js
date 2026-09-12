// lib/provider_tools.js
// End-to-end adapters for loaded provider keys (vault / snapshot / env).
// Fail-soft when unconfigured. Never fabricate success. Secrets never logged.
// Tool names match VIDEO-Engine-CCFL where the proxy already uses them.

import { envSecret } from './external_tools.js';

const DEFAULT_TIMEOUT_MS = 30_000;

function unconfigured(tool, envName) {
  return { ok: false, error: `${tool}_unconfigured`, env: envName, tool };
}

function redact(text, secrets) {
  let s = String(text || '');
  for (const secret of secrets) {
    if (secret) s = s.split(secret).join('[redacted]');
  }
  return s;
}

async function httpJson(url, init, { timeoutMs = DEFAULT_TIMEOUT_MS, expectJson = true, fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const res = await fetchFn(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  if (expectJson && text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return { res, text, json };
}

function youtubeVideoId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtu.be')) return u.pathname.replace(/^\//, '').slice(0, 11);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const shorts = u.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
    if (shorts) return shorts[1];
  } catch { /* not a URL */ }
  return '';
}

function sanitizeYoutubeItem(item) {
  const id = item?.id?.videoId || item?.id || item?.snippet?.resourceId?.videoId || null;
  const sn = item?.snippet || {};
  return {
    videoId: typeof id === 'string' ? id : (id?.videoId || null),
    title: String(sn.title || '').slice(0, 300),
    channelTitle: String(sn.channelTitle || '').slice(0, 200),
    publishedAt: sn.publishedAt || null,
    description: String(sn.description || '').slice(0, 500),
    url: (typeof id === 'string' && id) ? `https://www.youtube.com/watch?v=${id}` : null,
  };
}

// ---- YouTube Data API ----

export async function youtubeSearch({ query, count = 5 } = {}, { fetchImpl } = {}) {
  const tool = 'youtube_search';
  const key = envSecret('YOUTUBE_API_KEY');
  if (!key) return unconfigured(tool, 'YOUTUBE_API_KEY');
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query_required', tool };
  const n = Math.max(1, Math.min(25, Number(count) || 5));
  const url = `https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({
    part: 'snippet',
    q: q.slice(0, 400),
    type: 'video',
    maxResults: String(n),
    key,
  })}`;
  try {
    const { res, json, text } = await httpJson(url, { method: 'GET', headers: { accept: 'application/json' } }, { fetchImpl });
    if (!res.ok) {
      return { ok: false, error: `youtube_http_${res.status}`, detail: redact((json?.error?.message || text), [key]).slice(0, 200), tool };
    }
    const items = Array.isArray(json?.items) ? json.items.map(sanitizeYoutubeItem).filter((i) => i.videoId) : [];
    return { ok: true, evidence: { query: q, count: items.length, results: items }, tool };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'youtube_timeout' : 'youtube_network', tool };
  }
}

export async function youtubeVideo({ videoId, id, url } = {}, { fetchImpl } = {}) {
  const tool = 'youtube_video';
  const key = envSecret('YOUTUBE_API_KEY');
  if (!key) return unconfigured(tool, 'YOUTUBE_API_KEY');
  const vid = youtubeVideoId(videoId || id || url);
  if (!vid) return { ok: false, error: 'video_id_required', tool };
  const endpoint = `https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({
    part: 'snippet,statistics,contentDetails',
    id: vid,
    key,
  })}`;
  try {
    const { res, json, text } = await httpJson(endpoint, { method: 'GET', headers: { accept: 'application/json' } }, { fetchImpl });
    if (!res.ok) {
      return { ok: false, error: `youtube_http_${res.status}`, detail: redact((json?.error?.message || text), [key]).slice(0, 200), tool };
    }
    const item = Array.isArray(json?.items) ? json.items[0] : null;
    if (!item) return { ok: false, error: 'video_not_found', tool };
    const sn = item.snippet || {};
    const st = item.statistics || {};
    return {
      ok: true,
      evidence: {
        videoId: item.id,
        title: String(sn.title || '').slice(0, 300),
        channelTitle: String(sn.channelTitle || '').slice(0, 200),
        publishedAt: sn.publishedAt || null,
        description: String(sn.description || '').slice(0, 1200),
        duration: item.contentDetails?.duration || null,
        views: st.viewCount || null,
        likes: st.likeCount || null,
        comments: st.commentCount || null,
        url: `https://www.youtube.com/watch?v=${item.id}`,
      },
      tool,
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'youtube_timeout' : 'youtube_network', tool };
  }
}

// ---- Chat-shaped providers (Gemini / xAI / Kimi / OpenAI) ----

function chatText(json) {
  if (!json || typeof json !== 'object') return '';
  const choice = json.choices?.[0];
  if (choice?.message?.content) return String(choice.message.content);
  if (typeof choice?.text === 'string') return choice.text;
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p.text || '').join('');
  return '';
}

export async function geminiChat({ prompt, text, model, maxTokens } = {}, { fetchImpl } = {}) {
  const tool = 'gemini_chat';
  const key = envSecret('GEMINI_API_KEY');
  if (!key) return unconfigured(tool, 'GEMINI_API_KEY');
  const input = String(prompt || text || '').trim();
  if (!input) return { ok: false, error: 'prompt_required', tool };
  const mdl = String(model || envSecret('GEMINI_MODEL') || 'gemini-2.0-flash').trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(key)}`;
  try {
    const { res, json, text: raw } = await httpJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: input.slice(0, 16_000) }] }],
        generationConfig: { maxOutputTokens: Math.max(16, Math.min(4096, Number(maxTokens) || 1024)) },
      }),
    }, { fetchImpl });
    if (!res.ok) {
      return { ok: false, error: `gemini_http_${res.status}`, detail: redact((json?.error?.message || raw), [key]).slice(0, 200), tool };
    }
    const out = chatText(json).slice(0, 12_000);
    return { ok: Boolean(out), evidence: { model: mdl, text: out, finish: json?.candidates?.[0]?.finishReason || null }, tool };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'gemini_timeout' : 'gemini_network', tool };
  }
}

async function openaiCompatChat({
  tool, envName, baseUrl, defaultModel, prompt, text, model, maxTokens, messages,
}, { fetchImpl } = {}) {
  const key = envSecret(envName);
  if (!key) return unconfigured(tool, envName);
  const input = String(prompt || text || '').trim();
  const msgs = Array.isArray(messages) && messages.length
    ? messages
    : (input ? [{ role: 'user', content: input.slice(0, 16_000) }] : []);
  if (!msgs.length) return { ok: false, error: 'prompt_required', tool };
  const mdl = String(model || defaultModel).trim();
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  try {
    const { res, json, text: raw } = await httpJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: mdl,
        messages: msgs,
        max_tokens: Math.max(16, Math.min(4096, Number(maxTokens) || 1024)),
      }),
    }, { fetchImpl });
    if (!res.ok) {
      return { ok: false, error: `${tool}_http_${res.status}`, detail: redact((json?.error?.message || json?.error || raw), [key]).slice(0, 200), tool };
    }
    const out = chatText(json).slice(0, 12_000);
    return { ok: Boolean(out), evidence: { model: json?.model || mdl, text: out, finish: json?.choices?.[0]?.finish_reason || null }, tool };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `${tool}_timeout` : `${tool}_network`, tool };
  }
}

export async function xaiChat(args = {}, opts = {}) {
  return openaiCompatChat({
    tool: 'xai_chat',
    envName: 'XAI_API_KEY',
    baseUrl: envSecret('XAI_BASE_URL') || 'https://api.x.ai/v1',
    defaultModel: args.model || envSecret('XAI_MODEL') || 'grok-4',
    ...args,
  }, opts);
}

export async function kimiChat(args = {}, opts = {}) {
  return openaiCompatChat({
    tool: 'kimi_chat',
    envName: 'KIMI_API_KEY',
    baseUrl: envSecret('KIMI_BASE_URL') || 'https://api.moonshot.ai/v1',
    defaultModel: args.model || envSecret('KIMI_MODEL') || 'moonshot-v1-128k',
    ...args,
  }, opts);
}

export async function openaiChat(args = {}, opts = {}) {
  return openaiCompatChat({
    tool: 'openai_chat',
    envName: 'OPENAI_API_KEY',
    baseUrl: envSecret('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
    defaultModel: args.model || envSecret('OPENAI_MODEL') || 'gpt-4.1-mini',
    ...args,
  }, opts);
}

async function embedRequest({ tool, key, baseUrl, model, input }, { fetchImpl } = {}) {
  const texts = Array.isArray(input) ? input.map((t) => String(t).slice(0, 8000)) : [String(input || '').slice(0, 8000)];
  if (!texts[0]) return { ok: false, error: 'input_required', tool };
  const url = `${String(baseUrl).replace(/\/+$/, '')}/embeddings`;
  const { res, json, text } = await httpJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: texts.length === 1 ? texts[0] : texts }),
  }, { fetchImpl });
  if (!res.ok) {
    return { ok: false, error: `${tool}_http_${res.status}`, detail: redact((json?.error?.message || text), [key]).slice(0, 200), tool };
  }
  const vectors = Array.isArray(json?.data) ? json.data.map((d) => ({
    index: d.index,
    dimensions: Array.isArray(d.embedding) ? d.embedding.length : 0,
    embedding: Array.isArray(d.embedding) ? d.embedding.slice(0, 8) : [],
  })) : [];
  return {
    ok: true,
    evidence: {
      model: json?.model || model,
      count: vectors.length,
      dimensions: vectors[0]?.dimensions || 0,
      vectors,
      usage: json?.usage || null,
    },
    embeddings: Array.isArray(json?.data) ? json.data.map((d) => d.embedding) : [],
    tool,
  };
}

export async function openaiEmbed({ input, text, model } = {}, opts = {}) {
  const tool = 'openai_embed';
  const key = envSecret('OPENAI_API_KEY');
  if (!key) return unconfigured(tool, 'OPENAI_API_KEY');
  return embedRequest({
    tool,
    key,
    baseUrl: envSecret('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
    model: model || envSecret('OPENAI_EMBED_MODEL') || 'text-embedding-3-small',
    input: input || text,
  }, opts);
}

export async function embeddingsEmbed({ input, text, model } = {}, opts = {}) {
  const tool = 'embeddings_embed';
  const key = envSecret('EMBEDDINGS_API_KEY') || envSecret('BITDEER_API_KEY') || envSecret('BITDEER_API_KEYS') || envSecret('OPENAI_API_KEY');
  if (!key) return unconfigured(tool, 'EMBEDDINGS_API_KEY');
  const firstKey = String(key).split(',')[0].trim();
  const base = envSecret('EMBEDDINGS_BASE_URL')
    || envSecret('BITDEER_BASE_URL')
    || envSecret('NVIDIA_BASE_URL')
    || (envSecret('EMBEDDINGS_API_KEY') ? 'https://api-inference.bitdeer.ai/v1' : 'https://api.openai.com/v1');
  const mdl = model || envSecret('EMBEDDINGS_MODEL') || envSecret('BITDEER_EMBED_MODEL') || 'nvidia/Nemotron-3-Embed-1B-BF16';
  return embedRequest({ tool, key: firstKey, baseUrl: base, model: mdl, input: input || text }, opts);
}

// ---- Pinecone ----

export function pineconeConfigured() {
  return Boolean(envSecret('PINECONE_API_KEY') && (envSecret('PINECONE_INDEX_HOST') || envSecret('PINECONE_INDEX')));
}

function pineconeHost() {
  const host = (envSecret('PINECONE_INDEX_HOST') || envSecret('PINECONE_INDEX') || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return host;
}

function pineconeHeaders(key) {
  return { 'Api-Key': key, 'content-type': 'application/json', accept: 'application/json' };
}

export async function pineconeQuery({ query, vector, topK, namespace, filter } = {}, { fetchImpl } = {}) {
  const tool = 'pinecone_query';
  const key = envSecret('PINECONE_API_KEY');
  const host = pineconeHost();
  if (!key || !host) return unconfigured(tool, 'PINECONE_API_KEY');
  let values = Array.isArray(vector) ? vector : null;
  if (!values) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'query_or_vector_required', tool };
    const { hashEmbed } = await import('./bos_omega_rag.js');
    values = hashEmbed(q);
  }
  const ns = namespace || envSecret('PINECONE_NAMESPACE') || 'bos-omega';
  try {
    const { res, json, text } = await httpJson(`https://${host}/query`, {
      method: 'POST',
      headers: pineconeHeaders(key),
      body: JSON.stringify({
        vector: values,
        topK: Math.max(1, Math.min(50, Number(topK) || 6)),
        includeMetadata: true,
        namespace: ns,
        filter: filter && typeof filter === 'object' ? filter : undefined,
      }),
    }, { fetchImpl, timeoutMs: 15_000 });
    if (!res.ok) return { ok: false, error: `pinecone_http_${res.status}`, detail: redact(text, [key]).slice(0, 200), tool };
    const matches = Array.isArray(json?.matches) ? json.matches.map((m) => ({
      id: m.id || null,
      score: Number(m.score || 0),
      metadata: m.metadata && typeof m.metadata === 'object' ? m.metadata : {},
      text: String(m.metadata?.text || m.metadata?.object || '').slice(0, 2000),
    })) : [];
    return { ok: true, evidence: { namespace: ns, count: matches.length, matches }, tool };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'pinecone_timeout' : 'pinecone_network', tool };
  }
}

export async function pineconeUpsert({ vectors, namespace, id, text, metadata } = {}, { fetchImpl } = {}) {
  const tool = 'pinecone_upsert';
  const key = envSecret('PINECONE_API_KEY');
  const host = pineconeHost();
  if (!key || !host) return unconfigured(tool, 'PINECONE_API_KEY');
  let batch = Array.isArray(vectors) ? vectors : [];
  if (!batch.length && (id || text)) {
    const { hashEmbed } = await import('./bos_omega_rag.js');
    const body = String(text || '').trim();
    if (!body) return { ok: false, error: 'vectors_or_text_required', tool };
    batch = [{
      id: String(id || `mem_${Date.now()}`).slice(0, 128),
      values: hashEmbed(body),
      metadata: { text: body.slice(0, 2000), ...(metadata && typeof metadata === 'object' ? metadata : {}) },
    }];
  }
  if (!batch.length) return { ok: false, error: 'vectors_or_text_required', tool };
  const ns = namespace || envSecret('PINECONE_NAMESPACE') || 'bos-omega';
  const payload = batch.slice(0, 100).map((v, i) => ({
    id: String(v.id || `vec_${i}`).slice(0, 128),
    values: Array.isArray(v.values || v.vector) ? (v.values || v.vector) : [],
    metadata: v.metadata && typeof v.metadata === 'object' ? v.metadata : {},
  })).filter((v) => v.id && v.values.length);
  if (!payload.length) return { ok: false, error: 'invalid_vectors', tool };
  try {
    const { res, json, text } = await httpJson(`https://${host}/vectors/upsert`, {
      method: 'POST',
      headers: pineconeHeaders(key),
      body: JSON.stringify({ vectors: payload, namespace: ns }),
    }, { fetchImpl, timeoutMs: 20_000 });
    if (!res.ok) return { ok: false, error: `pinecone_http_${res.status}`, detail: redact(text, [key]).slice(0, 200), tool };
    return { ok: true, evidence: { namespace: ns, upserted: json?.upsertedCount ?? payload.length, count: payload.length }, tool };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'pinecone_timeout' : 'pinecone_network', tool };
  }
}

// ---- Hedra v3 generate / job (status stays in external_tools) ----

export async function hedraGenerate({ prompt, text, model, input, quality, aspect_ratio, resolution } = {}, { fetchImpl } = {}) {
  const tool = 'hedra_generate';
  const key = envSecret('HEDRA_API_KEY');
  if (!key) return unconfigured(tool, 'HEDRA_API_KEY');
  const mdl = String(model || envSecret('HEDRA_DEFAULT_MODEL') || 'gpt-image-2').trim();
  const bodyInput = input && typeof input === 'object'
    ? input
    : {
      prompt: String(prompt || text || '').trim(),
      quality: quality || undefined,
      aspect_ratio: aspect_ratio || undefined,
      resolution: resolution || undefined,
    };
  if (!bodyInput.prompt) return { ok: false, error: 'prompt_required', tool };
  try {
    const { res, json, text: raw } = await httpJson(`https://api.hedra.com/v3/models/${encodeURIComponent(mdl)}`, {
      method: 'POST',
      headers: { authorization: `Key ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ input: bodyInput }),
    }, { fetchImpl, timeoutMs: 45_000 });
    if (!res.ok) {
      return { ok: false, error: `hedra_http_${res.status}`, detail: redact(raw, [key]).slice(0, 200), tool };
    }
    const jobId = json?.job_id || json?.id || json?.jobId || null;
    return { ok: Boolean(jobId || res.status === 202), evidence: { job_id: jobId, model: mdl, status: json?.status || (res.status === 202 ? 'accepted' : null) }, tool };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'hedra_timeout' : 'hedra_network', tool };
  }
}

export async function hedraJob({ jobId, id } = {}, { fetchImpl } = {}) {
  const tool = 'hedra_job';
  const key = envSecret('HEDRA_API_KEY');
  if (!key) return unconfigured(tool, 'HEDRA_API_KEY');
  const jid = String(jobId || id || '').trim();
  if (!jid || /[/?#]/.test(jid) || jid.length > 128) return { ok: false, error: 'job_id_required', tool };
  try {
    const headers = { authorization: `Key ${key}`, accept: 'application/json' };
    const job = await httpJson(`https://api.hedra.com/v3/jobs/${encodeURIComponent(jid)}`, { method: 'GET', headers }, { fetchImpl });
    if (!job.res.ok && job.res.status !== 404) {
      return { ok: false, error: `hedra_http_${job.res.status}`, detail: redact(job.text, [key]).slice(0, 200), tool };
    }
    let statusJson = job.json;
    if (!job.res.ok) {
      const st = await httpJson(`https://api.hedra.com/v3/jobs/${encodeURIComponent(jid)}/status`, { method: 'GET', headers }, { fetchImpl });
      if (!st.res.ok) return { ok: false, error: `hedra_http_${st.res.status}`, detail: redact(st.text, [key]).slice(0, 200), tool };
      statusJson = st.json;
    }
    const outputs = Array.isArray(statusJson?.outputs) ? statusJson.outputs.slice(0, 8).map((o) => ({
      url: o.url || null,
      asset_id: o.asset_id || o.id || null,
      kind: o.type || o.kind || null,
    })) : [];
    return {
      ok: true,
      evidence: {
        job_id: statusJson?.job_id || statusJson?.id || jid,
        status: statusJson?.status || null,
        outputs,
      },
      tool,
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'hedra_timeout' : 'hedra_network', tool };
  }
}

// ---- Composio live catalog (ak_ project REST; names match CCFL) ----

export async function composioListTools({ toolkit, search, limit } = {}, { fetchImpl } = {}) {
  const { classifyComposioKey } = await import('./external_tools.js');
  const tool = 'composio_list_tools';
  const key = envSecret('COMPOSIO_API_KEY');
  const kind = classifyComposioKey(key);
  if (!key) return unconfigured(tool, 'COMPOSIO_API_KEY');
  if (!kind.ok) return { ok: false, error: kind.error, key_type: kind.type, tool };
  const qs = new URLSearchParams();
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  qs.set('limit', String(n));
  if (toolkit) qs.set('appNames', String(toolkit).trim());
  try {
    const { res, json, text } = await httpJson(`https://backend.composio.dev/api/v2/actions?${qs}`, {
      method: 'GET',
      headers: { 'x-api-key': key, accept: 'application/json' },
    }, { fetchImpl });
    if (!res.ok) return { ok: false, error: `composio_http_${res.status}`, detail: redact(text, [key]).slice(0, 200), key_type: kind.type, tool };
    let items = Array.isArray(json?.items) ? json.items : (Array.isArray(json) ? json : []);
    const q = String(search || '').trim().toLowerCase();
    if (q) {
      items = items.filter((it) => {
        const blob = `${it.name || ''} ${it.enum || ''} ${it.displayName || ''} ${it.description || ''}`.toLowerCase();
        return blob.includes(q);
      });
    }
    const slugs = items.slice(0, n).map((it) => ({
      slug: it.name || it.enum || it.displayName || null,
      toolkit: it.appName || it.appId || toolkit || null,
      description: String(it.description || '').slice(0, 240),
    })).filter((s) => s.slug);
    return { ok: true, evidence: { count: slugs.length, tools: slugs, key_type: kind.type }, key_type: kind.type, tool };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'composio_timeout' : 'composio_network', key_type: kind.type, tool };
  }
}

export async function composioToolSchema({ name, slug } = {}, { fetchImpl } = {}) {
  const { classifyComposioKey } = await import('./external_tools.js');
  const tool = 'composio_tool_schema';
  const key = envSecret('COMPOSIO_API_KEY');
  const kind = classifyComposioKey(key);
  if (!key) return unconfigured(tool, 'COMPOSIO_API_KEY');
  if (!kind.ok) return { ok: false, error: kind.error, key_type: kind.type, tool };
  const action = String(slug || name || '').trim();
  if (!action) return { ok: false, error: 'slug_required', tool };
  try {
    const { res, json, text } = await httpJson(`https://backend.composio.dev/api/v2/actions/${encodeURIComponent(action)}`, {
      method: 'GET',
      headers: { 'x-api-key': key, accept: 'application/json' },
    }, { fetchImpl });
    if (!res.ok) return { ok: false, error: `composio_http_${res.status}`, detail: redact(text, [key]).slice(0, 200), key_type: kind.type, tool };
    return {
      ok: true,
      evidence: {
        slug: json?.name || action,
        description: String(json?.description || '').slice(0, 400),
        parameters: json?.parameters || json?.input_parameters || json?.schema || null,
      },
      key_type: kind.type,
      tool,
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'composio_timeout' : 'composio_network', key_type: kind.type, tool };
  }
}
