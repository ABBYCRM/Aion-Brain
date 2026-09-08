import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../lib/agent_runtime.js';
import { extendAgentTools } from '../lib/agent_tool_extensions.js';

const baseTools = {
  catalog() {
    return [
      { name: 'echo', description: 'echo', args_schema: { type: 'object' }, side_effects: false },
      { name: 'firecrawl_scrape', description: 'legacy', args_schema: { type: 'object' }, side_effects: true },
    ];
  },
  async run(name, args) {
    return { ok: true, evidence: { name, args }, tool: name };
  },
};

test('agent extension catalog replaces legacy Firecrawl scrape and exposes TeacherRAG + Interact', () => {
  const tools = extendAgentTools(baseTools);
  const names = tools.catalog().map(tool => tool.name);
  assert.equal(names.filter(name => name === 'firecrawl_scrape').length, 1);
  assert.ok(names.includes('teacher_rag_prepare'));
  assert.ok(names.includes('teacher_rag_teach'));
  assert.ok(names.includes('teacher_rag_build'));
  assert.ok(names.includes('firecrawl_interact'));
  assert.ok(names.includes('firecrawl_stop'));
});

test('AgentRuntime uses the extended tool registry', () => {
  const runtime = new AgentRuntime({ tools: baseTools, chain: null });
  const names = runtime.tools.catalog().map(tool => tool.name);
  assert.ok(names.includes('teacher_rag_prepare'));
  assert.ok(names.includes('teacher_rag_teach'));
  assert.ok(names.includes('teacher_rag_build'));
  assert.ok(names.includes('firecrawl_interact'));
});

test('agent extension delegates unrelated tools to the base registry', async () => {
  const tools = extendAgentTools(baseTools);
  const result = await tools.run('echo', { text: 'ok' });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.args.text, 'ok');
});
