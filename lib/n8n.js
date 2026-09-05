import { randomUUID } from 'node:crypto';

const DEFAULT_URL = 'https://paisabrazil.app.n8n.cloud/mcp-server/http';
const READ_TOOLS = ['search_workflows', 'get_workflow_details'];
function config() {
  const url = new URL(process.env.N8N_MCP_URL || DEFAULT_URL);
  const token = process.env.N8N_MCP_TOKEN?.trim();
  if (!token) throw new Error('n8n MCP is not configured: set N8N_MCP_TOKEN on Aion-Brain.');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('N8N_MCP_URL must be an HTTPS URL without embedded credentials.');
  return { url: url.href, token };
}

async function rpcResponse(response, id) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`n8n MCP returned HTTP ${response.status}.`); }
  if (!response.body) throw new Error('n8n MCP returned an empty response.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  let buffer = '', size = 0;
  const check = message => {
    if (message.id !== id) return undefined;
    if (message.error) throw new Error(`n8n MCP protocol error (${message.error.code}).`);
    if (!Object.hasOwn(message, 'result')) throw new Error('n8n MCP response has no result.');
    return message;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4_000_000) throw new Error('n8n MCP response exceeds 4 MB.');
      buffer += decoder.decode(chunk.value, {stream:true});
      if (sse) {
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0,boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
          if (data && data !== '[DONE]') {const found = check(JSON.parse(data)); if(found) return found.result;}
        }
      }
    }
    buffer += decoder.decode();
    if (!sse) {const found = check(JSON.parse(buffer)); if(found) return found.result;}
    throw new Error('n8n MCP stream ended without the requested result.');
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

async function withSession(action) {
  const { url, token } = config();
  let session, protocol = '2025-03-26';
  const headers = () => ({Authorization:`Bearer ${token}`, 'Content-Type':'application/json', Accept:'application/json, text/event-stream',
    'MCP-Protocol-Version':protocol, ...(session ? {'Mcp-Session-Id':session} : {})});
  const rpc = async (method, params) => {
    const id = randomUUID();
    const response = await fetch(url, {method:'POST', headers:headers(), redirect:'error', signal:AbortSignal.timeout(60_000),
      body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
    if (method === 'initialize') session = response.headers.get('mcp-session-id') || undefined;
    return rpcResponse(response,id);
  };
  try {
    const init = await rpc('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'aion-brain',version:'0.1.15'}});
    if (!['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(init.protocolVersion)) throw new Error('Unsupported n8n MCP protocol version.');
    protocol = init.protocolVersion;
    const ready = await fetch(url,{method:'POST',headers:headers(),redirect:'error',signal:AbortSignal.timeout(10_000),body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
    await ready.body?.cancel();
    if (!ready.ok) throw new Error(`n8n MCP initialization returned HTTP ${ready.status}.`);
    return await action(rpc);
  } finally {
    if (session) await fetch(url,{method:'DELETE',headers:headers(),redirect:'error',signal:AbortSignal.timeout(5000)}).then(r=>r.body?.cancel()).catch(()=>{});
  }
}

export async function n8nTools() {
  return withSession(async rpc => {
    const tools = [], seen = new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await rpc('tools/list',cursor ? {cursor} : {});
      if (!Array.isArray(result.tools)) throw new Error('Invalid n8n tool catalog.');
      tools.push(...result.tools);
      if (!result.nextCursor) return {ok:true,tools};
      cursor=result.nextCursor;
      if (seen.has(cursor)) throw new Error('Repeated n8n tool cursor.');
      seen.add(cursor);
    }
    throw new Error('n8n tool catalog exceeds 20 pages.');
  });
}

export async function n8nCall(name, args = {}) {
  if (typeof name !== 'string' || !name || !args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Provide a tool name and an arguments object.');
  const allowed = (process.env.N8N_ALLOWED_TOOLS || READ_TOOLS.join(',')).split(',').map(s=>s.trim());
  if (!allowed.includes(name)) throw new Error('This n8n tool is not enabled in N8N_ALLOWED_TOOLS. Workflow execution and writes require explicit server configuration.');
  if (JSON.stringify(args).length > 100_000) throw new TypeError('n8n arguments exceed 100 KB.');
  return withSession(async rpc => {
    // Do not retry tools/call: a timeout may occur after an action has already run.
    const result = await rpc('tools/call',{name,arguments:args});
    return {ok:result.isError !== true,result};
  });
}

export async function n8nStatus() {
  const result = await n8nTools();
  return {ok:true,connected:true,toolCount:result.tools.length,tools:result.tools.map(t=>t.name),
    allowedTools:(process.env.N8N_ALLOWED_TOOLS || READ_TOOLS.join(',')).split(',').map(s=>s.trim())};
}

export async function n8nWorkflows() {
  const key = process.env.N8N_API_KEY?.trim();
  if (!key) throw new Error('n8n public API is not configured: set N8N_API_KEY (different from the MCP token).');
  const url = new URL(process.env.N8N_API_URL || 'https://paisabrazil.app.n8n.cloud/api/v1/');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid N8N_API_URL.');
  const response = await fetch(url.href.replace(/\/$/,'')+'/workflows?limit=100',{headers:{'X-N8N-API-KEY':key},redirect:'error',signal:AbortSignal.timeout(15_000)});
  if (!response.ok) {await response.body?.cancel();throw new Error(`n8n public API returned HTTP ${response.status}.`);}
  const result = await response.json();
  if (!Array.isArray(result.data)) throw new Error('Invalid n8n workflow list.');
  // Return metadata only, excluding node parameters and credential references.
  return {ok:true,workflows:result.data.map(w=>({id:w.id,name:w.name,active:w.active})),hasMore:Boolean(result.nextCursor)};
}
