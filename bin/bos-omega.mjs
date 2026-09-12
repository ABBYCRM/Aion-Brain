#!/usr/bin/env node
// CLI for BOS-OMEGA local RAG. No paid APIs required (hash embeddings).
//   node bin/bos-omega.mjs ingest
//   node bin/bos-omega.mjs retrieve "Trinity"
//   node bin/bos-omega.mjs retrieve "Weldon Angelos"

import { BosOmegaRag } from '../lib/bos_omega_rag.js';

const [cmd, ...rest] = process.argv.slice(2);
const rag = new BosOmegaRag();

try {
  if (cmd === 'ingest' || cmd === 'status') {
    const ingest = rag.ensureIngested();
    console.log(JSON.stringify({ ...rag.status(), last_ingest: ingest }, null, 2));
  } else if (cmd === 'retrieve') {
    const query = rest.join(' ').trim();
    if (!query) {
      console.error('usage: node bin/bos-omega.mjs retrieve <query>');
      process.exit(2);
    }
    rag.ensureIngested();
    console.log(JSON.stringify(rag.retrieve(query), null, 2));
  } else {
    console.error('usage: node bin/bos-omega.mjs <ingest|status|retrieve> [query]');
    process.exit(2);
  }
} finally {
  rag.close();
}
