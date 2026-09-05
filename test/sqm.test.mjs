import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { TOPICS, devSearch, buildSQM, renderMarkdown, selectTopics, registerSQMRoutes } from '../lib/sqm.js';
import * as catalog from '../lib/skill_catalog.js';

test('all 42 requested topics are selectable, unknown and malformed topics fail', () => {
  assert.equal(TOPICS.length, 42);
  assert.deepEqual(selectTopics(['python', 'Python']).map(t => t.name), ['Python']);
  for (const bad of [[], ['Python', 'typo'], 'Python', [null]]) assert.throws(() => selectTopics(bad), TypeError);
});
test('real bundled bodies preserve nested sections and exclude neighboring files', async () => {
  const entries = await catalog.list();
  assert.equal(entries.length, 286);
  for (const entry of entries) {
    const skill = await catalog.get(entry.name);
    assert.ok(skill.body.length > 100, entry.name);
    assert.ok(!skill.body.includes('ECC_BUNDLE_FILE_END'), entry.name);
  }
  const accessibility = await catalog.get('skills/accessibility');
  assert.match(accessibility.body, /## Core Concepts/);
  assert.match(accessibility.body, /## Examples/);
});
test('real Python search finds Python material, with full bodies and provenance', async () => {
  const result = await devSearch({ query: 'Python', limit: 3 });
  assert.equal(result.retrieval, 'lexical');
  assert.ok(result.matches.length);
  assert.match(result.matches[0].title, /python/);
  assert.ok(result.matches.every(r => r.body.length > 100 && r.source.endsWith('/SKILL.md')));
  assert.equal((await devSearch({ query: 'zzznomatchingcorpusword' })).count, 0);
});
test('limits and query types are validated', async () => {
  for (const params of [{query:''},{query:[]},{query:'x',limit:0},{query:'x',limit:11},{query:'x',limit:1.5},{query:'x',category:'unknown'}]) {
    await assert.rejects(devSearch(params), TypeError);
  }
});
test('curriculum records gaps honestly and renders JSON and Markdown', async () => {
  const doc = await buildSQM({ topics: ['OSINT', 'OPSEC'] }, async () => ({ matches: [] }));
  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].coverage, 'no_matches');
  assert.match(renderMarkdown(doc), /No corpus results found/);
  const real = await buildSQM({ topics: ['Python'], limit: 2 });
  assert.ok(real.sections[0].results.length);
  assert.match(renderMarkdown(real), /Source: skills\//);
  assert.equal(JSON.parse(JSON.stringify(real)).sections[0].topic, 'Python');
});
test('CLI lists all topics, exports JSON and rejects unknown names', () => {
  const list = execFileSync(process.execPath, ['bin/sqm.mjs','--list-topics'], {encoding:'utf8'});
  assert.equal(list.trim().split('\n').length, 42);
  const json = JSON.parse(execFileSync(process.execPath, ['bin/sqm.mjs','--topic','GitHub','--format','json'], {encoding:'utf8',maxBuffer:10_000_000}));
  assert.equal(json.sections[0].topic, 'GitHub');
  assert.equal(spawnSync(process.execPath, ['bin/sqm.mjs','--topic','typo']).status, 1);
});
test('every SQM route requires authentication and rejects invalid payloads', async () => {
  const routes = new Map();
  const app = {get:(path,fn)=>routes.set(path,fn),post:(path,fn)=>routes.set(path,fn)};
  registerSQMRoutes(app, req => { if(req.key !== 'test-key') throw Object.assign(Error(), {statusCode:401}); });
  function response() { return {code:200,status(c){this.code=c;return this},json(v){this.value=v;return this},type(){return this},send(v){this.value=v;return this}}; }
  for (const handler of routes.values()) {const res=response();await handler({},res);assert.equal(res.code,401);}
  const res=response();await routes.get('/api/sqm')({key:'test-key',body:{topics:['typo']}},res);assert.equal(res.code,400);
  const ok=response();await routes.get('/api/sqm')({key:'test-key',body:{topics:['Python'],limit:1}},ok);assert.equal(ok.value.sections.length,1);
});
