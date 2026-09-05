// Useful AURA functions only: no duplicates of Claw web/GitHub/Composio tools.
export const AURA_FUNCTIONS = Object.freeze({
  self_check: 'rJalU7F8V8jHtZYF', skill_list: 'hrpMu07UbueFwPra', vault_list: 'cMzzwy0zfNf9Zx8E',
  memory_search: 'uoG9g6rbWRvb8Fjj', memory_write: 'ee1IkvhOYxnFhrNR',
  list_scheduled_tasks: 'LUuWhyUPRjwOHEC8', schedule_task: 'DFei1Fgh2oby2fBs', cancel_scheduled_task: 'EdYOMDN53I8ERL7k',
  spawn_status: 'EiRJHl5wb4j1sKS3', render_status: 'ZRYl9NBU2ezvXsUm'
});

export async function auraCall(name, payload = {}) {
  if (!Object.hasOwn(AURA_FUNCTIONS,name)) throw new TypeError('Unknown AURA function. Use memory, scheduling, skills, vault or status.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length>100_000) throw new TypeError('payload must be an object under 100 KB.');
  const base = new URL(process.env.N8N_BASE_URL || 'https://paisabrazil.app.n8n.cloud');
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('N8N_BASE_URL must be an HTTPS origin.');
  const key=process.env.N8N_API_KEY;
  if(!key)throw new Error('N8N_API_KEY is required to verify the selected AURA workflow.');
  const response=await fetch(`${base.origin}/api/v1/workflows/${AURA_FUNCTIONS[name]}`,{headers:{'X-N8N-API-KEY':key},redirect:'error',signal:AbortSignal.timeout(15_000)});
  if(!response.ok){await response.body?.cancel();throw new Error(`AURA verification returned HTTP ${response.status}.`);}
  const graph=await response.json();
  const webhook=graph.nodes?.find(n=>n.type==='n8n-nodes-base.webhook' && n.parameters?.path===`aura-${name}`);
  const method=webhook?.parameters?.httpMethod || 'GET';
  if(!graph.active || graph.name!==`AURA: ${name}` || !webhook || !['GET','POST'].includes(method)) throw new Error('AURA workflow identity, active state or webhook did not match. Nothing was executed.');
  const url=new URL(`/webhook/aura-${name}`,base);
  if(method==='GET') {
    for(const [k,v] of Object.entries(payload)){if(!['string','number','boolean'].includes(typeof v))throw new TypeError('GET parameters must be scalar values.');url.searchParams.set(k,String(v));}
    if(url.href.length>8000)throw new TypeError('AURA query exceeds 8 KB.');
  }
  // Webhook auth is separate. Never forward n8n's MCP or public API credential.
  const headers={'Content-Type':'application/json',...(process.env.N8N_WEBHOOK_TOKEN?{Authorization:`Bearer ${process.env.N8N_WEBHOOK_TOKEN}`}:{})};
  // Never automatically retry: a timed-out write may already have succeeded.
  const result=await fetch(url,{method,headers,body:method==='POST'?JSON.stringify(payload):undefined,redirect:'error',signal:AbortSignal.timeout(60_000)});
  if(!result.ok){await result.body?.cancel();throw new Error(`AURA returned HTTP ${result.status}. Check execution status before retrying a write.`);}
  const reader=result.body?.getReader();if(!reader)throw new Error('AURA returned an empty response.');
  const decoder=new TextDecoder();let text='',size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1_000_000)throw new Error('AURA response exceeds 1 MB.');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const data=result.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text;
  return {ok:!(data && typeof data==='object' && (data.ok===false || data.error)),function:name,data};
}
