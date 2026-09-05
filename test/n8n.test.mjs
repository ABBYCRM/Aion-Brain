import test from 'node:test';
import assert from 'node:assert/strict';
import { n8nTools, n8nCall, n8nStatus, n8nWorkflows } from '../lib/n8n.js';

const originalFetch=globalThis.fetch;
const saved={...process.env};
test.beforeEach(()=>{process.env.N8N_MCP_TOKEN='fake-test-token';delete process.env.N8N_ALLOWED_TOOLS;});
test.afterEach(()=>{globalThis.fetch=originalFetch;for(const key of ['N8N_MCP_TOKEN','N8N_ALLOWED_TOOLS','N8N_API_KEY']){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}});
function mockMcp({sse=false,toolError=false,pages=false}={}) {
  const calls=[];
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer fake-test-token');
    assert.equal(options.redirect,'error');
    if(options.method==='DELETE'){calls.push('DELETE');return new Response(null,{status:204});}
    const body=JSON.parse(options.body);calls.push(body.method);
    if(body.method==='notifications/initialized')return new Response(null,{status:202});
    let result;
    if(body.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}}};
    else {assert.equal(options.headers['Mcp-Session-Id'],'test-session');
      result=body.method==='tools/list'?{tools:[{name:body.params.cursor?'get_workflow_details':'search_workflows',inputSchema:{type:'object'}}],...(pages&&!body.params.cursor?{nextCursor:'second'}:{})}
        :{isError:toolError,content:[{type:'text',text:'workflow data'}],structuredContent:{found:true}};
    }
    const payload={jsonrpc:'2.0',id:body.id,result};
    return sse ? new Response(`: keepalive\r\n\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`,{headers:{'content-type':'text/event-stream','mcp-session-id':'test-session'}})
      :Response.json(payload,{headers:{'mcp-session-id':'test-session'}});
  };
  return calls;
}
test('MCP initializes, paginates, preserves schemas and closes its session',async()=>{
  const calls=mockMcp({pages:true});const result=await n8nTools();assert.equal(result.tools.length,2);
  assert.deepEqual(calls,['initialize','notifications/initialized','tools/list','tools/list','DELETE']);
});
test('MCP handles SSE and exposes read-only connection status',async()=>{
  mockMcp({sse:true});const result=await n8nStatus();assert.equal(result.connected,true);assert.ok(!JSON.stringify(result).includes('fake-test-token'));
});
test('tool result objects are preserved and upstream tool errors remain failures',async()=>{
  mockMcp();assert.equal((await n8nCall('search_workflows',{query:'example'})).result.structuredContent.found,true);
  mockMcp({toolError:true});assert.equal((await n8nCall('search_workflows',{})).ok,false);
});
test('execution is disabled by default before any network call; explicit allowlist enables it',async()=>{
  globalThis.fetch=async()=>{throw Error('must not call')};await assert.rejects(n8nCall('execute_workflow',{}),/not enabled/);
  process.env.N8N_ALLOWED_TOOLS='execute_workflow';const calls=mockMcp();await n8nCall('execute_workflow',{workflowId:'test-only'});
  assert.equal(calls.filter(c=>c==='tools/call').length,1);
});
test('authentication failure excludes upstream body and unconfigured fails clearly',async()=>{
  globalThis.fetch=async()=>new Response('private',{status:401});await assert.rejects(n8nTools(),/HTTP 401/);
  delete process.env.N8N_MCP_TOKEN;await assert.rejects(n8nTools(),/not configured/);
});
test('public API uses its separate header and exposes only workflow metadata',async()=>{
  process.env.N8N_API_KEY='fake-api-key';
  globalThis.fetch=async(url,options)=>{assert.equal(options.headers['X-N8N-API-KEY'],'fake-api-key');return Response.json({data:[{id:'1',name:'Example',active:true,nodes:[{secret:'private'}]}],nextCursor:'next'});};
  const result=await n8nWorkflows();assert.equal(result.hasMore,true);assert.ok(!JSON.stringify(result).includes('private'));
});
