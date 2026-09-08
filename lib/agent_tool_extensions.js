// lib/agent_tool_extensions.js
// Runtime adapter that adds TeacherRAG and Firecrawl v2 Interact to the
// actual AgentRuntime tool surface while preserving the existing kernel tools.

import { FirecrawlClient } from './firecrawl.js';
import { teacherRagBuild, teacherRagPrepare, teacherRagTeach } from './teacher_rag.js';

const EXTENSIONS = Object.freeze([
  {
    name: 'teacher_rag_prepare',
    description: 'Seed the bundled teaching curriculum and vectorize the current Aion-Brain repository into chunks for grounded retrieval.',
    args_schema: {
      type: 'object',
      properties: { force: { type: 'boolean' } },
    },
    cost_estimate: 'repository chunking plus embedding inference when NVIDIA embeddings are configured',
    side_effects: true,
  },
  {
    name: 'teacher_rag_teach',
    description: 'Ask the bundled TeacherRAG for grounded engineering guidance and retrieved code/library context before implementing or repairing code.',
    args_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', maxLength: 4000 },
        level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
      },
    },
    cost_estimate: 'local vector retrieval plus NVIDIA inference when configured',
    side_effects: false,
  },
  {
    name: 'teacher_rag_build',
    description: 'Use TeacherRAG plus the NVIDIA coding model to create real files in an isolated workspace, execute code, repair failures, run recognized tests, and return success only after a fresh passing verification.',
    args_schema: {
      type: 'object',
      required: ['goal'],
      properties: {
        goal: { type: 'string', maxLength: 8000 },
        level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
        maxIterations: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    cost_estimate: 'multiple NVIDIA inference calls plus local sandboxed workspace execution',
    side_effects: true,
  },
  {
    name: 'firecrawl_scrape',
    description: 'Scrape a URL with Firecrawl v2 and return clean data plus scrapeId for follow-up Interact actions.',
    args_schema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', maxLength: 2000 },
        formats: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
        profile: { type: 'object' },
      },
    },
    cost_estimate: '1 Firecrawl scrape',
    side_effects: true,
  },
  {
    name: 'firecrawl_interact',
    description: 'Continue a Firecrawl scrape session by scrapeId. Supply exactly one focused prompt or one Node/Python/Bash code action.',
    args_schema: {
      type: 'object',
      required: ['scrapeId'],
      properties: {
        scrapeId: { type: 'string' },
        prompt: { type: 'string', maxLength: 10000 },
        code: { type: 'string', maxLength: 100000 },
        language: { type: 'string', enum: ['node', 'python', 'bash'] },
        timeout: { type: 'integer', minimum: 1, maximum: 300 },
      },
    },
    cost_estimate: 'Firecrawl browser-session usage',
    side_effects: true,
  },
  {
    name: 'firecrawl_stop',
    description: 'Stop a Firecrawl Interact session. Use when done so browser billing stops and writable profile state is saved.',
    args_schema: {
      type: 'object',
      required: ['scrapeId'],
      properties: { scrapeId: { type: 'string' } },
    },
    cost_estimate: '1 Firecrawl session stop',
    side_effects: true,
  },
]);

export function extendAgentTools(baseTools) {
  if (!baseTools) return baseTools;
  return {
    catalog() {
      const base = typeof baseTools.catalog === 'function' ? baseTools.catalog() : [];
      const overridden = new Set(EXTENSIONS.map(item => item.name));
      return [...base.filter(item => !overridden.has(item.name)), ...EXTENSIONS];
    },

    async run(name, args = {}) {
      if (name === 'teacher_rag_prepare') return teacherRagPrepare(args);
      if (name === 'teacher_rag_teach') return teacherRagTeach(args);
      if (name === 'teacher_rag_build') return teacherRagBuild(args);
      if (name === 'firecrawl_scrape') {
        try {
          const result = await client().scrape(String(args.url || ''), {
            formats: args.formats || ['markdown'],
            profile: args.profile,
          });
          return { ok: true, evidence: result, tool: name };
        } catch (error) {
          return { ok: false, error: `firecrawl_scrape_failed:${error?.message || error}`, tool: name };
        }
      }
      if (name === 'firecrawl_interact') {
        try {
          const result = await client().interact(String(args.scrapeId || args.scrape_id || ''), {
            prompt: args.prompt,
            code: args.code,
            language: args.language || 'node',
            timeout: args.timeout ?? 30,
            origin: 'aion-brain',
          });
          return { ok: true, evidence: result, tool: name };
        } catch (error) {
          return { ok: false, error: `firecrawl_interact_failed:${error?.message || error}`, tool: name };
        }
      }
      if (name === 'firecrawl_stop') {
        try {
          const result = await client().stop(String(args.scrapeId || args.scrape_id || ''));
          return { ok: true, evidence: result, tool: name };
        } catch (error) {
          return { ok: false, error: `firecrawl_stop_failed:${error?.message || error}`, tool: name };
        }
      }
      return baseTools.run(name, args);
    },
  };
}

function client() {
  return new FirecrawlClient({
    apiKey: String(process.env.FIRECRAWL_API_KEY || '').trim(),
    baseUrl: process.env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev',
  });
}

export { EXTENSIONS as AGENT_TOOL_EXTENSIONS };
