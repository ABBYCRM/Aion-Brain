#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { TOPICS, buildSQM, renderMarkdown } from '../lib/sqm.js';

try {
  const { values } = parseArgs({ options: {
    topic: { type: 'string', multiple: true },
    'list-topics': { type: 'boolean' },
    format: { type: 'string', default: 'markdown' },
    output: { type: 'string', short: 'o' }
  }});
  if (values['list-topics']) console.log(TOPICS.map(t => t.name).join('\n'));
  else {
    if (!['json', 'markdown'].includes(values.format)) throw Error('format must be json or markdown');
    const result = await buildSQM({ topics: values.topic });
    const content = values.format === 'json' ? JSON.stringify(result, null, 2) : renderMarkdown(result);
    if (values.output) { await writeFile(values.output, content, 'utf8'); console.error(`SQM written to ${values.output}`); }
    else console.log(content);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
